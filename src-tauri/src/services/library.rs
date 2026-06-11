use std::fs;
use std::path::PathBuf;

use base64::prelude::{BASE64_STANDARD, Engine};
use tauri::AppHandle;
use uuid::Uuid;

use crate::app_error::{AppError, AppResult};
use crate::models::ImportedBook;
use crate::services::app_data_dir;

fn library_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let path = app_data_dir(app)?.join("library");
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn import_epub_from_path(app: &AppHandle, path: &str) -> AppResult<ImportedBook> {
    let source_path = PathBuf::from(path);

    if !source_path.is_file() {
        return Err(AppError::Message("選択した EPUB ファイルが見つかりません。".into()));
    }

    let source_path = fs::canonicalize(&source_path)?;

    if !source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
    {
        return Err(AppError::Message("EPUB ファイルだけを取り込めます。".into()));
    }

    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::Message("EPUB ファイル名を解決できませんでした。".into()))?
        .to_string();

    let id = Uuid::new_v4().to_string();
    let destination_path = library_dir(app)?.join(format!("{id}.epub"));
    fs::copy(&source_path, &destination_path)?;

    let size = destination_path.metadata()?.len();

    Ok(ImportedBook {
        id,
        file_name,
        source_path: source_path.to_string_lossy().to_string(),
        stored_path: destination_path.to_string_lossy().to_string(),
        size,
    })
}

pub fn read_book_base64(app: &AppHandle, id: &str) -> AppResult<String> {
    Uuid::parse_str(id)
        .map_err(|_| AppError::Message("書籍 ID の形式が不正です。".into()))?;

    let file_path = library_dir(app)?.join(format!("{id}.epub"));

    if !file_path.exists() {
        return Err(AppError::Message("指定された EPUB はライブラリに存在しません。".into()));
    }

    let bytes = fs::read(file_path)?;
    Ok(BASE64_STANDARD.encode(bytes))
}
