//! 登録フォルダ(`sources`)の読み書き。

use rusqlite::{params, OptionalExtension, Row};

use super::Store;
use crate::app_error::AppResult;

/// 登録フォルダの行。`path` は正規化した絶対パス。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRecord {
    pub id: i64,
    pub path: String,
    pub added_at: i64,
}

fn source_from_row(row: &Row<'_>) -> rusqlite::Result<SourceRecord> {
    Ok(SourceRecord {
        id: row.get(0)?,
        path: row.get(1)?,
        added_at: row.get(2)?,
    })
}

impl Store {
    /// 登録フォルダを足す。同じパスが登録済みなら、その行をそのまま返す。
    pub fn add_source(&self, path: &str, now: i64) -> AppResult<SourceRecord> {
        self.conn.execute(
            "INSERT INTO sources (path, added_at) VALUES (?1, ?2)
             ON CONFLICT (path) DO NOTHING",
            params![path, now],
        )?;
        Ok(self.conn.query_row(
            "SELECT id, path, added_at FROM sources WHERE path = ?1",
            [path],
            source_from_row,
        )?)
    }

    /// 登録フォルダを外す。外した行があれば真。本の行は `source_id` が NULL になるだけで残る。
    pub fn remove_source(&self, id: i64) -> AppResult<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM sources WHERE id = ?1", [id])?
            > 0)
    }

    /// 登録フォルダを登録した順に返す。
    pub fn sources(&self) -> AppResult<Vec<SourceRecord>> {
        let mut statement = self
            .conn
            .prepare("SELECT id, path, added_at FROM sources ORDER BY added_at, id")?;
        let rows = statement.query_map([], source_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// id で登録フォルダを引く。無ければ `None`。
    pub fn source(&self, id: i64) -> AppResult<Option<SourceRecord>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, path, added_at FROM sources WHERE id = ?1",
                [id],
                source_from_row,
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::store::DATABASE_FILE_NAME;

    #[test]
    fn library_sources_are_added_once_listed_in_order_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join(DATABASE_FILE_NAME)).unwrap();

        let first = store.add_source(r"C:\books\b", 10).unwrap();
        let second = store.add_source(r"C:\books\a", 20).unwrap();
        // 同じパスを足し直しても行は増えず、最初の登録が返る。
        assert_eq!(store.add_source(r"C:\books\b", 30).unwrap(), first);
        assert_eq!(store.sources().unwrap(), [first.clone(), second.clone()]);
        assert_eq!(store.source(second.id).unwrap(), Some(second.clone()));

        store
            .connection()
            .execute(
                "INSERT INTO items (path, kind, title, source_id, added_at)
                     VALUES ('C:/books/b/1.zip', 'zip', '1', ?1, 0)",
                [first.id],
            )
            .unwrap();
        assert!(store.remove_source(first.id).unwrap());
        assert!(!store.remove_source(first.id).unwrap());
        assert_eq!(store.sources().unwrap(), [second]);
        // 登録を外しても本の行は残り、登録フォルダとの結び付きだけが外れる。
        let source_id: Option<i64> = store
            .connection()
            .query_row("SELECT source_id FROM items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(source_id, None);
    }
}
