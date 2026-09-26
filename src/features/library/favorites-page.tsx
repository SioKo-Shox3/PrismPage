import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { listFavorites } from '@/lib/tauri'
import type { CollectionBook } from '@/types/app'

import { useBookMenu } from './use-book-menu'
import { BookCovers } from './collection-views'
import pageStyles from './reading-pages.module.css'

// お気に入りの画面。お気に入りに入れた本を入れた時刻の新しい順に表紙で並べる。
// 付け外しは本の右クリックメニュー(ビューアでは「本棚」ボタン)で行う。元が見つからない本も残して見せる。

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; books: CollectionBook[] }
  | { status: 'error'; message: string }

export function FavoritesPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  const menu = useBookMenu(reload)

  useEffect(() => {
    let cancelled = false
    listFavorites().then(
      (books) => {
        if (!cancelled) setState({ status: 'ready', books })
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error && error.message ? error.message : 'お気に入りを読み込めませんでした。',
          })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [generation])

  const books = state.status === 'ready' ? state.books : []
  const missingCount = books.filter((book) => !book.available).length

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.header}>
        <div>
          <h1 className={pageStyles.title}>お気に入り</h1>
          {books.length > 0 ? (
            <p className={pageStyles.lead}>
              {books.length} 冊・入れた順
              {missingCount > 0 ? `・見つからない本 ${missingCount} 冊` : ''}
            </p>
          ) : null}
        </div>
      </header>

      {state.status === 'error' ? (
        <p className={pageStyles.message} role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === 'ready' && books.length === 0 ? (
        <div className={pageStyles.empty}>
          <p>お気に入りの本はありません。</p>
          <p className={pageStyles.muted}>
            <Link to="/folders" search={{}}>
              フォルダ
            </Link>
            や読みかけの本を右クリックして「お気に入りに入れる」を選ぶと、ここに並びます。
          </p>
        </div>
      ) : null}

      {books.length > 0 ? <BookCovers books={books} onMenu={(event, book) => menu.openAtPointer(event, book)} /> : null}

      {menu.menu}
    </div>
  )
}
