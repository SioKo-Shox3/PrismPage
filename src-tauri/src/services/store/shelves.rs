//! 本棚とお気に入り。どちらも本の行(`items`)を参照するだけのコレクションで、元ファイルには触れない。
//! 元ファイルが見つからなくなっても本の行と本棚・お気に入りの行は消さない(外すのは利用者の操作だけ)。
//! 本棚を消しても、入っていた本の行・読書状態・お気に入りは残る。

use rusqlite::{params, OptionalExtension, Row};

use super::Store;
use crate::app_error::{AppError, AppResult};

/// 本棚の名前の長さの上限(文字数)。
pub const SHELF_NAME_MAX_CHARS: usize = 60;

/// 本棚の 1 件。`book_count` は入っている本の数(見つからない本も数える)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShelfRecord {
    pub id: i64,
    pub name: String,
    pub book_count: usize,
    pub created_at: i64,
}

/// 本棚・お気に入りに入っている本の 1 冊。読書位置・最終閲覧は開いたことのある本だけが持つ。
/// `added_at` はその本棚・お気に入りに入れた時刻。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionRecord {
    pub item_id: i64,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub page_count: Option<usize>,
    pub page: Option<usize>,
    pub last_read_at: Option<i64>,
    pub added_at: i64,
}

/// 本棚の名前を整える。前後の空白を除き、空の名前・長すぎる名前は拒否する。
pub fn normalize_shelf_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Message("本棚の名前を入力してください。".into()));
    }
    if name.chars().count() > SHELF_NAME_MAX_CHARS {
        return Err(AppError::Message(format!(
            "本棚の名前は {SHELF_NAME_MAX_CHARS} 文字以内にしてください。"
        )));
    }
    Ok(name.to_string())
}

const SHELF_SELECT: &str = "
SELECT shelves.id, shelves.name, shelves.created_at,
       (SELECT COUNT(*) FROM shelf_items WHERE shelf_items.shelf_id = shelves.id)
  FROM shelves";

const COLLECTION_COLUMNS: &str = "
SELECT items.id, items.path, items.kind, items.title, items.page_count,
       reading_state.page, reading_state.last_read_at";

impl Store {
    /// path がそのまま一致する本の行の id。無ければ `None`。
    pub fn find_item(&self, path: &str) -> AppResult<Option<i64>> {
        Ok(self
            .conn
            .query_row("SELECT id FROM items WHERE path = ?1", [path], |row| row.get(0))
            .optional()?)
    }

    /// 本の行が無ければ作り、行の id を返す。既にある行(開いたことのある本)は書き換えない。
    /// 開いたことのない本のページ数は分からないので `NULL` のまま作る(開くと `upsert_item` が埋める)。
    pub fn ensure_item(&self, path: &str, kind: &str, title: &str, now: i64) -> AppResult<i64> {
        self.conn.execute(
            "INSERT INTO items (path, kind, title, added_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (path) DO NOTHING",
            params![path, kind, title, now],
        )?;
        Ok(self
            .conn
            .query_row("SELECT id FROM items WHERE path = ?1", [path], |row| row.get(0))?)
    }

