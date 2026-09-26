import type { InvokeArgs } from '@tauri-apps/api/core'

import { engineOptions } from '@/lib/engines'
import type { AppErrorPayload } from '@/types/error'
import type {
  AdjacentBooks,
  BookCollections,
  BookFormat,
  CollectionBook,
  DirectoryEntry,
  DirectoryListing,
  EngineCandidate,
  EngineId,
  EngineInstallOption,
  EngineInstallOptionsResponse,
  EngineInstallProgress,
  EngineInstallStage,
  EngineStatus,
  BatchEnhanceResult,
  EnhanceCacheInfo,
  EnhanceRequestResult,
  EnhanceSettings,
  EnhanceStatusEvent,
  HistoryEntry,
  LegacyLibraryDir,
  LibrarySearchHit,
  LibrarySearchResult,
  LibrarySource,
  OpenedBook,
  PageInfo,
  Shelf,
  ViewSettings,
} from '@/types/app'

// ブラウザ確認用(`VITE_MOCK=1`)の command モック。Rust 側の command と同じ名前・同じ引数で答える。
// 状態はメモリにだけ持ち、再読み込みで初期状態へ戻る。ファイルにも Rust にも触れない。
// サンプルの本と合成したページ画像は `public/mock/` にある(`scripts/generate-mock-assets.mjs` が生成)。

const mockEngineRoot = 'C:\\PrismPageMock\\engines'

const downloadUrls: Record<EngineId, string> = {
  'real-cugan': 'https://github.com/nihui/realcugan-ncnn-vulkan/releases',
  waifu2x: 'https://github.com/nihui/waifu2x-ncnn-vulkan/releases',
  'real-esrgan': 'https://github.com/xinntao/Real-ESRGAN/releases',
}

function unconfiguredStatus(engineId: EngineId, label: string): EngineStatus {
  return {
    id: engineId,
    label,
    configured: false,
    ready: false,
    downloadUrl: downloadUrls[engineId],
    notes: ['モック: 未登録のエンジン'],
  }
}

function configuredStatus(engineId: EngineId, label: string, source: string): EngineStatus {
  const directory = `${mockEngineRoot}\\${engineId}`
  return {
    id: engineId,
    label,
    configured: true,
    ready: true,
    executablePath: `${directory}\\${engineId}-ncnn-vulkan.exe`,
    modelPath: `${directory}\\models`,
    modelName: 'models-se',
    source,
    downloadUrl: downloadUrls[engineId],
    notes: ['モック: 登録済みとして扱うエンジン'],
  }
}

// 初期状態は Real-CUGAN だけ登録済み。登録済み・未登録の両方の表示を確かめられるようにする。
let statuses: EngineStatus[] = engineOptions.map(({ id, label }) =>
  id === 'real-cugan' ? configuredStatus(id, label, 'mock') : unconfiguredStatus(id, label),
)

function labelOf(engineId: EngineId) {
  return engineOptions.find((engine) => engine.id === engineId)?.label ?? engineId
}

function replaceStatus(status: EngineStatus) {
  statuses = statuses.map((entry) => (entry.id === status.id ? status : entry))
  return status
}

// Rust の command と同じく、失敗は `{ code, message }` で投げる。
function appError(code: AppErrorPayload['code'], message: string): AppErrorPayload {
  return { code, message }
}

function argsRecord(args?: InvokeArgs): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args) && !ArrayBuffer.isView(args)) {
    return args as Record<string, unknown>
  }
  return {}
}

function requireEngineId(args: Record<string, unknown>): EngineId {
  const engineId = args.engineId
  if (typeof engineId === 'string' && engineOptions.some((engine) => engine.id === engineId)) {
    return engineId as EngineId
  }
  throw appError('failed', `モック: 未知のエンジン ID です: ${String(engineId)}`)
}

function detectCandidates(): EngineCandidate[] {
  return statuses
    .filter((status) => !status.configured)
    .slice(0, 1)
    .map((status) => ({
      id: status.id,
      label: status.label,
      directoryPath: `${mockEngineRoot}\\found\\${status.id}`,
      executablePath: `${mockEngineRoot}\\found\\${status.id}\\${status.id}-ncnn-vulkan.exe`,
      modelPath: `${mockEngineRoot}\\found\\${status.id}\\models`,
      source: 'mock-detected',
    }))
}

function installOptions(): EngineInstallOptionsResponse {
  const options: EngineInstallOption[] = statuses
    .filter((status) => !status.configured)
    .map((status) => ({
      engineId: status.id,
      label: status.label,
      releaseName: `${status.label} mock release`,
      releaseTag: 'v0.0.0-mock',
      assetName: `${status.id}-windows.zip`,
      downloadUrl: status.downloadUrl,
      size: 48 * 1024 * 1024,
    }))
  return { options, warnings: [] }
}

// エンジンの導入の進み具合。Rust と同じ段階を、画面で見える程度の間隔で流す。
const installListeners = new Set<(event: EngineInstallProgress) => void>()

export function mockListenEngineInstallProgress(handler: (event: EngineInstallProgress) => void) {
  installListeners.add(handler)
  return () => {
    installListeners.delete(handler)
  }
}

