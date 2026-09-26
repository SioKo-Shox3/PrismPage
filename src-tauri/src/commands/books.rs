use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::app_error::{AppError, AppResult};
use crate::commands::run_blocking;
use crate::models::{AdjacentBooks, OpenedBook, ViewSettings};
use crate::services::source::{self, BookCache, OpenedSource};
use crate::services::store::{now_millis, BookState, ItemRecord, SharedStore, Store};
use crate::state::{BookItems, BookRoots};

/// フォルダまたは画像ファイルを本として開き、ページ一覧を返す。開いた本はハンドルとして
/// キャッシュされ、以後は返した `bookId` で参照する。
/// 本はデータベースに記録して履歴に残し、保存してある読書位置から始め、表示設定を添えて返す
/// (画像ファイルを指定して開いたときはその画像から始める)。`from_start` が真なら、保存してある
/// 読書位置を使わず先頭から始める(次の巻・前の巻へ移るとき)。
#[tauri::command]
pub async fn open_book(
    app: AppHandle,
    path: String,
    from_start: Option<bool>,
) -> AppResult<OpenedBook> {
    run_blocking(move || {
        let cache = app.state::<BookCache>();
        let opened = source::open_source(&PathBuf::from(path), &cache)?;
        app.state::<BookRoots>().insert(
            opened.book.book_id.clone(),
            opened.root.clone(),
            opened.kind,
        );
        let store = app.state::<SharedStore>();
        match store.with(&app, |store| restore(store, &opened)) {
            Ok((item_id, state)) => {
                app.state::<BookItems>()
                    .insert(opened.book.book_id.clone(), item_id);
                let book = apply_state(opened, state, from_start.unwrap_or(false));
                // 開いたことを履歴に残す。残せなくても本は読める。
                if let Err(error) = store.with(&app, |store| {
                    store.record_opened(item_id, book.start_index, now_millis())
                }) {
                    log::warn!("履歴を記録できませんでした: {error}");
                }
                Ok(book)
            }
            // 保存の仕組みが使えなくても本は読めるようにする(位置と設定は既定のまま)。
            Err(error) => {
                log::warn!("読書状態を読み込めませんでした: {error}");
                Ok(opened.book)
            }
        }
    })
    .await
}

/// 読書位置(表示中の見開きの最初のページ、0 始まり)を保存する。
#[tauri::command]
pub async fn save_reading_position(app: AppHandle, book_id: String, page: usize) -> AppResult<()> {
    run_blocking(move || {
        let item_id = app.state::<BookItems>().get(&book_id)?;
        app.state::<SharedStore>().with(&app, |store| {
            store.save_reading_position(item_id, page, now_millis())
        })
    })
    .await
}

/// 本ごとの表示設定(見開き・綴じ方向・表紙単独)を保存する。
#[tauri::command]
pub async fn save_view_settings(
    app: AppHandle,
    book_id: String,
    settings: ViewSettings,
) -> AppResult<()> {
    run_blocking(move || {
        let item_id = app.state::<BookItems>().get(&book_id)?;
        app.state::<SharedStore>()
            .with(&app, |store| store.save_view_settings(item_id, &settings))
    })
    .await
}

/// 開いた本と同じフォルダで自然順に隣り合う、同じ種類の本(前の巻・次の巻)を返す。
/// 隣の本は開いてキャッシュに置くので、返した本 ID で表紙(先頭ページ)を表示できる。
#[tauri::command]
pub async fn get_adjacent_books(app: AppHandle, book_id: String) -> AppResult<AdjacentBooks> {
    run_blocking(move || {
        let (root, kind) = app
            .state::<BookRoots>()
            .lock()
            .get(&book_id)
            .cloned()
            .ok_or(AppError::BookNotOpen)?;
        source::adjacent_books(&root, kind, &app.state::<BookCache>())
    })
    .await
}

/// ビューアを閉じた本と、その前後の巻として表紙を出すために開いた本を手放す。
/// RAR/CBR の一時フォルダはここで消える。直後に同じ本を開き直しても消さないよう、
/// 裏へ回さず受け取った順にキャッシュから外し、外したハンドルの後片付け(フォルダの削除)だけを裏で行う。
#[tauri::command]
pub fn close_books(app: AppHandle, book_ids: Vec<String>) {
    let released = source::close_books(&app.state::<BookCache>(), &book_ids);
    if !released.is_empty() {
        tauri::async_runtime::spawn_blocking(move || drop(released));
    }
}

