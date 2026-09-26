use std::collections::HashMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

fn default_engine_registration_source() -> String {
    "legacy".into()
}

/// 本の 1 ページ。寸法は画像ヘッダから読んだ画素数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// 見開きでこのページを置く側(EPUB の `page-spread-left/right`)。指定の無いページは省く。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spread: Option<PageSpread>,
}

/// 見開きでページを置く側。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PageSpread {
    Left,
    Right,
}

/// ページを進める向き(EPUB の `page-progression-direction`)。`rtl` は右綴じ。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PageProgression {
    Ltr,
    Rtl,
}

/// 本の開き方。画像ファイルを指定して親フォルダを開いたときは `Image`、それ以外(フォルダ・アーカイブ・
/// EPUB・PDF を指定したとき)は `Book`。ビューアは `Image` のとき端で最初・最後の見開きへ回る。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenMode {
    Book,
    Image,
}

/// `open_book` の結果。`book_id` はページ配信などで本を指す ID。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedBook {
    pub book_id: String,
    pub title: String,
    /// 最初に表示するページ(画像ファイルを指定して開いたときはその画像)。
    pub start_index: usize,
    /// 本の開き方(画像ファイルを指定して開いたか)。
    pub open_mode: OpenMode,
    /// 本が指定するページを進める向き。指定の無い本は省く(設定の既定値に従う)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_progression: Option<PageProgression>,
    pub pages: Vec<PageInfo>,
    /// この本に保存してある表示設定。保存が無い本は省く(設定の既定値と本の指定に従う)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_settings: Option<ViewSettings>,
}

/// 同じフォルダで隣り合う本(前の巻・次の巻)。`book_id` は開いてある本の ID で、表紙(先頭ページ)の配信に使う。
/// `path` は `open_book` にそのまま渡せる本の場所。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjacentBook {
    pub book_id: String,
    pub title: String,
    pub path: String,
}

/// `get_adjacent_books` の結果。隣の本が無ければ `None`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjacentBooks {
    pub previous: Option<AdjacentBook>,
    pub next: Option<AdjacentBook>,
}

/// 見開きの表示モード(`view_settings.spread_mode`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpreadMode {
    Single,
    Spread,
    Auto,
}

impl SpreadMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Spread => "spread",
            Self::Auto => "auto",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "single" => Some(Self::Single),
            "spread" => Some(Self::Spread),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
}

/// 綴じ方向(`view_settings.binding`)。`right` は右綴じ。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewBinding {
    Right,
    Left,
}

impl ViewBinding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Right => "right",
            Self::Left => "left",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "right" => Some(Self::Right),
            "left" => Some(Self::Left),
            _ => None,
        }
    }
}

/// 本ごとの表示設定(見開き・綴じ方向・表紙単独)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSettings {
    pub spread_mode: SpreadMode,
    pub binding: ViewBinding,
    pub cover_single: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineId {
    RealCugan,
    Waifu2x,
    RealEsrgan,
}

impl EngineId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RealCugan => "real-cugan",
            Self::Waifu2x => "waifu2x",
            Self::RealEsrgan => "real-esrgan",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::RealCugan => "Real-CUGAN-ncnn-vulkan",
            Self::Waifu2x => "waifu2x-ncnn-vulkan",
            Self::RealEsrgan => "Real-ESRGAN-ncnn-vulkan",
        }
    }
}