async function mockInstallProgress(engineId: EngineId, stages: EngineInstallStage[], size: number) {
  const emit = (stage: EngineInstallStage, done: number, total: number) => {
    for (const listener of installListeners) listener({ engineId, stage, done, total })
  }
  const wait = () => new Promise((resolve) => setTimeout(resolve, 200))
  for (const stage of stages) {
    const total = stage === 'downloading' ? size : stage === 'extracting' ? 120 : 0
    const steps = total > 0 ? 4 : 1
    for (let step = 0; step < steps; step += 1) {
      emit(stage, Math.round((total * step) / steps), total)
      await wait()
    }
    if (total > 0) emit(stage, total, total)
  }
}

interface MockLibraryBook {
  id: string
  title: string
  kind: string
  direction?: string
  pages: string[]
  // 全ページの寸法。無ければ各ページの SVG から読む(性能の計測では SVG でない合成画像を差し込むので指定する)。
  pageSize?: { width: number; height: number }
}

// 本ごとに保存した読書位置と表示設定(`save_reading_position`・`save_view_settings`)。
const savedBooks = new Map<string, { page?: number; view?: ViewSettings }>()

function requireBookId(args: Record<string, unknown>): string {
  const { bookId } = args
  if (typeof bookId !== 'string' || bookId.length === 0) {
    throw appError('book_not_open', '本が開かれていません。もう一度開いてください。')
  }
  return bookId
}

// モックでは `path` をサンプルの本の ID(`public/mock/library.json` の `id`)として扱う。
// 登録フォルダの一覧に載せた本の場所なら、その本が指すサンプルの本を開く。
// ページの寸法は合成 SVG の width / height 属性から読む。
async function openMockBook(path: unknown, fromStart: boolean): Promise<OpenedBook> {
  if (typeof path !== 'string' || path.length === 0) {
    throw appError('not_found', '開く本のパスがありません。')
  }
  const books = await mockLibrary()
  const mockId = findMockBookId(path)
  const book = books.find(
    (candidate) =>
      mockId === candidate.id || path === candidate.id || path.endsWith(`/${candidate.id}`),
  )
  if (!book) {
    throw appError('not_found', `モックに無い本です: ${path}`)
  }
  const { pageSize } = book
  const pages = pageSize
    ? book.pages.map((url) => ({ name: url.slice(url.lastIndexOf('/') + 1), ...pageSize }))
    : await Promise.all(book.pages.map(mockPageInfo))
  const saved = savedBooks.get(book.id)
  const startIndex = fromStart ? 0 : Math.min(saved?.page ?? 0, Math.max(0, pages.length - 1))
  const opened: OpenedBook = { bookId: book.id, title: book.title, startIndex, pages }
  openedPageCounts.set(book.id, pages.length)
  recordMockOpened(path, book, startIndex)
  if (saved?.view) opened.viewSettings = saved.view
  // Rust と同じく、綴じ方向は EPUB が指定したときだけ載せる(フォルダ・アーカイブはキー自体が無い)。
  if (book.kind === 'epub' && (book.direction === 'ltr' || book.direction === 'rtl')) {
    opened.pageProgression = book.direction
  }
  return opened
}

async function mockLibrary(): Promise<MockLibraryBook[]> {
  return ((await (await fetch('/mock/library.json')).json()) as { books: MockLibraryBook[] }).books
}

// モックの隣の本。画面を確かめられるよう、種類を問わず `library.json` の並びを 1 つのフォルダと見なす。
async function mockAdjacentBooks(bookId: string): Promise<AdjacentBooks> {
  const books = await mockLibrary()
  const index = books.findIndex((book) => book.id === bookId)
  if (index < 0) throw appError('book_not_open', '本が開かれていません。もう一度開いてください。')
  const toAdjacent = (book: MockLibraryBook | undefined) =>
    book ? { bookId: book.id, title: book.title, path: book.id } : null
  return { previous: toAdjacent(books[index - 1]), next: toAdjacent(books[index + 1]) }
}

async function mockPageInfo(url: string): Promise<PageInfo> {
  const svg = await (await fetch(url)).text()
  const width = Number(/\swidth="(\d+)"/.exec(svg)?.[1] ?? 0)
  const height = Number(/\sheight="(\d+)"/.exec(svg)?.[1] ?? 0)
  return { name: url.slice(url.lastIndexOf('/') + 1), width, height }
}

// 登録フォルダの模擬。フォルダの木はメモリ上の固定の内容で、本の項目は `library.json` のサンプルの本を指す。
// 本は Rust と同じくどの形式も開ける本として載せる(PDF もサンプルの本を指す)。
interface MockNode {
  name: string
  // 本のときの形式と、開いたときに出すサンプルの本の ID。
  book?: { format: BookFormat; mockId?: string }
  children?: MockNode[]
}

const mockSourceRoot = 'C:\\PrismPageMock\\蔵書'

const magazineIssues: MockNode[] = Array.from({ length: 30 }, (_, index) => ({
  name: `月刊 色見本 第${index + 1}号`,
  book: { format: 'folder', mockId: 'sample-artbook' },
}))

const mockTrees = new Map<string, MockNode[]>([
  [
    mockSourceRoot,
    [
      {
        name: '漫画',
        children: [
          {
            name: '光の階段',
            children: [
              { name: '試し読み 光の階段.epub', book: { format: 'epub', mockId: 'sample-manga' } },
              { name: '走査の練習帳.cbz', book: { format: 'zip', mockId: 'sample-scan' } },
              { name: '古い合本.rar', book: { format: 'rar', mockId: 'sample-scan' } },
            ],
          },
          { name: '短編集', children: [] },
        ],
      },
      {
        name: '画集',
        children: [
          { name: '色見本帳', book: { format: 'folder', mockId: 'sample-artbook' } },
          { name: '資料集.pdf', book: { format: 'pdf', mockId: 'sample-artbook' } },
        ],
      },
      { name: '雑誌', children: magazineIssues },
      { name: '単話 光の階段 番外編.epub', book: { format: 'epub', mockId: 'sample-manga' } },
    ],
  ],
])

