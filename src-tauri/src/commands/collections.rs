//! 本棚とお気に入り。どちらも本の場所を参照するだけで、読む対象の元ファイルには触れない。
//! 本は場所(パス)で指す。記録してある場所と一致すればその本の行を使うので、元が見つからなくなった本も
//! 外したり付け外ししたりできる。一致しなければ `open_book` と同じ規則で正規化した場所を探し、入れるときは行を作る。

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::app_error::AppResult;
use crate::commands::history::{format_of_kind, BookPlace};
use crate::commands::run_blocking;
use crate::models::{BookCollections, BookFormat, CollectionBook, Shelf};
use crate::services::library;
use crate::services::store::{now_millis, CollectionRecord, SharedStore, ShelfRecord, Store};
use crate::services::thumbs::Thumbs;

/// 本棚を並び順に返す。
#[tauri::command]
pub async fn list_shelves(app: AppHandle) -> AppResult<Vec<Shelf>> {
    run_blocking(move || {
        let records = app
            .state::<SharedStore>()
            .with(&app, |store| store.shelves())?;
        Ok(records.iter().map(to_shelf).collect())
    })
    .await
}

/// 本棚を作る。名前は前後の空白を除き、空・長すぎる名前は失敗する。
#[tauri::command]
pub async fn create_shelf(app: AppHandle, name: String) -> AppResult<Shelf> {
    run_blocking(move || {
        let record = app
            .state::<SharedStore>()
            .with(&app, |store| store.create_shelf(&name, now_millis()))?;
        Ok(to_shelf(&record))
    })
    .await
}

/// 本棚の名前を変える。
#[tauri::command]
pub async fn rename_shelf(app: AppHandle, shelf_id: i64, name: String) -> AppResult<Shelf> {
    run_blocking(move || {
        let record = app
            .state::<SharedStore>()
            .with(&app, |store| store.rename_shelf(shelf_id, &name))?;
        Ok(to_shelf(&record))
    })
    .await
}

/// 本棚を消す。入っていた本の記録(読書位置・お気に入り)と元ファイルには触れない。
#[tauri::command]
pub async fn delete_shelf(app: AppHandle, shelf_id: i64) -> AppResult<()> {
    run_blocking(move || {
        app.state::<SharedStore>()
            .with(&app, |store| store.delete_shelf(shelf_id))
    })
    .await
}

/// 本棚の本を入れた順に返す。元が見つからなくなった本も `available: false` で返す(自動では外さない)。
#[tauri::command]
pub async fn list_shelf_books(app: AppHandle, shelf_id: i64) -> AppResult<Vec<CollectionBook>> {
    run_blocking(move || {
        let records = app
            .state::<SharedStore>()
            .with(&app, |store| store.shelf_books(shelf_id))?;
        Ok(to_books(&app, &records))
    })
    .await
}

/// お気に入りの本を入れた時刻の新しい順に返す。元が見つからなくなった本も `available: false` で返す。
#[tauri::command]
pub async fn list_favorites(app: AppHandle) -> AppResult<Vec<CollectionBook>> {
    run_blocking(move || {
        let records = app
            .state::<SharedStore>()
            .with(&app, |store| store.favorites())?;
        Ok(to_books(&app, &records))
    })
    .await
}

/// 本がお気に入りに入っているかと、入っている本棚を返す。記録の無い本はどこにも入っていない。
#[tauri::command]
pub async fn get_book_collections(app: AppHandle, path: String) -> AppResult<BookCollections> {
    run_blocking(move || {
        app.state::<SharedStore>().with(&app, |store| {
            let Some(item_id) = recorded_item(store, &path)? else {
                return Ok(BookCollections::default());
            };
            Ok(BookCollections {
                favorite: store.is_favorite(item_id)?,
                shelf_ids: store.shelves_of(item_id)?,
            })
        })
    })
    .await
}

