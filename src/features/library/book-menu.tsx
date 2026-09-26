import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Plus, Star } from 'lucide-react'

import { Button } from '@/design'
import {
  addToShelf,
  createShelf,
  getBookCollections,
  listShelves,
  removeFromShelf,
  setFavorite,
} from '@/lib/tauri'
import type { BookCollections, Shelf } from '@/types/app'

import styles from './collections.module.css'

// 本の右クリックメニュー(ビューアではボタンから開く。開閉は `use-book-menu.tsx`)。お気に入りの付け外しと、本棚への出し入れ・
// 新しい本棚を作って入れる操作を置く。本は場所(`path`)で指す。本のファイルには触れない。

export interface MenuBook {
  path: string
  title: string
}

// 本棚・お気に入りの上に足す操作(ビューアの AI の一括事前処理など)。選ぶとメニューを閉じてから `onSelect` を呼ぶ。
// `note` は項目の下に添える説明(使えない理由など)。
export interface MenuAction {
  label: string
  onSelect: () => void
  disabled?: boolean
  note?: string
}

export interface MenuState {
  book: MenuBook
  x: number
  y: number
  // メニューを開いたボタン。押し直しで閉じられるよう、外を押したときの判定から除く。
  anchor?: HTMLElement
  actions?: MenuAction[]
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; shelves: Shelf[]; collections: BookCollections }
  | { status: 'error'; message: string }

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

const itemSelector = '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)'

// 足した操作の項目。本棚の読み込みを待たずに出す。
function ActionItems({ actions, onClose }: { actions: MenuAction[]; onClose: () => void }) {
  return (
    <>
      {actions.map((action) => (
        <div key={action.label}>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            disabled={action.disabled}
            onClick={() => {
              onClose()
              action.onSelect()
            }}
          >
            <span className={styles.menuLabel}>{action.label}</span>
          </button>
          {action.note ? <p className={styles.menuNote}>{action.note}</p> : null}
        </div>
      ))}
      <div role="separator" className={styles.menuSeparator} />
    </>
  )
}

