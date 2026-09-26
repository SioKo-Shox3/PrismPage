import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { routeTree } from '@/app/router'
import type { EngineStatus, EnhanceStatusEvent, OpenedBook } from '@/types/app'

import { useEnhancedBooksStore } from './enhance-store'

const book: OpenedBook = {
  bookId: '0123456789abcdef',
  title: 'テストの本',
  startIndex: 0,
  openMode: 'book',
  pages: Array.from({ length: 10 }, (_, index) => ({ name: `${index}.png`, width: 1000, height: 1500 })),
}

const KEY = 'real-cugan-modelsse-0000000a-x2-dm1'

const tauri = vi.hoisted(() => ({
  statuses: [] as EngineStatus[],
  request: vi.fn<
    (bookId: string, visible: number[], prefetch: number[], settings: unknown) => Promise<{ key: string; ready: number[] }>
  >(),
  cancel: vi.fn<(bookId: string) => Promise<void>>(),
  startBatch: vi.fn<
    (bookId: string, settings: unknown) => Promise<{ key: string; total: number; ready: number[] }>
  >(),
  cancelBatch: vi.fn<(bookId: string) => Promise<void>>(),
  handlers: new Set<(event: EnhanceStatusEvent) => void>(),
  listenFails: false,
}))

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  openBook: () => Promise.resolve(book),
  getAdjacentBooks: () => Promise.resolve({ previous: null, next: null }),
  saveReadingPosition: () => Promise.resolve(),
  saveViewSettings: () => Promise.resolve(),
  pageUrl: (_bookId: string, index: number) => `data:,${index}`,
  enhancedPageUrl: (_bookId: string, index: number, key: string, revision: number) =>
    `data:,${index}-${key}#${revision}`,
  getEngineStatuses: () => Promise.resolve(tauri.statuses),
  requestEnhancement: tauri.request,
  cancelEnhancement: tauri.cancel,
  startBatchEnhancement: tauri.startBatch,
  cancelBatchEnhancement: tauri.cancelBatch,
  listShelves: () => Promise.resolve([]),
  getBookCollections: () => Promise.resolve({ favorite: false, shelfIds: [] }),
  listenEnhanceStatus: (handler: (event: EnhanceStatusEvent) => void) => {
    if (tauri.listenFails) return Promise.reject(new Error('listen failed'))
    tauri.handlers.add(handler)
    return Promise.resolve(() => {
      tauri.handlers.delete(handler)
    })
  },
}))

function engine(id: EngineStatus['id'], ready: boolean): EngineStatus {
  return { id, label: id, configured: ready, ready, modelName: 'models-se', downloadUrl: '', notes: [] }
}

