export type EngineId = 'real-cugan' | 'waifu2x' | 'real-esrgan'

// 設定で選ぶテーマ。system は OS の明暗設定に合わせて paper / ink のどちらかに解決する。
export type ThemeMode = 'paper' | 'ink' | 'system'

export type ResolvedTheme = Exclude<ThemeMode, 'system'>

// 本の 1 ページ。幅・高さは画像ヘッダから読んだ画素数(Rust の `PageInfo`)。
export interface PageInfo {
  name: string
  width: number
  height: number
  // 見開きでこのページを置く側(EPUB の `page-spread-left/right`)。指定の無いページはキー自体が無い。
  spread?: PageSpread
}

// 見開きでページを置く側(Rust の `PageSpread`)。
export type PageSpread = 'left' | 'right'

// ページを進める向き(Rust の `PageProgression`)。`rtl` は右綴じ。
export type PageProgression = 'ltr' | 'rtl'

// `open_book` の結果(Rust の `OpenedBook`)。`bookId` でページ配信などから本を指す。
export interface OpenedBook {
  bookId: string
  title: string
  // 最初に表示するページ。画像ファイルを指定して開いたときはその画像。
  startIndex: number
  // 本が指定するページを進める向き。指定の無い本はキー自体が無い(設定の既定値に従う)。
  pageProgression?: PageProgression
  pages: PageInfo[]
  // この本に保存してある表示設定。保存が無い本はキー自体が無い(設定の既定値と本の指定に従う)。
  viewSettings?: ViewSettings
}

// 同じフォルダで隣り合う本(Rust の `AdjacentBook`)。`bookId` は開いてある本の ID で表紙の表示に使い、
// `path` は `openBook` にそのまま渡せる本の場所。
export interface AdjacentBook {
  bookId: string
  title: string
  path: string
}

// `get_adjacent_books` の結果(前の巻・次の巻)。隣の本が無ければ null。
export interface AdjacentBooks {
  previous: AdjacentBook | null
  next: AdjacentBook | null
}

// 登録フォルダ(Rust の `LibrarySource`)。`path` は正規化した絶対パスで `listDirectory` に渡せる。
// 画面には `displayPath` と `name` を見せる。`addedAt` は UNIX エポックのミリ秒。
export interface LibrarySource {
  id: number
  path: string
  displayPath: string
  name: string
  addedAt: number
}

// フォルダ一覧の項目の種類(Rust の `EntryKind`)。`folder` は中へ辿るフォルダ、`book` は本。
export type EntryKind = 'folder' | 'book'

// 本の形式(Rust の `BookFormat`)。`folder` は画像を直接含むフォルダ、`zip` は ZIP・CBZ、`rar` は RAR・CBR。
export type BookFormat = 'folder' | 'zip' | 'epub' | 'rar' | 'pdf'

// フォルダ一覧の 1 項目(Rust の `DirectoryEntry`)。`format` は本のときだけ持つ。
// `openable` が偽の本は開けない(いまの形式はすべて開けるので Rust は真だけを返す)。`path` は本なら `openBook`、フォルダなら `listDirectory` に渡せる。
// `thumbId` は開ける本だけが持つ表紙サムネイルの ID(`thumbUrl` に渡す)。
// `modifiedAt` は元のファイル・フォルダの更新日時(UNIX エポックのミリ秒。読めなければ null)。
// `page`・`pageCount`・`lastReadAt` は開いたことのある本だけが持つ読書の記録(無ければ null)。
export interface DirectoryEntry {
  name: string
  title: string
  path: string
  kind: EntryKind
  format: BookFormat | null
  openable: boolean
  thumbId: string | null
  modifiedAt: number | null
  page: number | null
  pageCount: number | null
  lastReadAt: number | null
}

// `list_directory` の結果(Rust の `DirectoryListing`)。`segments` は登録フォルダから表示中のフォルダまでの
// フォルダ名の並び(パンくずに使う。登録フォルダそのものなら空)。並びはフォルダが先、それぞれ名前の自然順。
export interface DirectoryListing {
  sourceId: number
  path: string
  segments: string[]
  entries: DirectoryEntry[]
}

// 検索に合った 1 項目(Rust の `LibrarySearchHit`)。`path` は本なら `openBook` に渡せる本の場所、
// `folder` は項目のあるフォルダの登録フォルダからの相対パス(`/` 区切り。登録フォルダの直下なら空)。
// `thumbId` は開ける本だけが持つ表紙サムネイルの ID(`thumbUrl` に渡す)。
export interface LibrarySearchHit {
  sourceId: number
  sourceName: string
  name: string
  title: string
  path: string
  folder: string
  kind: EntryKind
  format: BookFormat | null
  openable: boolean
  thumbId: string | null
}

// `search_library` の結果(Rust の `LibrarySearchResult`)。`truncated` は件数の上限で打ち切ったか、
// `indexing` は索引を作っている途中か(途中なら前回の索引で答えていて、まだ載っていない項目がある)。
export interface LibrarySearchResult {
  hits: LibrarySearchHit[]
  truncated: boolean
  indexing: boolean
}