// 性能の計測(`scripts/perf`)用のフォルダ。localStorage の `prismpage-mock-perf` が '1' のときだけ、
// 登録フォルダの直下に `perf-long`(計測が library.json に差し込む本)を 1,000 冊並べたフォルダを足す。
const PERF_FLAG_KEY = 'prismpage-mock-perf'
const PERF_BOOK_COUNT = 1000

function mockRootNodes(source: LibrarySource): MockNode[] {
  const nodes = mockTrees.get(source.displayPath) ?? []
  let perf = false
  try {
    perf = localStorage.getItem(PERF_FLAG_KEY) === '1'
  } catch {
    // localStorage を使えない環境では足さない。
  }
  if (!perf || source.displayPath !== mockSourceRoot) return nodes
  const books: MockNode[] = Array.from({ length: PERF_BOOK_COUNT }, (_, index) => ({
    name: `計測用の本 ${index + 1}.cbz`,
    book: { format: 'zip', mockId: 'perf-long' },
  }))
  return [...nodes, { name: '負荷試験', children: books }]
}

let nextSourceId = 2
let sources: LibrarySource[] = [
  {
    id: 1,
    path: `\\\\?\\${mockSourceRoot}`,
    displayPath: mockSourceRoot,
    name: '蔵書',
    addedAt: Date.UTC(2026, 8, 1),
  },
]

function requireSource(sourceId: unknown): LibrarySource {
  const source = sources.find((candidate) => candidate.id === sourceId)
  if (!source) throw appError('source_not_found', '登録フォルダが見つかりません。')
  return source
}

// 登録フォルダからの相対パス(`/` か `\` 区切り)をたどる。`..` と外を指す絶対パスは Rust と同じく拒否する。
function mockListDirectory(sourceId: unknown, path: unknown): DirectoryListing {
  const source = requireSource(sourceId)
  let relative = typeof path === 'string' ? path : ''
  if (relative.startsWith(source.path)) relative = relative.slice(source.path.length)
  else if (/^[a-zA-Z]:|^\\\\/.test(relative)) throw appError('outside_source', '登録フォルダの外です。')
  const segments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.includes('..')) throw appError('outside_source', '登録フォルダの外です。')

  let nodes = mockRootNodes(source)
  for (const segment of segments) {
    const folder = nodes.find((node) => node.name === segment && node.children)
    if (!folder?.children) throw appError('not_found', `フォルダが見つかりません: ${segment}`)
    nodes = folder.children
  }
  const directory = [source.path, ...segments].join('\\')
  const collator = new Intl.Collator('ja', { numeric: true })
  const entries: DirectoryEntry[] = nodes.map((node) => {
    const entryPath = `${directory}\\${node.name}`
    const history = node.book ? mockHistory.find((item) => item.entry.path === entryPath)?.entry : undefined
    return {
      name: node.name,
      title: node.book && node.book.format !== 'folder' ? node.name.replace(/\.[^.]+$/, '') : node.name,
      path: entryPath,
      kind: node.book ? 'book' : 'folder',
      format: node.book?.format ?? null,
      openable: node.book ? node.book.mockId !== undefined : false,
      thumbId: node.book?.mockId ?? null,
      modifiedAt: mockModifiedAt(node.name),
      page: history?.page ?? null,
      pageCount: history?.pageCount ?? null,
      lastReadAt: history?.lastReadAt ?? null,
    }
  })
  entries.sort(
    (a, b) =>
      Number(a.kind === 'book') - Number(b.kind === 'book') || collator.compare(a.name, b.name),
  )
  return { sourceId: source.id, path: directory, segments, entries }
}

// 検索の正規化(Rust の `fold_for_search` の代わり。モックでは NFKC で全角半角をそろえる)。
function foldForSearch(text: string) {
  return text.normalize('NFKC').toLowerCase()
}

// 登録フォルダの木をたどって、書名・相対パスに検索語をすべて含む項目を返す(画像フォルダの中はたどらない)。
function mockSearchLibrary(query: unknown, sourceId: unknown, path: unknown): LibrarySearchResult {
  const terms = foldForSearch(typeof query === 'string' ? query : '')
    .split(/\s+/)
    .filter((term) => term.length > 0)
  if (sourceId !== null && sourceId !== undefined) requireSource(sourceId)
  const within =
    typeof path === 'string' ? path.split(/[\\/]+/).filter((segment) => segment.length > 0).join('/') : ''
  const hits: { byTitle: boolean; relative: string; hit: LibrarySearchHit }[] = []
  const visit = (source: LibrarySource, nodes: MockNode[], folder: string) => {
    for (const node of nodes) {
      const relative = folder ? `${folder}/${node.name}` : node.name
      const title = node.book && node.book.format !== 'folder' ? node.name.replace(/\.[^.]+$/, '') : node.name
      const inside = within === '' || folder === within || folder.startsWith(`${within}/`)
      const pathKey = foldForSearch(relative)
      if (inside && terms.length > 0 && terms.every((term) => pathKey.includes(term))) {
        hits.push({
          byTitle: terms.every((term) => foldForSearch(title).includes(term)),
          relative,
          hit: {
            sourceId: source.id,
            sourceName: source.name,
            name: node.name,
            title,
            path: [source.path, ...relative.split('/')].join('\\'),
            folder,
            kind: node.book ? 'book' : 'folder',
            format: node.book?.format ?? null,
            openable: node.book ? node.book.mockId !== undefined : true,
            thumbId: node.book?.mockId ?? null,
          },
        })
      }
      if (node.children) visit(source, node.children, relative)
    }
  }
  for (const source of sources) {
    if (sourceId !== null && sourceId !== undefined && source.id !== sourceId) continue
    visit(source, mockTrees.get(source.displayPath) ?? [], '')
  }
  const collator = new Intl.Collator('ja', { numeric: true })
  hits.sort((a, b) => Number(b.byTitle) - Number(a.byTitle) || collator.compare(a.relative, b.relative))
  return { hits: hits.slice(0, 300).map((item) => item.hit), truncated: hits.length > 300, indexing: false }
}

