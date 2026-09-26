//! AI 超解像エンジンの層。command から呼ばれる入口だけをここに置き、
//! 登録簿(registry)・取得と展開(installer)・子プロセスの実行(runner)・結果のキャッシュ(cache)・
//! キャッシュの容量の管理(cache_store)・その場処理のキュー(queue)と 1 ページの処理(enhance)に分ける。

pub mod cache;
mod cache_store;
mod enhance;
mod installer;
pub mod queue;
mod registry;
mod runner;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, MutexGuard};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::app_error::{AppError, AppResult};
use crate::models::{
    BatchEnhanceResult, EngineCandidate, EngineId, EngineInstallOption,
    EngineInstallOptionsResponse, EngineInstallProgress, EngineInstallStage, EngineInstallWarning,
    EngineRegistration, EngineRegistry, EngineStatus, EnhanceCacheInfo, EnhanceJobState,
    EnhanceRequestResult, EnhanceSettings, EnhanceStatusEvent,
};
use crate::services::app_data_dir;
use crate::services::source::{BookCache, PageSource};
use crate::state::RegistryLock;

use cache::{cache_entry_path, cache_key, EnhanceParams, ENHANCED_CACHE_DIR};
use enhance::{enhance_page, not_registered, PageInput, ENHANCE_TIMEOUT};
use queue::{EnhanceQueue, JobExecutor, JobOutcome, JobSpec, JobState};

use installer::DEFAULT_EXTRACT_LIMITS;
use registry::{all_engine_ids, descriptor, load_registry, save_registry, source_label};

fn registry_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_data_dir(app)?.join("engines").join("registry.json"))
}

fn tools_dir(app: &AppHandle, engine_id: EngineId) -> AppResult<PathBuf> {
    let path = app_data_dir(app)?.join("tools").join(engine_id.as_str());
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn lock_registry(lock: &RegistryLock) -> AppResult<MutexGuard<'_, ()>> {
    lock.0
        .lock()
        .map_err(|_| AppError::Message("AI エンジン設定の排他制御に失敗しました。".into()))
}

fn build_status(engine_id: EngineId, registration: Option<&EngineRegistration>) -> EngineStatus {
    let descriptor = descriptor(engine_id);
    let mut warning = None;
    let mut configured = false;
    let mut ready = false;

    if let Some(entry) = registration {
        configured = true;
        if let Err(error) = runner::run_healthcheck(entry) {
            warning = Some(error.to_string());
        } else {
            ready = true;
        }
    }

    EngineStatus {
        id: engine_id,
        label: descriptor.id.label().to_string(),
        configured,
        ready,
        executable_path: registration.map(|item| item.executable_path.clone()),
        model_path: registration.map(|item| item.model_path.clone()),
        model_name: registration.and_then(|item| item.model_name.clone()),
        source: registration.map(|item| source_label(&item.source)),
        warning,
        download_url: descriptor.download_url.to_string(),
        notes: descriptor
            .notes
            .iter()
            .map(|note| (*note).to_string())
            .collect(),
    }
}

pub fn get_engine_statuses(app: &AppHandle) -> AppResult<Vec<EngineStatus>> {
    let registry: EngineRegistry = {
        let registry_lock = app.state::<RegistryLock>();
        let _guard = lock_registry(&registry_lock)?;
        load_registry(&registry_path(app)?)?
    };

    Ok(all_engine_ids()
        .into_iter()
        .map(|engine_id| build_status(engine_id, registry.engines.get(&engine_id)))
        .collect())
}

pub fn detect_engine_candidates() -> AppResult<Vec<EngineCandidate>> {
    Ok(registry::detect_candidates())
}

pub fn get_engine_install_options() -> AppResult<EngineInstallOptionsResponse> {
    let client = installer::github_client(Duration::from_secs(45))?;
    let mut options = Vec::new();
    let mut warnings = Vec::new();

    for engine_id in all_engine_ids() {
        match installer::find_release_assets(&client, engine_id) {
            Ok(mut engine_options) => options.append(&mut engine_options),
            Err(error) => warnings.push(EngineInstallWarning {
                engine_id,
                label: engine_id.label().to_string(),
                message: error.to_string(),
            }),
        }
    }

    Ok(EngineInstallOptionsResponse { options, warnings })
}

