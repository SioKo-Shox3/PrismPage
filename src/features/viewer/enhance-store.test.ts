import { beforeEach, describe, expect, it } from 'vitest'

import { ENHANCED_BOOKS_VERSION, MAX_BOOKS, isBookEnhanced, useEnhancedBooksStore } from './enhance-store'

const STORAGE_KEY = 'prismpage-enhanced-books'

describe('本ごとの AI の記録', () => {
  beforeEach(() => {
    localStorage.clear()
    useEnhancedBooksStore.setState({ books: [] })
  })

  it('version 1 の bookIds はすべて「オン」の記録として引き継ぎ、version 2 で保存し直す', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, state: { bookIds: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'] } }),
    )

    await useEnhancedBooksStore.persist.rehydrate()

    const expected = [
      { bookId: 'aaaaaaaaaaaaaaaa', enabled: true },
      { bookId: 'bbbbbbbbbbbbbbbb', enabled: true },
    ]
    expect(useEnhancedBooksStore.getState().books).toEqual(expected)
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(saved.version).toBe(ENHANCED_BOOKS_VERSION)
    expect(saved.version).toBe(2)
    expect(saved.state).toEqual({ books: expected })
  })

  it('未知の版は移行せず空に戻す', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 99, state: { books: [{ bookId: 'aaaaaaaaaaaaaaaa', enabled: true }] } }),
    )

    await useEnhancedBooksStore.persist.rehydrate()

    expect(useEnhancedBooksStore.getState().books).toEqual([])
  })

  it('記録の無い本は設定に従い、記録のある本は設定より記録に従う', () => {
    const books = [
      { bookId: 'on', enabled: true },
      { bookId: 'off', enabled: false },
    ]
    expect(isBookEnhanced(books, 'new', false)).toBe(false)
    expect(isBookEnhanced(books, 'new', true)).toBe(true)
    expect(isBookEnhanced(books, 'off', true)).toBe(false)
    expect(isBookEnhanced(books, 'on', false)).toBe(true)
  })

  it('切り替えた本は 1 冊 1 件で新しい側へ移り、上限を超えると古く切り替えた本から忘れる', () => {
    const { setBookEnhanced } = useEnhancedBooksStore.getState()
    for (let index = 0; index < MAX_BOOKS; index += 1) setBookEnhanced(`book-${index}`, true)
    setBookEnhanced('book-0', false)
    setBookEnhanced('book-new', true)

    const books = useEnhancedBooksStore.getState().books
    expect(books).toHaveLength(MAX_BOOKS)
    expect(books[0]).toEqual({ bookId: 'book-2', enabled: true })
    expect(books.slice(-2)).toEqual([
      { bookId: 'book-0', enabled: false },
      { bookId: 'book-new', enabled: true },
    ])
    expect(books.some((entry) => entry.bookId === 'book-1')).toBe(false)
  })
})