// 名前から決まる模擬の更新日時(2026 年 9 月 20 日から 0〜399 日前)。同じ名前はいつも同じ日時になる。
function mockModifiedAt(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return Date.UTC(2026, 8, 20) - (hash % 400) * 24 * 60 * 60 * 1000
}

// 本の場所から、その本が指すサンプルの本の ID を引く。
function findMockBookId(path: string): string | undefined {
  for (const source of sources) {
    if (!path.startsWith(`${source.path}\\`)) continue
    const segments = path.slice(source.path.length + 1).split('\\')
    let nodes = mockRootNodes(source)
    for (const [index, segment] of segments.entries()) {
      const node = nodes.find((candidate) => candidate.name === segment)
      if (!node) return undefined
      if (index === segments.length - 1) return node.book?.mockId
      nodes = node.children ?? []
    }
  }
  return undefined
}

// 履歴の模擬。最初は読みかけ 3 冊・読み終えた本 1 冊・見つからなくなった本 1 冊を載せる。
// 本を開くと先頭へ移り、読書位置の保存でページが進む。表紙の `thumbId` はサンプルの本の ID。
interface MockHistoryItem {
  entry: HistoryEntry
  mockId?: string
}

const hour = 60 * 60 * 1000
let nextHistoryId = 1
let mockHistory: MockHistoryItem[] = [
  mockHistoryItem(['漫画', '光の階段', '試し読み 光の階段.epub'], 'epub', 'sample-manga', 3, 8, 2 * hour),
  mockHistoryItem(['雑誌', '月刊 色見本 第3号'], 'folder', 'sample-artbook', 1, 6, 26 * hour),
  mockHistoryItem(['漫画', '光の階段', '走査の練習帳.cbz'], 'zip', 'sample-scan', 2, 6, 3 * 24 * hour),
  mockHistoryItem(['画集', '色見本帳'], 'folder', 'sample-artbook', 5, 6, 4 * 24 * hour),
  mockHistoryItem(['漫画', '手放した本 第1巻.cbz'], 'zip', undefined, 12, 40, 21 * 24 * hour),
]

function mockHistoryItem(
  segments: string[],
  format: BookFormat,
  mockId: string | undefined,
  page: number,
  pageCount: number,
  age: number,
): MockHistoryItem {
  const name = segments.at(-1) ?? ''
  const folderSegments = segments.slice(0, -1)
  const folderPath = [mockSourceRoot, ...folderSegments].join('\\')
  return {
    mockId,
    entry: {
      itemId: nextHistoryId++,
      name,
      title: format === 'folder' ? name : name.replace(/\.[^.]+$/, ''),
      path: `\\\\?\\${folderPath}\\${name}`,
      format,
      folder: folderSegments.at(-1) ?? '蔵書',
      folderPath,
      page,
      pageCount,
      lastReadAt: Date.now() - age,
      available: mockId !== undefined,
      thumbId: mockId ?? null,
    },
  }
}

function sortedHistory() {
  return [...mockHistory].sort((a, b) => b.entry.lastReadAt - a.entry.lastReadAt)
}

// 本を開いたことを履歴に残す(Rust の `record_opened` と同じく、記録があれば最終閲覧だけを進める)。
function recordMockOpened(path: string, book: MockLibraryBook, startIndex: number) {
  const existing = mockHistory.find((item) => item.entry.path === path)
  if (existing) {
    existing.entry = { ...existing.entry, lastReadAt: Date.now(), pageCount: book.pages.length }
    return
  }
  const name = path.slice(path.lastIndexOf('\\') + 1)
  const folderPath = path.slice(0, Math.max(0, path.lastIndexOf('\\'))).replace(/^\\\\\?\\/, '')
  mockHistory.push({
    mockId: book.id,
    entry: {
      itemId: nextHistoryId++,
      name,
      title: book.title,
      path,
      format: book.kind === 'epub' ? 'epub' : book.kind === 'folder' ? 'folder' : 'zip',
      folder: folderPath.slice(folderPath.lastIndexOf('\\') + 1),
      folderPath,
      page: startIndex,
      pageCount: book.pages.length,
      lastReadAt: Date.now(),
      available: true,
      thumbId: book.id,
    },
  })
}

// 読書位置の保存を、その本を最後に開いた履歴に反映する。
function saveMockHistoryPage(bookId: string, page: number) {
  const item = sortedHistory().find((candidate) => candidate.mockId === bookId)
  if (item) item.entry = { ...item.entry, page, lastReadAt: Date.now() }
}

