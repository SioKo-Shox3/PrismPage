//! 1 ページの超解像。ページの画像を作業フォルダへ書き出し、登録されたエンジンの実行ファイルで処理して、
//! 結果をキャッシュの置き場所へ移す。作業フォルダは成否に関わらず消す。元の本には触らない。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use crate::app_error::{AppError, AppResult};
use crate::models::{EngineId, EngineRegistration, PageInfo};

use super::cache::{cache_entry_path, EnhanceParams};
use super::queue::JobOutcome;
use super::runner::{hide_command_window, run_command_cancellable};

/// 1 ページの処理の制限時間。大きなページと遅い GPU でも収まる長さにする。
pub const ENHANCE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// キャッシュの置き場所の下に作る作業フォルダの名前(本 ID の形ではないのでキャッシュの項目と混ざらない)。
pub(super) const WORK_DIR: &str = ".work";
/// エラー文言に添える、エンジンの出力の長さの上限(文字数)。
const MAX_OUTPUT_IN_MESSAGE: usize = 400;

/// 処理する 1 ページ。
pub struct PageInput<'a> {
    pub book_id: &'a str,
    pub index: usize,
    pub key: &'a str,
    /// ページの情報(名前の拡張子で入力の形式を決め、名前と寸法をキャッシュの置き場所に含める)。
    pub page: &'a PageInfo,
    /// ページの中身の目印(`PageSource::page_revision`)。キャッシュの置き場所に含める。
    pub revision: Option<u64>,
    pub bytes: &'a [u8],
}

/// エンジンに渡す入力の拡張子。ncnn-vulkan 版が読めない形式(AVIF)は `None`。
fn input_extension(name: &str) -> Option<&'static str> {
    let (_, extension) = name.rsplit_once('.')?;
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "png" => Some("png"),
        "webp" => Some("webp"),
        "gif" => Some("gif"),
        "bmp" => Some("bmp"),
        _ => None,
    }
}

/// エンジンごとの引数。`-m` にはモデルのフォルダを渡す。
/// Real-CUGAN と waifu2x は登録されたモデルフォルダの隣にある、指定のモデル名のフォルダを使う。
/// Real-ESRGAN は登録されたモデルフォルダの中のモデルを `-n` で選ぶ。エンジンは `realesr-animevideov3` に
/// 倍率を付けた `realesr-animevideov3-x<倍率>.param/.bin` を読むので、その名前のファイルも探す(登録簿の判定と同じ)。
fn engine_args(
    registration: &EngineRegistration,
    params: &EnhanceParams,
    input: &Path,
    output: &Path,
) -> AppResult<Vec<std::ffi::OsString>> {
    let registered = PathBuf::from(&registration.model_path);
    let mut args: Vec<std::ffi::OsString> = vec![
        "-i".into(),
        input.into(),
        "-o".into(),
        output.into(),
        "-s".into(),
        params.scale.to_string().into(),
    ];
    match params.engine {
        EngineId::RealCugan | EngineId::Waifu2x => {
            let model_dir = registered
                .parent()
                .map(|parent| parent.join(&params.model))
                .filter(|dir| dir.is_dir())
                .ok_or_else(|| missing_model(params))?;
            let denoise = params
                .denoise
                .ok_or_else(|| AppError::Message("ノイズ除去の指定がありません。".into()))?;
            args.extend(["-n".into(), denoise.to_string().into()]);
            args.extend(["-m".into(), model_dir.into()]);
        }
        EngineId::RealEsrgan => {
            let has_pair = |name: &str| {
                registered.join(format!("{name}.param")).is_file()
                    && registered.join(format!("{name}.bin")).is_file()
            };
            if !has_pair(&params.model) && !has_pair(&format!("{}-x{}", params.model, params.scale))
            {
                return Err(missing_model(params));
            }
            args.extend(["-m".into(), registered.into()]);
            args.extend(["-n".into(), params.model.clone().into()]);
        }
    }
    Ok(args)
}

fn missing_model(params: &EnhanceParams) -> AppError {
    AppError::Message(format!(
        "{} のモデル「{}」が見つかりません。エンジンを登録し直してください。",
        params.engine.label(),
        params.model
    ))
}

