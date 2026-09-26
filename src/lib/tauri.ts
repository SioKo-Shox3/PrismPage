import { convertFileSrc, invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { toCommandError } from '@/lib/errors'
import { whenSavesSettled } from '@/lib/save-queue'
import type {
  AdjacentBooks,
  BookCollections,
  CollectionBook,
  DirectoryListing,
  EngineCandidate,
  EngineId,
  EngineInstallOption,
  EngineInstallOptionsResponse,
  EngineInstallProgress,
  EngineStatus,
  BatchEnhanceResult,
  EnhanceCacheInfo,
  EnhanceRequestResult,
  EnhanceSettings,
  EnhanceStatusEvent,
  HistoryEntry,
  LegacyLibraryDir,
  LibrarySearchResult,
  LibrarySource,
  OpenedBook,
  Shelf,
  ViewSettings,
} from '@/types/app'

export const isTauriRuntime =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// `VITE_MOCK=1` で起動したブラウザ確認用のモード。command は `tauri-mock.ts` のモックが答える。
export const isMockRuntime = import.meta.env.VITE_MOCK === '1'

// command を呼べる環境か(Tauri 上、またはモック)。
export const hasCommandBackend = isTauriRuntime || isMockRuntime

// command 呼び出しの唯一の出口。モックは動的 import なので、VITE_MOCK 無しのビルドでは
// 条件が定数 false に畳まれてモックのチャンクごと除かれる。
// 失敗は必ず `CommandError`(`code` で種類を判別できる)として投げる。
async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    if (import.meta.env.VITE_MOCK === '1') {
      const { mockInvoke } = await import('./tauri-mock')
      return await mockInvoke<T>(command, args)
    }

    return await invoke<T>(command, args)
  } catch (error) {
    throw toCommandError(error)
  }
}

// 読書状態(読書位置・表示設定・最終閲覧)を返す command の出口。待っている保存がすべて終わってから呼ぶので、
// ビューアを閉じた直後に開き直した本や読み直した一覧が、保存前の古い状態を返さない。
async function callAfterSaves<T>(command: string, args?: InvokeArgs): Promise<T> {
  await whenSavesSettled()
  return call<T>(command, args)
}

// 起動引数・2 つ目の起動・ウィンドウへのドロップで要求され、まだ受け取っていない場所
// (正規化した絶対パス)。受け取ると Rust 側から消える。無ければ null。
export async function takePendingOpenPath() {
  return call<string | null>('take_pending_open_path')
}

// 開きたい場所が積まれたら `handler` を呼ぶ(中身は `takePendingOpenPath` で取り出す)。
// Tauri 上でだけ待ち受け、それ以外は何もしない。
export async function listenOpenRequests(handler: () => void): Promise<UnlistenFn> {
  if (!isTauriRuntime) return () => {}
  return listen('open-path-requested', () => handler())
}

// フォルダまたは画像ファイルを本として開く。画像ファイルなら親フォルダを 1 冊として、その画像から始める。
// `fromStart` なら保存してある読書位置を使わず先頭から始める(次の巻・前の巻へ移るとき)。
export async function openBook(path: string, options: { fromStart?: boolean } = {}) {
  return callAfterSaves<OpenedBook>('open_book', { path, fromStart: options.fromStart ?? false })
}

// 開いた本と同じフォルダで自然順に隣り合う、同じ種類の本(前の巻・次の巻)を求める。
export async function getAdjacentBooks(bookId: string) {
  return call<AdjacentBooks>('get_adjacent_books', { bookId })
}

// ビューアを閉じた本と、前後の巻として表紙を出すために開いた本を手放す。RAR/CBR の一時フォルダはここで消える。
// 開き直す前に外れるよう、保存の完了を待たずに送る。
export async function closeBooks(bookIds: string[]) {
  return call<void>('close_books', { bookIds })
}

// 開いた本の読書位置(表示中の見開きの最初のページ、0 始まり)を保存する。
export async function saveReadingPosition(bookId: string, page: number) {
  return call<void>('save_reading_position', { bookId, page })
}

