import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { BookOpen, LayoutGrid, Library, Pencil, Plus, Trash2 } from 'lucide-react'

import { Button, Dialog, IconButton, TextField } from '@/design'
import { createShelf, deleteShelf, listShelfBooks, listShelves, renameShelf } from '@/lib/tauri'
import type { CollectionBook, Shelf } from '@/types/app'

import { useBookMenu } from './use-book-menu'
import { BookCovers, BookSpines, type CollectionView } from './collection-views'
import { orderItems, useListOrderStore, type ReadFilter } from './list-order'
import { ListOrderControls } from './list-order-controls'
import pageStyles from './reading-pages.module.css'
import styles from './collections.module.css'

// 本棚の画面。本棚を選び、中の本を背表紙か表紙のグリッドで並べる。本棚の作成・名前変更・削除もここで行う。
// 本棚を消しても本のファイルと読書の記録は消えない。元が見つからない本も棚に残し「見つかりません」と見せる。

// 最後に選んだ並べ方。画面を離れて戻ったときに使う。
let lastView: CollectionView = 'spines'

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

type ShelvesState =
  | { status: 'loading' }
  | { status: 'ready'; shelves: Shelf[] }
  | { status: 'error'; message: string }

// 表示中の本棚と `shelfId` が違う間は読み込み中。
type BooksState =
  | { status: 'ready'; shelfId: number; books: CollectionBook[] }
  | { status: 'error'; shelfId: number; message: string }

type EditState = { mode: 'create' } | { mode: 'rename'; shelf: Shelf } | { mode: 'delete'; shelf: Shelf }