pub fn register_engine_directory(
    app: &AppHandle,
    engine_id: EngineId,
    directory_path: &str,
) -> AppResult<EngineStatus> {
    let registry_lock = app.state::<RegistryLock>();
    let _guard = lock_registry(&registry_lock)?;
    let directory = Path::new(directory_path);
    if !directory.is_dir() {
        return Err(AppError::Message(
            "指定されたフォルダが見つかりません。".into(),
        ));
    }
    let root = fs::canonicalize(directory)?;

    let path = registry_path(app)?;
    let mut registry = load_registry(&path)?;
    let mut registration = registry::infer_registration(engine_id, &root)?;
    registration.source = "directory".into();
    registry.engines.insert(engine_id, registration);
    save_registry(&path, &registry)?;

    Ok(build_status(engine_id, registry.engines.get(&engine_id)))
}

/// エンジンの導入の進み具合を知らせるイベントの名前。中身は `EngineInstallProgress`。
pub const ENGINE_INSTALL_PROGRESS_EVENT: &str = "engine-install-progress";

/// 導入の進み具合を知らせる。知らせられなくても導入は続ける。
fn emit_install_progress(
    app: &AppHandle,
    engine_id: EngineId,
    stage: EngineInstallStage,
    done: u64,
    total: u64,
) {
    let payload = EngineInstallProgress {
        engine_id,
        stage,
        done,
        total,
    };
    if let Err(error) = app.emit(ENGINE_INSTALL_PROGRESS_EVENT, payload) {
        log::warn!("エンジンの導入の進み具合を知らせられません: {error}");
    }
}

/// ZIP をエンジンごとの新しいフォルダへ展開して登録する。失敗したら展開先を消す。
/// 呼び出し側が登録簿の排他を取っていること。
fn install_archive_from_path(
    app: &AppHandle,
    engine_id: EngineId,
    archive_path: &Path,
    source: &str,
) -> AppResult<EngineStatus> {
    let extraction_root = installer::create_unique_extraction_root(&tools_dir(app, engine_id)?)?;

    let result = (|| -> AppResult<EngineStatus> {
        installer::extract_archive(
            archive_path,
            &extraction_root,
            DEFAULT_EXTRACT_LIMITS,
            &mut |done, total| {
                emit_install_progress(app, engine_id, EngineInstallStage::Extracting, done, total)
            },
        )?;
        emit_install_progress(app, engine_id, EngineInstallStage::Registering, 0, 0);

        let path = registry_path(app)?;
        let mut registry = load_registry(&path)?;
        let mut registration = registry::infer_registration(engine_id, &extraction_root)?;
        registration.source = source.into();
        registry.engines.insert(engine_id, registration);
        save_registry(&path, &registry)?;
        Ok(build_status(engine_id, registry.engines.get(&engine_id)))
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&extraction_root);
    }

    result
}

pub fn import_engine_archive(
    app: &AppHandle,
    engine_id: EngineId,
    archive_path: &str,
) -> AppResult<EngineStatus> {
    let registry_lock = app.state::<RegistryLock>();
    let _guard = lock_registry(&registry_lock)?;
    let archive_path = Path::new(archive_path);
    if !archive_path.is_file() {
        return Err(AppError::Message(
            "指定された ZIP ファイルが見つかりません。".into(),
        ));
    }

    install_archive_from_path(app, engine_id, archive_path, "archive")
}

pub fn install_engine_from_release(
    app: &AppHandle,
    option: EngineInstallOption,
) -> AppResult<EngineStatus> {
    emit_install_progress(app, option.engine_id, EngineInstallStage::Verifying, 0, 0);
    let client = installer::github_client(Duration::from_secs(15 * 60))?;
    let verified_option = installer::verify_release_option(&client, &option)?;
    let engine_id = verified_option.engine_id;
    let total = verified_option.size;
    let downloads_root = tools_dir(app, verified_option.engine_id)?.join("_downloads");
    fs::create_dir_all(&downloads_root)?;
    // 一時フォルダは関数を抜けるときに(失敗時も)消える。
    let temp_dir = tempfile::Builder::new()
        .prefix("release-")
        .tempdir_in(downloads_root)?;
    let archive_path = temp_dir.path().join("engine.zip");
    emit_install_progress(app, engine_id, EngineInstallStage::Downloading, 0, total);
    installer::download_release_archive(&client, &verified_option, &archive_path, &mut |done| {
        emit_install_progress(app, engine_id, EngineInstallStage::Downloading, done, total)
    })?;

    let registry_lock = app.state::<RegistryLock>();
    let _guard = lock_registry(&registry_lock)?;

    install_archive_from_path(app, engine_id, &archive_path, "download")
}

