//! 履歴と読みかけ。開いた本の記録は `reading_state` の行そのもので、`last_read_at` が最終閲覧。
//! 履歴から消すと、その本の読書位置も消える(本の行・表示設定・本棚・お気に入りは残す)。
//! 読む対象の元ファイルには触れない。

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, Row};

use super::Store;
use crate::app_error::AppResult;

/// 履歴の 1 件。`path` は正規化した絶対パス、`kind` は `items.kind` の値。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRecord {
    pub item_id: i64,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub page_count: Option<usize>,
    /// 保存してある読書位置(0 始まり)。
    pub page: usize,
    pub last_read_at: i64,
}

impl HistoryRecord {
    /// 読み終えたか。最後のページまで進んだ本(読み終わりの案内まで進むと最後のページを保存する)。
    /// ページ数の分からない本は読み終えていないものとする。
    pub fn finished(&self) -> bool {
        self.page_count
            .is_some_and(|count| count > 0 && self.page + 1 >= count)
    }
}

const HISTORY_SELECT: &str = "
SELECT items.id, items.path, items.kind, items.title, items.page_count,
       reading_state.page, reading_state.last_read_at
  FROM reading_state
  JOIN items ON items.id = reading_state.item_id";

impl Store {
    /// 本を開いたことを記録する。初めてなら `page` を読書位置として行を作り、
    /// 記録があれば最終閲覧だけを更新する(保存してある読書位置は変えない)。
    pub fn record_opened(&self, item_id: i64, page: usize, now: i64) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO reading_state (item_id, page, last_read_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (item_id) DO UPDATE SET last_read_at = excluded.last_read_at",
            params![item_id, page as i64, now],
        )?;
        Ok(())
    }

    /// 開いた本を最終閲覧の新しい順に最大 `limit` 件返す。
    pub fn history(&self, limit: usize) -> AppResult<Vec<HistoryRecord>> {
        let mut statement = self.conn.prepare(&format!(
            "{HISTORY_SELECT}
             ORDER BY reading_state.last_read_at DESC, items.id DESC
             LIMIT ?1"
        ))?;
        let rows = statement.query_map([limit as i64], history_record)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 読み終えていない本を最終閲覧の新しい順に最大 `limit` 件返す。
    pub fn continue_reading(&self, limit: usize) -> AppResult<Vec<HistoryRecord>> {
        let mut statement = self.conn.prepare(&format!(
            "{HISTORY_SELECT}
             ORDER BY reading_state.last_read_at DESC, items.id DESC"
        ))?;
        let mut records = Vec::new();
        for record in statement.query_map([], history_record)? {
            let record = record?;
            if !record.finished() {
                records.push(record);
                if records.len() >= limit {
                    break;
                }
            }
        }
        Ok(records)
    }

    /// 本の場所(`items.path` と同じ正規化した絶対パス)ごとの読書の記録。開いたことのない本は結果に入らない。
    /// フォルダ一覧の本に読書状態を添えるのに使う(場所は UNIQUE の索引で引く)。
    pub fn reading_of_paths<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> AppResult<HashMap<String, HistoryRecord>> {
        let mut statement = self
            .conn
            .prepare(&format!("{HISTORY_SELECT} WHERE items.path = ?1"))?;
        let mut records = HashMap::new();
        for path in paths {
            if let Some(record) = statement.query_row([path], history_record).optional()? {
                records.insert(path.to_string(), record);
            }
        }
        Ok(records)
    }

    /// 1 冊を履歴から消す。消した行があれば真。
    pub fn remove_history(&self, item_id: i64) -> AppResult<bool> {
        let removed = self
            .conn
            .execute("DELETE FROM reading_state WHERE item_id = ?1", [item_id])?;
        Ok(removed > 0)
    }

    /// 履歴をすべて消し、消した件数を返す。
    pub fn clear_history(&self) -> AppResult<usize> {
        Ok(self.conn.execute("DELETE FROM reading_state", [])?)
    }
}

