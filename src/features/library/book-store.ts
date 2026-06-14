import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { BookRecord } from '@/types/app'

const LIBRARY_PERSIST_VERSION = 2
const MAX_PERSISTED_COVER_DATA_URL_LENGTH = 140 * 1024
const MAX_PERSISTED_LIBRARY_COVER_DATA_URL_LENGTH = 960 * 1024

interface LibraryState {
  books: BookRecord[]
  upsertBook: (book: BookRecord) => void
  patchBook: (id: string, patch: Partial<BookRecord>) => void
  removeBook: (id: string) => void
}

interface PersistedLibraryState {
  books: BookRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBookRecord(value: unknown): value is BookRecord {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.storedPath === 'string' &&
    typeof value.size === 'number' &&
    typeof value.importedAt === 'number' &&
    typeof value.title === 'string'
  )
}

function sanitizeCoverDataUrl(coverDataUrl: unknown) {
  if (typeof coverDataUrl !== 'string' || coverDataUrl.length === 0) {
    return undefined
  }

  if (
    !coverDataUrl.startsWith('data:image/') ||
    coverDataUrl.length > MAX_PERSISTED_COVER_DATA_URL_LENGTH
  ) {
    return undefined
  }

  return coverDataUrl
}

function sanitizeBook(book: BookRecord): BookRecord {
  return {
    ...book,
    coverDataUrl: sanitizeCoverDataUrl(book.coverDataUrl),
  }
}

function sanitizeBooks(books: BookRecord[]) {
  return books.map(sanitizeBook)
}

function sanitizeBooksForPersistence(books: BookRecord[]) {
  const sanitizedBooks = sanitizeBooks(books)
  const retainedCoverIndexes = new Set<number>()
  let remainingCoverLength = MAX_PERSISTED_LIBRARY_COVER_DATA_URL_LENGTH

  const prioritizedBooks = sanitizedBooks
    .map((book, index) => ({
      book,
      index,
      priority: book.lastOpenedAt ?? book.importedAt,
    }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index)

  for (const { book, index } of prioritizedBooks) {
    if (!book.coverDataUrl) {
      continue
    }

    if (book.coverDataUrl.length > remainingCoverLength) {
      continue
    }

    retainedCoverIndexes.add(index)
    remainingCoverLength -= book.coverDataUrl.length
  }

  return sanitizedBooks.map((book, index) =>
    book.coverDataUrl && !retainedCoverIndexes.has(index)
      ? { ...book, coverDataUrl: undefined }
      : book,
  )
}

function sanitizePersistedState(persistedState: unknown): PersistedLibraryState {
  if (!isRecord(persistedState) || !Array.isArray(persistedState.books)) {
    return { books: [] }
  }

  return {
    books: sanitizeBooksForPersistence(persistedState.books.filter(isBookRecord)),
  }
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set) => ({
      books: [],
      upsertBook: (book) =>
        set((state) => {
          const sanitizedBook = sanitizeBook(book)
          const existing = state.books.find((entry) => entry.id === sanitizedBook.id)
          if (!existing) {
            return { books: [sanitizedBook, ...state.books] }
          }

          return {
            books: state.books.map((entry) =>
              entry.id === sanitizedBook.id
                ? sanitizeBook({ ...existing, ...sanitizedBook })
                : entry,
            ),
          }
        }),
      patchBook: (id, patch) =>
        set((state) => ({
          books: state.books.map((entry) =>
            entry.id === id ? sanitizeBook({ ...entry, ...patch }) : entry,
          ),
        })),
      removeBook: (id) =>
        set((state) => ({
          books: state.books.filter((entry) => entry.id !== id),
        })),
    }),
    {
      name: 'prismpage-library',
      version: LIBRARY_PERSIST_VERSION,
      migrate: (persistedState) => sanitizePersistedState(persistedState),
      merge: (persistedState, currentState) => ({
        ...currentState,
        books: sanitizePersistedState(persistedState).books,
      }),
      partialize: (state) => ({
        books: sanitizeBooksForPersistence(state.books),
      }),
    },
  ),
)