function mockContinueReading(): HistoryEntry[] {
  return sortedHistory()
    .map((item) => item.entry)
    .filter((entry) => entry.pageCount === null || entry.page + 1 < entry.pageCount)
}

// 本棚とお気に入りの模擬。本は場所で指し、サンプルの本の ID(場所を持たずに開いたビューア)はその本の場所に読み替える。
// 最初は本棚 3 つ(1 つは空)とお気に入り 2 冊を載せ、見つからなくなった本と、まだ開けない形式の本も棚に置く。
interface MockCollectionItem {
  itemId: number
  path: string
  name: string
  title: string
  format: BookFormat
  mockId?: string
  available: boolean
}

const mockRootPath = `\\\\?\\${mockSourceRoot}`

function mockBookPath(...segments: string[]) {
  return [mockRootPath, ...segments].join('\\')
}

const missingBookPath = mockBookPath('漫画', '手放した本 第1巻.cbz')
let nextItemId = 100
const mockItems: MockCollectionItem[] = [
  {
    itemId: nextItemId++,
    path: missingBookPath,
    name: '手放した本 第1巻.cbz',
    title: '手放した本 第1巻',
    format: 'zip',
    available: false,
  },
]

// 木の中の本の節を場所から引く。
function findMockNode(path: string): MockNode | undefined {
  for (const source of sources) {
    if (!path.startsWith(`${source.path}\\`)) continue
    let nodes = mockTrees.get(source.displayPath) ?? []
    const segments = path.slice(source.path.length + 1).split('\\')
    for (const [index, segment] of segments.entries()) {
      const node = nodes.find((candidate) => candidate.name === segment)
      if (!node) return undefined
      if (index === segments.length - 1) return node
      nodes = node.children ?? []
    }
  }
  return undefined
}

// サンプルの本の ID を、その本を指す木の中の最初の場所にする。場所ならそのまま返す。
function resolveMockPath(path: string): string {
  if (path.includes('\\')) return path
  const walk = (nodes: MockNode[], prefix: string): string | undefined => {
    for (const node of nodes) {
      const current = `${prefix}\\${node.name}`
      if (node.book?.mockId === path) return current
      const found = node.children ? walk(node.children, current) : undefined
      if (found) return found
    }
    return undefined
  }
  return walk(mockTrees.get(mockSourceRoot) ?? [], mockRootPath) ?? path
}

// 記録してある本を探す。`create` なら記録が無い本の記録を作る(木に無い場所は失敗)。
function mockItemFor(path: unknown, create: boolean): MockCollectionItem | undefined {
  if (typeof path !== 'string') throw appError('not_found', '本の場所がありません。')
  const resolved = resolveMockPath(path)
  const existing = mockItems.find((item) => item.path === resolved)
  if (existing || !create) return existing
  const node = findMockNode(resolved)
  if (!node?.book) throw appError('not_found', `本が見つかりません: ${resolved}`)
  const item: MockCollectionItem = {
    itemId: nextItemId++,
    path: resolved,
    name: node.name,
    title: node.book.format === 'folder' ? node.name : node.name.replace(/\.[^.]+$/, ''),
    format: node.book.format,
    mockId: node.book.mockId,
    available: true,
  }
  mockItems.push(item)
  return item
}

function requireMockItem(path: unknown) {
  const item = mockItemFor(path, true)
  if (!item) throw appError('not_found', '本が見つかりません。')
  return item
}

interface MockShelved {
  itemId: number
  addedAt: number
}

interface MockShelf {
  shelf: Omit<Shelf, 'bookCount'>
  items: MockShelved[]
}

let nextShelfId = 1
const mockShelves: MockShelf[] = []
const mockFavorites: MockShelved[] = []

function seedMockShelf(name: string, paths: string[], age: number) {
  const shelf = { id: nextShelfId++, name, createdAt: Date.now() - age }
  const items = paths.map((path, index) => ({
    itemId: requireMockItem(path).itemId,
    addedAt: shelf.createdAt + index,
  }))
  mockShelves.push({ shelf, items })
}

seedMockShelf(
  '光の階段',
  [
    mockBookPath('漫画', '光の階段', '試し読み 光の階段.epub'),
    mockBookPath('漫画', '光の階段', '走査の練習帳.cbz'),
    missingBookPath,
    mockBookPath('漫画', '光の階段', '古い合本.rar'),
    mockBookPath('単話 光の階段 番外編.epub'),
  ],
  10 * 24 * hour,
)
seedMockShelf(
  '画集と資料',
  [
    mockBookPath('画集', '色見本帳'),
    mockBookPath('画集', '資料集.pdf'),
    mockBookPath('雑誌', '月刊 色見本 第3号'),
  ],
  8 * 24 * hour,
)
seedMockShelf('あとで読む', [], 2 * 24 * hour)
for (const [index, path] of [
  mockBookPath('画集', '色見本帳'),
  mockBookPath('漫画', '光の階段', '試し読み 光の階段.epub'),
  missingBookPath,
].entries()) {
  mockFavorites.push({ itemId: requireMockItem(path).itemId, addedAt: Date.now() - (index + 1) * hour })
}

function requireMockShelf(shelfId: unknown) {
  const entry = mockShelves.find((candidate) => candidate.shelf.id === shelfId)
  if (!entry) throw appError('shelf_not_found', '本棚が見つかりません。消された可能性があります。')
  return entry
}

function mockShelfName(name: unknown) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length === 0) throw appError('failed', '本棚の名前を入力してください。')
  if ([...trimmed].length > 60) throw appError('failed', '本棚の名前は 60 文字以内にしてください。')
  return trimmed
}

