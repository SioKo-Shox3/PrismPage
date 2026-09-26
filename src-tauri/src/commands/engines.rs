use tauri::AppHandle;

use crate::app_error::AppResult;
use crate::commands::run_blocking;
use crate::models::{
    BatchEnhanceResult, EngineCandidate, EngineId, EngineInstallOption,
    EngineInstallOptionsResponse, EngineStatus, EnhanceCacheInfo, EnhanceRequestResult,
    EnhanceSettings,
};
use crate::services::engines as engine_service;

// 状態確認も実行ファイルの起動(ヘルスチェック)を含むため、すべて裏のスレッドで実行する。

#[tauri::command]
pub async fn get_engine_statuses(app: AppHandle) -> AppResult<Vec<EngineStatus>> {
    run_blocking(move || engine_service::get_engine_statuses(&app)).await
}

#[tauri::command]
pub async fn detect_engine_candidates() -> AppResult<Vec<EngineCandidate>> {
    run_blocking(engine_service::detect_engine_candidates).await
}

#[tauri::command]
pub async fn get_engine_install_options() -> AppResult<EngineInstallOptionsResponse> {
    run_blocking(engine_service::get_engine_install_options).await
}

#[tauri::command]
pub async fn register_engine_directory(
    app: AppHandle,
    engine_id: EngineId,
    directory_path: String,
) -> AppResult<EngineStatus> {
    run_blocking(move || {
        engine_service::register_engine_directory(&app, engine_id, &directory_path)
    })
    .await
}

#[tauri::command]
pub async fn import_engine_archive(
    app: AppHandle,
    engine_id: EngineId,
    archive_path: String,
) -> AppResult<EngineStatus> {
    run_blocking(move || engine_service::import_engine_archive(&app, engine_id, &archive_path))
        .await
}

#[tauri::command]
pub async fn install_engine_from_release(
    app: AppHandle,
    option: EngineInstallOption,
) -> AppResult<EngineStatus> {
    run_blocking(move || engine_service::install_engine_from_release(&app, option)).await
}

#[tauri::command]
pub async fn clear_engine_registration(
    app: AppHandle,
    engine_id: EngineId,
) -> AppResult<Vec<EngineStatus>> {
    run_blocking(move || engine_service::clear_engine_registration(&app, engine_id)).await
}

/// 表示中・先読みのページの超解像を要求する。処理の進み具合はイベント `enhance-status` で届く。
/// 受付番号は裏のスレッドへ渡す前に取る(待っている間に本が閉じられたら、その要求は積まない)。
#[tauri::command]
pub async fn request_enhancement(
    app: AppHandle,
    book_id: String,
    visible: Vec<usize>,
    prefetch: Vec<usize>,
    settings: EnhanceSettings,
) -> AppResult<EnhanceRequestResult> {
    let ticket = engine_service::enhancement_ticket(&app);
    run_blocking(move || {
        engine_service::request_enhancement(&app, ticket, &book_id, &visible, &prefetch, settings)
    })
    .await
}

/// 本の全ページの一括事前処理を始める(やめた後に呼べば処理済みを飛ばして続きから)。
/// 表示中・先読みのページが常に先に処理される。進み具合はイベント `enhance-status` で届く。
#[tauri::command]
pub async fn start_batch_enhancement(
    app: AppHandle,
    book_id: String,
    settings: EnhanceSettings,
) -> AppResult<BatchEnhanceResult> {
    let ticket = engine_service::enhancement_ticket(&app);
    run_blocking(move || engine_service::start_batch_enhancement(&app, ticket, &book_id, settings))
        .await
}

/// 本の一括事前処理をやめる(表示中・先読みのページの処理は続ける)。
#[tauri::command]
pub async fn cancel_batch_enhancement(app: AppHandle, book_id: String) -> AppResult<()> {
    engine_service::cancel_batch_enhancement(&app, &book_id);
    Ok(())
}

/// 本の超解像ジョブをすべて取り消し、実行中のエンジンを終わらせる。
#[tauri::command]
pub async fn cancel_enhancement(app: AppHandle, book_id: String) -> AppResult<()> {
    engine_service::cancel_enhancement(&app, &book_id);
    Ok(())
}

/// 超解像キャッシュの使用量と上限を返す。
#[tauri::command]
pub async fn get_enhance_cache_info(app: AppHandle) -> AppResult<EnhanceCacheInfo> {
    run_blocking(move || engine_service::get_enhance_cache_info(&app)).await
}

/// 超解像キャッシュの上限を変え、超えている分を古いものから消す。
#[tauri::command]
pub async fn set_enhance_cache_limit(
    app: AppHandle,
    limit_bytes: u64,
) -> AppResult<EnhanceCacheInfo> {
    run_blocking(move || engine_service::set_enhance_cache_limit(&app, limit_bytes)).await
}

/// 超解像キャッシュをすべて消す。
#[tauri::command]
pub async fn clear_enhance_cache(app: AppHandle) -> AppResult<EnhanceCacheInfo> {
    run_blocking(move || engine_service::clear_enhance_cache(&app)).await
}
