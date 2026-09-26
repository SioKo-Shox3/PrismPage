import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isCommandError } from '@/lib/errors'
import { enqueueSave } from '@/lib/save-queue'
import {
  getEngineStatuses,
  listContinueReading,
  listDirectory,
  listFavorites,
  listHistory,
  listShelfBooks,
  isPdfPath,
  openBook,
  pageUrl,
  pdfPageWidth,
  saveReadingPosition,
  searchLibrary,
} from '@/lib/tauri'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('command の失敗', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('Rust の AppError を code 付きの Error として投げる', async () => {
    invoke.mockRejectedValue({ code: 'timeout', message: 'ヘルスチェックがタイムアウトしました。' })

    const error = await getEngineStatuses().catch((reason: unknown) => reason)

    expect(isCommandError(error)).toBe(true)
    // 既存の画面は `instanceof Error` で文言を取り出している。
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      code: 'timeout',
      message: 'ヘルスチェックがタイムアウトしました。',
    })
  })

  it('形の合わない失敗は unknown として文言を残す', async () => {
    invoke.mockRejectedValue('command get_engine_statuses not found')

    const error = await getEngineStatuses().catch((reason: unknown) => reason)

    expect(error).toMatchObject({
      code: 'unknown',
      message: 'command get_engine_statuses not found',
    })
  })
})

describe('読書状態を返す command', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('待っている保存がすべて終わってから呼ぶ', async () => {
    const pending: Array<() => void> = []
    invoke.mockImplementation((command: string) =>
      command === 'save_reading_position'
        ? new Promise<void>((resolve) => pending.push(resolve))
        : Promise.resolve(null),
    )
    // ビューアを閉じるときの書き出しと同じく、保存を 2 件続けて列に積む。
    enqueueSave(() => saveReadingPosition('book', 8))
    enqueueSave(() => saveReadingPosition('book', 9))

    const reads = Promise.all([
      openBook('C:/本/第1巻.cbz'),
      listContinueReading(),
      listHistory(),
      listShelfBooks(1),
      listFavorites(),
      listDirectory(1),
      searchLibrary('階段'),
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['save_reading_position'])

    pending.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 1 件目が終わっても、2 件目の保存が残っている間は読まない。
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['save_reading_position', 'save_reading_position'])

    pending.shift()?.()
    await reads
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'save_reading_position',
      'save_reading_position',
      'open_book',
      'list_continue_reading',
      'list_history',
      'list_shelf_books',
      'list_favorites',
      'list_directory',
      'search_library',
    ])
  })
})

describe('ページの URL', () => {
  it('幅を渡すと Rust の `/page/<bookId>/<index>/width/<px>` を指し、渡さなければ元画像を指す', () => {
    expect(pageUrl('abc', 3)).toBe('prism://localhost/page/abc/3')
    expect(pageUrl('abc', 3, 1536)).toBe('prism://localhost/page/abc/3/width/1536')
  })

  it('Rust が拒む幅(0・負・小数)は URL にしない', () => {
    expect(() => pageUrl('abc', 0, 0)).toThrow(RangeError)
    expect(() => pageUrl('abc', 0, -800)).toThrow(RangeError)
    expect(() => pageUrl('abc', 0, 800.5)).toThrow(RangeError)
  })

  it('PDF の幅は表示幅に画素比を掛けて 256 単位に切り上げ、上限 8192 で抑える', () => {
    expect(pdfPageWidth(1000, 1)).toBe(1024)
    expect(pdfPageWidth(1000, 1.5)).toBe(1536)
    expect(pdfPageWidth(1024, 1)).toBe(1024)
    expect(pdfPageWidth(1025, 1)).toBe(1280)
    expect(pdfPageWidth(6000, 2)).toBe(8192)
    // 画素比が分からなければ 1 とみなす。
    expect(pdfPageWidth(1000, Number.NaN)).toBe(1024)
    // 表示領域の幅がまだ分からないときは幅を指定しない。
    expect(pdfPageWidth(0, 2)).toBeNull()
    expect(pdfPageWidth(Number.NaN, 1)).toBeNull()
  })

  it('PDF かどうかは拡張子で決める(大文字も)', () => {
    expect(isPdfPath('C:/本/資料.pdf')).toBe(true)
    expect(isPdfPath('C:/本/資料.PDF')).toBe(true)
    expect(isPdfPath('C:/本/pdf')).toBe(false)
    expect(isPdfPath('C:/本/資料.pdf.zip')).toBe(false)
  })
})