// 開いた本の表示設定(見開き・綴じ方向・表紙単独)を保存する。次に開くと `OpenedBook.viewSettings` で返る。
export async function saveViewSettings(bookId: string, settings: ViewSettings) {
  return call<void>('save_view_settings', { bookId, settings })
}

// 読み終えていない本を最終閲覧の新しい順に返す(読みかけ)。
export async function listContinueReading() {
  return callAfterSaves<HistoryEntry[]>('list_continue_reading')
}

// 開いた本を最終閲覧の新しい順に返す(履歴)。
export async function listHistory() {
  return callAfterSaves<HistoryEntry[]>('list_history')
}

// 1 冊を履歴から消す(その本の読書位置も消える)。元ファイルには触れない。
export async function removeHistoryEntry(itemId: number) {
  return call<void>('remove_history_entry', { itemId })
}

// 履歴をすべて消す。元ファイルには触れない。
export async function clearHistory() {
  return call<void>('clear_history')
}

// 本棚を並び順(作った順)に返す。
export async function listShelves() {
  return call<Shelf[]>('list_shelves')
}

// 本棚を作る。名前は前後の空白を除き、空・60 文字を超える名前は失敗する。
export async function createShelf(name: string) {
  return call<Shelf>('create_shelf', { name })
}

// 本棚の名前を変える。
export async function renameShelf(shelfId: number, name: string) {
  return call<Shelf>('rename_shelf', { shelfId, name })
}

// 本棚を消す。入っていた本の記録と本のファイルには触れない。
export async function deleteShelf(shelfId: number) {
  return call<void>('delete_shelf', { shelfId })
}

// 本棚の本を入れた順に返す。元が見つからない本も `available: false` で返る。
export async function listShelfBooks(shelfId: number) {
  return callAfterSaves<CollectionBook[]>('list_shelf_books', { shelfId })
}

// お気に入りの本を入れた時刻の新しい順に返す。
export async function listFavorites() {
  return callAfterSaves<CollectionBook[]>('list_favorites')
}

// 本(場所で指す)がお気に入りに入っているかと、入っている本棚を返す。
export async function getBookCollections(path: string) {
  return call<BookCollections>('get_book_collections', { path })
}

// 本を本棚に入れる。入っていれば何もしない。
export async function addToShelf(shelfId: number, path: string) {
  return call<void>('add_to_shelf', { shelfId, path })
}

// 本を本棚から外す。本の記録と本のファイルには触れない。
export async function removeFromShelf(shelfId: number, path: string) {
  return call<void>('remove_from_shelf', { shelfId, path })
}

// 本をお気に入りに入れるか外す。
export async function setFavorite(path: string, favorite: boolean) {
  return call<void>('set_favorite', { path, favorite })
}

// 登録フォルダを登録した順に返す。
export async function listSources() {
  return call<LibrarySource[]>('list_sources')
}

// フォルダを登録する。登録済みのフォルダなら既存の登録が返る。
export async function addSource(path: string) {
  return call<LibrarySource>('add_source', { path })
}

// 登録フォルダを外す(フォルダの中身には触れない)。
export async function removeSource(sourceId: number) {
  return call<void>('remove_source', { sourceId })
}

// 登録フォルダ配下のフォルダの中身を、フォルダと本に分けて返す。`path` を省くと登録フォルダそのもの。
// 登録フォルダの外を指すパスは `outside_source` で失敗する。
export async function listDirectory(sourceId: number, path?: string) {
  return callAfterSaves<DirectoryListing>('list_directory', { sourceId, path: path ?? null })
}

// 登録フォルダ全体の索引から、書名・パスで本とフォルダを探す(大文字小文字・全角半角を問わない部分一致。
// 空白で区切った語はすべて含む項目を返す)。`scope` を渡すとその登録フォルダのそのフォルダの中だけを探す。
export async function searchLibrary(query: string, scope?: { sourceId: number; path?: string }) {
  return callAfterSaves<LibrarySearchResult>('search_library', {
    query,
    sourceId: scope?.sourceId ?? null,
    path: scope?.path ?? null,
  })
}

// ページ画像を配信する URI スキーム(Rust の `protocol::SCHEME`)。
const pageScheme = 'prism'