export function BookMenu({
  book,
  x,
  y,
  anchor,
  actions,
  onClose,
  onChanged,
}: MenuState & { onClose: () => void; onChanged?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [position, setPosition] = useState({ left: x, top: y })

  useEffect(() => {
    let cancelled = false
    Promise.all([listShelves(), getBookCollections(book.path)]).then(
      ([shelves, collections]) => {
        if (!cancelled) setLoad({ status: 'ready', shelves, collections })
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: messageOf(error, '本棚を読み込めませんでした。') })
      },
    )
    return () => {
      cancelled = true
    }
  }, [book.path])

  // 画面の外にはみ出さないよう、描いた大きさで位置を収める。
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const margin = 8
    const rect = element.getBoundingClientRect()
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    })
  }, [x, y, load.status, creating])

  // 開いたら最初の項目へ、閉じたら開く前の場所へフォーカスを戻す。
  useEffect(() => {
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    if (load.status !== 'loading' && !creating) {
      ref.current?.querySelector<HTMLElement>(itemSelector)?.focus()
    }
  }, [load.status, creating])

  // メニューの外を押したら閉じる。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (target && (ref.current?.contains(target) || anchor?.contains(target))) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose, anchor])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // メニューの中のキーはビューアのページ送りなどへ渡さない。
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      if (creating) setCreating(false)
      else onClose()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[(index + step + items.length) % items.length].focus()
  }

  // 変更を行い、成功したらメニューの表示を新しい状態にする。
  const run = async (task: () => Promise<Partial<{ shelves: Shelf[]; collections: BookCollections }>>) => {
    if (load.status !== 'ready') return
    setBusy(true)
    setActionError(null)
    try {
      const next = await task()
      setLoad((current) => (current.status === 'ready' ? { ...current, ...next } : current))
      onChanged?.()
      return true
    } catch (error) {
      setActionError(messageOf(error, '変更できませんでした。'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const toggleFavorite = () =>
    run(async () => {
      if (load.status !== 'ready') return {}
      const favorite = !load.collections.favorite
      await setFavorite(book.path, favorite)
      return { collections: { ...load.collections, favorite } }
    })

  const toggleShelf = (shelf: Shelf) =>
    run(async () => {
      if (load.status !== 'ready') return {}
      const { shelfIds } = load.collections
      const inShelf = shelfIds.includes(shelf.id)
      if (inShelf) await removeFromShelf(shelf.id, book.path)
      else await addToShelf(shelf.id, book.path)
      return {
        collections: {
          ...load.collections,
          shelfIds: inShelf ? shelfIds.filter((id) => id !== shelf.id) : [...shelfIds, shelf.id],
        },
        shelves: load.shelves.map((candidate) =>
          candidate.id === shelf.id
            ? { ...candidate, bookCount: candidate.bookCount + (inShelf ? -1 : 1) }
            : candidate,
        ),
      }
    })

  const createAndAdd = async (event: FormEvent) => {
    event.preventDefault()
    const done = await run(async () => {
      if (load.status !== 'ready') return {}
      const shelf = await createShelf(name)
      await addToShelf(shelf.id, book.path)
      return {
        shelves: [...load.shelves, { ...shelf, bookCount: shelf.bookCount + 1 }],
        collections: { ...load.collections, shelfIds: [...load.collections.shelfIds, shelf.id] },
      }
    })
    if (done) {
      setCreating(false)
      setName('')
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={actions && actions.length > 0 ? `${book.title} のメニュー` : `${book.title} の本棚とお気に入り`}
      className={styles.menu}
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className={styles.menuTitle} title={book.title}>
        {book.title}
      </p>
      {actions && actions.length > 0 ? <ActionItems actions={actions} onClose={onClose} /> : null}
      {load.status === 'loading' ? <p className={styles.menuNote}>読み込み中…</p> : null}
      {load.status === 'error' ? (
        <p className={styles.menuError} role="alert">
          {load.message}
        </p>
      ) : null}
      {load.status === 'ready' ? (
        <>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={load.collections.favorite}
            className={styles.menuItem}
            disabled={busy}
            onClick={() => void toggleFavorite()}
          >
            <Star
              size={15}
              aria-hidden="true"
              className={load.collections.favorite ? styles.starOn : styles.menuIcon}
            />
            <span>{load.collections.favorite ? 'お気に入りから外す' : 'お気に入りに入れる'}</span>
          </button>
          <div role="separator" className={styles.menuSeparator} />
          <p className={styles.menuGroup} id="book-menu-shelves">
            本棚
          </p>
          {load.shelves.length === 0 ? <p className={styles.menuNote}>本棚はまだありません。</p> : null}
          <div role="group" aria-labelledby="book-menu-shelves" className={styles.menuShelves}>
            {load.shelves.map((shelf) => {
              const checked = load.collections.shelfIds.includes(shelf.id)
              return (
                <button
                  key={shelf.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  className={styles.menuItem}
                  disabled={busy}
                  onClick={() => void toggleShelf(shelf)}
                >
                  <span className={styles.menuCheck} aria-hidden="true">
                    {checked ? <Check size={15} /> : null}
                  </span>
                  <span className={styles.menuLabel}>{shelf.name}</span>
                  <span className={styles.menuCount}>{shelf.bookCount}</span>
                </button>
              )
            })}
          </div>
          <div role="separator" className={styles.menuSeparator} />
          {creating ? (
            <form className={styles.menuForm} onSubmit={(event) => void createAndAdd(event)}>
              <input
                autoFocus
                className={styles.menuInput}
                aria-label="新しい本棚の名前"
                placeholder="新しい本棚の名前"
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" size="sm" variant="primary" disabled={busy || name.trim().length === 0}>
                作って入れる
              </Button>
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              disabled={busy}
              onClick={() => setCreating(true)}
            >
              <Plus size={15} aria-hidden="true" className={styles.menuIcon} />
              <span>新しい本棚を作って入れる…</span>
            </button>
          )}
          {actionError ? (
            <p className={styles.menuError} role="alert">
              {actionError}
            </p>
          ) : null}
        </>
      ) : null}
    </div>,
    document.body,
  )
}