export function ShelvesPage() {
  const search = useSearch({ from: '/shelves' })
  const navigate = useNavigate()
  const view = search.view ?? lastView
  const [shelvesState, setShelvesState] = useState<ShelvesState>({ status: 'loading' })
  const [booksState, setBooksState] = useState<BooksState | null>(null)
  const [generation, setGeneration] = useState(0)
  const [edit, setEdit] = useState<EditState | null>(null)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  const menu = useBookMenu(reload)
  const sort = useListOrderStore((state) => state.sorts.shelves)
  const setSort = useListOrderStore((state) => state.setSort)
  const [filter, setFilter] = useState<ReadFilter>('all')

  useEffect(() => {
    lastView = view
  }, [view])

  useEffect(() => {
    let cancelled = false
    listShelves().then(
      (shelves) => {
        if (!cancelled) setShelvesState({ status: 'ready', shelves })
      },
      (error: unknown) => {
        if (!cancelled) setShelvesState({ status: 'error', message: messageOf(error, '本棚を読み込めませんでした。') })
      },
    )
    return () => {
      cancelled = true
    }
  }, [generation])

  const shelves = shelvesState.status === 'ready' ? shelvesState.shelves : []
  const selected = shelves.find((shelf) => shelf.id === search.shelf) ?? shelves[0] ?? null
  const selectedId = selected?.id ?? null

  // 選んだ本棚の本を読む。ビューアを閉じた直後は読書位置の保存が終わるのを待ってから読む。
  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false
    listShelfBooks(selectedId).then(
      (books) => {
        if (!cancelled) setBooksState({ status: 'ready', shelfId: selectedId, books })
      },
      (error: unknown) => {
        if (!cancelled) {
          setBooksState({
            status: 'error',
            shelfId: selectedId,
            message: messageOf(error, '本棚の本を読み込めませんでした。'),
          })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [selectedId, generation])

  const select = (shelfId: number, nextView: CollectionView = view) => {
    void navigate({ to: '/shelves', search: { shelf: shelfId, view: nextView }, replace: true })
  }
  const setView = (nextView: CollectionView) => {
    lastView = nextView
    void navigate({ to: '/shelves', search: { ...(selectedId !== null ? { shelf: selectedId } : {}), view: nextView }, replace: true })
  }

  const allBooks = booksState && booksState.shelfId === selectedId && booksState.status === 'ready' ? booksState.books : []
  const missingCount = allBooks.filter((book) => !book.available).length
  const books = orderItems(allBooks, sort, filter)

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.header}>
        <div>
          <h1 className={pageStyles.title}>本棚</h1>
          {shelvesState.status === 'ready' && shelves.length > 0 ? (
            <p className={pageStyles.lead}>{shelves.length} つの本棚</p>
          ) : null}
        </div>
        <Button variant="secondary" size="sm" onClick={() => setEdit({ mode: 'create' })}>
          <Plus size={14} aria-hidden="true" />
          本棚を作る
        </Button>
      </header>

      {shelvesState.status === 'error' ? (
        <p className={pageStyles.message} role="alert">
          {shelvesState.message}
        </p>
      ) : null}

      {shelvesState.status === 'ready' && shelves.length === 0 ? (
        <div className={pageStyles.empty}>
          <p>本棚はまだありません。</p>
          <p className={pageStyles.muted}>
            「本棚を作る」で本棚を作り、
            <Link to="/folders" search={{}}>
              フォルダ
            </Link>
            の本を右クリックして入れます。1 冊を複数の本棚に入れられます。
          </p>
        </div>
      ) : null}

      {shelves.length > 0 ? (
        <nav aria-label="本棚の一覧" className={styles.shelfTabs}>
          <ul>
            {shelves.map((shelf) => (
              <li key={shelf.id}>
                <button
                  type="button"
                  className={styles.shelfTab}
                  aria-current={shelf.id === selectedId ? 'page' : undefined}
                  onClick={() => select(shelf.id)}
                >
                  <span>{shelf.name}</span>
                  <span className={styles.shelfCount}>{shelf.bookCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {selected ? (
        <section aria-label={selected.name} className={styles.shelfSection}>
          <div className={styles.shelfBar}>
            <div className={styles.shelfHeading}>
              <h2 className={styles.shelfName}>{selected.name}</h2>
              <p className={pageStyles.muted}>
                {selected.bookCount} 冊
                {missingCount > 0 ? `・見つからない本 ${missingCount} 冊` : ''}
              </p>
            </div>
            <div className={styles.viewSwitch} role="group" aria-label="並べ方">
              <Button
                size="sm"
                variant={view === 'spines' ? 'secondary' : 'ghost'}
                aria-pressed={view === 'spines'}
                onClick={() => setView('spines')}
              >
                <Library size={14} aria-hidden="true" />
                背表紙
              </Button>
              <Button
                size="sm"
                variant={view === 'covers' ? 'secondary' : 'ghost'}
                aria-pressed={view === 'covers'}
                onClick={() => setView('covers')}
              >
                <LayoutGrid size={14} aria-hidden="true" />
                表紙
              </Button>
            </div>
            <IconButton
              icon={Pencil}
              size="sm"
              label={`${selected.name} の名前を変える`}
              onClick={() => setEdit({ mode: 'rename', shelf: selected })}
            />
            <IconButton
              icon={Trash2}
              size="sm"
              label={`${selected.name} を消す`}
              onClick={() => setEdit({ mode: 'delete', shelf: selected })}
            />
          </div>

          {booksState?.shelfId === selectedId && booksState.status === 'error' ? (
            <p className={pageStyles.message} role="alert">
              {booksState.message}
            </p>
          ) : null}

          {allBooks.length > 0 ? (
            <ListOrderControls
              sort={sort}
              filter={filter}
              onSortChange={(next) => setSort('shelves', next)}
              onFilterChange={setFilter}
            />
          ) : null}

          {allBooks.length > 0 && books.length === 0 ? (
            <p className={pageStyles.muted}>絞り込みに合う本はありません。</p>
          ) : null}

          {booksState?.shelfId === selectedId && booksState.status === 'ready' && allBooks.length === 0 ? (
            <div className={pageStyles.empty}>
              <p>この本棚には本がありません。</p>
              <p className={pageStyles.muted}>
                <BookOpen size={14} aria-hidden="true" className={styles.inlineIcon} />
                フォルダ・読みかけ・履歴の本を右クリックするか、ビューアの「本棚」から入れられます。
              </p>
            </div>
          ) : null}

          {books.length > 0 ? (
            view === 'spines' ? (
              <BookSpines books={books} onMenu={(event, book) => menu.openAtPointer(event, book)} />
            ) : (
              <BookCovers books={books} onMenu={(event, book) => menu.openAtPointer(event, book)} />
            )
          ) : null}
        </section>
      ) : null}

      {menu.menu}

      <ShelfDialogs
        // 開くたびに入力を作り直す(名前の初期値は開いた操作で決まる)。
        key={edit ? `${edit.mode}-${edit.mode === 'create' ? '' : edit.shelf.id}` : 'closed'}
        edit={edit}
        onClose={() => setEdit(null)}
        onDone={(shelfId) => {
          setEdit(null)
          reload()
          if (shelfId !== undefined) select(shelfId)
        }}
      />
    </div>
  )
}

// 本棚の作成・名前変更・削除のダイアログ。`onDone` には選び直す本棚の ID を渡す(消したときは無し)。
function ShelfDialogs({
  edit,
  onClose,
  onDone,
}: {
  edit: EditState | null
  onClose: () => void
  onDone: (shelfId?: number) => void
}) {
  const [name, setName] = useState(edit?.mode === 'rename' ? edit.shelf.name : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!edit) return
    setBusy(true)
    setError(null)
    try {
      if (edit.mode === 'create') {
        onDone((await createShelf(name)).id)
      } else if (edit.mode === 'rename') {
        onDone((await renameShelf(edit.shelf.id, name)).id)
      } else {
        await deleteShelf(edit.shelf.id)
        onDone()
      }
    } catch (submitError) {
      setError(messageOf(submitError, '本棚を変更できませんでした。'))
    } finally {
      setBusy(false)
    }
  }

  if (edit?.mode === 'delete') {
    return (
      <Dialog
        open
        title="本棚を消す"
        onClose={onClose}
        actions={
          <>
            <Button variant="ghost" onClick={onClose}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={() => void submit()} disabled={busy}>
              消す
            </Button>
          </>
        }
      >
        <p>
          本棚「{edit.shelf.name}」を消します。入っている {edit.shelf.bookCount} 冊の本のファイル・読書位置・お気に入りはそのまま残ります。
        </p>
        {error ? <p role="alert">{error}</p> : null}
      </Dialog>
    )
  }

  return (
    <Dialog
      open={edit !== null}
      title={edit?.mode === 'rename' ? '本棚の名前を変える' : '本棚を作る'}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="shelf-name-form"
            disabled={busy || name.trim().length === 0}
          >
            {edit?.mode === 'rename' ? '変える' : '作る'}
          </Button>
        </>
      }
    >
      <form id="shelf-name-form" onSubmit={(event) => void submit(event)}>
        <TextField
          label="本棚の名前"
          value={name}
          maxLength={60}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          error={error ?? undefined}
        />
      </form>
    </Dialog>
  )
}