impl FromStr for EngineId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "real-cugan" => Ok(Self::RealCugan),
            "waifu2x" => Ok(Self::Waifu2x),
            "real-esrgan" => Ok(Self::RealEsrgan),
            _ => Err(format!("未対応の AI エンジンです: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRegistration {
    pub executable_path: String,
    pub model_name: Option<String>,
    pub model_path: String,
    pub registered_at: u64,
    #[serde(default = "default_engine_registration_source")]
    pub source: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct EngineRegistry {
    pub engines: HashMap<EngineId, EngineRegistration>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub id: EngineId,
    pub label: String,
    pub configured: bool,
    pub ready: bool,
    pub executable_path: Option<String>,
    pub model_path: Option<String>,
    pub model_name: Option<String>,
    pub source: Option<String>,
    pub warning: Option<String>,
    pub download_url: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCandidate {
    pub id: EngineId,
    pub label: String,
    pub directory_path: String,
    pub executable_path: String,
    pub model_path: String,
    pub model_name: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallOption {
    pub engine_id: EngineId,
    pub label: String,
    pub release_name: String,
    pub release_tag: String,
    pub asset_name: String,
    pub download_url: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallWarning {
    pub engine_id: EngineId,
    pub label: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallOptionsResponse {
    pub options: Vec<EngineInstallOption>,
    pub warnings: Vec<EngineInstallWarning>,
}

/// 登録フォルダ。`path` は正規化した絶対パス(Windows では verbatim の接頭辞付き)で、画面には `display_path` を見せる。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySource {
    pub id: i64,
    pub path: String,
    pub display_path: String,
    pub name: String,
    pub added_at: i64,
}

/// フォルダ一覧の項目の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    /// 画像を直接含まないフォルダ。中へ辿る。
    Folder,
    /// 本(画像フォルダ・アーカイブ・EPUB・PDF)。
    Book,
}

/// 本の形式。検索索引の保存にも同じ名前で書く。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookFormat {
    /// 画像を直接含むフォルダ。
    Folder,
    /// ZIP・CBZ。
    Zip,
    Epub,
    /// RAR・CBR。
    Rar,
    Pdf,
}

impl BookFormat {
    /// このビルドで開ける形式か。今はすべての形式を開ける。
    pub fn is_openable(self) -> bool {
        true
    }
}

/// フォルダ一覧の 1 項目。`title` は本なら拡張子を除いた名前、フォルダなら名前。
/// `format` は本のときだけ持つ。`openable` はフォルダなら常に真。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub title: String,
    pub path: String,
    pub kind: EntryKind,
    pub format: Option<BookFormat>,
    pub openable: bool,
    /// 表紙サムネイルの ID(`prism` スキームの `/thumb/<ID>`)。開ける本だけが持つ。
    pub thumb_id: Option<String>,
    /// 元のファイル・フォルダの更新日時(UNIX エポックのミリ秒)。読めなければ `None`。
    pub modified_at: Option<i64>,
    /// 保存してある読書位置(0 始まり)・最後に開いたときのページ数・最終閲覧。開いたことのある本だけが持つ。
    pub page: Option<usize>,
    pub page_count: Option<usize>,
    pub last_read_at: Option<i64>,
}

/// 履歴・読みかけの 1 冊。`path` は `open_book` にそのまま渡せる本の場所(正規化した絶対パス)。
/// `folder` は本があるフォルダの名前、`folder_path` はその画面向けのパス。`page` は保存してある読書位置(0 始まり)、
/// `page_count` は最後に開いたときのページ数。`last_read_at` は最終閲覧(UNIX エポックのミリ秒)。
/// `available` は元の本が今も見つかるか。見つかる本だけが表紙サムネイルの `thumb_id` を持つ。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub item_id: i64,
    pub name: String,
    pub title: String,
    pub path: String,
    pub format: BookFormat,
    pub folder: String,
    pub folder_path: String,
    pub page: usize,
    pub page_count: Option<usize>,
    pub last_read_at: i64,
    pub available: bool,
    pub thumb_id: Option<String>,
}

/// 本棚。`book_count` は入っている本の数(見つからない本も数える)、`created_at` は作った時刻(UNIX エポックのミリ秒)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub id: i64,
    pub name: String,
    pub book_count: usize,
    pub created_at: i64,
}

/// 本棚・お気に入りの 1 冊。`path` は本の場所(正規化した絶対パス)で、本棚への出し入れ・`open_book` にそのまま渡せる。
/// `page`・`last_read_at` は開いたことのある本だけが持ち、`page_count` は最後に開いたときのページ数。
/// `added_at` はその本棚・お気に入りに入れた時刻。`available` は元の本が今も見つかるか。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionBook {
    pub item_id: i64,
    pub name: String,
    pub title: String,
    pub path: String,
    pub format: BookFormat,
    pub folder: String,
    pub folder_path: String,
    pub page: Option<usize>,
    pub page_count: Option<usize>,
    pub last_read_at: Option<i64>,
    pub added_at: i64,
    pub available: bool,
    pub thumb_id: Option<String>,
    /// 元の本の更新日時(UNIX エポックのミリ秒)。見つからない本は `None`。
    pub modified_at: Option<i64>,
}

