import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// 本ごとの AI 超解像の ON/OFF。本の ID(本の場所から決まる)で、利用者が切り替えた本のオン・オフを覚える。
// 記録の無い本は設定の「初めて開く本でも AI をオンにする」(`enhanceNewBooks`)に従う。

// 永続化する形式の版。形を変えたら上げ、migrate で旧版の扱いを決める。
export const ENHANCED_BOOKS_VERSION = 2

// 覚えておく本の数の上限。超えたら古く切り替えたものから忘れる。
export const MAX_BOOKS = 500

export interface BookEnhanceChoice {
  bookId: string
  enabled: boolean
}

export interface PersistedEnhancedBooks {
  // 切り替えた本のオン・オフ。古く切り替えた順で、1 冊につき 1 件。
  books: BookEnhanceChoice[]
}

interface EnhancedBooksState extends PersistedEnhancedBooks {
  setBookEnhanced: (bookId: string, enabled: boolean) => void
}

// 本の AI をオンにするか。記録があれば記録に従い、無ければ設定 `enhanceNewBooks` に従う。
export function isBookEnhanced(
  books: readonly BookEnhanceChoice[],
  bookId: string,
  enhanceNewBooks: boolean,
): boolean {
  const choice = books.find((entry) => entry.bookId === bookId)
  return choice ? choice.enabled : enhanceNewBooks
}

// 保存済みの形式が現在の版と違うときに呼ばれる。
// version 1(オンにした本の ID だけを `bookIds` に持つ形式)は、その本すべてを「オン」の記録として引き継ぐ。
// 形の崩れた項目は捨てる。未知の版は移行せず空に戻す。
export function migrateEnhancedBooks(persisted: unknown, version: number): PersistedEnhancedBooks {
  if (version === 1 && typeof persisted === 'object' && persisted !== null) {
    const bookIds = (persisted as Record<string, unknown>).bookIds
    if (Array.isArray(bookIds)) {
      const ids = bookIds.filter((id): id is string => typeof id === 'string')
      // 同じ ID が重なっていたら、後ろ(新しく ON にした方)を残す。
      const unique = ids.filter((id, index) => ids.lastIndexOf(id) === index)
      return { books: unique.slice(-MAX_BOOKS).map((bookId) => ({ bookId, enabled: true })) }
    }
  }
  return { books: [] }
}

export const useEnhancedBooksStore = create<EnhancedBooksState>()(
  persist(
    (set) => ({
      books: [],
      setBookEnhanced: (bookId, enabled) =>
        set(({ books }) => ({
          books: [...books.filter((entry) => entry.bookId !== bookId), { bookId, enabled }].slice(-MAX_BOOKS),
        })),
    }),
    {
      name: 'prismpage-enhanced-books',
      version: ENHANCED_BOOKS_VERSION,
      migrate: migrateEnhancedBooks,
      partialize: (state): PersistedEnhancedBooks => ({ books: state.books }),
    },
  ),
)
