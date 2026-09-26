//! 本の行と、本ごとの読書位置・表示設定の読み書き。

use rusqlite::{params, OptionalExtension};

use super::Store;
use crate::app_error::AppResult;
use crate::models::{SpreadMode, ViewBinding, ViewSettings};

/// 本の種類(`items.kind`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Folder,
    Zip,
    Epub,
    /// RAR・CBR。
    Rar,
    Pdf,
}

impl ItemKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Zip => "zip",
            Self::Epub => "epub",
            Self::Rar => "rar",
            Self::Pdf => "pdf",
        }
    }
}

/// `items` に載せる本の情報。`path` は正規化した絶対パス(本の識別に使う)。
#[derive(Debug, Clone)]
pub struct ItemRecord<'a> {
    pub path: &'a str,
    pub kind: ItemKind,
    pub title: &'a str,
    pub page_count: usize,
}

/// 保存してある本ごとの状態。どちらも保存が無ければ `None`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BookState {
    pub page: Option<usize>,
    pub view: Option<ViewSettings>,
}

impl Store {
    /// 本の行を path で探して作るか更新し、行の id を返す。読書状態などの関連する行には触れない。
    pub fn upsert_item(&self, item: &ItemRecord, now: i64) -> AppResult<i64> {
        self.conn.execute(
            "INSERT INTO items (path, kind, title, page_count, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (path) DO UPDATE SET
                 kind = excluded.kind,
                 title = excluded.title,
                 page_count = excluded.page_count",
            params![
                item.path,
                item.kind.as_str(),
                item.title,
                item.page_count as i64,
                now
            ],
        )?;
        Ok(self
            .conn
            .query_row("SELECT id FROM items WHERE path = ?1", [item.path], |row| {
                row.get(0)
            })?)
    }

    /// 本の読書位置と表示設定を読む。
    pub fn book_state(&self, item_id: i64) -> AppResult<BookState> {
        let page = self
            .conn
            .query_row(
                "SELECT page FROM reading_state WHERE item_id = ?1",
                [item_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map(|page| usize::try_from(page).unwrap_or(0));
        let view = self
            .conn
            .query_row(
                "SELECT spread_mode, binding, cover_single FROM view_settings WHERE item_id = ?1",
                [item_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()?
            .and_then(|(spread_mode, binding, cover_single)| {
                // スキーマの CHECK で弾かれる値は来ないが、読めない行は保存が無いものとして扱う。
                Some(ViewSettings {
                    spread_mode: SpreadMode::parse(&spread_mode)?,
                    binding: ViewBinding::parse(&binding)?,
                    cover_single,
                })
            });
        Ok(BookState { page, view })
    }

    /// 読書位置(表示中の見開きの最初のページ、0 始まり)と最後に読んだ時刻を保存する。
    pub fn save_reading_position(&self, item_id: i64, page: usize, now: i64) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO reading_state (item_id, page, last_read_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (item_id) DO UPDATE SET
                 page = excluded.page,
                 last_read_at = excluded.last_read_at",
            params![item_id, page as i64, now],
        )?;
        Ok(())
    }

    /// 本ごとの表示設定を保存する。
    pub fn save_view_settings(&self, item_id: i64, view: &ViewSettings) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO view_settings (item_id, spread_mode, binding, cover_single)
                 VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (item_id) DO UPDATE SET
                 spread_mode = excluded.spread_mode,
                 binding = excluded.binding,
                 cover_single = excluded.cover_single",
            params![
                item_id,
                view.spread_mode.as_str(),
                view.binding.as_str(),
                view.cover_single
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::store::DATABASE_FILE_NAME;

    fn record(path: &str) -> ItemRecord<'_> {
        ItemRecord {
            path,
            kind: ItemKind::Zip,
            title: "a",
            page_count: 20,
        }
    }

    #[test]
    fn store_reading_state_survives_reopen_and_is_per_book() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE_NAME);
        let view = ViewSettings {
            spread_mode: SpreadMode::Single,
            binding: ViewBinding::Left,
            cover_single: false,
        };
        {
            let store = Store::open(&path).unwrap();
            let a = store.upsert_item(&record("C:\\books\\a.cbz"), 1).unwrap();
            let b = store.upsert_item(&record("C:\\books\\b.cbz"), 1).unwrap();
            assert_ne!(a, b);
            assert_eq!(store.book_state(a).unwrap(), BookState::default());

            store.save_reading_position(a, 3, 2).unwrap();
            store.save_reading_position(a, 7, 3).unwrap();
            store.save_view_settings(a, &view).unwrap();
            store.save_reading_position(b, 1, 4).unwrap();
        }

        // 開き直しても、同じ path の本は同じ行になり、最後に保存した値が読める。
        let store = Store::open(&path).unwrap();
        let a = store.upsert_item(&record("C:\\books\\a.cbz"), 9).unwrap();
        let b = store.upsert_item(&record("C:\\books\\b.cbz"), 9).unwrap();
        assert_eq!(
            store.book_state(a).unwrap(),
            BookState {
                page: Some(7),
                view: Some(view)
            }
        );
        assert_eq!(
            store.book_state(b).unwrap(),
            BookState {
                page: Some(1),
                view: None
            }
        );
        let last_read_at: i64 = store
            .connection()
            .query_row(
                "SELECT last_read_at FROM reading_state WHERE item_id = ?1",
                [a],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_read_at, 3);
    }

    #[test]
    fn store_upsert_item_updates_metadata_but_keeps_added_at_and_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join(DATABASE_FILE_NAME)).unwrap();
        let id = store.upsert_item(&record("C:\\books\\a"), 1).unwrap();
        store.save_reading_position(id, 5, 1).unwrap();

        let renamed = ItemRecord {
            title: "b",
            page_count: 30,
            ..record("C:\\books\\a")
        };
        assert_eq!(store.upsert_item(&renamed, 2).unwrap(), id);
        let (title, page_count, added_at): (String, i64, i64) = store
            .connection()
            .query_row(
                "SELECT title, page_count, added_at FROM items WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((title.as_str(), page_count, added_at), ("b", 30, 1));
        assert_eq!(store.book_state(id).unwrap().page, Some(5));
    }

    #[test]
    fn store_saving_view_settings_overwrites_all_three_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join(DATABASE_FILE_NAME)).unwrap();
        let id = store.upsert_item(&record("C:\\books\\a"), 1).unwrap();
        let first = ViewSettings {
            spread_mode: SpreadMode::Spread,
            binding: ViewBinding::Right,
            cover_single: true,
        };
        let second = ViewSettings {
            spread_mode: SpreadMode::Auto,
            binding: ViewBinding::Left,
            cover_single: false,
        };
        store.save_view_settings(id, &first).unwrap();
        store.save_view_settings(id, &second).unwrap();
        assert_eq!(store.book_state(id).unwrap().view, Some(second));
    }
}