/// 本の行を作るか更新し、保存してある状態を読む。本は正規化した絶対パスで識別する。
fn restore(store: &Store, opened: &OpenedSource) -> AppResult<(i64, BookState)> {
    let path = opened.root.to_string_lossy();
    let record = ItemRecord {
        path: &path,
        kind: opened.kind,
        title: &opened.book.title,
        page_count: opened.book.pages.len(),
    };
    let item_id = store.upsert_item(&record, now_millis())?;
    Ok((item_id, store.book_state(item_id)?))
}

/// 保存してある状態を開いた本に当てる。読書位置はページ数が減っていれば最後のページに収める。
/// `from_start` が真なら読書位置は当てず、表示設定だけを当てる。
fn apply_state(opened: OpenedSource, state: BookState, from_start: bool) -> OpenedBook {
    let mut book = opened.book;
    if !opened.explicit_start && !from_start {
        if let Some(page) = state.page {
            book.start_index = page.min(book.pages.len().saturating_sub(1));
        }
    }
    book.view_settings = state.view;
    book
}

impl BookItems {
    fn get(&self, book_id: &str) -> AppResult<i64> {
        self.lock()
            .get(book_id)
            .copied()
            .ok_or(AppError::BookNotOpen)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::models::{SpreadMode, ViewBinding};
    use crate::services::source::test_images;
    use crate::services::store::DATABASE_FILE_NAME;

    /// command と同じ手順で開く(本の行を作り、保存してある状態を当てる)。
    fn open(store: &Store, path: &std::path::Path, cache: &BookCache) -> (i64, OpenedBook) {
        open_with(store, path, cache, false)
    }

    fn open_with(
        store: &Store,
        path: &std::path::Path,
        cache: &BookCache,
        from_start: bool,
    ) -> (i64, OpenedBook) {
        let opened = source::open_source(path, cache).unwrap();
        let (item_id, state) = restore(store, &opened).unwrap();
        (item_id, apply_state(opened, state, from_start))
    }

    #[test]
    fn store_reopening_a_book_restores_position_and_view_settings() {
        let books = tempfile::tempdir().unwrap();
        for index in 0..4 {
            fs::write(
                books.path().join(format!("{index}.png")),
                test_images::png(10, 15),
            )
            .unwrap();
        }
        let data = tempfile::tempdir().unwrap();
        let db = data.path().join(DATABASE_FILE_NAME);
        let cache = BookCache::new(4);
        let view = ViewSettings {
            spread_mode: SpreadMode::Spread,
            binding: ViewBinding::Left,
            cover_single: false,
        };

        {
            let store = Store::open(&db).unwrap();
            let (item_id, book) = open(&store, books.path(), &cache);
            assert_eq!((book.start_index, book.view_settings), (0, None));
            store.save_reading_position(item_id, 2, 1).unwrap();
            store.save_view_settings(item_id, &view).unwrap();
        }

        let store = Store::open(&db).unwrap();
        let (_, book) = open(&store, books.path(), &cache);
        assert_eq!((book.start_index, book.view_settings), (2, Some(view)));

        // 次の巻・前の巻として開くときは、保存してある位置を使わず先頭から始める(表示設定は当てる)。
        let (_, from_start) = open_with(&store, books.path(), &cache, true);
        assert_eq!(
            (from_start.start_index, from_start.view_settings),
            (0, Some(view))
        );

        // 画像ファイルを指定して開いたときは、その画像から始める(表示設定は当てる)。
        let (_, from_image) = open(&store, &books.path().join("1.png"), &cache);
        assert_eq!(
            (from_image.start_index, from_image.view_settings),
            (1, Some(view))
        );
    }

    #[test]
    fn store_saved_position_past_the_end_is_clamped_to_the_last_page() {
        let books = tempfile::tempdir().unwrap();
        for index in 0..3 {
            fs::write(
                books.path().join(format!("{index}.png")),
                test_images::png(10, 15),
            )
            .unwrap();
        }
        let data = tempfile::tempdir().unwrap();
        let store = Store::open(&data.path().join(DATABASE_FILE_NAME)).unwrap();
        let cache = BookCache::new(4);

        let (item_id, _) = open(&store, books.path(), &cache);
        store.save_reading_position(item_id, 40, 1).unwrap();
        let (_, book) = open(&store, books.path(), &cache);
        assert_eq!(book.start_index, 2);
    }
}