function toMockShelf(entry: MockShelf): Shelf {
  return { ...entry.shelf, bookCount: entry.items.length }
}

function toCollectionBook({ itemId, addedAt }: MockShelved): CollectionBook {
  const item = mockItems.find((candidate) => candidate.itemId === itemId)
  if (!item) throw appError('internal', `本の記録がありません: ${itemId}`)
  const history = mockHistory.find((candidate) => candidate.entry.path === item.path)?.entry
  const folderPath = item.path.slice(0, item.path.lastIndexOf('\\')).replace(/^\\\\\?\\/, '')
  return {
    itemId,
    name: item.name,
    title: item.title,
    path: item.path,
    format: item.format,
    folder: folderPath.slice(folderPath.lastIndexOf('\\') + 1),
    folderPath,
    page: history?.page ?? null,
    pageCount: history?.pageCount ?? null,
    lastReadAt: history?.lastReadAt ?? null,
    addedAt,
    available: item.available,
    thumbId: item.available ? (item.mockId ?? null) : null,
    modifiedAt: item.available ? mockModifiedAt(item.name) : null,
  }
}

function mockBookCollections(path: unknown): BookCollections {
  const item = mockItemFor(path, false)
  if (!item) return { favorite: false, shelfIds: [] }
  return {
    favorite: mockFavorites.some((favorite) => favorite.itemId === item.itemId),
    shelfIds: mockShelves
      .filter((entry) => entry.items.some((shelved) => shelved.itemId === item.itemId))
      .map((entry) => entry.shelf.id),
  }
}

const notHandled = Symbol('notHandled')

// 本棚・お気に入りの command に答える。それ以外の command なら `notHandled`。
function mockCollectionCommand(command: string, record: Record<string, unknown>): unknown {
  switch (command) {
    case 'list_shelves':
      return mockShelves.map(toMockShelf)
    case 'create_shelf': {
      const entry: MockShelf = {
        shelf: { id: nextShelfId++, name: mockShelfName(record.name), createdAt: Date.now() },
        items: [],
      }
      mockShelves.push(entry)
      return toMockShelf(entry)
    }
    case 'rename_shelf': {
      const entry = requireMockShelf(record.shelfId)
      entry.shelf = { ...entry.shelf, name: mockShelfName(record.name) }
      return toMockShelf(entry)
    }
    case 'delete_shelf':
      mockShelves.splice(mockShelves.indexOf(requireMockShelf(record.shelfId)), 1)
      return undefined
    case 'list_shelf_books':
      return requireMockShelf(record.shelfId).items.map(toCollectionBook)
    case 'list_favorites':
      return [...mockFavorites].sort((a, b) => b.addedAt - a.addedAt).map(toCollectionBook)
    case 'get_book_collections':
      return mockBookCollections(record.path)
    case 'add_to_shelf': {
      const entry = requireMockShelf(record.shelfId)
      const item = requireMockItem(record.path)
      if (!entry.items.some((shelved) => shelved.itemId === item.itemId)) {
        entry.items.push({ itemId: item.itemId, addedAt: Date.now() })
      }
      return undefined
    }
    case 'remove_from_shelf': {
      const item = mockItemFor(record.path, false)
      const entry = mockShelves.find((candidate) => candidate.shelf.id === record.shelfId)
      if (item && entry) entry.items = entry.items.filter((shelved) => shelved.itemId !== item.itemId)
      return undefined
    }
    case 'set_favorite': {
      const item = record.favorite ? requireMockItem(record.path) : mockItemFor(record.path, false)
      if (!item) return undefined
      const index = mockFavorites.findIndex((favorite) => favorite.itemId === item.itemId)
      if (record.favorite && index < 0) mockFavorites.push({ itemId: item.itemId, addedAt: Date.now() })
      if (!record.favorite && index >= 0) mockFavorites.splice(index, 1)
      return undefined
    }
    default:
      return notHandled
  }
}

function mockAddSource(path: unknown): LibrarySource {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw appError('not_found', 'フォルダのパスがありません。')
  }
  const displayPath = path.trim().replace(/[\\/]+$/, '').replaceAll('/', '\\')
  const existing = sources.find((source) => source.displayPath === displayPath)
  if (existing) return existing
  const source: LibrarySource = {
    id: nextSourceId++,
    path: `\\\\?\\${displayPath}`,
    displayPath,
    name: displayPath.slice(displayPath.lastIndexOf('\\') + 1),
    addedAt: Date.now(),
  }
  sources = [...sources, source]
  return source
}

// 超解像の模擬処理。要求されたページを表示中 → 先読みの順に 1 ページずつ「実行中 → 完了」にしてイベントを流す。
// 新しい要求で外れたページは取り消す。処理結果はメモリにだけ覚え、画像は元の合成画像のまま。
const enhanceListeners = new Set<(event: EnhanceStatusEvent) => void>()
const enhancedPages = new Set<string>()
const enhanceStepMs = 150
interface MockEnhanceJob {
  bookId: string
  index: number
  key: string
}
// 表示中・先読みの列と、一括事前処理の列。一括は表示中・先読みの列が空のときだけ進む。
let enhanceQueue: MockEnhanceJob[] = []
let enhanceBatch: MockEnhanceJob[] = []
// 開いた本のページ数(一括事前処理の全ページ数に使う)。
const openedPageCounts = new Map<string, number>()
let enhanceTimer: ReturnType<typeof setTimeout> | null = null

