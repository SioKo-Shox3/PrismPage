import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// 本ごとの AI 超解像の ON/OFF。本の ID(本の場所から決まる)で覚え、ON の本だけを持つ。

// 永続化する形式の版。形を変えたら上げ、migrate で旧版の扱いを決める。
export const ENHANCED_BOOKS_VERSION = 1

// 覚えておく本の数の上限。超えたら古く ON にしたものから忘れる。
const MAX_BOOKS = 500

export interface PersistedEnhancedBooks {
  // ON にした本の ID。古く ON にした順。
  bookIds: string[]
}

interface EnhancedBooksState extends PersistedEnhancedBooks {
  setBookEnhanced: (bookId: string, enabled: boolean) => void
}

// 保存済みの形式が現在の版と違うときに呼ばれる。版 1 より前は無く、未知の版は移行せず空に戻す。
export function migrateEnhancedBooks(): PersistedEnhancedBooks {
  return { bookIds: [] }
}

export const useEnhancedBooksStore = create<EnhancedBooksState>()(
  persist(
    (set) => ({
      bookIds: [],
      setBookEnhanced: (bookId, enabled) =>
        set(({ bookIds }) => {
          const rest = bookIds.filter((id) => id !== bookId)
          return { bookIds: enabled ? [...rest, bookId].slice(-MAX_BOOKS) : rest }
        }),
    }),
    {
      name: 'prismpage-enhanced-books',
      version: ENHANCED_BOOKS_VERSION,
      migrate: migrateEnhancedBooks,
      partialize: (state): PersistedEnhancedBooks => ({ bookIds: state.bookIds }),
    },
  ),
)