pub fn clear_engine_registration(
    app: &AppHandle,
    engine_id: EngineId,
) -> AppResult<Vec<EngineStatus>> {
    {
        let registry_lock = app.state::<RegistryLock>();
        let _guard = lock_registry(&registry_lock)?;
        let path = registry_path(app)?;
        let mut registry = load_registry(&path)?;
        registry.engines.remove(&engine_id);
        save_registry(&path, &registry)?;
    }

    get_engine_statuses(app)
}

/// 超解像ジョブの状態を知らせるイベントの名前。中身は `EnhanceStatusEvent`。
pub const ENHANCE_STATUS_EVENT: &str = "enhance-status";
/// 1 回の要求で受け付けるページ数の上限(表示中と先読みの合計)。
const MAX_REQUEST_PAGES: usize = 64;

/// 超解像の結果を置くフォルダ(アプリのデータ領域の下)。
pub fn enhanced_cache_root(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_data_dir(app)?.join(ENHANCED_CACHE_DIR))
}

/// キャッシュの上限の設定の保存先。
fn cache_settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_data_dir(app)?.join("enhanced-cache.json"))
}

fn cache_info(usage: cache_store::CacheUsage, limit_bytes: u64) -> EnhanceCacheInfo {
    EnhanceCacheInfo {
        used_bytes: usage.bytes,
        file_count: usage.files,
        limit_bytes,
        min_limit_bytes: cache_store::MIN_LIMIT_BYTES,
        max_limit_bytes: cache_store::MAX_LIMIT_BYTES,
    }
}

/// キャッシュの使用量と上限。
pub fn get_enhance_cache_info(app: &AppHandle) -> AppResult<EnhanceCacheInfo> {
    let limit = cache_store::load_limit(&cache_settings_path(app)?);
    Ok(cache_info(
        cache_store::usage(&enhanced_cache_root(app)?)?,
        limit,
    ))
}

/// キャッシュの上限を保存し、超えている分を古いものから消す。
pub fn set_enhance_cache_limit(app: &AppHandle, limit_bytes: u64) -> AppResult<EnhanceCacheInfo> {
    cache_store::save_limit(&cache_settings_path(app)?, limit_bytes)?;
    let usage = cache_store::prune(&enhanced_cache_root(app)?, limit_bytes)?;
    Ok(cache_info(usage, limit_bytes))
}

/// キャッシュをすべて消す。処理中のジョブは続き、終わった結果はまた置かれる。
pub fn clear_enhance_cache(app: &AppHandle) -> AppResult<EnhanceCacheInfo> {
    let limit = cache_store::load_limit(&cache_settings_path(app)?);
    Ok(cache_info(
        cache_store::clear(&enhanced_cache_root(app)?)?,
        limit,
    ))
}

/// 新しい結果を置いた後に、上限を超えた分を古いものから消す。失敗しても処理の結果は変えない。
fn prune_after_job(app: &AppHandle, cache_root: &Path) {
    let result = cache_settings_path(app)
        .map(|path| cache_store::load_limit(&path))
        .and_then(|limit| cache_store::prune(cache_root, limit));
    if let Err(error) = result {
        log::warn!("超解像キャッシュの整理に失敗しました: {error}");
    }
}

/// 登録簿からエンジンの登録内容を読む。未登録なら `None`。
fn load_registration(
    app: &AppHandle,
    engine_id: EngineId,
) -> AppResult<Option<EngineRegistration>> {
    let registry_lock = app.state::<RegistryLock>();
    let _guard = lock_registry(&registry_lock)?;
    let mut registry = load_registry(&registry_path(app)?)?;
    Ok(registry.engines.remove(&engine_id))
}

