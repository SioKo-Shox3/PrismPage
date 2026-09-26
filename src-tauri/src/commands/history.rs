//! 読みかけ(ホーム)と履歴。どちらも開いた本の記録を最終閲覧の新しい順に返す。
//! 履歴の削除は記録を消すだけで、読む対象の元ファイルには触れない。

use std::fs;
use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::app_error::AppResult;
use crate::commands::run_blocking;
use crate::models::{BookFormat, HistoryEntry};
use crate::services::library;
use crate::services::source::book_id_for_path;
use crate::services::store::{HistoryRecord, SharedStore};
use crate::services::thumbs::Thumbs;

/// 読みかけ・履歴に一度に返す上限。
const LIST_LIMIT: usize = 500;

/// 読み終えていない本を最終閲覧の新しい順に返す。
#[tauri::command]
pub async fn list_continue_reading(app: AppHandle) -> AppResult<Vec<HistoryEntry>> {
    run_blocking(move || {
        let records = app
            .state::<SharedStore>()
            .with(&app, |store| store.continue_reading(LIST_LIMIT))?;
        Ok(to_entries(&app, &records))
    })
    .await
}

/// 開いた本を最終閲覧の新しい順に返す。
#[tauri::command]
pub async fn list_history(app: AppHandle) -> AppResult<Vec<HistoryEntry>> {
    run_blocking(move || {
        let records = app
            .state::<SharedStore>()
            .with(&app, |store| store.history(LIST_LIMIT))?;
        Ok(to_entries(&app, &records))
    })
    .await
}

/// 1 冊を履歴から消す(その本の読書位置も消える)。履歴に無い本なら何もしない。元ファイルには触れない。
#[tauri::command]
pub async fn remove_history_entry(app: AppHandle, item_id: i64) -> AppResult<()> {
    run_blocking(move || {
        app.state::<SharedStore>()
            .with(&app, |store| store.remove_history(item_id))?;
        Ok(())
    })
    .await
}

/// 履歴をすべて消す。元ファイルには触れない。
#[tauri::command]
pub async fn clear_history(app: AppHandle) -> AppResult<()> {
    run_blocking(move || {
        app.state::<SharedStore>()
            .with(&app, |store| store.clear_history())?;
        Ok(())
    })
    .await
}

/// 記録を画面向けの形にし、今も見つかる本の表紙を `prism` スキームで出せるよう登録する。
/// 登録するのはこのアプリで開いた本の場所だけ。
fn to_entries(app: &AppHandle, records: &[HistoryRecord]) -> Vec<HistoryEntry> {
    let thumbs = app.state::<Thumbs>();
    records
        .iter()
        .map(|record| {
            let entry = to_entry(record);
            if let Some(thumb_id) = &entry.thumb_id {
                thumbs.register(thumb_id.clone(), record.path.clone().into());
            }
            entry
        })
        .collect()
}

fn to_entry(record: &HistoryRecord) -> HistoryEntry {
    let place = BookPlace::of(&record.path, &record.title);
    HistoryEntry {
        item_id: record.item_id,
        name: place.name,
        title: record.title.clone(),
        path: record.path.clone(),
        format: format_of_kind(&record.kind),
        folder: place.folder,
        folder_path: place.folder_path,
        page: record.page,
        page_count: record.page_count,
        last_read_at: record.last_read_at,
        available: place.available,
        thumb_id: place.thumb_id,
    }
}

/// 記録してある本の場所から求める、画面に見せるファイル名・フォルダと、元が今も見つかるか・表紙の ID。
/// 表紙の ID は見つかる本だけが持つ。
pub(super) struct BookPlace {
    pub name: String,
    pub folder: String,
    pub folder_path: String,
    pub available: bool,
    pub thumb_id: Option<String>,
    /// 元の本の更新日時(UNIX エポックのミリ秒)。見つからなければ `None`。
    pub modified_at: Option<i64>,
}

impl BookPlace {
    pub fn of(path: &str, title: &str) -> Self {
        let path = Path::new(path);
        let metadata = fs::metadata(path).ok();
        let available = metadata.is_some();
        let parent = path.parent();
        Self {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| title.to_string()),
            folder: parent.map(library::source_name).unwrap_or_default(),
            folder_path: parent.map(library::display_path).unwrap_or_default(),
            available,
            thumb_id: available.then(|| book_id_for_path(path)),
            modified_at: metadata.as_ref().and_then(library::modified_millis),
        }
    }
}

/// `items.kind` の値を本の形式にする。画像ファイルから開いた本(`image`)は画像フォルダ。
pub(super) fn format_of_kind(kind: &str) -> BookFormat {
    match kind {
        "zip" => BookFormat::Zip,
        "epub" => BookFormat::Epub,
        "rar" => BookFormat::Rar,
        "pdf" => BookFormat::Pdf,
        _ => BookFormat::Folder,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn record(path: &Path, kind: &str) -> HistoryRecord {
        HistoryRecord {
            item_id: 1,
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            title: "第1巻".to_string(),
            page_count: Some(10),
            page: 3,
            last_read_at: 5,
        }
    }

    #[test]
    fn store_history_entries_carry_the_folder_and_a_thumb_only_for_existing_books() {
        let dir = tempfile::tempdir().unwrap();
        let shelf = dir.path().join("漫画");
        fs::create_dir(&shelf).unwrap();
        let book = shelf.join("第1巻.cbz");
        fs::write(&book, b"zip").unwrap();
        let book = fs::canonicalize(book).unwrap();

        let entry = to_entry(&record(&book, "zip"));
        assert_eq!(entry.name, "第1巻.cbz");
        assert_eq!(entry.folder, "漫画");
        assert!(!entry.folder_path.starts_with(r"\\?\"));
        assert_eq!(entry.format, BookFormat::Zip);
        assert!(entry.available);
        assert_eq!(entry.thumb_id, Some(book_id_for_path(&book)));

        let missing = to_entry(&record(&book.with_file_name("無い.cbz"), "image"));
        assert!(!missing.available);
        assert_eq!(missing.thumb_id, None);
        assert_eq!(missing.format, BookFormat::Folder);
    }
}