// 開いた本の `index` 番目(0 始まり)のページ画像の URL。`<img src>` にそのまま渡す。
// Tauri 上では prism スキーム(Windows では `http://prism.localhost/`)を指す。
// `width` を渡すと、その幅(画素)で画像化したページを要求する(PDF だけが幅に合わせ、ほかは元画像)。
// モックでは `public/mock/books/<bookId>/` の合成画像(1 始まり・3 桁)を指し、幅は使わない。
export function pageUrl(bookId: string, index: number, width?: number) {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`ページ番号が不正です: ${index}`)
  }
  if (width !== undefined && (!Number.isInteger(width) || width < 1)) {
    throw new RangeError(`ページの幅が不正です: ${width}`)
  }
  const id = encodeURIComponent(bookId)
  if (import.meta.env.VITE_MOCK === '1') {
    return `/mock/books/${id}/${String(index + 1).padStart(3, '0')}.svg`
  }
  const base = `${pageSchemeBase()}page/${id}/${index}`
  return width === undefined ? base : `${base}/width/${width}`
}

// PDF のページを要求する幅。表示領域の幅に装置の画素比を掛け、少しの大きさの変化で取り直さないよう
// `PDF_WIDTH_STEP` 単位に切り上げ、Rust の上限(`pdf::MAX_RENDER_WIDTH`)で抑える。
// 表示領域の幅が分からないとき(0 以下・非数)は null を返す(幅を指定しない)。
const PDF_WIDTH_STEP = 256
const PDF_MAX_WIDTH = 8192
export function pdfPageWidth(viewportWidth: number, devicePixelRatio: number) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const pixels = viewportWidth * ratio
  if (!Number.isFinite(pixels) || pixels <= 0) return null
  return Math.min(Math.ceil(pixels / PDF_WIDTH_STEP) * PDF_WIDTH_STEP, PDF_MAX_WIDTH)
}

// 本の場所が PDF か(Rust と同じく拡張子で決める)。
export function isPdfPath(path: string) {
  return /\.pdf$/i.test(path)
}

// 開いた本の `index` 番目のページの超解像結果の URL。`key` は `requestEnhancement` が返した版。
// 結果がまだ無ければ Rust 側は元画像を返すので、処理済みと分かったページにだけ使う。
// `revision` は同じ版を作り直したときに読み直させるための番号で、Rust 側は見ない(クエリに載せる)。
// モックでは元の合成画像に版を示す問い合わせを付けたものを指す。
export function enhancedPageUrl(bookId: string, index: number, key: string, revision = 0) {
  const original = pageUrl(bookId, index)
  if (import.meta.env.VITE_MOCK === '1') {
    return `${original}?enhanced=${encodeURIComponent(key)}&r=${revision}`
  }
  return `${original}/enhanced/${encodeURIComponent(key)}?r=${revision}`
}

// 本の表紙サムネイル(長辺 320px の JPEG)の URL。ID は `listDirectory` の結果の `thumbId`。
// 表紙は Rust 側が初めて要求されたときに作ってキャッシュするので、画面に入った項目から要求する。
// モックではサンプルの本の 1 ページ目を指す。
export function thumbUrl(thumbId: string) {
  const id = encodeURIComponent(thumbId)
  if (import.meta.env.VITE_MOCK === '1') {
    return `/mock/books/${id}/001.svg`
  }
  return `${pageSchemeBase()}thumb/${id}`
}

// スキームの根の URL。形が OS で違うので、Tauri の変換に空のパスを渡して根だけを得る。
function pageSchemeBase() {
  if (isTauriRuntime) {
    return convertFileSrc('', pageScheme)
  }
  return `${pageScheme}://localhost/`
}

export async function getEngineStatuses() {
  return call<EngineStatus[]>('get_engine_statuses')
}

export async function detectEngineCandidates() {
  return call<EngineCandidate[]>('detect_engine_candidates')
}

export async function getEngineInstallOptions() {
  return call<EngineInstallOptionsResponse>('get_engine_install_options')
}

