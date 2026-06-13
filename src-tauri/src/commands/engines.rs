use tauri::AppHandle;

use crate::models::{
    EngineCandidate, EngineId, EngineInstallOption, EngineInstallOptionsResponse, EngineStatus,
    EnhanceImageRequest, EnhanceImageResponse,
};
use crate::services::engines as engine_service;

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
