import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { BookImage, ChevronRight, Folder, FolderPlus, Trash2 } from 'lucide-react'

import { Badge, Button, IconButton } from '@/design'
import { isCommandError } from '@/lib/errors'
import { listDirectory, thumbUrl } from '@/lib/tauri'
import type { DirectoryEntry, DirectoryListing, LibrarySource } from '@/types/app'

import { LibrarySearchField, LibrarySearchResults } from './library-search'
import { useBookMenu } from './use-book-menu'
import { orderFolders, orderItems, readStatus, useListOrderStore, type ReadFilter } from './list-order'
import { ListOrderControls } from './list-order-controls'
import { pagePositionLabel } from './reading-list'
import { AddSourceDialog, RemoveSourceDialog } from './source-dialogs'
import { useLibrarySources } from './use-library-sources'
import styles from './folders-page.module.css'

// フォルダ画面。登録フォルダの一覧 → 登録フォルダ配下のフォルダ → 本の順にパンくずで辿る。
// 本を選ぶとビューアを開き、ビューアの Esc で戻ったときは同じフォルダの同じスクロール位置から続ける。
// 検索欄に語を入れると、一覧の代わりに登録フォルダ全体(または表示中のフォルダの中)を探した結果を見せる。
// 検索語と範囲は URL(`q`・`scope`)に持つので、結果から本を開いて戻ったときも同じ結果に戻る。

// 画面の場所ごとの一覧とスクロール位置。ビューアから戻ったときに、読み直しを待たずに同じ位置で描くために持つ。
const listingCache = new Map<string, DirectoryListing>()
const scrollPositions = new Map<string, number>()

function locationKey(sourceId: number | undefined, path: string) {
  return sourceId === undefined ? 'sources' : `${sourceId}\n${path}`
}

// 表示中の場所のスクロール位置を覚え、`ready` になった最初の描画でその位置へ戻す(初めての場所は先頭)。
// 記録は layout effect で購読するので、画面を離れて中身が消えたときの位置(0 など)は記録しない。
function useScrollMemory(key: string, ready: boolean) {
  const router = useRouter()
  const restored = useRef(false)

  useLayoutEffect(() => {
    const record = () => {
      if (restored.current) scrollPositions.set(key, window.scrollY)
    }
    window.addEventListener('scroll', record, { passive: true })
    return () => window.removeEventListener('scroll', record)
  }, [key])

  useLayoutEffect(() => {
    if (!ready || restored.current) return
    restored.current = true
    const y = scrollPositions.get(key) ?? 0
    window.scrollTo(0, y)
    // 移動と同じ描画で戻すときは、ルーターがこの後の layout effect(onRendered)で先頭へ戻すので、
    // その直後にもう一度合わせる。購読はこの描画の間だけで、次の移動には持ち越さない。
    const unsubscribe = router.subscribe('onRendered', () => window.scrollTo(0, y))
    queueMicrotask(unsubscribe)
  }, [key, ready, router])
}

export function FoldersPage() {
  const { source, path = '', q = '', scope } = useSearch({ from: '/folders' })
  const navigate = useNavigate()
  const library = useLibrarySources()
  const setQuery = useCallback(
    (next: string) => {
      void navigate({
        to: '/folders',
        search: (previous) => ({ ...previous, q: next || undefined }),
        replace: true,
      })
    },
    [navigate],
  )
  const setWithinFolder = useCallback(
    (within: boolean) => {
      void navigate({
        to: '/folders',
        search: (previous) => ({ ...previous, scope: within ? ('folder' as const) : undefined }),
        replace: true,
      })
    },
    [navigate],
  )
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<LibrarySource | null>(null)

  const dialogs = (
    <>
      <AddSourceDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false)
          void library.reload()
        }}
      />
      <RemoveSourceDialog
        source={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null)
          void library.reload()
          // 外した登録フォルダの中を表示していたら、登録フォルダの一覧へ戻る。
          if (source !== undefined) void navigate({ to: '/folders', search: {} })
        }}
      />
    </>
  )

  if (source === undefined) {
    return (
      <>
        <SourceIndex
          sources={library.sources}
          error={library.error}
          onAdd={() => setAdding(true)}
          onRemove={setRemoving}
          query={q}
          onQueryChange={setQuery}
        />
        {dialogs}
      </>
    )
  }

  const current = library.sources?.find((candidate) => candidate.id === source)
  return (
    <>
      <FolderView
        key={locationKey(source, path)}
        sourceId={source}
        path={path}
        sourceName={current?.name}
        onRemove={current ? () => setRemoving(current) : undefined}
        query={q}
        onQueryChange={setQuery}
        withinFolder={scope === 'folder'}
        onWithinFolderChange={setWithinFolder}
      />
      {dialogs}
    </>
  )
}