export function mockListenEnhanceStatus(handler: (event: EnhanceStatusEvent) => void) {
  enhanceListeners.add(handler)
  return () => {
    enhanceListeners.delete(handler)
  }
}

function emitEnhanceStatus(event: EnhanceStatusEvent) {
  for (const listener of enhanceListeners) listener(event)
}

function enhancedPageId(bookId: string, index: number, key: string) {
  return `${bookId}/${index}/${key}`
}

function mockEnhanceKey(settings: EnhanceSettings) {
  const denoise = settings.denoise === undefined ? 'dnone' : settings.denoise < 0 ? 'dm1' : `d${settings.denoise}`
  return `${settings.engine}-${settings.model.replace(/[^a-z0-9]/gi, '').slice(0, 12)}-mock-x${settings.scale}-${denoise}`
}

function nextMockEnhanceJob() {
  return enhanceQueue[0] ?? enhanceBatch[0]
}

function runMockEnhanceQueue() {
  if (enhanceTimer !== null) return
  const job = nextMockEnhanceJob()
  if (!job) return
  emitEnhanceStatus({ ...job, state: 'running' })
  enhanceTimer = setTimeout(() => {
    enhanceTimer = null
    if (nextMockEnhanceJob() !== job) {
      // 表示中のページに譲った一括のジョブは積み直しに戻す(Rust と同じく取り消しにはしない)。
      if (enhanceBatch.includes(job)) emitEnhanceStatus({ ...job, state: 'queued' })
      runMockEnhanceQueue()
      return
    }
    const id = enhancedPageId(job.bookId, job.index, job.key)
    enhanceQueue = enhanceQueue.filter((entry) => entry !== job)
    enhanceBatch = enhanceBatch.filter((entry) => enhancedPageId(entry.bookId, entry.index, entry.key) !== id)
    enhancedPages.add(id)
    emitEnhanceStatus({ ...job, state: 'done' })
    runMockEnhanceQueue()
  }, enhanceStepMs)
}

// 超解像キャッシュの模擬。上限を下げると使用量も上限まで減ったことにする。
const mebibyte = 1024 * 1024
let enhanceCache: EnhanceCacheInfo = {
  usedBytes: 734 * mebibyte,
  fileCount: 186,
  limitBytes: 2048 * mebibyte,
  minLimitBytes: 256 * mebibyte,
  maxLimitBytes: 1024 * 1024 * mebibyte,
}

function mockSetEnhanceCacheLimit(record: Record<string, unknown>): EnhanceCacheInfo {
  const limitBytes = Number(record.limitBytes)
  if (!(limitBytes >= enhanceCache.minLimitBytes && limitBytes <= enhanceCache.maxLimitBytes)) {
    throw appError('failed', 'キャッシュの上限は 256 MB から 1 TB の間で指定してください。')
  }
  const usedBytes = Math.min(enhanceCache.usedBytes, limitBytes)
  const fileCount = Math.round((enhanceCache.fileCount * usedBytes) / Math.max(1, enhanceCache.usedBytes))
  enhanceCache = { ...enhanceCache, limitBytes, usedBytes, fileCount }
  return enhanceCache
}

// 旧版が残した `library/` フォルダ。設定画面の削除の確認のため、最初はあることにする。
let legacyLibraryDir: LegacyLibraryDir | null = {
  path: String.raw`C:\Users\user\AppData\Roaming\com.sioko.prismpage\library`,
  fileCount: 128,
  totalBytes: 18_400_000,
}

function mockClearEnhanceCache(): EnhanceCacheInfo {
  enhancedPages.clear()
  enhanceCache = { ...enhanceCache, usedBytes: 0, fileCount: 0 }
  return enhanceCache
}

function mockRequestEnhancement(record: Record<string, unknown>): EnhanceRequestResult {
  const bookId = requireBookId(record)
  const settings = record.settings as EnhanceSettings
  const status = statuses.find((candidate) => candidate.id === settings.engine)
  if (!status?.ready) {
    throw appError('failed', `${labelOf(settings.engine)} が登録されていません。設定の AI 超解像から登録してください。`)
  }
  const key = mockEnhanceKey(settings)
  const wanted = [...(record.visible as number[]), ...(record.prefetch as number[])]
  const ready: number[] = []
  const pending: number[] = []
  for (const index of wanted) {
    if (ready.includes(index) || pending.includes(index)) continue
    if (enhancedPages.has(enhancedPageId(bookId, index, key))) ready.push(index)
    else pending.push(index)
  }
  const kept = enhanceQueue.filter(
    (job) => job.bookId === bookId && job.key === key && pending.includes(job.index),
  )
  for (const job of enhanceQueue) {
    if (!kept.includes(job)) emitEnhanceStatus({ ...job, state: 'cancelled' })
  }
  enhanceQueue = pending.map(
    (index) => kept.find((job) => job.index === index) ?? { bookId, index, key },
  )
  for (const job of enhanceQueue) {
    if (!kept.includes(job)) emitEnhanceStatus({ ...job, state: 'queued' })
  }
  runMockEnhanceQueue()
  return { key, ready }
}

function mockCancelEnhancement(bookId: string) {
  const cancelled = [...enhanceQueue, ...enhanceBatch].filter((job) => job.bookId === bookId)
  enhanceQueue = enhanceQueue.filter((job) => job.bookId !== bookId)
  enhanceBatch = enhanceBatch.filter((job) => job.bookId !== bookId)
  for (const job of cancelled) emitEnhanceStatus({ ...job, state: 'cancelled' })
}

