//! スキーマの移行手順。`MIGRATIONS[i]` はデータベースを version `i` から `i + 1` へ上げる。
//! 一度出荷した手順は書き換えない。形式を変えるときは末尾に手順を足して version を上げる。

/// version 1: 登録フォルダ・本・読書状態・本ごとの表示設定・本棚・お気に入り。
///
/// 時刻はすべて UNIX エポックからのミリ秒。`items.path` は呼び出し側で正規化した絶対パスを入れる。
/// 本の行は元ファイルが見つからなくなっても消さない(本棚・履歴から「見つかりません」と見せるため)。
const V1: &str = "
CREATE TABLE sources (
    id          INTEGER PRIMARY KEY,
    path        TEXT    NOT NULL UNIQUE,
    added_at    INTEGER NOT NULL
);

CREATE TABLE items (
    id          INTEGER PRIMARY KEY,
    path        TEXT    NOT NULL UNIQUE,
    kind        TEXT    NOT NULL
                CHECK (kind IN ('folder', 'image', 'zip', 'epub', 'rar', 'pdf')),
    title       TEXT    NOT NULL,
    page_count  INTEGER CHECK (page_count IS NULL OR page_count >= 0),
    modified_at INTEGER,
    size        INTEGER CHECK (size IS NULL OR size >= 0),
    source_id   INTEGER REFERENCES sources (id) ON DELETE SET NULL,
    added_at    INTEGER NOT NULL
);
CREATE INDEX items_source_id ON items (source_id);

CREATE TABLE reading_state (
    item_id      INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    page         INTEGER NOT NULL DEFAULT 0 CHECK (page >= 0),
    last_read_at INTEGER NOT NULL
);
CREATE INDEX reading_state_last_read_at ON reading_state (last_read_at DESC);

CREATE TABLE view_settings (
    item_id      INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    spread_mode  TEXT    NOT NULL CHECK (spread_mode IN ('single', 'spread', 'auto')),
    binding      TEXT    NOT NULL CHECK (binding IN ('right', 'left')),
    cover_single INTEGER NOT NULL CHECK (cover_single IN (0, 1))
);

CREATE TABLE shelves (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE shelf_items (
    shelf_id INTEGER NOT NULL REFERENCES shelves (id) ON DELETE CASCADE,
    item_id  INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (shelf_id, item_id)
);
CREATE INDEX shelf_items_item_id ON shelf_items (item_id);

CREATE TABLE favorites (
    item_id  INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL
);
";

pub const MIGRATIONS: &[&str] = &[V1];

/// このビルドが扱えるスキーマの version。
pub const LATEST_VERSION: i64 = MIGRATIONS.len() as i64;