interface SourceIndexProps {
  sources: LibrarySource[] | null
  error: string | null
  onAdd: () => void
  onRemove: (source: LibrarySource) => void
  query: string
  onQueryChange: (query: string) => void
}

// 登録フォルダの一覧(フォルダ画面の最上位)。
function SourceIndex({ sources, error, onAdd, onRemove, query, onQueryChange }: SourceIndexProps) {
  useScrollMemory(locationKey(undefined, ''), sources !== null)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>フォルダ</h1>
          <p className={styles.lead}>登録したフォルダの中を辿って本を開きます。</p>
        </div>
        <Button variant="primary" onClick={onAdd}>
          <FolderPlus size={16} aria-hidden="true" />
          フォルダを登録
        </Button>
      </header>

      {error ? (
        <p className={styles.message} role="alert">
          {error}
        </p>
      ) : null}

      {sources && sources.length > 0 ? (
        <LibrarySearchField query={query} onQueryChange={onQueryChange} />
      ) : null}

      {query && sources && sources.length > 0 ? (
        <LibrarySearchResults query={query} sourcesRevision={sources.map((source) => source.id).join(',')} />
      ) : null}

      {sources && sources.length === 0 ? (
        <div className={styles.empty}>
          <p>まだフォルダが登録されていません。</p>
          <p className={styles.muted}>
            漫画や画集を入れたフォルダを登録すると、ここから中を辿って読めます。
          </p>
        </div>
      ) : null}

      {!query && sources && sources.length > 0 ? (
        <ul className={styles.sourceList} aria-label="登録フォルダ">
          {sources.map((source) => (
            <li key={source.id} className={styles.sourceItem}>
              <Link
                to="/folders"
                search={{ source: source.id }}
                className={styles.sourceLink}
              >
                <Folder size={22} aria-hidden="true" className={styles.folderIcon} />
                <span className={styles.sourceText}>
                  <span className={styles.sourceName}>{source.name}</span>
                  <span className={styles.sourcePath}>{source.displayPath}</span>
                </span>
              </Link>
              <IconButton
                icon={Trash2}
                label={`「${source.name}」の登録を外す`}
                size="sm"
                onClick={() => onRemove(source)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

interface FolderViewProps {
  sourceId: number
  path: string
  sourceName?: string
  onRemove?: () => void
  query: string
  onQueryChange: (query: string) => void
  withinFolder: boolean
  onWithinFolderChange: (within: boolean) => void
}

// 登録フォルダ配下の 1 つのフォルダ。サブフォルダを先に、本を表紙のグリッドで並べる。
function FolderView({
  sourceId,
  path,
  sourceName,
  onRemove,
  query,
  onQueryChange,
  withinFolder,
  onWithinFolderChange,
}: FolderViewProps) {
  const key = locationKey(sourceId, path)
  const navigate = useNavigate()
  const [listing, setListing] = useState<DirectoryListing | null>(() => listingCache.get(key) ?? null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const menu = useBookMenu()
  const sort = useListOrderStore((state) => state.sorts.folders)
  const setSort = useListOrderStore((state) => state.setSort)
  const [filter, setFilter] = useState<ReadFilter>('all')
  useScrollMemory(key, listing !== null || error !== null)

  // `listDirectory` は読書位置の保存が終わってから読む(ビューアを閉じた直後も読み終えた本を読みかけのまま見せない)。
  useEffect(() => {
    let cancelled = false
    listDirectory(sourceId, path || undefined).then(
      (result) => {
        if (cancelled) return
        listingCache.set(key, result)
        setListing(result)
        setError(null)
      },
      (loadError: unknown) => {
        if (cancelled) return
        listingCache.delete(key)
        setListing(null)
        setError({
          code: isCommandError(loadError) ? loadError.code : 'unknown',
          message:
            loadError instanceof Error && loadError.message
              ? loadError.message
              : 'フォルダを読み込めませんでした。',
        })
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, sourceId, path])

  const segments = listing?.segments ?? []
  const heading = segments.at(-1) ?? sourceName ?? 'フォルダ'
  // フォルダは並び順だけに従い(読書の記録を持たないので絞り込まない)、本は並び替えて絞り込む。
  const folders = orderFolders(listing?.entries.filter((entry) => entry.kind === 'folder') ?? [], sort)
  const allBooks = listing?.entries.filter((entry) => entry.kind === 'book') ?? []
  const books = orderItems(allBooks, sort, filter)

  const openBook = (entry: DirectoryEntry) => {
    scrollPositions.set(key, window.scrollY)
    void navigate({
      to: '/viewer/$bookId',
      params: { bookId: entry.name },
      search: { path: entry.path },
    })
  }

  return (
    <div className={styles.page}>
      <nav aria-label="パンくず" className={styles.breadcrumbs}>
        <ol>
          <li>
            <Link to="/folders" search={{}}>
              フォルダ
            </Link>
          </li>
          <Crumb current={segments.length === 0} search={{ source: sourceId }}>
            {sourceName ?? '登録フォルダ'}
          </Crumb>
          {segments.map((segment, index) => (
            <Crumb
              key={`${index}-${segment}`}
              current={index === segments.length - 1}
              search={{ source: sourceId, path: segments.slice(0, index + 1).join('/') }}
            >
              {segment}
            </Crumb>
          ))}
        </ol>
      </nav>

      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{heading}</h1>
          {listing ? (
            <p className={styles.lead}>
              フォルダ {folders.length}・本 {filter === 'all' ? allBooks.length : `${books.length} / ${allBooks.length}`}
            </p>
          ) : null}
        </div>
        {onRemove && segments.length === 0 ? (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <Trash2 size={14} aria-hidden="true" />
            登録を外す
          </Button>
        ) : null}
      </header>

      {error ? (
        <div className={styles.empty} role="alert">
          <p>
            {error.code === 'source_not_found'
              ? 'この登録フォルダは見つかりません。登録が外されたか、フォルダが移動した可能性があります。'
              : error.code === 'outside_source'
                ? '登録フォルダの外は表示できません。'
                : error.message}
          </p>
          <p>
            <Link to="/folders" search={{}}>
              登録フォルダの一覧へ戻る
            </Link>
          </p>
        </div>
      ) : null}

      {error ? null : (
        <LibrarySearchField
          query={query}
          onQueryChange={onQueryChange}
          withinFolder={withinFolder}
          onWithinFolderChange={onWithinFolderChange}
        />
      )}

      {query && !error ? (
        <LibrarySearchResults
          query={query}
          scope={withinFolder ? { sourceId, path: segments.length > 0 ? segments.join('/') : path } : undefined}
        />
      ) : null}

      {!query && listing && listing.entries.length > 0 ? (
        <ListOrderControls
          sort={sort}
          filter={filter}
          onSortChange={(next) => setSort('folders', next)}
          onFilterChange={setFilter}
        />
      ) : null}

      {!query && listing && listing.entries.length === 0 ? (
        <div className={styles.empty}>
          <p>このフォルダには本もフォルダもありません。</p>
        </div>
      ) : null}

      {!query && allBooks.length > 0 && books.length === 0 ? (
        <p className={styles.muted}>絞り込みに合う本はありません。</p>
      ) : null}

      {!query && folders.length > 0 ? (
        <section aria-label="フォルダ" className={styles.section}>
          <ul className={styles.folderGrid}>
            {folders.map((entry) => (
              <li key={entry.path}>
                <Link
                  to="/folders"
                  search={{ source: sourceId, path: [...segments, entry.name].join('/') }}
                  className={styles.folderLink}
                >
                  <Folder size={18} aria-hidden="true" className={styles.folderIcon} />
                  <span className={styles.folderName}>{entry.title}</span>
                  <ChevronRight size={16} aria-hidden="true" className={styles.chevron} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!query && books.length > 0 ? (
        <section aria-label="本" className={styles.section}>
          <ul className={styles.bookGrid}>
            {books.map((entry) => (
              // 右クリックで本棚・お気に入りのメニューを開く(押せないカードでも開けるよう項目で受ける)。
              <li key={entry.path} onContextMenu={(event) => menu.openAtPointer(event, entry)}>
                <BookCard entry={entry} onOpen={() => openBook(entry)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {menu.menu}
    </div>
  )
}

function Crumb({
  current,
  search,
  children,
}: {
  current: boolean
  search: { source: number; path?: string }
  children: string
}) {
  return (
    <li>
      <ChevronRight size={14} aria-hidden="true" className={styles.crumbSeparator} />
      {current ? (
        <span aria-current="page" className={styles.crumbCurrent}>
          {children}
        </span>
      ) : (
        <Link to="/folders" search={search}>
          {children}
        </Link>
      )}
    </li>
  )
}

// 本の形式の表示名。ZIP・RAR・EPUB・PDF は拡張子(CBZ・CBR を含む)をそのまま見せる。
function formatLabel(entry: DirectoryEntry) {
  if (entry.format === 'folder') return '画像フォルダ'
  const extension = /\.([^.]+)$/.exec(entry.name)?.[1]
  return extension ? extension.toUpperCase() : (entry.format ?? '').toUpperCase()
}

// 表紙のカード。表紙はサムネイルを重ね、読み込むまでと作れなかったときは形式を書いた仮の面を見せる。
// 開けない本(`openable` が偽。いまの形式はすべて開けるので Rust は返さない)は押せないボタンにし、その旨を添える。
function BookCard({ entry, onOpen }: { entry: DirectoryEntry; onOpen: () => void }) {
  const label = formatLabel(entry)
  return (
    <button
      type="button"
      className={styles.bookCard}
      onClick={onOpen}
      disabled={!entry.openable}
      title={entry.openable ? entry.name : `${entry.name}(${label} はまだ開けません)`}
    >
      <span className={styles.cover} aria-hidden="true">
        <BookImage size={28} className={styles.coverIcon} />
        <span className={styles.coverFormat}>{label}</span>
        {entry.thumbId ? <CoverImage thumbId={entry.thumbId} /> : null}
      </span>
      <span className={styles.bookTitle}>{entry.title}</span>
      <ReadingFacts entry={entry} />
      {entry.openable ? null : (
        <Badge tone="warning" className={styles.bookBadge}>
          まだ開けない形式
        </Badge>
      )}
    </button>
  )
}

// 読書の状態(読みかけはページ位置、読了はその旨)。開いたことの無い本は何も出さない。
function ReadingFacts({ entry }: { entry: DirectoryEntry }) {
  const status = readStatus(entry)
  if (status === 'unread' || entry.page === null) return null
  return (
    <span className={styles.bookFacts}>
      {status === 'finished' ? '読了' : pagePositionLabel({ page: entry.page, pageCount: entry.pageCount })}
    </span>
  )
}

// 表紙のサムネイル。画面に入ってから URL を渡すので、サムネイルは画面に入った項目から順に要求される
// (Rust 側は初めての要求で作るため、見えない項目の分を先に作らせない)。一度入ったら監視をやめる。
// IntersectionObserver が無い環境ではすぐに読む。
// AVIF の表紙は縮めていない元のページが届くが、同じ <img> を枠に合わせて縮めて見せる(復号は WebView)。
export function CoverImage({ thumbId }: { thumbId: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading')

  useEffect(() => {
    const element = ref.current
    if (visible || !element) return
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])

  if (state === 'failed') return null
  return (
    <span ref={ref} className={styles.coverImageFrame} data-state={state}>
      {visible ? (
        <img
          className={styles.coverImage}
          src={thumbUrl(thumbId)}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setState('loaded')}
          onError={() => setState('failed')}
        />
      ) : null}
    </span>
  )
}
