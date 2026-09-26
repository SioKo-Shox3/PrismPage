import type { MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { BookImage } from 'lucide-react'

import { Badge } from '@/design'
import type { CollectionBook } from '@/types/app'

import { CoverImage } from './folders-page'
import { bookFormatLabel, pagePositionLabel, volumeLabel } from './reading-list'
import styles from './collections.module.css'

// 本棚・お気に入りの本の並べ方(背表紙・表紙のグリッド)。元が見つからない本も並べ、「見つかりません」と添える。
// 見つからない本・まだ開けない形式の本は開けないが、右クリックのメニュー(本棚から外すなど)は使える。

export type CollectionView = 'spines' | 'covers'

interface BooksProps {
  books: CollectionBook[]
  onMenu: (event: ReactMouseEvent<HTMLElement>, book: CollectionBook) => void
}

// 開ける本か。形式はすべて開けるので(Rust の `BookFormat::is_openable`)、見つかるかどうかだけで決まる。
function canOpen(book: CollectionBook) {
  return book.available
}

// 開けない理由(開ける本なら null)。
function unavailableLabel(book: CollectionBook) {
  if (!canOpen(book)) return '見つかりません'
  return null
}

function useOpenBook() {
  const navigate = useNavigate()
  return (book: CollectionBook) => {
    if (!canOpen(book)) return
    void navigate({ to: '/viewer/$bookId', params: { bookId: book.name }, search: { path: book.path } })
  }
}

// 背表紙の色の番号(1〜5)。書名から決めるので、同じ本はいつも同じ色になる。
function spineTone(book: CollectionBook) {
  let hash = 0
  for (const char of book.title) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return (hash % 5) + 1
}

// 背表紙の太さ(px)。ページ数が分かれば厚みを変え、分からなければ中ほどにする。
function spineWidth(book: CollectionBook) {
  if (!book.pageCount) return 40
  return Math.round(Math.min(64, Math.max(30, 26 + book.pageCount / 6)))
}

function bookTooltip(book: CollectionBook) {
  const reason = unavailableLabel(book)
  return [book.name, book.folderPath, reason].filter(Boolean).join('\n')
}

export function BookSpines({ books, onMenu }: BooksProps) {
  const open = useOpenBook()
  return (
    <ul className={styles.spineShelf} aria-label="本(背表紙)">
      {books.map((book) => {
        const reason = unavailableLabel(book)
        const volume = volumeLabel(book.title)
        return (
          <li key={book.itemId} className={styles.spineSlot}>
            <button
              type="button"
              className={styles.spine}
              data-tone={spineTone(book)}
              data-missing={book.available ? undefined : ''}
              style={{ width: spineWidth(book) }}
              aria-disabled={reason ? true : undefined}
              aria-label={reason ? `${book.title}(${reason})` : book.title}
              title={bookTooltip(book)}
              onClick={() => open(book)}
              onContextMenu={(event) => onMenu(event, book)}
            >
              <span className={styles.spineTitle}>{book.title}</span>
              {reason ? (
                <span className={styles.spineMissing}>{reason}</span>
              ) : volume ? (
                <span className={styles.spineVolume}>{volume}</span>
              ) : null}
              <span className={styles.spineFormat}>{bookFormatLabel(book)}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function BookCovers({ books, onMenu }: BooksProps) {
  const open = useOpenBook()
  return (
    <ul className={styles.coverGrid} aria-label="本(表紙)">
      {books.map((book) => {
        const reason = unavailableLabel(book)
        return (
          <li key={book.itemId}>
            <button
              type="button"
              className={styles.coverCard}
              data-missing={book.available ? undefined : ''}
              aria-disabled={reason ? true : undefined}
              aria-label={reason ? `${book.title}(${reason})` : book.title}
              title={bookTooltip(book)}
              onClick={() => open(book)}
              onContextMenu={(event) => onMenu(event, book)}
            >
              <span className={styles.cover} aria-hidden="true">
                <BookImage size={26} className={styles.coverIcon} />
                <span className={styles.coverFormat}>{bookFormatLabel(book)}</span>
                {book.thumbId ? <CoverImage thumbId={book.thumbId} /> : null}
              </span>
              <span className={styles.coverTitle}>{book.title}</span>
              <span className={styles.coverFacts}>
                {book.page !== null ? pagePositionLabel({ page: book.page, pageCount: book.pageCount }) : '未読'}
              </span>
              {reason ? (
                <Badge tone="warning" className={styles.coverBadge}>
                  {reason}
                </Badge>
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