/// 1 冊の本がお気に入りに入っているかと、入っている本棚の ID(本棚の並び順)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookCollections {
    pub favorite: bool,
    pub shelf_ids: Vec<i64>,
}

/// `list_directory` の結果。`path` は一覧を読んだフォルダの正規化した絶対パス、
/// `segments` は登録フォルダからそのフォルダまでのフォルダ名の並び(登録フォルダそのものなら空)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub source_id: i64,
    pub path: String,
    pub segments: Vec<String>,
    pub entries: Vec<DirectoryEntry>,
}

/// 検索に合った 1 項目。`path` は本なら `open_book` に渡せる本の場所、`folder` は項目のあるフォルダの
/// 登録フォルダからの相対パス(`/` 区切り。登録フォルダの直下なら空)。`thumb_id` は開ける本だけが持つ。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySearchHit {
    pub source_id: i64,
    pub source_name: String,
    pub name: String,
    pub title: String,
    pub path: String,
    pub folder: String,
    pub kind: EntryKind,
    pub format: Option<BookFormat>,
    pub openable: bool,
    pub thumb_id: Option<String>,
}

/// `search_library` の結果。`truncated` は上限を超えて打ち切ったか、`indexing` は索引を作っている途中か
/// (途中なら前回の索引で答えていて、まだ載っていない項目がある)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySearchResult {
    pub hits: Vec<LibrarySearchHit>,
    pub truncated: bool,
    pub indexing: bool,
}

/// 超解像の設定(`request_enhancement` の引数)。`denoise` はノイズ除去の指定が無いエンジン(Real-ESRGAN)では省く。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceSettings {
    pub engine: EngineId,
    pub model: String,
    pub scale: u8,
    #[serde(default)]
    pub denoise: Option<i8>,
}

/// 超解像キャッシュの使用量と上限(バイト)。`min_limit_bytes`・`max_limit_bytes` は設定できる上限の範囲。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceCacheInfo {
    pub used_bytes: u64,
    pub file_count: u64,
    pub limit_bytes: u64,
    pub min_limit_bytes: u64,
    pub max_limit_bytes: u64,
}

/// `request_enhancement` の結果。`key` は `prism` スキームの `/page/<bookId>/<index>/enhanced/<key>` に使う。
/// `ready` は処理済みで、要求しなかったページ(すぐ差し替えられる)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceRequestResult {
    pub key: String,
    pub ready: Vec<usize>,
}

/// `start_batch_enhancement` の結果。`total` は本の全ページ数、`ready` は処理済みで積まなかったページ。
/// ほかのページは一括のジョブとして積み、進み具合は `enhance-status` で届く。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEnhanceResult {
    pub key: String,
    pub total: usize,
    pub ready: Vec<usize>,
}

/// 超解像ジョブの状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnhanceJobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

/// イベント `enhance-status` の中身。`message` は失敗したときだけ持つ。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceStatusEvent {
    pub book_id: String,
    pub index: usize,
    pub key: String,
    pub state: EnhanceJobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// エンジンの導入の段階。公式配布の確認 → ダウンロード → 展開 → 登録と動作確認 の順に進む
/// (ZIP の取り込みは展開から始まる)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineInstallStage {
    Verifying,
    Downloading,
    Extracting,
    Registering,
}

/// イベント `engine-install-progress` の中身。`done`/`total` はダウンロードならバイト数、展開なら項目数で、
/// 数えない段階では 0。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstallProgress {
    pub engine_id: EngineId,
    pub stage: EngineInstallStage,
    pub done: u64,
    pub total: u64,
}

/// 旧版が残したアプリのデータ領域の `library/` フォルダの概要(削除前に利用者へ見せる)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLibraryDir {
    pub path: String,
    pub file_count: u64,
    pub total_bytes: u64,
}