fn history_record(row: &Row) -> rusqlite::Result<HistoryRecord> {
    Ok(HistoryRecord {
        item_id: row.get(0)?,
        path: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        page_count: row
            .get::<_, Option<i64>>(4)?
            .and_then(|count| usize::try_from(count).ok()),
        page: usize::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
        last_read_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SpreadMode, ViewBinding, ViewSettings};
    use crate::services::store::{ItemKind, ItemRecord, DATABASE_FILE_NAME};

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join(DATABASE_FILE_NAME)).unwrap();
        (dir, store)
    }

    fn item(store: &Store, path: &str, page_count: usize) -> i64 {
        let record = ItemRecord {
            path,
            kind: ItemKind::Zip,
            title: path,
            page_count,
        };
        store.upsert_item(&record, 1).unwrap()
    }

    fn paths(records: &[HistoryRecord]) -> Vec<&str> {
        records.iter().map(|record| record.path.as_str()).collect()
    }

    #[test]
    fn store_history_is_ordered_by_last_read_and_opening_keeps_the_position() {
        let (_dir, store) = store();
        let a = item(&store, "a", 10);
        let b = item(&store, "b", 10);
        let c = item(&store, "c", 10);
        store.record_opened(a, 0, 100).unwrap();
        store.record_opened(b, 3, 200).unwrap();
        store.save_reading_position(a, 6, 300).unwrap();
        // 開き直しは最終閲覧だけを進め、読書位置は保存したままにする。
        store.record_opened(b, 0, 400).unwrap();
        // 開いていない本は履歴に載らない。
        let _ = c;

        let history = store.history(10).unwrap();
        assert_eq!(paths(&history), vec!["b", "a"]);
        assert_eq!((history[0].page, history[0].last_read_at), (3, 400));
        assert_eq!((history[1].page, history[1].last_read_at), (6, 300));
        assert_eq!(history[0].page_count, Some(10));
        assert_eq!(history[0].kind, "zip");
        assert_eq!(paths(&store.history(1).unwrap()), vec!["b"]);
    }

    #[test]
    fn store_reading_of_paths_returns_only_opened_books_by_exact_path() {
        let (_dir, store) = store();
        let opened = item(&store, "C:/lib/first.cbz", 10);
        // 行はあるが開いていない本(本棚に入れただけ)は記録を持たない。
        item(&store, "C:/lib/second.cbz", 10);
        store.record_opened(opened, 4, 500).unwrap();
        let records = store
            .reading_of_paths([
                "C:/lib/first.cbz",
                "C:/lib/second.cbz",
                "C:/lib/third.cbz",
                "C:/LIB/FIRST.CBZ",
            ])
            .unwrap();
        assert_eq!(records.len(), 1);
        let record = &records["C:/lib/first.cbz"];
        assert_eq!((record.page, record.page_count, record.last_read_at), (4, Some(10), 500));
    }

    #[test]
    fn store_continue_reading_leaves_out_finished_books() {
        let (_dir, store) = store();
        let reading = item(&store, "reading", 10);
        let finished = item(&store, "finished", 10);
        let last_spread = item(&store, "last-spread", 10);
        store.save_reading_position(reading, 4, 100).unwrap();
        store.save_reading_position(finished, 9, 300).unwrap();
        store.save_reading_position(last_spread, 8, 200).unwrap();

        // 最後のページを保存した本だけが読み終えた本。最後の見開きの手前のページはまだ読みかけ。
        assert_eq!(
            paths(&store.continue_reading(10).unwrap()),
            vec!["last-spread", "reading"]
        );
        assert_eq!(paths(&store.continue_reading(1).unwrap()), vec!["last-spread"]);
        // 履歴には読み終えた本も載る。
        assert_eq!(
            paths(&store.history(10).unwrap()),
            vec!["finished", "last-spread", "reading"]
        );
    }

    #[test]
    fn store_removing_history_keeps_the_book_row_and_its_settings() {
        let (_dir, store) = store();
        let a = item(&store, "a", 10);
        let b = item(&store, "b", 10);
        let view = ViewSettings {
            spread_mode: SpreadMode::Single,
            binding: ViewBinding::Left,
            cover_single: false,
        };
        store.save_view_settings(a, &view).unwrap();
        store.save_reading_position(a, 2, 100).unwrap();
        store.save_reading_position(b, 5, 200).unwrap();

        assert!(store.remove_history(a).unwrap());
        assert!(!store.remove_history(a).unwrap());
        assert_eq!(paths(&store.history(10).unwrap()), vec!["b"]);
        let state = store.book_state(a).unwrap();
        assert_eq!((state.page, state.view), (None, Some(view)));
        // 同じ path で開き直すと、同じ本の行に戻る。
        assert_eq!(item(&store, "a", 10), a);

        assert_eq!(store.clear_history().unwrap(), 1);
        assert!(store.history(10).unwrap().is_empty());
        let items: i64 = store
            .connection()
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(items, 2);
    }
}
