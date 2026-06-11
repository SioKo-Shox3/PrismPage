use tauri::{AppHandle, Manager};

use crate::app_error::AppError;
use crate::services::library as library_service;
use crate::state::OpenedEpubPaths;

#[tauri::command]
pub fn import_epub_from_path(app: AppHandle, path: String) -> Result<crate::models::ImportedBook, String> {
    library_service::import_epub_from_path(&app, &path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_book_base64(app: AppHandle, id: String) -> Result<String, String> {
    library_service::read_book_base64(&app, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn take_pending_opened_epubs(app: AppHandle) -> Result<Vec<String>, String> {
    let pending_paths = app.state::<OpenedEpubPaths>();
    let mut guard = pending_paths
        .0
        .lock()
        .map_err(|_| AppError::Message("EPUB 起動パスの排他制御に失敗しました。".into()).to_string())?;

    Ok(guard.drain(..).collect())
}