    /// 本棚を並び順(作った順)に返す。
    pub fn shelves(&self) -> AppResult<Vec<ShelfRecord>> {
        let mut statement = self.conn.prepare(&format!(
            "{SHELF_SELECT} ORDER BY shelves.position, shelves.id"
        ))?;
        let rows = statement.query_map([], shelf_record)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 本棚を 1 件返す。無ければ `ShelfNotFound`。
    pub fn shelf(&self, shelf_id: i64) -> AppResult<ShelfRecord> {
        self.conn
            .query_row(
                &format!("{SHELF_SELECT} WHERE shelves.id = ?1"),
                [shelf_id],
                shelf_record,
            )
            .optional()?
            .ok_or(AppError::ShelfNotFound)
    }

    /// 本棚を作り、末尾に並べる。名前は `normalize_shelf_name` で整える(同じ名前の本棚も作れる)。
    pub fn create_shelf(&self, name: &str, now: i64) -> AppResult<ShelfRecord> {
        let name = normalize_shelf_name(name)?;
        self.conn.execute(
            "INSERT INTO shelves (name, position, created_at)
                 VALUES (?1, (SELECT COALESCE(MAX(position), -1) + 1 FROM shelves), ?2)",
            params![name, now],
        )?;
        self.shelf(self.conn.last_insert_rowid())
    }

    /// 本棚の名前を変える。
    pub fn rename_shelf(&self, shelf_id: i64, name: &str) -> AppResult<ShelfRecord> {
        let name = normalize_shelf_name(name)?;
        let changed = self.conn.execute(
            "UPDATE shelves SET name = ?1 WHERE id = ?2",
            params![name, shelf_id],
        )?;
        if changed == 0 {
            return Err(AppError::ShelfNotFound);
        }
        self.shelf(shelf_id)
    }

    /// 本棚を消す。入っていた本の行・読書状態・お気に入りは残す。
    pub fn delete_shelf(&self, shelf_id: i64) -> AppResult<()> {
        let removed = self
            .conn
            .execute("DELETE FROM shelves WHERE id = ?1", [shelf_id])?;
        if removed == 0 {
            return Err(AppError::ShelfNotFound);
        }
        Ok(())
    }

    /// 本棚の本を入れた順に返す。見つからなくなった本も含める。
    pub fn shelf_books(&self, shelf_id: i64) -> AppResult<Vec<CollectionRecord>> {
        self.shelf(shelf_id)?;
        let mut statement = self.conn.prepare(&format!(
            "{COLLECTION_COLUMNS}, shelf_items.added_at
               FROM shelf_items
               JOIN items ON items.id = shelf_items.item_id
               LEFT JOIN reading_state ON reading_state.item_id = items.id
              WHERE shelf_items.shelf_id = ?1
              ORDER BY shelf_items.position, shelf_items.added_at, items.id"
        ))?;
        let rows = statement.query_map([shelf_id], collection_record)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 本を本棚に入れる。入っていれば何もしない。
    pub fn add_to_shelf(&self, shelf_id: i64, item_id: i64, now: i64) -> AppResult<()> {
        self.shelf(shelf_id)?;
        self.conn.execute(
            "INSERT INTO shelf_items (shelf_id, item_id, position, added_at) VALUES (?1, ?2, 0, ?3)
             ON CONFLICT (shelf_id, item_id) DO NOTHING",
            params![shelf_id, item_id, now],
        )?;
        Ok(())
    }

    /// 本を本棚から外す。外した行があれば真。本の行は残す。
    pub fn remove_from_shelf(&self, shelf_id: i64, item_id: i64) -> AppResult<bool> {
        let removed = self.conn.execute(
            "DELETE FROM shelf_items WHERE shelf_id = ?1 AND item_id = ?2",
            params![shelf_id, item_id],
        )?;
        Ok(removed > 0)
    }

    /// 本が入っている本棚の id を本棚の並び順に返す。
    pub fn shelves_of(&self, item_id: i64) -> AppResult<Vec<i64>> {
        let mut statement = self.conn.prepare(
            "SELECT shelves.id FROM shelf_items
               JOIN shelves ON shelves.id = shelf_items.shelf_id
              WHERE shelf_items.item_id = ?1
              ORDER BY shelves.position, shelves.id",
        )?;
        let rows = statement.query_map([item_id], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// お気に入りに入れるか外す。既にその状態なら何もしない(入れた時刻も変えない)。
    pub fn set_favorite(&self, item_id: i64, favorite: bool, now: i64) -> AppResult<()> {
        if favorite {
            self.conn.execute(
                "INSERT INTO favorites (item_id, added_at) VALUES (?1, ?2)
                 ON CONFLICT (item_id) DO NOTHING",
                params![item_id, now],
            )?;
        } else {
            self.conn
                .execute("DELETE FROM favorites WHERE item_id = ?1", [item_id])?;
        }
        Ok(())
    }

    /// お気に入りに入っているか。
    pub fn is_favorite(&self, item_id: i64) -> AppResult<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM favorites WHERE item_id = ?1",
                [item_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// お気に入りの本を入れた時刻の新しい順に返す。見つからなくなった本も含める。
    pub fn favorites(&self) -> AppResult<Vec<CollectionRecord>> {
        let mut statement = self.conn.prepare(&format!(
            "{COLLECTION_COLUMNS}, favorites.added_at
               FROM favorites
               JOIN items ON items.id = favorites.item_id
               LEFT JOIN reading_state ON reading_state.item_id = items.id
              ORDER BY favorites.added_at DESC, items.id DESC"
        ))?;
        let rows = statement.query_map([], collection_record)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

fn shelf_record(row: &Row) -> rusqlite::Result<ShelfRecord> {
    Ok(ShelfRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        book_count: usize::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
    })
}

fn collection_record(row: &Row) -> rusqlite::Result<CollectionRecord> {
    Ok(CollectionRecord {
        item_id: row.get(0)?,
        path: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        page_count: row
            .get::<_, Option<i64>>(4)?
            .and_then(|count| usize::try_from(count).ok()),
        page: row
            .get::<_, Option<i64>>(5)?
            .and_then(|page| usize::try_from(page).ok()),
        last_read_at: row.get(6)?,
        added_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::store::{ItemKind, ItemRecord, DATABASE_FILE_NAME};

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join(DATABASE_FILE_NAME)).unwrap();
        (dir, store)
    }

    fn opened_item(store: &Store, path: &str) -> i64 {
        let record = ItemRecord {
            path,
            kind: ItemKind::Zip,
            title: path,
            page_count: 10,
        };
        store.upsert_item(&record, 1).unwrap()
    }

    fn count(store: &Store, table: &str) -> i64 {
        store
            .connection()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .unwrap()
    }

    fn paths(records: &[CollectionRecord]) -> Vec<&str> {
        records.iter().map(|record| record.path.as_str()).collect()
    }

    #[test]
    fn store_shelves_are_created_renamed_and_deleted_in_order() {
        let (_dir, store) = store();
        let first = store.create_shelf("  連載中  ", 10).unwrap();
        let second = store.create_shelf("画集", 20).unwrap();
        assert_eq!(first.name, "連載中");
        assert_eq!((first.book_count, first.created_at), (0, 10));

        let renamed = store.rename_shelf(first.id, "完結").unwrap();
        assert_eq!(renamed.name, "完結");
        let names: Vec<String> = store.shelves().unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["完結", "画集"]);

        store.delete_shelf(first.id).unwrap();
        assert_eq!(store.shelves().unwrap(), vec![second.clone()]);
        // 消した本棚・無い本棚の操作は ShelfNotFound。
        for result in [
            store.delete_shelf(first.id).map(|_| ()),
            store.rename_shelf(first.id, "x").map(|_| ()),
            store.shelf_books(first.id).map(|_| ()),
            store.add_to_shelf(first.id, opened_item(&store, "a"), 1),
        ] {
            assert_eq!(result.unwrap_err().code(), "shelf_not_found");
        }
        // 消した後に作った本棚は末尾に並ぶ。
        let third = store.create_shelf("あとで読む", 30).unwrap();
        let ids: Vec<i64> = store.shelves().unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![second.id, third.id]);
    }

    #[test]
    fn store_shelf_names_must_be_non_empty_and_short() {
        let (_dir, store) = store();
        assert_eq!(normalize_shelf_name(" a ").unwrap(), "a");
        assert!(normalize_shelf_name("   ").is_err());
        assert!(normalize_shelf_name(&"本".repeat(SHELF_NAME_MAX_CHARS)).is_ok());
        assert!(normalize_shelf_name(&"本".repeat(SHELF_NAME_MAX_CHARS + 1)).is_err());

        assert!(store.create_shelf(" ", 1).is_err());
        let shelf = store.create_shelf("a", 1).unwrap();
        assert!(store.rename_shelf(shelf.id, "").is_err());
        assert_eq!(store.shelf(shelf.id).unwrap().name, "a");
        assert_eq!(count(&store, "shelves"), 1);
    }

    #[test]
    fn store_a_book_can_be_on_several_shelves_and_removed_from_one() {
        let (_dir, store) = store();
        let a = store.create_shelf("A", 1).unwrap();
        let b = store.create_shelf("B", 2).unwrap();
        let book = opened_item(&store, "book");
        let other = opened_item(&store, "other");

        store.add_to_shelf(a.id, book, 100).unwrap();
        store.add_to_shelf(b.id, book, 200).unwrap();
        store.add_to_shelf(a.id, other, 300).unwrap();
        // 二度入れても 1 冊のまま、入れた時刻も変わらない。
        store.add_to_shelf(a.id, book, 400).unwrap();

        assert_eq!(store.shelves_of(book).unwrap(), vec![a.id, b.id]);
        let on_a = store.shelf_books(a.id).unwrap();
        assert_eq!(paths(&on_a), vec!["book", "other"]);
        assert_eq!(on_a[0].added_at, 100);
        assert_eq!(store.shelf(a.id).unwrap().book_count, 2);

        assert!(store.remove_from_shelf(a.id, book).unwrap());
        assert!(!store.remove_from_shelf(a.id, book).unwrap());
        assert_eq!(store.shelves_of(book).unwrap(), vec![b.id]);
        assert_eq!(paths(&store.shelf_books(a.id).unwrap()), vec!["other"]);
        // 外しても本の行は残る。
        assert_eq!(count(&store, "items"), 2);
    }

    #[test]
    fn store_deleting_a_shelf_keeps_books_reading_state_and_favorites() {
        let (_dir, store) = store();
        let shelf = store.create_shelf("A", 1).unwrap();
        let other = store.create_shelf("B", 1).unwrap();
        let book = opened_item(&store, "book");
        store.save_reading_position(book, 4, 50).unwrap();
        store.set_favorite(book, true, 60).unwrap();
        store.add_to_shelf(shelf.id, book, 70).unwrap();
        store.add_to_shelf(other.id, book, 70).unwrap();

        store.delete_shelf(shelf.id).unwrap();

        assert_eq!(count(&store, "items"), 1);
        assert_eq!(store.book_state(book).unwrap().page, Some(4));
        assert!(store.is_favorite(book).unwrap());
        assert_eq!(store.shelves_of(book).unwrap(), vec![other.id]);
    }

    #[test]
    fn store_favorites_are_toggled_and_listed_newest_first_with_reading_state() {
        let (_dir, store) = store();
        let read = opened_item(&store, "read");
        let unread = store.ensure_item("unread", "rar", "未読", 5).unwrap();
        store.save_reading_position(read, 3, 50).unwrap();

        store.set_favorite(read, true, 100).unwrap();
        store.set_favorite(unread, true, 200).unwrap();
        // 入れ直しても入れた時刻は変わらない。
        store.set_favorite(read, true, 300).unwrap();

        let favorites = store.favorites().unwrap();
        assert_eq!(paths(&favorites), vec!["unread", "read"]);
        assert_eq!(
            (favorites[0].page, favorites[0].last_read_at, favorites[0].page_count),
            (None, None, None)
        );
        assert_eq!(favorites[0].kind, "rar");
        assert_eq!(
            (favorites[1].page, favorites[1].last_read_at, favorites[1].added_at),
            (Some(3), Some(50), 100)
        );

        store.set_favorite(read, false, 400).unwrap();
        store.set_favorite(read, false, 400).unwrap();
        assert!(!store.is_favorite(read).unwrap());
        assert_eq!(paths(&store.favorites().unwrap()), vec!["unread"]);
        assert_eq!(count(&store, "items"), 2);
    }

    #[test]
    fn store_ensure_item_does_not_overwrite_an_opened_book() {
        let (_dir, store) = store();
        let opened = opened_item(&store, "book");
        assert_eq!(store.ensure_item("book", "folder", "別名", 99).unwrap(), opened);
        let (kind, title, page_count): (String, String, Option<i64>) = store
            .connection()
            .query_row(
                "SELECT kind, title, page_count FROM items WHERE id = ?1",
                [opened],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((kind.as_str(), title.as_str(), page_count), ("zip", "book", Some(10)));

        assert_eq!(store.find_item("book").unwrap(), Some(opened));
        assert_eq!(store.find_item("none").unwrap(), None);
        let created = store.ensure_item("new", "epub", "新しい本", 1).unwrap();
        assert_eq!(store.find_item("new").unwrap(), Some(created));
    }

    #[test]
    fn store_books_whose_files_are_gone_stay_on_shelves_and_favorites() {
        // 元ファイルの有無は見ずに載せる(存在しないパスの本もそのまま返す)。
        let (_dir, store) = store();
        let shelf = store.create_shelf("A", 1).unwrap();
        let gone = store
            .ensure_item(r"C:\どこにも無い\第1巻.cbz", "zip", "第1巻", 1)
            .unwrap();
        store.add_to_shelf(shelf.id, gone, 2).unwrap();
        store.set_favorite(gone, true, 3).unwrap();

        assert_eq!(store.shelf_books(shelf.id).unwrap().len(), 1);
        assert_eq!(store.favorites().unwrap().len(), 1);
    }
}