export async function registerEngineDirectory(engineId: EngineId, directoryPath: string) {
  return call<EngineStatus>('register_engine_directory', { engineId, directoryPath })
}

export async function importEngineArchive(engineId: EngineId, archivePath: string) {
  return call<EngineStatus>('import_engine_archive', { engineId, archivePath })
}

export async function installEngineFromRelease(option: EngineInstallOption) {
  return call<EngineStatus>('install_engine_from_release', { option })
}

export async function clearEngineRegistration(engineId: EngineId) {
  return call<EngineStatus[]>('clear_engine_registration', { engineId })
}

// エンジンの導入(公式配布の取得・ZIP の取り込み)の進み具合を受ける。返した関数で受けるのをやめる。
export async function listenEngineInstallProgress(
  handler: (event: EngineInstallProgress) => void,
): Promise<UnlistenFn> {
  if (import.meta.env.VITE_MOCK === '1') {
    const { mockListenEngineInstallProgress } = await import('./tauri-mock')
    return mockListenEngineInstallProgress(handler)
  }
  if (!isTauriRuntime) return () => {}
  return listen<EngineInstallProgress>('engine-install-progress', (event) => handler(event.payload))
}

// 表示中(`visible`)と先読み(`prefetch`)のページの超解像を要求する。前の要求の顔ぶれは置き換わり、
// 外れたページのジョブは取り消される。進み具合は `listenEnhanceStatus` で届く。
export async function requestEnhancement(
  bookId: string,
  visible: number[],
  prefetch: number[],
  settings: EnhanceSettings,
) {
  return call<EnhanceRequestResult>('request_enhancement', { bookId, visible, prefetch, settings })
}

// 本の全ページの一括事前処理を始める。処理済みのページは飛ばすので、やめた後にもう一度呼べば続きから。
// 表示中・先読みのページが常に先に処理される。進み具合は `listenEnhanceStatus` で届く。
export async function startBatchEnhancement(bookId: string, settings: EnhanceSettings) {
  return call<BatchEnhanceResult>('start_batch_enhancement', { bookId, settings })
}

// 本の一括事前処理をやめる(表示中・先読みのページの処理は続ける)。
export async function cancelBatchEnhancement(bookId: string) {
  return call<void>('cancel_batch_enhancement', { bookId })
}

// 本の超解像ジョブをすべて取り消す(本を閉じたとき・AI を切ったとき)。
export async function cancelEnhancement(bookId: string) {
  return call<void>('cancel_enhancement', { bookId })
}

// 超解像キャッシュの使用量と上限。
export async function getEnhanceCacheInfo() {
  return call<EnhanceCacheInfo>('get_enhance_cache_info')
}

// 超解像キャッシュの上限を変える。超えている分は古いものから消える。
export async function setEnhanceCacheLimit(limitBytes: number) {
  return call<EnhanceCacheInfo>('set_enhance_cache_limit', { limitBytes })
}

// 超解像キャッシュをすべて消す。
export async function clearEnhanceCache() {
  return call<EnhanceCacheInfo>('clear_enhance_cache')
}

// 超解像ジョブの状態が変わるたびに `handler` を呼ぶ。Tauri 上ではイベント `enhance-status`、
// モックではモックの模擬処理から届く。それ以外は何もしない。
export async function listenEnhanceStatus(
  handler: (event: EnhanceStatusEvent) => void,
): Promise<UnlistenFn> {
  if (import.meta.env.VITE_MOCK === '1') {
    const { mockListenEnhanceStatus } = await import('./tauri-mock')
    return mockListenEnhanceStatus(handler)
  }
  if (!isTauriRuntime) return () => {}
  return listen<EnhanceStatusEvent>('enhance-status', (event) => handler(event.payload))
}

// 旧版が残したアプリのデータ領域の `library/` フォルダ。無ければ null。
export async function getLegacyLibraryDir() {
  return call<LegacyLibraryDir | null>('get_legacy_library_dir')
}

// 旧版が残したアプリのデータ領域の `library/` フォルダを消す(ほかのデータには触れない)。
export async function deleteLegacyLibraryDir() {
  return call<void>('delete_legacy_library_dir')
}
