//! 本・読書状態・本棚を持つ SQLite。アプリのデータ領域にだけ置き、読む対象の元ファイルには触れない。
//! スキーマの version は `PRAGMA user_version` に持ち、開くたびに未適用の移行だけを流す。
//! 旧版の `library/` フォルダと localStorage の旧キーは読まない(消すのは設定画面の明示操作)。

// 本棚などの表を使う command は L 系で足すので、それまで呼び出し元の無い関数がある。
#![allow(dead_code)]

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, TransactionBehavior};
use tauri::AppHandle;

use crate::app_error::{AppError, AppResult};

mod history;
mod reading;
mod schema;
mod shelves;
mod sources;

pub use history::HistoryRecord;
pub use reading::{BookState, ItemKind, ItemRecord};
pub use shelves::{CollectionRecord, ShelfRecord};
pub use sources::SourceRecord;
pub use schema::LATEST_VERSION;

/// アプリのデータ領域に置くデータベースのファイル名。
pub const DATABASE_FILE_NAME: &str = "prismpage.sqlite3";

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        AppError::Internal(format!("データベースの処理に失敗しました: {error}"))
    }
}

pub struct Store {
    conn: Connection,
}

impl Store {
    /// アプリのデータ領域のデータベースを開き、スキーマを最新にする。
    pub fn open_in_app_data(app: &AppHandle) -> AppResult<Self> {
        let data_dir = super::app_data_dir(app)?;
        Self::open(&data_dir.join(DATABASE_FILE_NAME))
    }

    /// `path` のデータベースを開き(無ければ作り)、スキーマを最新にする。
    /// このビルドより新しい version のデータベースは、中身に触れずに開くのを拒否する。
    pub fn open(path: &Path) -> AppResult<Self> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        Ok(Self { conn })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}

/// アプリ全体で共有するデータベース。最初に使うときにアプリのデータ領域で開き、以後は同じ接続を使う。
/// 開くのに失敗したときは保持せず、次に使うときにもう一度開く。
#[derive(Default)]
pub struct SharedStore(Mutex<Option<Store>>);

impl SharedStore {
    pub fn with<T>(
        &self,
        app: &AppHandle,
        task: impl FnOnce(&Store) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self.lock();
        let store = match &mut *guard {
            Some(store) => store,
            slot @ None => slot.insert(Store::open_in_app_data(app)?),
        };
        task(store)
    }

    fn lock(&self) -> MutexGuard<'_, Option<Store>> {
        // 保持しているのは接続だけなので、他のスレッドが panic した後もそのまま使う。
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 現在時刻(UNIX エポックからのミリ秒)。時計が 1970 年より前を指すときは 0。
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn schema_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

/// 未適用の移行を順に流す。1 手順ごとに 1 トランザクションで、失敗した手順は丸ごと巻き戻る。
/// version の読み取りも書き込みロックを取った中で行うので、同じファイルを同時に開いても二重に流れない。
/// 最新のデータベースに対しては何もしないので、何度呼んでもよい。
fn migrate(conn: &mut Connection) -> AppResult<()> {
    loop {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = schema_version(&tx)?;
        if current > LATEST_VERSION {
            return Err(AppError::Message(format!(
                "データベースの形式(version {current})がこのバージョンのアプリより新しいため開けません。\
                 アプリを更新してください(対応している形式は version {LATEST_VERSION} まで)。"
            )));
        }
        if current < 0 {
            return Err(AppError::Message(format!(
                "データベースの形式(version {current})が不正なため開けません。"
            )));
        }
        if current == LATEST_VERSION {
            return Ok(());
        }

        tx.execute_batch(schema::MIGRATIONS[current as usize])?;
        tx.pragma_update(None, "user_version", current + 1)?;
        tx.commit()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLES: [&str; 7] = [
        "sources",
        "items",
        "reading_state",
        "view_settings",
        "shelves",
        "shelf_items",
        "favorites",
    ];

    fn table_names(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn store_open_creates_all_tables_at_latest_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join(DATABASE_FILE_NAME)).unwrap();

        let tables = table_names(store.connection());
        for table in TABLES {
            assert!(
                tables.iter().any(|name| name == table),
                "{table} が無い: {tables:?}"
            );
        }
        assert_eq!(schema_version(store.connection()).unwrap(), LATEST_VERSION);
    }

    #[test]
    fn store_migrating_twice_keeps_schema_and_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE_NAME);

        let mut store = Store::open(&path).unwrap();
        store
            .connection()
            .execute_batch(
                "INSERT INTO items (id, path, kind, title, added_at)
                     VALUES (1, 'C:\\books\\a.cbz', 'zip', 'a', 0);
                 INSERT INTO reading_state (item_id, page, last_read_at) VALUES (1, 12, 5);
                 INSERT INTO favorites (item_id, added_at) VALUES (1, 6);",
            )
            .unwrap();
        let before = table_names(store.connection());

        // 同じ接続でもう一度流しても、開き直しても、何も変わらない。
        migrate(store.connection_mut()).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();

        assert_eq!(table_names(store.connection()), before);
        assert_eq!(schema_version(store.connection()).unwrap(), LATEST_VERSION);
        let page: i64 = store
            .connection()
            .query_row(
                "SELECT page FROM reading_state WHERE item_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(page, 12);
        let favorites: i64 = store
            .connection()
            .query_row("SELECT COUNT(*) FROM favorites", [], |row| row.get(0))
            .unwrap();
        assert_eq!(favorites, 1);
    }

    #[test]
    fn store_refuses_future_version_without_touching_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE_NAME);
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", LATEST_VERSION + 1)
                .unwrap();
        }

        let error = Store::open(&path)
            .err()
            .expect("将来の version は開けないこと");
        assert!(matches!(error, AppError::Message(_)), "{error:?}");

        let conn = Connection::open(&path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION + 1);
        assert!(table_names(&conn).is_empty());
    }

    #[test]
    fn store_deleting_item_cascades_but_keeps_shelf() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join(DATABASE_FILE_NAME)).unwrap();
        let conn = store.connection();
        conn.execute_batch(
            "INSERT INTO items (id, path, kind, title, added_at)
                 VALUES (1, 'C:\\books\\a', 'folder', 'a', 0);
             INSERT INTO shelves (id, name, created_at) VALUES (1, '棚', 0);
             INSERT INTO shelf_items (shelf_id, item_id, added_at) VALUES (1, 1, 0);
             INSERT INTO view_settings (item_id, spread_mode, binding, cover_single)
                 VALUES (1, 'spread', 'right', 1);
             DELETE FROM items WHERE id = 1;",
        )
        .unwrap();

        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
        };
        assert_eq!(count("shelf_items"), 0);
        assert_eq!(count("view_settings"), 0);
        assert_eq!(count("shelves"), 1);
    }
}