function mockStartBatchEnhancement(record: Record<string, unknown>): BatchEnhanceResult {
  const bookId = requireBookId(record)
  const settings = record.settings as EnhanceSettings
  const status = statuses.find((candidate) => candidate.id === settings.engine)
  if (!status?.ready) {
    throw appError('failed', `${labelOf(settings.engine)} が登録されていません。設定の AI 超解像から登録してください。`)
  }
  const total = openedPageCounts.get(bookId)
  if (total === undefined) throw appError('book_not_open', '本が開かれていません。')
  const key = mockEnhanceKey(settings)
  const ready: number[] = []
  for (let index = 0; index < total; index += 1) {
    if (enhancedPages.has(enhancedPageId(bookId, index, key))) {
      ready.push(index)
    } else if (!enhanceBatch.some((job) => job.bookId === bookId && job.index === index && job.key === key)) {
      const job = { bookId, index, key }
      enhanceBatch.push(job)
      emitEnhanceStatus({ ...job, state: 'queued' })
    }
  }
  runMockEnhanceQueue()
  return { key, total, ready }
}

function mockCancelBatchEnhancement(bookId: string) {
  const cancelled = enhanceBatch.filter((job) => job.bookId === bookId)
  enhanceBatch = enhanceBatch.filter((job) => job.bookId !== bookId)
  for (const job of cancelled) {
    if (!enhanceQueue.some((entry) => entry.bookId === bookId && entry.index === job.index && entry.key === job.key)) {
      emitEnhanceStatus({ ...job, state: 'cancelled' })
    }
  }
}

export async function mockInvoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  const record = argsRecord(args)
  const collectionResult = mockCollectionCommand(command, record)
  if (collectionResult !== notHandled) return collectionResult as T

  switch (command) {
    case 'get_engine_statuses':
      return statuses as T
    case 'detect_engine_candidates':
      return detectCandidates() as T
    case 'get_engine_install_options':
      return installOptions() as T
    case 'register_engine_directory': {
      const engineId = requireEngineId(record)
      return replaceStatus(configuredStatus(engineId, labelOf(engineId), '外部フォルダ')) as T
    }
    case 'import_engine_archive': {
      const engineId = requireEngineId(record)
      await mockInstallProgress(engineId, ['extracting', 'registering'], 0)
      return replaceStatus(configuredStatus(engineId, labelOf(engineId), 'ZIP 取込')) as T
    }
    case 'install_engine_from_release': {
      const option = record.option as EngineInstallOption | undefined
      const engineId = requireEngineId({ engineId: option?.engineId })
      await mockInstallProgress(engineId, ['verifying', 'downloading', 'extracting', 'registering'], option?.size ?? 0)
      return replaceStatus(configuredStatus(engineId, labelOf(engineId), 'アプリ内インストール')) as T
    }
    case 'clear_engine_registration': {
      const engineId = requireEngineId(record)
      replaceStatus(unconfiguredStatus(engineId, labelOf(engineId)))
      return statuses as T
    }
    case 'request_enhancement':
      return mockRequestEnhancement(record) as T
    case 'cancel_enhancement':
      mockCancelEnhancement(requireBookId(record))
      return undefined as T
    case 'start_batch_enhancement':
      return mockStartBatchEnhancement(record) as T
    case 'cancel_batch_enhancement':
      mockCancelBatchEnhancement(requireBookId(record))
      return undefined as T
    case 'get_enhance_cache_info':
      return enhanceCache as T
    case 'set_enhance_cache_limit':
      return mockSetEnhanceCacheLimit(record) as T
    case 'clear_enhance_cache':
      return mockClearEnhanceCache() as T
    case 'get_legacy_library_dir':
      return legacyLibraryDir as T
    case 'delete_legacy_library_dir':
      legacyLibraryDir = null
      return undefined as T
    case 'open_book':
      return (await openMockBook(record.path, record.fromStart === true)) as T
    case 'close_books':
      return undefined as T
    case 'get_adjacent_books':
      return (await mockAdjacentBooks(requireBookId(record))) as T
    case 'save_reading_position': {
      const bookId = requireBookId(record)
      savedBooks.set(bookId, { ...savedBooks.get(bookId), page: Number(record.page) })
      saveMockHistoryPage(bookId, Number(record.page))
      return undefined as T
    }
    case 'save_view_settings': {
      const bookId = requireBookId(record)
      savedBooks.set(bookId, { ...savedBooks.get(bookId), view: record.settings as ViewSettings })
      return undefined as T
    }
    case 'list_continue_reading':
      return mockContinueReading() as T
    case 'list_history':
      return sortedHistory().map((item) => item.entry) as T
    case 'remove_history_entry':
      mockHistory = mockHistory.filter((item) => item.entry.itemId !== record.itemId)
      return undefined as T
    case 'clear_history':
      mockHistory = []
      return undefined as T
    case 'list_sources':
      return sources as T
    case 'add_source':
      return mockAddSource(record.path) as T
    case 'remove_source':
      requireSource(record.sourceId)
      sources = sources.filter((source) => source.id !== record.sourceId)
      return undefined as T
    case 'list_directory':
      return mockListDirectory(record.sourceId, record.path) as T
    case 'search_library':
      return mockSearchLibrary(record.query, record.sourceId, record.path) as T
    case 'take_pending_open_path':
      return null as T
    default:
      throw appError('internal', `モックに未実装の command です: ${command}`)
  }
}