// 読みかけ・履歴の 1 冊(Rust の `HistoryEntry`)。`path` は `openBook` にそのまま渡せる本の場所。
// `folder` は本があるフォルダの名前、`folderPath` はその画面向けのパス。`page` は保存してある読書位置(0 始まり)、
// `pageCount` は最後に開いたときのページ数(分からなければ null)。`lastReadAt` は最終閲覧(UNIX エポックのミリ秒)。
// `available` は元の本が今も見つかるか。見つかる本だけが表紙の `thumbId`(`thumbUrl` に渡す)を持つ。
export interface HistoryEntry {
  itemId: number
  name: string
  title: string
  path: string
  format: BookFormat
  folder: string
  folderPath: string
  page: number
  pageCount: number | null
  lastReadAt: number
  available: boolean
  thumbId: string | null
}

// 本棚(Rust の `Shelf`)。`bookCount` は入っている本の数(見つからない本も数える)。
export interface Shelf {
  id: number
  name: string
  bookCount: number
  createdAt: number
}

// 本棚・お気に入りの 1 冊(Rust の `CollectionBook`)。`path` は本の場所で、本棚への出し入れと `openBook` にそのまま渡せる。
// `page`・`lastReadAt` は開いたことのある本だけが持つ(無ければ null)。`addedAt` はその本棚・お気に入りに入れた時刻。
// `available` は元の本が今も見つかるか(見つからない本も自動では外さない)。`modifiedAt` は元の本の更新日時
// (見つからない本は null)。
export interface CollectionBook {
  itemId: number
  name: string
  title: string
  path: string
  format: BookFormat
  folder: string
  folderPath: string
  page: number | null
  pageCount: number | null
  lastReadAt: number | null
  addedAt: number
  available: boolean
  thumbId: string | null
  modifiedAt: number | null
}

// 1 冊の本がお気に入りに入っているかと、入っている本棚の ID(Rust の `BookCollections`)。
export interface BookCollections {
  favorite: boolean
  shelfIds: number[]
}

// 見開きの表示モード(Rust の `SpreadMode`)。`auto` はウィンドウが横長なら見開き。
export type SpreadMode = 'single' | 'spread' | 'auto'

// 綴じ方向(Rust の `ViewBinding`)。`right` は右綴じ。
export type Binding = 'right' | 'left'

// 本ごとの表示設定(Rust の `ViewSettings`)。
export interface ViewSettings {
  spreadMode: SpreadMode
  binding: Binding
  coverSingle: boolean
}

export interface EngineStatus {
  id: EngineId
  label: string
  configured: boolean
  ready: boolean
  executablePath?: string
  modelPath?: string
  modelName?: string
  source?: string
  warning?: string
  downloadUrl: string
  notes: string[]
}

export interface EngineCandidate {
  id: EngineId
  label: string
  directoryPath: string
  executablePath: string
  modelPath: string
  modelName?: string
  source: string
}

export interface EngineInstallOption {
  engineId: EngineId
  label: string
  releaseName: string
  releaseTag: string
  assetName: string
  downloadUrl: string
  size: number
}

export interface EngineInstallWarning {
  engineId: EngineId
  label: string
  message: string
}

export interface EngineInstallOptionsResponse {
  options: EngineInstallOption[]
  warnings: EngineInstallWarning[]
}

// エンジンの導入の段階(Rust の `EngineInstallStage`)。公式配布の確認 → ダウンロード → 展開 → 登録と動作確認。
export type EngineInstallStage = 'verifying' | 'downloading' | 'extracting' | 'registering'

// イベント `engine-install-progress` の中身(Rust の `EngineInstallProgress`)。`done`/`total` はダウンロードなら
// バイト数、展開なら項目数で、数えない段階では 0。
export interface EngineInstallProgress {
  engineId: EngineId
  stage: EngineInstallStage
  done: number
  total: number
}

// 超解像の設定(Rust の `EnhanceSettings`、`request_enhancement` の引数)。`denoise` はノイズ除去の指定が無い
// エンジン(Real-ESRGAN)では省く。
export interface EnhanceSettings {
  engine: EngineId
  model: string
  scale: number
  denoise?: number
}

// `request_enhancement` の結果(Rust の `EnhanceRequestResult`)。`key` は処理結果の版を指す(`enhancedPageUrl` に渡す)。
// `ready` は処理済みで要求しなかったページ(すぐ差し替えられる)。
export interface EnhanceRequestResult {
  key: string
  ready: number[]
}

// `start_batch_enhancement` の結果(Rust の `BatchEnhanceResult`)。`total` は本の全ページ数、`ready` は処理済みで
// 積まなかったページ。残りのページの進み具合は `enhance-status` で届く。
export interface BatchEnhanceResult {
  key: string
  total: number
  ready: number[]
}

// 超解像キャッシュの使用量と上限(Rust の `EnhanceCacheInfo`、単位はバイト)。
// `minLimitBytes`・`maxLimitBytes` は設定できる上限の範囲。
export interface EnhanceCacheInfo {
  usedBytes: number
  fileCount: number
  limitBytes: number
  minLimitBytes: number
  maxLimitBytes: number
}

// 超解像ジョブの状態(Rust の `EnhanceJobState`)。
export type EnhanceJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

// イベント `enhance-status` の中身(Rust の `EnhanceStatusEvent`)。`message` は失敗したときだけ持つ。
export interface EnhanceStatusEvent {
  bookId: string
  index: number
  key: string
  state: EnhanceJobState
  message?: string
}

// 旧版が残したアプリのデータ領域の `library/` フォルダ(Rust の `LegacyLibraryDir`、サイズはバイト)。
export interface LegacyLibraryDir {
  path: string
  fileCount: number
  totalBytes: number
}
