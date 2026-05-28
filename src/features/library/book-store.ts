import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { BookRecord } from '@/types/app'

interface LibraryState {
  books: BookRecord[]
  upsertBook: (book: BookRecord) => void
  patchBook: (id: string, patch: Partial<BookRecord>) => void
  removeBook: (id: string) => void
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set) => ({
      books: [],
      upsertBook: (book) =>
        set((state) => {
          const existing = state.books.find((entry) => entry.id === book.id)
          if (!existing) {
            return { books: [book, ...state.books] }
          }

          return {
            books: state.books.map((entry) =>
              entry.id === book.id ? { ...existing, ...book } : entry,
            ),
          }
        }),
      patchBook: (id, patch) =>
        set((state) => ({
          books: state.books.map((entry) =>
            entry.id === id ? { ...entry, ...patch } : entry,
          ),
        })),
      removeBook: (id) =>
        set((state) => ({
          books: state.books.filter((entry) => entry.id !== id),
        })),
    }),
    {
      name: 'prismpage-library',
    },
  ),
)
