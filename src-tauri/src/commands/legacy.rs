//! 旧バージョンのデータ(アプリのデータ領域の `library/` フォルダ)の確認と削除。

use tauri::AppHandle;

use crate::app_error::AppResult;
use crate::commands::run_blocking;
use crate::models::LegacyLibraryDir;
use crate::services::{self, legacy};

/// 旧 `library/` フォルダがあれば、その場所・ファイル数・合計サイズを返す。無ければ `None`。
#[tauri::command]
pub async fn get_legacy_library_dir(app: AppHandle) -> AppResult<Option<LegacyLibraryDir>> {
    run_blocking(move || {
        let data_dir = services::app_data_dir(&app)?;
        Ok(legacy::inspect(&data_dir)?.map(to_model))
    })
    .await
}

/// 旧 `library/` フォルダを中身ごと消す。ほかのデータには触れない。
#[tauri::command]
pub async fn delete_legacy_library_dir(app: AppHandle) -> AppResult<()> {
    run_blocking(move || {
        let data_dir = services::app_data_dir(&app)?;
        legacy::remove(&data_dir)?;
        Ok(())
    })
    .await
}

fn to_model(summary: legacy::LegacyDirSummary) -> LegacyLibraryDir {
    LegacyLibraryDir {
        path: summary.path.to_string_lossy().into_owned(),
        file_count: summary.file_count,
        total_bytes: summary.total_bytes,
    }
}