/// 本を本棚に入れる。入っていれば何もしない。
#[tauri::command]
pub async fn add_to_shelf(app: AppHandle, shelf_id: i64, path: String) -> AppResult<()> {
    run_blocking(move || {
        let location = locate_unrecorded(&app, &path)?;
        app.state::<SharedStore>().with(&app, |store| {
            store.shelf(shelf_id)?;
            let item_id = item_for_adding(store, &path, location.as_ref())?;
            store.add_to_shelf(shelf_id, item_id, now_millis())
        })
    })
    .await
}

/// 本を本棚から外す。入っていなければ何もしない。本の記録と元ファイルには触れない。
#[tauri::command]
pub async fn remove_from_shelf(app: AppHandle, shelf_id: i64, path: String) -> AppResult<()> {
    run_blocking(move || {
        app.state::<SharedStore>().with(&app, |store| {
            if let Some(item_id) = recorded_item(store, &path)? {
                store.remove_from_shelf(shelf_id, item_id)?;
            }
            Ok(())
        })
    })
    .await
}

/// お気に入りに入れるか外す。
#[tauri::command]
pub async fn set_favorite(app: AppHandle, path: String, favorite: bool) -> AppResult<()> {
    run_blocking(move || {
        if !favorite {
            return app.state::<SharedStore>().with(&app, |store| {
                if let Some(item_id) = recorded_item(store, &path)? {
                    store.set_favorite(item_id, false, now_millis())?;
                }
                Ok(())
            });
        }
        let location = locate_unrecorded(&app, &path)?;
        app.state::<SharedStore>().with(&app, |store| {
            let item_id = item_for_adding(store, &path, location.as_ref())?;
            store.set_favorite(item_id, true, now_millis())
        })
    })
    .await
}

/// 記録してある本の行を探す。記録した場所そのものか、正規化した場所で探す(無いパス・本でないパスは記録なし)。
fn recorded_item(store: &Store, path: &str) -> AppResult<Option<i64>> {
    if let Some(item_id) = store.find_item(path)? {
        return Ok(Some(item_id));
    }
    match library::book_location(Path::new(path)) {
        Ok(location) => store.find_item(&location.path.to_string_lossy()),
        Err(_) => Ok(None),
    }
}

/// 記録してある場所と一致しないときだけ、ファイルを調べて本の場所を求める(データベースのロックの外で行う)。
/// 見つからない本・本でないパスはここで失敗する。
fn locate_unrecorded(app: &AppHandle, path: &str) -> AppResult<Option<library::BookLocation>> {
    let recorded = app
        .state::<SharedStore>()
        .with(app, |store| store.find_item(path))?;
    if recorded.is_some() {
        return Ok(None);
    }
    library::book_location(Path::new(path)).map(Some)
}

/// 入れる本の行。記録が無ければ作る。
fn item_for_adding(
    store: &Store,
    path: &str,
    location: Option<&library::BookLocation>,
) -> AppResult<i64> {
    if let Some(item_id) = store.find_item(path)? {
        return Ok(item_id);
    }
    let Some(location) = location else {
        // 調べた後に記録が消えることはない(本の行は消さない)が、念のためその場で求める。
        let location = library::book_location(Path::new(path))?;
        return insert_location(store, &location);
    };
    insert_location(store, location)
}

fn insert_location(store: &Store, location: &library::BookLocation) -> AppResult<i64> {
    store.ensure_item(
        &location.path.to_string_lossy(),
        kind_of_format(location.format),
        &location.title,
        now_millis(),
    )
}

/// 本の形式を `items.kind` の値にする。
fn kind_of_format(format: BookFormat) -> &'static str {
    match format {
        BookFormat::Folder => "folder",
        BookFormat::Zip => "zip",
        BookFormat::Epub => "epub",
        BookFormat::Rar => "rar",
        BookFormat::Pdf => "pdf",
    }
}

fn to_shelf(record: &ShelfRecord) -> Shelf {
    Shelf {
        id: record.id,
        name: record.name.clone(),
        book_count: record.book_count,
        created_at: record.created_at,
    }
}

