use tauri::AppHandle;

use crate::services::library as library_service;

#[tauri::command]
pub fn import_epub_from_path(app: AppHandle, path: String) -> Result<crate::models::ImportedBook, String> {
    library_service::import_epub_from_path(&app, &path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn read_book_base64(app: AppHandle, id: String) -> Result<String, String> {
    library_service::read_book_base64(&app, &id).map_err(|error| error.to_string())
}
