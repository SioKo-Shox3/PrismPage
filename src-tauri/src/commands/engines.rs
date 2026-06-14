use tauri::AppHandle;

use crate::models::{
    EngineCandidate, EngineId, EngineInstallOption, EngineInstallOptionsResponse, EngineStatus,
    EnhanceBookAssetImageRequest, EnhanceBookAssetImageResponse, EnhanceBookImageRequest,
    EnhanceBookImageResponse, EnhanceImageRequest, EnhanceImageResponse,
    ReadEnhancedBookImageRequest, ScanBookImagesRequest, ScanBookImagesResponse,
};
use crate::services::engines as engine_service;
use crate::services::library as library_service;

#[tauri::command]
pub fn get_engine_statuses(app: AppHandle) -> Result<Vec<EngineStatus>, String> {
    engine_service::get_engine_statuses(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn detect_engine_candidates() -> Result<Vec<EngineCandidate>, String> {
    engine_service::detect_engine_candidates().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_engine_install_options() -> Result<EngineInstallOptionsResponse, String> {
    engine_service::get_engine_install_options().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn register_engine_directory(
    app: AppHandle,
    engine_id: EngineId,
    directory_path: String,
) -> Result<EngineStatus, String> {
    engine_service::register_engine_directory(&app, engine_id, &directory_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_engine_archive(
    app: AppHandle,
    engine_id: EngineId,
    archive_path: String,
) -> Result<EngineStatus, String> {
    engine_service::import_engine_archive(&app, engine_id, &archive_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn install_engine_from_release(
    app: AppHandle,
    option: EngineInstallOption,
) -> Result<EngineStatus, String> {
    engine_service::install_engine_from_release(&app, option).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_engine_registration(
    app: AppHandle,
    engine_id: EngineId,
) -> Result<Vec<EngineStatus>, String> {
    engine_service::clear_engine_registration(&app, engine_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn enhance_image(
    app: AppHandle,
    request: EnhanceImageRequest,
) -> Result<EnhanceImageResponse, String> {
    engine_service::enhance_image(&app, request).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn enhance_book_image(
    app: AppHandle,
    request: EnhanceBookImageRequest,
) -> Result<EnhanceBookImageResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        engine_service::enhance_book_image(&app, request)
    })
    .await
    .map_err(|error| format!("AI 高精細化処理の実行に失敗しました: {error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn scan_book_images(
    app: AppHandle,
    request: ScanBookImagesRequest,
) -> Result<ScanBookImagesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || library_service::scan_book_images(&app, request))
        .await
        .map_err(|error| format!("EPUB 画像一覧の取得に失敗しました: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn enhance_book_asset_image(
    app: AppHandle,
    request: EnhanceBookAssetImageRequest,
) -> Result<EnhanceBookAssetImageResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        engine_service::enhance_book_asset_image(&app, request)
    })
    .await
    .map_err(|error| format!("EPUB 画像のAI高精細化処理に失敗しました: {error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_enhanced_book_image(
    app: AppHandle,
    request: ReadEnhancedBookImageRequest,
) -> Result<Option<String>, String> {
    engine_service::read_enhanced_book_image(&app, request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_enhancement_jobs(app: AppHandle, reader_session_id: String) -> Result<(), String> {
    engine_service::cancel_enhancement_jobs(&app, &reader_session_id)
        .map_err(|error| error.to_string())
}