fn clip_output(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    let clipped: String = text.chars().take(MAX_OUTPUT_IN_MESSAGE).collect();
    if clipped.len() < text.len() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

/// 1 ページを処理して `<cache_root>/<bookId>/<index>/<key>.png` に置く。取り消されたら `Cancelled`。
/// `registration` が `None` ならエンジン未登録として失敗にする。
pub fn enhance_page(
    registration: Option<&EngineRegistration>,
    params: &EnhanceParams,
    page: &PageInput<'_>,
    cache_root: &Path,
    timeout: Duration,
    cancel: &AtomicBool,
) -> JobOutcome {
    let destination =
        match cache_entry_path(
            cache_root,
            page.book_id,
            page.index,
            page.page,
            page.revision,
            page.key,
        ) {
            Ok(path) => path,
            Err(error) => return JobOutcome::Failed(error.to_string()),
        };
    // 前に処理した結果があればそのまま使う。
    if destination.is_file() {
        return JobOutcome::Done;
    }
    let Some(registration) = registration else {
        return JobOutcome::Failed(not_registered(params.engine));
    };
    let work_root = cache_root.join(WORK_DIR);
    let work = match fs::create_dir_all(&work_root).and_then(|_| {
        tempfile::Builder::new()
            .prefix("job-")
            .tempdir_in(&work_root)
    }) {
        Ok(work) => work,
        Err(error) => return JobOutcome::Failed(AppError::from(error).to_string()),
    };
    // 作業フォルダ(`work`)は抜けるときに消える。
    match run_in(
        registration,
        params,
        page,
        work.path(),
        &destination,
        timeout,
        cancel,
    ) {
        Ok(true) => JobOutcome::Done,
        Ok(false) => JobOutcome::Cancelled,
        Err(error) => JobOutcome::Failed(error.to_string()),
    }
}

/// 未登録のエンジンを使おうとしたときの文言。
pub fn not_registered(engine: EngineId) -> String {
    format!(
        "{} が登録されていません。設定の「AI 超解像」からエンジンを登録してください。",
        engine.label()
    )
}

fn run_in(
    registration: &EngineRegistration,
    params: &EnhanceParams,
    page: &PageInput<'_>,
    work: &Path,
    destination: &Path,
    timeout: Duration,
    cancel: &AtomicBool,
) -> AppResult<bool> {
    let executable = PathBuf::from(&registration.executable_path);
    if !executable.is_file() {
        return Err(AppError::Message(
            "AI エンジンの実行ファイルが見つかりません。エンジンを登録し直してください。".into(),
        ));
    }
    let extension = input_extension(&page.page.name)
        .ok_or_else(|| AppError::Message("この形式のページは超解像できません。".into()))?;
    let input = work.join(format!("in.{extension}"));
    let output = work.join("out.png");
    fs::write(&input, page.bytes)?;

    let mut command = Command::new(&executable);
    hide_command_window(&mut command)
        .args(engine_args(registration, params, &input, &output)?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let Some(result) = run_command_cancellable(
        &mut command,
        timeout,
        "AI エンジンの処理が時間内に終わりませんでした。",
        cancel,
    )?
    else {
        return Ok(false);
    };

    let produced = fs::metadata(&output)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false);
    if !result.status.success() || !produced {
        let detail = [clip_output(&result.stderr), clip_output(&result.stdout)]
            .into_iter()
            .find(|text| !text.is_empty())
            .unwrap_or_default();
        let code = result
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "不明".into());
        return Err(AppError::Message(format!(
            "AI エンジンの処理に失敗しました(終了コード {code})。{detail}"
        )));
    }

    // 書きかけの結果を置き場所に見せないよう、作業フォルダで書き終えたものを移す。
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&output, destination)?;
    Ok(true)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Instant;

    use super::*;

    const BOOK: &str = "0123456789abcdef";

    /// 偽のエンジン。`-i <入力> -o <出力>` を受け取り、入力を出力へ写して引数を `args.txt` に書く。
    const COPY_ENGINE: &str =
        "@echo off\r\necho %* > \"%~dp0args.txt\"\r\ncopy /Y \"%~2\" \"%~4\" > nul\r\n";
    /// 偽のエンジン。何も書かずに失敗する。
    const FAILING_ENGINE: &str = "@echo off\r\necho model load failed 1>&2\r\nexit /b 5\r\n";
    /// 偽のエンジン。長く動き続ける。
    const SLOW_ENGINE: &str = "@echo off\r\nping -n 60 127.0.0.1 > nul\r\n";

    struct Setup {
        dir: tempfile::TempDir,
        registration: EngineRegistration,
    }

    fn setup(script: &str) -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let engine_dir = dir.path().join("engine");
        fs::create_dir_all(engine_dir.join("models-se")).unwrap();
        fs::create_dir_all(engine_dir.join("models-pro")).unwrap();
        let executable = engine_dir.join("fake-engine.cmd");
        fs::write(&executable, script).unwrap();
        let registration = EngineRegistration {
            executable_path: executable.to_string_lossy().to_string(),
            model_name: Some("models-se".into()),
            model_path: engine_dir.join("models-se").to_string_lossy().to_string(),
            registered_at: 0,
            source: "manual".into(),
        };
        Setup { dir, registration }
    }

    fn params() -> EnhanceParams {
        EnhanceParams {
            engine: EngineId::RealCugan,
            model: "models-pro".into(),
            scale: 3,
            denoise: Some(-1),
        }
    }

    fn page_info(name: &str) -> &'static PageInfo {
        Box::leak(Box::new(PageInfo {
            name: name.into(),
            width: 10,
            height: 20,
            spread: None,
        }))
    }

    fn page<'a>(bytes: &'a [u8], name: &str) -> PageInput<'a> {
        PageInput {
            book_id: BOOK,
            index: 4,
            key: "real-cugan-x3",
            page: page_info(name),
            revision: Some(1),
            bytes,
        }
    }

    fn run(setup: &Setup, name: &str, cancel: &AtomicBool) -> JobOutcome {
        enhance_page(
            Some(&setup.registration),
            &params(),
            &page(b"image-bytes", name),
            &setup.dir.path().join("cache"),
            Duration::from_secs(60),
            cancel,
        )
    }

    fn work_is_empty(setup: &Setup) -> bool {
        let work = setup.dir.path().join("cache").join(WORK_DIR);
        !work.exists() || fs::read_dir(work).unwrap().next().is_none()
    }

    #[test]
    fn places_the_result_in_the_cache_and_passes_the_settings() {
        let setup = setup(COPY_ENGINE);
        let outcome = run(&setup, "sub/001.JPG", &AtomicBool::new(false));

        assert_eq!(outcome, JobOutcome::Done);
        let result = cache_entry_path(
            &setup.dir.path().join("cache"),
            BOOK,
            4,
            page_info("sub/001.JPG"),
            Some(1),
            "real-cugan-x3",
        )
        .unwrap();
        assert_eq!(fs::read(result).unwrap(), b"image-bytes");
        let args = fs::read_to_string(setup.dir.path().join("engine").join("args.txt")).unwrap();
        assert!(args.contains("in.jpg"), "{args}");
        assert!(args.contains("-s 3"), "{args}");
        assert!(args.contains("-n -1"), "{args}");
        assert!(args.contains("models-pro"), "{args}");
        assert!(work_is_empty(&setup));
    }

    /// 登録簿が `realesr-animevideov3` として登録するフォルダ(倍率付きのファイルだけを持つ)でも処理できる。
    #[test]
    fn real_esrgan_resolves_models_with_the_scale_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("models");
        fs::create_dir_all(&models).unwrap();
        for name in ["realesr-animevideov3-x2", "realesrgan-x4plus"] {
            fs::write(models.join(format!("{name}.param")), "").unwrap();
            fs::write(models.join(format!("{name}.bin")), "").unwrap();
        }
        let registration = EngineRegistration {
            executable_path: String::new(),
            model_name: Some("realesr-animevideov3".into()),
            model_path: models.to_string_lossy().to_string(),
            registered_at: 0,
            source: "manual".into(),
        };
        let esrgan = |model: &str, scale: u8| EnhanceParams {
            engine: EngineId::RealEsrgan,
            model: model.into(),
            scale,
            denoise: None,
        };
        let (input, output) = (Path::new("in.png"), Path::new("out.png"));

        let args = engine_args(
            &registration,
            &esrgan("realesr-animevideov3", 2),
            input,
            output,
        )
        .unwrap();
        assert!(args.iter().any(|arg| arg == "realesr-animevideov3"));
        assert!(engine_args(
            &registration,
            &esrgan("realesrgan-x4plus", 4),
            input,
            output
        )
        .is_ok());
        // 3 倍のファイルは無い。
        assert!(engine_args(
            &registration,
            &esrgan("realesr-animevideov3", 3),
            input,
            output
        )
        .is_err());
    }

    #[test]
    fn engine_failures_report_the_output_and_leave_no_files() {
        let setup = setup(FAILING_ENGINE);
        let outcome = run(&setup, "1.png", &AtomicBool::new(false));

        let JobOutcome::Failed(message) = outcome else {
            panic!("{outcome:?}");
        };
        assert!(message.contains("終了コード 5"), "{message}");
        assert!(message.contains("model load failed"), "{message}");
        assert!(!setup.dir.path().join("cache").join(BOOK).exists());
        assert!(work_is_empty(&setup));
    }

    #[test]
    fn cancelling_kills_the_engine_and_cleans_up() {
        let setup = setup(SLOW_ENGINE);
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let outcome = run(&setup, "1.png", &cancel);
        setter.join().unwrap();

        assert_eq!(outcome, JobOutcome::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(20));
        assert!(!setup.dir.path().join("cache").join(BOOK).exists());
        assert!(work_is_empty(&setup));
    }

    #[test]
    fn unregistered_engines_missing_models_and_avif_pages_fail_with_a_message() {
        let setup = setup(COPY_ENGINE);
        let cache = setup.dir.path().join("cache");
        let cancel = AtomicBool::new(false);

        let JobOutcome::Failed(message) = enhance_page(
            None,
            &params(),
            &page(b"x", "1.png"),
            &cache,
            Duration::from_secs(60),
            &cancel,
        ) else {
            panic!();
        };
        assert!(message.contains("登録されていません"), "{message}");

        let mut nose = params();
        nose.model = "models-nose".into();
        nose.scale = 2;
        nose.denoise = Some(0);
        let JobOutcome::Failed(message) = enhance_page(
            Some(&setup.registration),
            &nose,
            &page(b"x", "1.png"),
            &cache,
            Duration::from_secs(60),
            &cancel,
        ) else {
            panic!();
        };
        assert!(message.contains("models-nose"), "{message}");

        assert!(matches!(
            run(&setup, "1.avif", &cancel),
            JobOutcome::Failed(_)
        ));
        assert!(!cache.join(BOOK).exists());
        assert!(work_is_empty(&setup));
    }
}