/// キューの本番の実行。開いた本からページを読み、登録されたエンジンで処理する。
struct AppExecutor {
    app: AppHandle,
}

impl JobExecutor for AppExecutor {
    fn run(&self, job: &JobSpec, cancel: &AtomicBool) -> JobOutcome {
        // 閉じられた本のジョブは取り消し扱いにする。
        let Some(source) = self.app.state::<BookCache>().get(&job.book_id) else {
            return JobOutcome::Cancelled;
        };
        let Some(page) = source.pages().get(job.index) else {
            return JobOutcome::Failed("そのページはありません。".into());
        };
        let page = page.clone();
        let revision = source.page_revision(job.index);
        let prepared = (|| -> AppResult<_> {
            let cache_root = enhanced_cache_root(&self.app)?;
            let cached = cache_entry_path(
                &cache_root,
                &job.book_id,
                job.index,
                &page,
                revision,
                &job.key,
            )?;
            if cached.is_file() {
                return Ok(None);
            }
            let bytes = source.read_page(job.index)?;
            let registration = load_registration(&self.app, job.params.engine)?;
            Ok(Some((cache_root, bytes, registration)))
        })();
        match prepared {
            Ok(None) => JobOutcome::Done,
            Ok(Some((cache_root, bytes, registration))) => {
                let outcome = enhance_page(
                    registration.as_ref(),
                    &job.params,
                    &PageInput {
                        book_id: &job.book_id,
                        index: job.index,
                        key: &job.key,
                        page: &page,
                        revision,
                        bytes: &bytes,
                    },
                    &cache_root,
                    ENHANCE_TIMEOUT,
                    cancel,
                );
                if matches!(outcome, JobOutcome::Done) {
                    prune_after_job(&self.app, &cache_root);
                }
                outcome
            }
            Err(error) => JobOutcome::Failed(error.to_string()),
        }
    }
}

/// キューを起動する(`setup` で 1 回)。ジョブの状態は `ENHANCE_STATUS_EVENT` でフロントへ流す。
pub fn start_queue(app: &AppHandle) -> EnhanceQueue {
    let events = app.clone();
    EnhanceQueue::start(
        AppExecutor { app: app.clone() },
        Box::new(move |spec, state| {
            let (state, message) = match state {
                JobState::Queued => (EnhanceJobState::Queued, None),
                JobState::Running => (EnhanceJobState::Running, None),
                JobState::Done => (EnhanceJobState::Done, None),
                JobState::Failed(message) => {
                    log::warn!(
                        "超解像に失敗しました({}/{}): {message}",
                        spec.book_id,
                        spec.index
                    );
                    (EnhanceJobState::Failed, Some(message.clone()))
                }
                JobState::Cancelled => (EnhanceJobState::Cancelled, None),
            };
            let payload = EnhanceStatusEvent {
                book_id: spec.book_id.clone(),
                index: spec.index,
                key: spec.key.clone(),
                state,
                message,
            };
            if let Err(error) = events.emit(ENHANCE_STATUS_EVENT, payload) {
                log::warn!("超解像の状態を知らせられません: {error}");
            }
        }),
    )
}

/// 超解像の要求の受付番号を取る。command が要求を受け取った時点で取り、`request_enhancement` に渡す。
pub fn enhancement_ticket(app: &AppHandle) -> u64 {
    app.state::<EnhanceQueue>().ticket()
}

/// 要求を受ける前の下調べ。設定を検証して版(`key`)を決め、本が開いていてエンジンが登録済みかを確かめる。
fn prepare_request(
    app: &AppHandle,
    book_id: &str,
    settings: EnhanceSettings,
) -> AppResult<(EnhanceParams, String, Arc<dyn PageSource>)> {
    let params = EnhanceParams {
        engine: settings.engine,
        model: settings.model,
        scale: settings.scale,
        denoise: settings.denoise,
    };
    let key = cache_key(&params)?;
    let source = app
        .state::<BookCache>()
        .get(book_id)
        .ok_or(AppError::BookNotOpen)?;
    if load_registration(app, params.engine)?.is_none() {
        return Err(AppError::Message(not_registered(params.engine)));
    }
    Ok((params, key, source))
}