function emit(index: number, state: EnhanceStatusEvent['state']) {
  act(() => {
    for (const handler of tauri.handlers) handler({ bookId: book.bookId, index, key: KEY, state })
  })
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
  HTMLImageElement.prototype.decode = () => Promise.resolve()
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

beforeEach(() => {
  localStorage.clear()
  useEnhancedBooksStore.setState({ bookIds: [] })
  tauri.statuses = [engine('waifu2x', false), engine('real-cugan', true)]
  tauri.handlers.clear()
  tauri.listenFails = false
  tauri.request.mockReset().mockImplementation(() => Promise.resolve({ key: KEY, ready: [] }))
  tauri.cancel.mockReset().mockImplementation(() => Promise.resolve())
  tauri.startBatch.mockReset().mockImplementation(() => Promise.resolve({ key: KEY, total: 10, ready: [] }))
  tauri.cancelBatch.mockReset().mockImplementation(() => Promise.resolve())
})

afterEach(() => {
  cleanup()
})

async function renderViewer() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/viewer/${book.bookId}`] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  await screen.findByText('1 / 10')
}

function pageImage(index: number) {
  return screen.getByAltText(`${index + 1} ページ`) as HTMLImageElement
}

describe('ビューアの AI 切り替え', () => {
  it('ボタンの文字・aria-pressed・title がオンとオフで切り替わる', async () => {
    await renderViewer()
    const button = screen.getByRole('button', { name: 'AI オフ' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('title')).toBe('この本を AI 超解像で高解像度にして表示する')

    fireEvent.click(button)
    await vi.waitFor(() => expect(button.textContent).toBe('AI オン'))
    expect(screen.getByRole('button', { name: 'AI オン' })).toBe(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('title')).toBe('AI 超解像をオフにする')

    fireEvent.click(button)
    await vi.waitFor(() => expect(button.textContent).toBe('AI オフ'))
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('title')).toBe('この本を AI 超解像で高解像度にして表示する')
  })

  it('ON で表示中と次の 4 ページを要求し、終わったページを差し替えて状態を出し、本ごとに覚える', async () => {
    await renderViewer()
    const button = screen.getByRole('button', { name: 'AI オフ' })
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalled())
    // 設定の既定(waifu2x)は未登録なので、登録済みの Real-CUGAN を使う。
    expect(tauri.request).toHaveBeenLastCalledWith(book.bookId, [0], [1, 2, 3, 4], {
      engine: 'real-cugan',
      model: 'models-se',
      scale: 2,
      denoise: -1,
    })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(useEnhancedBooksStore.getState().bookIds).toEqual([book.bookId])
    expect(localStorage.getItem('prismpage-enhanced-books')).toContain(book.bookId)
    expect(await screen.findByText('AI 2× 処理中')).toBeTruthy()
    expect(screen.getByText('先の 4 ページを準備中 0/4')).toBeTruthy()
    expect(pageImage(0).getAttribute('src')).toBe('data:,0')

    emit(0, 'running')
    emit(0, 'done')
    emit(1, 'done')
    expect(await screen.findByText('AI 2× 適用中')).toBeTruthy()
    expect(screen.getByText('先の 4 ページを準備中 1/4')).toBeTruthy()
    // デコードが終わってから差し替わる。
    await vi.waitFor(() => expect(pageImage(0).getAttribute('src')).toMatch(`data:,0-${KEY}#`))

    // 次のページへ進むと要求し直し、処理済みのページは最初から処理結果で出る。
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await vi.waitFor(() =>
      expect(tauri.request).toHaveBeenLastCalledWith(book.bookId, [1], [2, 3, 4, 5], expect.anything()),
    )
    expect(pageImage(1).getAttribute('src')).toMatch(`data:,1-${KEY}#`)

    // OFF で本のジョブを取り消し、元画像に戻す。
    fireEvent.click(button)
    await vi.waitFor(() => expect(tauri.cancel).toHaveBeenCalledWith(book.bookId))
    expect(useEnhancedBooksStore.getState().bookIds).toEqual([])
    await vi.waitFor(() => expect(pageImage(1).getAttribute('src')).toBe('data:,1'))
    expect(screen.queryByText(/AI 2×/)).toBeNull()
  })

  it('処理済みのページがキャッシュの整理で消えて処理し直されたら、元画像に戻してから新しい結果を読み直す', async () => {
    useEnhancedBooksStore.getState().setBookEnhanced(book.bookId, true)
    await renderViewer()
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalledTimes(1))
    emit(0, 'done')
    expect(await screen.findByText('AI 2× 適用中')).toBeTruthy()
    await vi.waitFor(() => expect(pageImage(0).getAttribute('src')).toMatch(`data:,0-${KEY}#`))
    const first = pageImage(0).getAttribute('src')

    // 先へ進んでいる間に 1 ページ目の結果がキャッシュから消え、戻ると未処理として要求される。
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalledTimes(2))
    tauri.request.mockImplementation(() => Promise.resolve({ key: KEY, ready: [] }))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalledTimes(3))
    emit(0, 'queued')
    expect(await screen.findByText('AI 2× 処理中')).toBeTruthy()
    await vi.waitFor(() => expect(pageImage(0).getAttribute('src')).toBe('data:,0'))

    emit(0, 'running')
    emit(0, 'done')
    expect(await screen.findByText('AI 2× 適用中')).toBeTruthy()
    await vi.waitFor(() => expect(pageImage(0).getAttribute('src')).toMatch(`data:,0-${KEY}#`))
    expect(pageImage(0).getAttribute('src')).not.toBe(first)
  })

  it('要求の結果に処理済みと無いページは、イベントが来なくても処理中に戻す', async () => {
    useEnhancedBooksStore.getState().setBookEnhanced(book.bookId, true)
    await renderViewer()
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalledTimes(1))
    emit(0, 'done')
    expect(await screen.findByText('AI 2× 適用中')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalledTimes(2))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('AI 2× 処理中')).toBeTruthy()
    await vi.waitFor(() => expect(pageImage(0).getAttribute('src')).toBe('data:,0'))
  })

  it('ON を覚えた本は開くと要求を始め、閉じるとジョブを取り消す', async () => {
    useEnhancedBooksStore.getState().setBookEnhanced(book.bookId, true)
    await renderViewer()
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalledTimes(1))

    cleanup()
    expect(tauri.cancel).toHaveBeenCalledWith(book.bookId)
  })

  it('使えるエンジンが無ければ要求せず、設定画面への案内を出す', async () => {
    tauri.statuses = [engine('waifu2x', false), engine('real-cugan', false)]
    await renderViewer()

    fireEvent.click(screen.getByRole('button', { name: 'AI オフ' }))
    expect(await screen.findByText(/AI エンジンが未登録です/)).toBeTruthy()
    const link = screen.getByRole('link', { name: '設定で登録する' })
    expect(link.getAttribute('href')).toBe('/settings#ai-engines')
    expect(tauri.request).not.toHaveBeenCalled()
  })

  it('処理状況を受け取れなければ要求せず、エラーを出す', async () => {
    tauri.listenFails = true
    await renderViewer()

    fireEvent.click(screen.getByRole('button', { name: 'AI オフ' }))
    expect(await screen.findByText(/AI を使えません: 処理状況を受け取れません/)).toBeTruthy()
    expect(tauri.request).not.toHaveBeenCalled()
  })

  it('本のメニューから全ページを事前処理し、進み具合を出して、中止と再開(処理済みは飛ばす)ができる', async () => {
    await renderViewer()
    const openMenu = () => {
      fireEvent.click(screen.getByRole('button', { name: '本棚' }))
      return screen.getByRole('menu', { name: 'テストの本 のメニュー' })
    }

    // AI が OFF の間は始められない。
    const menu = openMenu()
    expect(screen.getByRole('menuitem', { name: '全ページを事前処理' })).toHaveProperty('disabled', true)
    expect(menu.textContent).toContain('AI をオンにすると使えます。')
    fireEvent.keyDown(menu, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'AI オフ' }))
    await vi.waitFor(() => expect(tauri.request).toHaveBeenCalled())
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '全ページを事前処理' }))
    await vi.waitFor(() =>
      expect(tauri.startBatch).toHaveBeenCalledWith(book.bookId, expect.objectContaining({ engine: 'real-cugan' })),
    )
    expect(await screen.findByText('全ページを事前処理中 0 / 10 ページ')).toBeTruthy()

    emit(0, 'done')
    emit(5, 'done')
    emit(6, 'failed')
    expect(screen.getByText('全ページを事前処理中 2 / 10 ページ(処理できないページ 1)')).toBeTruthy()

    // 中止: 一括だけをやめる(表示中の処理は取り消さない)。
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '全ページの事前処理を中止' }))
    await vi.waitFor(() => expect(tauri.cancelBatch).toHaveBeenCalledWith(book.bookId))
    expect(tauri.cancel).not.toHaveBeenCalled()
    expect(screen.getByText('事前処理を中止 2 / 10 ページ(処理できないページ 1)')).toBeTruthy()

    // 再開: Rust が処理済みのページを返し(飛ばす)、残りが終われば済みになる。
    tauri.startBatch.mockResolvedValueOnce({ key: KEY, total: 10, ready: [0, 1, 5] })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: '全ページの事前処理を再開' }))
    expect(await screen.findByText('全ページを事前処理中 3 / 10 ページ(処理できないページ 1)')).toBeTruthy()
    for (const index of [2, 3, 4, 6, 7, 8, 9]) emit(index, 'done')
    expect(screen.getByText('事前処理済み 10 / 10 ページ')).toBeTruthy()
  })
})