/// 記録を画面向けの形にし、今も見つかる開ける本の表紙を `prism` スキームで出せるよう登録する。
fn to_books(app: &AppHandle, records: &[CollectionRecord]) -> Vec<CollectionBook> {
    let thumbs = app.state::<Thumbs>();
    records
        .iter()
        .map(|record| {
            let book = to_book(record);
            if let Some(thumb_id) = &book.thumb_id {
                thumbs.register(thumb_id.clone(), record.path.clone().into());
            }
            book
        })
        .collect()
}

fn to_book(record: &CollectionRecord) -> CollectionBook {
    let place = BookPlace::of(&record.path, &record.title);
    let format = format_of_kind(&record.kind);
    CollectionBook {
        item_id: record.item_id,
        name: place.name,
        title: record.title.clone(),
        path: record.path.clone(),
        format,
        folder: place.folder,
        folder_path: place.folder_path,
        page: record.page,
        page_count: record.page_count,
        last_read_at: record.last_read_at,
        added_at: record.added_at,
        available: place.available,
        // まだ開けない形式は表紙を作れないので、仮の面のままにする。
        thumb_id: place.thumb_id.filter(|_| format.is_openable()),
        modified_at: place.modified_at,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::services::store::DATABASE_FILE_NAME;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join(DATABASE_FILE_NAME)).unwrap();
        (dir, store)
    }

    fn add(store: &Store, path: &Path) -> i64 {
        let path = path.to_string_lossy();
        let location = library::book_location(Path::new(&*path)).ok();
        item_for_adding(store, &path, location.as_ref()).unwrap()
    }

    #[test]
    fn store_books_are_found_by_recorded_or_canonical_path_and_survive_removal() {
        let (dir, store) = store();
        let books = dir.path().join("漫画");
        fs::create_dir(&books).unwrap();
        let zip = books.join("第1巻.cbz");
        fs::write(&zip, b"zip").unwrap();
        let canonical = fs::canonicalize(&zip).unwrap();

        // 正規化前の場所で入れても、正規化した場所の行になる。
        let item_id = add(&store, &zip);
        assert_eq!(add(&store, &canonical), item_id);
        let recorded = canonical.to_string_lossy().to_string();
        assert_eq!(recorded_item(&store, &recorded).unwrap(), Some(item_id));
        assert_eq!(
            recorded_item(&store, &zip.to_string_lossy()).unwrap(),
            Some(item_id)
        );

        // 元が消えても、記録した場所でその本を指せる(外す・お気に入りを外すのに使う)。
        fs::remove_file(&zip).unwrap();
        assert_eq!(recorded_item(&store, &recorded).unwrap(), Some(item_id));
        assert_eq!(add(&store, &canonical), item_id);
        // 記録の無い無いパスは記録なしで、入れようとすると失敗する。
        let missing = books.join("第2巻.cbz");
        assert_eq!(recorded_item(&store, &missing.to_string_lossy()).unwrap(), None);
        assert!(library::book_location(&missing).is_err());
        assert!(item_for_adding(&store, &missing.to_string_lossy(), None).is_err());
    }

    #[test]
    fn store_collection_books_of_missing_files_are_marked_and_keep_their_place() {
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("棚").join("第1巻.cbz");
        let record = CollectionRecord {
            item_id: 7,
            path: book.to_string_lossy().to_string(),
            kind: "zip".into(),
            title: "第1巻".into(),
            page_count: None,
            page: None,
            last_read_at: None,
            added_at: 3,
        };

        let missing = to_book(&record);
        assert!(!missing.available);
        assert_eq!(missing.thumb_id, None);
        assert_eq!((missing.name.as_str(), missing.folder.as_str()), ("第1巻.cbz", "棚"));

        fs::create_dir(dir.path().join("棚")).unwrap();
        fs::write(&book, b"zip").unwrap();
        assert!(to_book(&record).available);
        assert!(to_book(&record).thumb_id.is_some());
        // PDF も開ける形式なので表紙の ID を持つ。
        let pdf = CollectionRecord {
            kind: "pdf".into(),
            ..record
        };
        let pdf = to_book(&pdf);
        assert!(pdf.available);
        assert_eq!(pdf.format, BookFormat::Pdf);
        assert!(pdf.thumb_id.is_some());
    }
}