/// ページを処理済み(結果がキャッシュにある)と未処理に分ける。無いページ番号は捨てる。
/// 処理済みの結果は使うので、上限を超えたときに消える順を後ろへ回す。
fn partition_cached(
    source: &dyn PageSource,
    cache_root: &Path,
    book_id: &str,
    key: &str,
    indices: impl IntoIterator<Item = usize>,
    ready: &mut Vec<usize>,
) -> AppResult<Vec<usize>> {
    let pages = source.pages();
    let mut pending = Vec::new();
    for index in indices {
        let Some(page) = pages.get(index) else {
            continue;
        };
        let revision = source.page_revision(index);
        let cached = cache_entry_path(cache_root, book_id, index, page, revision, key)?;
        if cached.is_file() {
            cache_store::touch(&cached);
            if !ready.contains(&index) {
                ready.push(index);
            }
        } else {
            pending.push(index);
        }
    }
    Ok(pending)
}

/// 表示中・先読みのページの超解像を要求する。処理済みのページは積まずに `ready` で返す。
/// この本のほかのページと、ほかの本の表示中・先読みのジョブは取り消す。
/// 一括事前処理のジョブを実行中なら、打ち切って表示中のページを先に処理する。
/// `ticket`(`enhancement_ticket`)を取った後に本が閉じられた・より新しい要求が来たときは、
/// 何も積まない(新しいほうの要求が顔ぶれを決める)。
pub fn request_enhancement(
    app: &AppHandle,
    ticket: u64,
    book_id: &str,
    visible: &[usize],
    prefetch: &[usize],
    settings: EnhanceSettings,
) -> AppResult<EnhanceRequestResult> {
    if visible.len() + prefetch.len() > MAX_REQUEST_PAGES {
        return Err(AppError::Message(
            "一度に要求できるページ数を超えています。".into(),
        ));
    }
    let (params, key, source) = prepare_request(app, book_id, settings)?;
    let cache_root = enhanced_cache_root(app)?;
    let mut ready = Vec::new();
    let visible = partition_cached(
        source.as_ref(),
        &cache_root,
        book_id,
        &key,
        visible.iter().copied(),
        &mut ready,
    )?;
    let prefetch = partition_cached(
        source.as_ref(),
        &cache_root,
        book_id,
        &key,
        prefetch.iter().copied(),
        &mut ready,
    )?;

    app.state::<EnhanceQueue>()
        .request_pages(ticket, book_id, &key, &params, &visible, &prefetch);
    Ok(EnhanceRequestResult { key, ready })
}

/// 本の全ページの一括事前処理を始める(やめた後に呼べば続きから)。処理済みのページは積まずに `ready` で返し、
/// 残りを一括の優先度(表示中・先読みより後)でページ順に積む。
pub fn start_batch_enhancement(
    app: &AppHandle,
    ticket: u64,
    book_id: &str,
    settings: EnhanceSettings,
) -> AppResult<BatchEnhanceResult> {
    let (params, key, source) = prepare_request(app, book_id, settings)?;
    let cache_root = enhanced_cache_root(app)?;
    let total = source.pages().len();
    let mut ready = Vec::new();
    let pending = partition_cached(
        source.as_ref(),
        &cache_root,
        book_id,
        &key,
        0..total,
        &mut ready,
    )?;
    if !app
        .state::<EnhanceQueue>()
        .enqueue_batch(ticket, book_id, &key, &params, &pending)
    {
        return Err(AppError::BookNotOpen);
    }
    Ok(BatchEnhanceResult { key, total, ready })
}

/// 本の一括事前処理をやめる。表示中・先読みのページの処理は続ける。
pub fn cancel_batch_enhancement(app: &AppHandle, book_id: &str) {
    app.state::<EnhanceQueue>().cancel_batch(book_id);
}

/// 本の超解像ジョブをすべて取り消す(本を閉じたとき・AI を切ったとき)。
pub fn cancel_enhancement(app: &AppHandle, book_id: &str) {
    app.state::<EnhanceQueue>().cancel_book(book_id);
}
