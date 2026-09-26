import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// フォルダ・本棚の一覧の並び替え(名前 / 更新日 / 最近読んだ)と絞り込み(未読 / 読みかけ / 読了)。
// 並び順は画面ごとに覚えて次に開いたときも使う。絞り込みは覚えない(開き直すと「すべて」に戻る)。

export type SortKey = 'name' | 'modified' | 'recent'
export type ReadFilter = 'all' | 'unread' | 'reading' | 'finished'
export type ReadStatus = Exclude<ReadFilter, 'all'>

// 並び順を覚える画面。
export type ListScreen = 'folders' | 'shelves'

export const sortOptions: { value: SortKey; label: string }[] = [
  { value: 'name', label: '名前' },
  { value: 'modified', label: '更新日' },
  { value: 'recent', label: '最近読んだ' },
]

export const filterOptions: { value: ReadFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'unread', label: '未読' },
  { value: 'reading', label: '読みかけ' },
  { value: 'finished', label: '読了' },
]

// 並べる項目に要る値(フォルダ一覧の項目と本棚の本の共通部分)。読書の値は開いたことのある本だけが持つ。
export interface OrderableItem {
  name: string
  modifiedAt: number | null
  page: number | null
  pageCount: number | null
  lastReadAt: number | null
}

// 読書の状態。開いたことが無ければ未読、最後のページまで進んでいれば読了(Rust の `HistoryRecord::finished` と同じ判定。
// ページ数の分からない本は読了にしない)、それ以外は読みかけ。
export function readStatus(item: Pick<OrderableItem, 'page' | 'pageCount' | 'lastReadAt'>): ReadStatus {
  if (item.lastReadAt === null || item.page === null) return 'unread'
  if (item.pageCount !== null && item.pageCount > 0 && item.page + 1 >= item.pageCount) return 'finished'
  return 'reading'
}

// 名前の比較。数字は数として比べ(「2巻」が「10巻」より先)、大文字小文字・全角半角の違いは無視する。
const nameCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

export function compareNames(left: string, right: string) {
  return nameCollator.compare(left.normalize('NFKC'), right.normalize('NFKC'))
}

// 値の新しい順。値の無い項目は後ろへ回す。同じなら名前順。
function newestFirst<T extends OrderableItem>(value: (item: T) => number | null) {
  return (left: T, right: T) => {
    const a = value(left)
    const b = value(right)
    if (a !== b) {
      if (a === null) return 1
      if (b === null) return -1
      return b - a
    }
    return compareNames(left.name, right.name)
  }
}

// 並び替えて絞り込んだ新しい配列を返す(元の配列は変えない)。
// 名前は自然順、更新日と最近読んだは新しい順で、更新日の分からない本・読んだことの無い本は名前順で後ろに付く。
export function orderItems<T extends OrderableItem>(items: readonly T[], sort: SortKey, filter: ReadFilter = 'all'): T[] {
  const kept = filter === 'all' ? [...items] : items.filter((item) => readStatus(item) === filter)
  const compare =
    sort === 'modified'
      ? newestFirst<T>((item) => item.modifiedAt)
      : sort === 'recent'
        ? newestFirst<T>((item) => item.lastReadAt)
        : (left: T, right: T) => compareNames(left.name, right.name)
  return kept.sort(compare)
}

// フォルダ(読書の記録を持たない)の並び。最近読んだの指定では名前順にする。
export function orderFolders<T extends Pick<OrderableItem, 'name' | 'modifiedAt'>>(folders: readonly T[], sort: SortKey): T[] {
  const withoutReading = folders.map((folder) => ({ folder, name: folder.name, modifiedAt: folder.modifiedAt, page: null, pageCount: null, lastReadAt: null }))
  return orderItems(withoutReading, sort === 'modified' ? 'modified' : 'name').map((item) => item.folder)
}

// 永続化する並び順の形式の版。形を変えたら上げ、migrate で旧版の扱いを決める。
export const LIST_ORDER_VERSION = 1

export interface PersistedListOrder {
  sorts: Record<ListScreen, SortKey>
}

export const defaultListOrder: PersistedListOrder = {
  sorts: { folders: 'name', shelves: 'name' },
}

const sortKeys = new Set<string>(sortOptions.map((option) => option.value))

// 保存された値を読める形に整える。知らない画面・知らない並び順は既定値にする。
// 版の違う保存(このビルドより新しい版を含む)は移行せず既定値に戻す。
export function migrateListOrder(persisted: unknown, version: number): PersistedListOrder {
  if (version !== LIST_ORDER_VERSION || typeof persisted !== 'object' || persisted === null) {
    return { sorts: { ...defaultListOrder.sorts } }
  }
  return { sorts: sanitizeSorts((persisted as { sorts?: unknown }).sorts) }
}

function sanitizeSorts(value: unknown): Record<ListScreen, SortKey> {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const pick = (screen: ListScreen): SortKey => {
    const sort = source[screen]
    return typeof sort === 'string' && sortKeys.has(sort) ? (sort as SortKey) : defaultListOrder.sorts[screen]
  }
  return { folders: pick('folders'), shelves: pick('shelves') }
}

interface ListOrderState extends PersistedListOrder {
  setSort: (screen: ListScreen, sort: SortKey) => void
}

export const useListOrderStore = create<ListOrderState>()(
  persist(
    (set) => ({
      ...defaultListOrder,
      setSort: (screen, sort) => set((state) => ({ sorts: { ...state.sorts, [screen]: sort } })),
    }),
    {
      name: 'prismpage-list-order',
      version: LIST_ORDER_VERSION,
      migrate: migrateListOrder,
      // 同じ版の保存も、壊れた値が混じっていれば既定値で補う。
      merge: (persisted, current) => ({
        ...current,
        sorts: sanitizeSorts((persisted as { sorts?: unknown } | undefined)?.sorts),
      }),
      partialize: (state): PersistedListOrder => ({ sorts: state.sorts }),
    },
  ),
)
