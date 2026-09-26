//! 登録フォルダの追加・削除・一覧と、登録フォルダ配下のフォルダ一覧。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::app_error::{AppError, AppResult};
use crate::commands::{run_blocking, search};
use crate::models::{DirectoryListing, EntryKind, LibrarySource};
use crate::services::library;
use crate::services::store::{now_millis, SharedStore, SourceRecord};
use crate::services::thumbs::Thumbs;

/// 登録フォルダを登録した順に返す。
#[tauri::command]
pub async fn list_sources(app: AppHandle) -> AppResult<Vec<LibrarySource>> {
    run_blocking(move || {
        let sources = app
            .state::<SharedStore>()
            .with(&app, |store| store.sources())?;
        Ok(sources.iter().map(to_library_source).collect())
    })
    .await
}

/// フォルダを登録する。パスは正規化して記録し、登録済みのフォルダなら既存の登録を返す。
#[tauri::command]
pub async fn add_source(app: AppHandle, path: String) -> AppResult<LibrarySource> {
    run_blocking(move || {
        let canonical = library::canonical_source_path(Path::new(&path))?;
        let path = canonical.to_string_lossy();
        let record = app
            .state::<SharedStore>()
            .with(&app, |store| store.add_source(&path, now_millis()))?;
        // 検索索引は裏で作る(登録済みのフォルダなら差分だけ読み直す)。
        search::spawn_index_refresh(app.clone(), Some(record.id));
        Ok(to_library_source(&record))
    })
    .await
}

/// 登録フォルダを外す。フォルダの中身には触れない。
#[tauri::command]
pub async fn remove_source(app: AppHandle, source_id: i64) -> AppResult<()> {
    run_blocking(move || {
        let removed = app
            .state::<SharedStore>()
            .with(&app, |store| store.remove_source(source_id))?;
        if removed {
            // 索引を保存し直せなくても登録は外れている。残った分は次の起動で捨てる。
            if let Err(error) = search::forget_source(&app, source_id) {
                log::warn!("検索索引から登録フォルダを外せませんでした: {error}");
            }
            Ok(())
        } else {
            Err(AppError::SourceNotFound)
        }
    })
    .await
}

/// 登録フォルダ配下のフォルダの中身を、フォルダと本に分けて返す。`path` が無ければ登録フォルダそのもの、
/// 相対パスなら登録フォルダからの相対とみなす。登録フォルダの外を指すパスは `outside_source` で拒否する。
#[tauri::command]
pub async fn list_directory(
    app: AppHandle,
    source_id: i64,
    path: Option<String>,
) -> AppResult<DirectoryListing> {
    run_blocking(move || {
        let source = app
            .state::<SharedStore>()
            .with(&app, |store| store.source(source_id))?
            .ok_or(AppError::SourceNotFound)?;
        let target = path.map(PathBuf::from).unwrap_or_default();
        let (root, dir) = library::resolve_within(Path::new(&source.path), &target)?;
        let mut entries = library::list_entries(&dir)?;
        // 並び替え・絞り込みに使う読書状態を、開いたことのある本にだけ添える。
        let reading = app.state::<SharedStore>().with(&app, |store| {
            store.reading_of_paths(
                entries
                    .iter()
                    .filter(|entry| entry.kind == EntryKind::Book)
                    .map(|entry| entry.path.as_str()),
            )
        })?;
        for entry in &mut entries {
            if let Some(record) = reading.get(&entry.path) {
                entry.page = Some(record.page);
                entry.page_count = record.page_count;
                entry.last_read_at = Some(record.last_read_at);
            }
        }
        // 表紙は prism スキームがこの ID で要求する。スキームは登録した本の場所しか読まない。
        let thumbs = app.state::<Thumbs>();
        for entry in &entries {
            if let Some(thumb_id) = &entry.thumb_id {
                thumbs.register(thumb_id.clone(), PathBuf::from(&entry.path));
            }
        }
        Ok(DirectoryListing {
            source_id,
            path: dir.to_string_lossy().to_string(),
            segments: library::relative_segments(&root, &dir),
            entries,
        })
    })
    .await
}

fn to_library_source(record: &SourceRecord) -> LibrarySource {
    let path = Path::new(&record.path);
    LibrarySource {
        id: record.id,
        path: record.path.clone(),
        display_path: library::display_path(path),
        name: library::source_name(path),
        added_at: record.added_at,
    }
}
