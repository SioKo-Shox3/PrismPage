import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { routeTree } from '@/app/router'
import type { AdjacentBooks, OpenedBook } from '@/types/app'

import { POSITION_SAVE_INTERVAL_MS } from './use-book-persistence'
import { PRELOAD_RADIUS, UI_EDGE_BAND_PX, UI_HIDE_DELAY_MS } from './viewer-state'

const saved = vi.hoisted(() => ({
  position: vi.fn<(bookId: string, page: number) => Promise<void>>(() => Promise.resolve()),
  view: vi.fn<(bookId: string, settings: unknown) => Promise<void>>(() => Promise.resolve()),
  open: vi.fn<(path: string, options?: { fromStart?: boolean }) => Promise<OpenedBook>>(),
  adjacent: vi.fn<(bookId: string) => Promise<AdjacentBooks>>(),
  close: vi.fn<(bookIds: string[]) => Promise<void>>(() => Promise.resolve()),
}))

const book: OpenedBook = {
  bookId: '0123456789abcdef',
  title: 'テストの本',
  startIndex: 0,
  pages: Array.from({ length: 5 }, (_, index) => ({
    name: `${index}.png`,
    width: 1000,
    height: 1500,
  })),
}

// 本を開くのは `@/lib/tauri` の本物のラッパー(保存の完了を待つ)を通し、command の呼び出しだけを差し替える。
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: (command: string, args: { path: string; fromStart: boolean }) =>
    command === 'open_book'
      ? saved.open(args.path, { fromStart: args.fromStart })
      : Promise.reject(new Error(`想定しない command: ${command}`)),
}))

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  saveReadingPosition: saved.position,
  saveViewSettings: saved.view,
  getAdjacentBooks: saved.adjacent,
  closeBooks: saved.close,
  // 幅を指定した要求(PDF)は `@<幅>` を付けて見分ける。
  pageUrl: (_bookId: string, index: number, width?: number) =>
    width === undefined ? `data:,${index}` : `data:,${index}@${width}`,
  // Esc で戻った先のフォルダ画面が読む一覧。
  listDirectory: (sourceId: number) =>
    Promise.resolve({ sourceId, path: 'C:/本', segments: ['漫画'], entries: [] }),
}))

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
  // jsdom は画像のデコード(先読みが使う)を持たない。
  HTMLImageElement.prototype.decode = () => Promise.resolve()
  // jsdom はポインタの捕捉を持たない。
  Element.prototype.setPointerCapture = () => {}
  // jsdom は ResizeObserver を持たない。画面の大きさは 0 のまま(自動は単ページ)で試す。
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

// 次に開く本(保存してある状態を載せて返す場合に差し替える)。
let openedBook: OpenedBook = book

beforeEach(() => {
  openedBook = book
  saved.position.mockReset().mockImplementation(() => Promise.resolve())
  saved.view.mockReset().mockImplementation(() => Promise.resolve())
  saved.open.mockReset().mockImplementation(() => Promise.resolve(openedBook))
  saved.adjacent.mockReset().mockImplementation(() => Promise.resolve({ previous: null, next: null }))
  saved.close.mockReset().mockImplementation(() => Promise.resolve())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function renderViewer(firstLabel = '1 / 5', entries = [`/viewer/${book.bookId}`]) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: entries, initialIndex: entries.length - 1 }),
  })
  await router.load()
  const { container } = render(<RouterProvider router={router} />)
  await screen.findByText(firstLabel)
  const viewer = container.querySelector('[data-ui]') as HTMLElement
  return { viewer, router }
}

describe('ビューアの操作', () => {
  // 画面を 1200×800 とし、開いたときに出ている UI を隠した状態から始める。開いたときの隠すタイマーは
  // 実時計で張られるので、帯に出入りして仮想時計で張り直してから進める。
  async function renderHiddenViewer() {
    const { viewer } = await renderViewer()
    const stage = screen.getByRole('region', { name: 'ページ' })
    for (const element of [viewer, stage]) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ x: 0, y: 0, width: 1200, height: 800 }),
      )
    }
    vi.useFakeTimers()
    fireEvent.pointerMove(viewer, { clientX: 600, clientY: 0, pointerType: 'mouse' })
    fireEvent.pointerMove(viewer, { clientX: 600, clientY: 400, pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(UI_HIDE_DELAY_MS))
    expect(viewer.dataset.ui).toBe('hidden')
    return { viewer, stage }
  }

  it('中央付近でポインタを動かしても UI は出ず、上端・下端の帯に入ると出る', async () => {
    const { viewer } = await renderHiddenViewer()

    for (const clientY of [UI_EDGE_BAND_PX, 400, 800 - UI_EDGE_BAND_PX - 1]) {
      fireEvent.pointerMove(viewer, { clientX: 600, clientY, pointerType: 'mouse' })
      expect(viewer.dataset.ui).toBe('hidden')
    }

    fireEvent.pointerMove(viewer, { clientX: 600, clientY: UI_EDGE_BAND_PX - 1, pointerType: 'mouse' })
    expect(viewer.dataset.ui).toBe('visible')
    // 帯の中にいる間は時間が経っても隠さない。
    act(() => vi.advanceTimersByTime(UI_HIDE_DELAY_MS * 2))
    expect(viewer.dataset.ui).toBe('visible')

    // 帯から出て 2.5 秒で隠す。
    fireEvent.pointerMove(viewer, { clientX: 600, clientY: 400, pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(UI_HIDE_DELAY_MS - 1))
    expect(viewer.dataset.ui).toBe('visible')
    act(() => vi.advanceTimersByTime(1))
    expect(viewer.dataset.ui).toBe('hidden')

    fireEvent.pointerMove(viewer, { clientX: 600, clientY: 800 - UI_EDGE_BAND_PX, pointerType: 'mouse' })
    expect(viewer.dataset.ui).toBe('visible')
  })

  it('左右のクリック・ホイール・キーでページを送っても UI は出ず、帯の中なら出したまま送る', async () => {
    const { viewer, stage } = await renderHiddenViewer()

    fireEvent.click(stage, { clientX: 100, clientY: 400 })
    expect(screen.getByText('2 / 5')).toBeTruthy()
    fireEvent.wheel(stage, { deltaY: 1000 })
    expect(screen.getByText('3 / 5')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('4 / 5')).toBeTruthy()
    expect(viewer.dataset.ui).toBe('hidden')

    fireEvent.pointerMove(viewer, { clientX: 600, clientY: 790, pointerType: 'mouse' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('3 / 5')).toBeTruthy()
    expect(viewer.dataset.ui).toBe('visible')
  })

  it('中央クリックで出した UI は時間では隠れず、ページを送ると隠れる', async () => {
    const { viewer, stage } = await renderHiddenViewer()

    fireEvent.click(stage, { clientX: 600, clientY: 400 })
    expect(viewer.dataset.ui).toBe('visible')
    act(() => vi.advanceTimersByTime(UI_HIDE_DELAY_MS * 4))
    expect(viewer.dataset.ui).toBe('visible')

    fireEvent.click(stage, { clientX: 100, clientY: 400 })
    expect(screen.getByText('2 / 5')).toBeTruthy()
    expect(viewer.dataset.ui).toBe('hidden')

    // もう一度の中央クリックでも隠れる。
    fireEvent.click(stage, { clientX: 600, clientY: 400 })
    expect(viewer.dataset.ui).toBe('visible')
    fireEvent.click(stage, { clientX: 600, clientY: 400 })
    expect(viewer.dataset.ui).toBe('hidden')
  })

  it('出ている UI は、帯の外でもポインタを動かし続ける間は隠れない', async () => {
    const { viewer } = await renderHiddenViewer()

    fireEvent.pointerMove(viewer, { clientX: 600, clientY: 0, pointerType: 'mouse' })
    fireEvent.pointerMove(viewer, { clientX: 600, clientY: 400, pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(2000))
    fireEvent.pointerMove(viewer, { clientX: 620, clientY: 420, pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(UI_HIDE_DELAY_MS - 1))
    expect(viewer.dataset.ui).toBe('visible')
    act(() => vi.advanceTimersByTime(1))
    expect(viewer.dataset.ui).toBe('hidden')

    // 隠れた後に帯の外で動かしても出さない。
    fireEvent.pointerMove(viewer, { clientX: 640, clientY: 440, pointerType: 'mouse' })
    expect(viewer.dataset.ui).toBe('hidden')
  })

  it('最後のページから次へ進んで読み終わりの案内を出しても、情報バーは出さない', async () => {
    const { viewer } = await renderHiddenViewer()

    fireEvent.keyDown(window, { key: 'End' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('読み終わりました')).toBeTruthy()
    expect(viewer.dataset.ui).toBe('hidden')
    expect(viewer.dataset.finished).toBe('')
  })

  it('下端中央のスライダーは右綴じで右端が先頭になり、ドラッグ中は行き先を出して離した所へ移る', async () => {
    const { viewer } = await renderViewer()
    const slider = screen.getByRole('slider', { name: 'ページ移動' })
    expect(slider.getAttribute('aria-valuemin')).toBe('1')
    expect(slider.getAttribute('aria-valuemax')).toBe('5')
    expect(slider.getAttribute('aria-valuenow')).toBe('1')
    expect(slider.getAttribute('aria-valuetext')).toBe('1 / 5 ページ')
    // 右綴じは右端に現在のページ、左端に総ページ。つまみは右端。
    const ends = Array.from(slider.parentElement!.children).filter((element) => element !== slider)
    expect(ends.map((element) => element.textContent)).toEqual(['5', '1'])
    const thumb = slider.lastElementChild as HTMLElement
    expect(thumb.style.left).toBe('100%')

    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 240, y: 760, width: 400, height: 28 }),
    )
    // 右端(先頭)から、左から 1/4 の所(4 ページ目)へドラッグする。
    fireEvent.pointerDown(slider, { clientX: 640, clientY: 770, button: 0, pointerId: 1 })
    fireEvent.pointerMove(slider, { clientX: 340, clientY: 770, pointerId: 1 })
    expect(screen.getByText('4 / 5')).toBeTruthy()
    expect(thumb.style.left).toBe('25%')
    // 離すまでは移らない。
    expect(slider.getAttribute('aria-valuenow')).toBe('1')

    fireEvent.pointerUp(slider, { clientX: 340, clientY: 770, pointerId: 1 })
    expect(slider.getAttribute('aria-valuenow')).toBe('4')
    expect(screen.getByAltText('4 ページ')).toBeTruthy()
    expect(Array.from(slider.parentElement!.children).map((element) => element.textContent)[2]).toBe('4')
    expect(viewer.dataset.ui).toBe('visible')
  })

  it('スライダーはフォーカス中の ← / → / Home / End で綴じ方向に合わせて動き、ページ送りと二重に動かない', async () => {
    await renderViewer()
    const slider = screen.getByRole('slider', { name: 'ページ移動' })
    slider.focus()

    // 右綴じは ← が次。
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(slider.getAttribute('aria-valuenow')).toBe('2')
    fireEvent.keyDown(slider, { key: 'End' })
    expect(slider.getAttribute('aria-valuenow')).toBe('5')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('4')
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(slider.getAttribute('aria-valuenow')).toBe('1')

    // 左綴じに変えると → が次。
    fireEvent.keyDown(window, { key: 'b' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('2')
  })

  it('Home / End・T で位置と見開きが変わり、Esc でビューアを閉じる', async () => {
    const { router } = await renderViewer()

    fireEvent.keyDown(window, { key: 'End' })
    expect(screen.getByText('5 / 5')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Home' })
    expect(screen.getByText('1 / 5')).toBeTruthy()

    // 単ページ(画面の大きさ 0 の自動)から見開きへ。表紙の次は 2 ページ組になる。
    fireEvent.keyDown(window, { key: 't' })
    fireEvent.keyDown(window, { key: 'PageDown' })
    expect(screen.getByText('2–3 / 5')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('右綴じの本は左右のクリックで次・前へ動き、中央のクリックで UI を出し入れする', async () => {
    const { viewer } = await renderViewer()
    const stage = screen.getByRole('region', { name: 'ページ' })
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1200, height: 800 }),
    )

    fireEvent.click(stage, { clientX: 100 })
    expect(screen.getByText('2 / 5')).toBeTruthy()
    fireEvent.click(stage, { clientX: 1100 })
    expect(screen.getByText('1 / 5')).toBeTruthy()
    // 開いたときに出ていた UI はページ送りで隠れる。
    expect(viewer.dataset.ui).toBe('hidden')

    fireEvent.click(stage, { clientX: 600 })
    expect(viewer.dataset.ui).toBe('visible')
    fireEvent.click(stage, { clientX: 600 })
    expect(viewer.dataset.ui).toBe('hidden')
  })

  it('左右の領域のダブルクリックは拡大せず、クリックごとにすぐページを送る', async () => {
    await renderViewer()
    const stage = screen.getByRole('region', { name: 'ページ' })
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1200, height: 800 }),
    )

    // ブラウザがダブルクリックで送る click → click → dblclick の並び。1 回目の click で待たずに送る。
    fireEvent.click(stage, { clientX: 100, detail: 1 })
    expect(screen.getByText('2 / 5')).toBeTruthy()
    fireEvent.click(stage, { clientX: 100, detail: 2 })
    fireEvent.doubleClick(stage, { clientX: 100, clientY: 400, detail: 2 })
    expect(screen.getByText('3 / 5')).toBeTruthy()
    expect(stage.dataset.zoomed).toBeUndefined()
  })

  it('拡大中は左右のクリックでページを送らず、0 で戻すと送る。拡大はダブルクリック・Ctrl+ホイール・- でも出入りする', async () => {
    await renderViewer()
    const stage = screen.getByRole('region', { name: 'ページ' })
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1200, height: 800 }),
    )

    fireEvent.keyDown(window, { key: '+' })
    expect(stage.dataset.zoomed).toBe('')
    fireEvent.click(stage, { clientX: 100 })
    expect(screen.getByText('1 / 5')).toBeTruthy()
    expect(stage.dataset.zoomed).toBe('')

    fireEvent.keyDown(window, { key: '0' })
    expect(stage.dataset.zoomed).toBeUndefined()
    fireEvent.click(stage, { clientX: 100 })
    expect(screen.getByText('2 / 5')).toBeTruthy()

    // 中央のダブルクリックで拡大し、もう一度で戻す。
    fireEvent.doubleClick(stage, { clientX: 600, clientY: 400 })
    expect(stage.dataset.zoomed).toBe('')
    fireEvent.doubleClick(stage, { clientX: 600, clientY: 400 })
    expect(stage.dataset.zoomed).toBeUndefined()

    // Ctrl+ホイールを上へで拡大、- で 1 倍まで縮めると拡大が解ける。
    fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true })
    expect(stage.dataset.zoomed).toBe('')
    for (let step = 0; step < 10; step += 1) fireEvent.keyDown(window, { key: '-' })
    expect(stage.dataset.zoomed).toBeUndefined()
    expect(screen.getByText('2 / 5')).toBeTruthy()
  })
})

describe('読書位置と表示設定の保存', () => {
  it('開いただけでは保存せず、続けてページを送ると間隔ごとに最新の位置だけを保存する', async () => {
    await renderViewer()
    vi.useFakeTimers()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('4 / 5')).toBeTruthy()
    expect(saved.position).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(POSITION_SAVE_INTERVAL_MS))
    expect(saved.position.mock.calls).toEqual([[book.bookId, 3]])
    expect(saved.view).not.toHaveBeenCalled()
  })

  it('閉じるときに待っている位置を書き出す', async () => {
    await renderViewer()
    vi.useFakeTimers()

    fireEvent.keyDown(window, { key: 'End' })
    cleanup()
    expect(saved.position.mock.calls).toEqual([[book.bookId, 4]])
  })

  it('保存してある位置と表示設定で開き、T・B・表紙単独を変えると表示設定を保存する', async () => {
    openedBook = {
      ...book,
      startIndex: 3,
      viewSettings: { spreadMode: 'spread', binding: 'right', coverSingle: false },
    }
    // 表紙単独なしの見開き: [0,1] [2,3] [4]。3 ページ目(0 始まり)を含む見開きから始まる。
    await renderViewer('3–4 / 5')
    expect(screen.getByRole('button', { name: '表紙単独' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.keyDown(window, { key: 'b' })
    expect(saved.view).toHaveBeenLastCalledWith(book.bookId, {
      spreadMode: 'spread',
      binding: 'left',
      coverSingle: false,
    })

    fireEvent.click(screen.getByRole('button', { name: '表紙単独' }))
    await vi.waitFor(() => expect(saved.view).toHaveBeenCalledTimes(2))
    expect(saved.view).toHaveBeenLastCalledWith(book.bookId, {
      spreadMode: 'spread',
      binding: 'left',
      coverSingle: true,
    })

    fireEvent.keyDown(window, { key: 't' })
    await vi.waitFor(() => expect(saved.view).toHaveBeenCalledTimes(3))
    expect(saved.view).toHaveBeenLastCalledWith(book.bookId, {
      spreadMode: 'single',
      binding: 'left',
      coverSingle: true,
    })
    expect(saved.view).toHaveBeenCalledTimes(3)
  })

  it('保存が無い本は設定画面の既定値で開き、EPUB の綴じ方向を優先する', async () => {
    const { useSettingsStore } = await import('@/features/settings/settings-store')
    useSettingsStore.setState({ defaultSpreadMode: 'spread', defaultBinding: 'left', defaultCoverSingle: false })
    openedBook = { ...book, pageProgression: 'rtl' }
    try {
      await renderViewer('1–2 / 5')
      // 右綴じなので ← が次。
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
      expect(screen.getByText('3–4 / 5')).toBeTruthy()
      expect(saved.view).not.toHaveBeenCalled()
    } finally {
      useSettingsStore.setState({ defaultSpreadMode: 'auto', defaultBinding: 'right', defaultCoverSingle: true })
    }
  })

  it('保存は要求した順に 1 件ずつ送り、前の保存が遅れても後の値が最後に残る', async () => {
    const pending: Array<() => void> = []
    const deferred = () => new Promise<void>((resolve) => pending.push(resolve))
    saved.view.mockImplementation(deferred)
    await renderViewer()

    // 綴じ方向を 右→左→右 と変える。前の保存が終わるまで次は送らない。
    fireEvent.keyDown(window, { key: 'b' })
    fireEvent.keyDown(window, { key: 'b' })
    expect(saved.view.mock.calls.map(([, settings]) => (settings as { binding: string }).binding)).toEqual(['left'])
    await act(async () => pending.shift()?.())
    expect(saved.view.mock.calls.map(([, settings]) => (settings as { binding: string }).binding)).toEqual([
      'left',
      'right',
    ])
    await act(async () => pending.shift()?.())
  })

  it('閉じた本の保存が終わるまで、次に開く本を読みに行かない', async () => {
    const pending: Array<() => void> = []
    saved.position.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)))
    const { router } = await renderViewer()
    vi.useFakeTimers()

    // 2 ページ目の保存が終わらないうちに 3 ページ目へ送って閉じる。
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    act(() => vi.advanceTimersByTime(POSITION_SAVE_INTERVAL_MS))
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    cleanup()
    expect(saved.position.mock.calls).toEqual([[book.bookId, 1]])
    vi.useRealTimers()

    // 開き直しは、先の 2 件の保存が順に終わるまで待つ。
    expect(saved.open).toHaveBeenCalledTimes(1)
    render(<RouterProvider router={router} />)
    await act(async () => {})
    expect(saved.open).toHaveBeenCalledTimes(1)
    await act(async () => pending.shift()?.())
    expect(saved.position.mock.calls).toEqual([
      [book.bookId, 1],
      [book.bookId, 2],
    ])
    expect(saved.open).toHaveBeenCalledTimes(1)
    await act(async () => pending.shift()?.())
    await screen.findByText('1 / 5')
    expect(saved.open).toHaveBeenCalledTimes(2)
  })
})

describe('ビューアを閉じる', () => {
  const folder = '/folders?source=1&path=%E6%BC%AB%E7%94%BB'

  it('Esc で本を開いたフォルダの画面へ戻る', async () => {
    const { router } = await renderViewer('1 / 5', [folder, `/viewer/${book.bookId}`])

    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/folders'))
    expect(router.state.location.search).toEqual({ source: 1, path: '漫画' })
  })

  it('Esc で閉じると、開いた本と表紙のために開いた前後の巻を手放す', async () => {
    const previous = { bookId: 'prev000000000000', title: '第1巻', path: 'C:/本/第1巻' }
    const next = { bookId: 'next000000000000', title: '第3巻', path: 'C:/本/第3巻' }
    saved.adjacent.mockResolvedValue({ previous, next })
    const { router } = await renderViewer('1 / 5', [folder, `/viewer/${book.bookId}`])
    const toNext = screen.getByRole('button', { name: '次の巻' }) as HTMLButtonElement
    await vi.waitFor(() => expect(toNext.disabled).toBe(false))
    expect(saved.close).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/folders'))
    await vi.waitFor(() => expect(saved.close).toHaveBeenCalledTimes(1))
    expect(saved.close).toHaveBeenCalledWith([book.bookId, previous.bookId, next.bookId])
  })

  it('別の本へ移ると、移る前の本を手放してから次の本を開く', async () => {
    const next = { bookId: 'next000000000000', title: '第3巻', path: 'C:/本/第3巻' }
    saved.adjacent.mockResolvedValue({ previous: null, next })
    await renderViewer('1 / 5', [folder, `/viewer/${book.bookId}`])
    const toNext = screen.getByRole('button', { name: '次の巻' }) as HTMLButtonElement
    await vi.waitFor(() => expect(toNext.disabled).toBe(false))

    openedBook = { ...book, bookId: next.bookId, title: next.title }
    fireEvent.click(toNext)
    await screen.findByRole('heading', { name: '第3巻' })
    expect(saved.close).toHaveBeenCalledWith([book.bookId, next.bookId])
    const closedAt = saved.close.mock.invocationCallOrder[0]
    const reopenedAt = saved.open.mock.invocationCallOrder[1]
    expect(closedAt).toBeLessThan(reopenedAt)
  })

  // 応答を待たせたまま表示する。`resolve` を呼ぶまで command は返らない。
  function deferredCalls<T>() {
    const pending: Array<(value: T) => void> = []
    const call = () => new Promise<T>((resolve) => pending.push(resolve))
    return { pending, call }
  }

  async function renderLoading(entries: string[]) {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: entries, initialIndex: entries.length - 1 }),
    })
    await router.load()
    render(<RouterProvider router={router} />)
    return router
  }

  it('本を開く応答より先に Esc で閉じると、遅れて返った本を手放す', async () => {
    const opens = deferredCalls<OpenedBook>()
    saved.open.mockImplementation(opens.call)
    const router = await renderLoading([folder, `/viewer/${book.bookId}`])
    await vi.waitFor(() => expect(opens.pending).toHaveLength(1))

    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/folders'))
    expect(saved.close).not.toHaveBeenCalled()

    await act(async () => opens.pending[0](book))
    await vi.waitFor(() => expect(saved.close).toHaveBeenCalledTimes(1))
    expect(saved.close).toHaveBeenCalledWith([book.bookId])
    expect(saved.adjacent).not.toHaveBeenCalled()
  })

  it('本を開く応答を受けてから表示に反映するまでの間に閉じても、その本を手放す', async () => {
    const opens = deferredCalls<OpenedBook>()
    saved.open.mockImplementation(opens.call)
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [`/viewer/${book.bookId}`] }),
    })
    await router.load()
    const { unmount } = render(<RouterProvider router={router} />)
    await vi.waitFor(() => expect(opens.pending).toHaveLength(1))

    // 同じ act の中で応答を返し、応答の処理(所有数の加算)が済んで表示へ反映する前に閉じる。
    await act(async () => {
      opens.pending[0](book)
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
      unmount()
    })
    await vi.waitFor(() => expect(saved.close).toHaveBeenCalledTimes(1))
    expect(saved.close).toHaveBeenCalledWith([book.bookId])

    // 同じ本を開き直して閉じても、所有数が残らずに手放す。
    saved.open.mockImplementation(() => Promise.resolve(book))
    await renderViewer()
    cleanup()
    await vi.waitFor(() => expect(saved.close).toHaveBeenCalledTimes(2))
    expect(saved.close).toHaveBeenLastCalledWith([book.bookId])
  })

  it('前後の巻の応答より先に Esc で閉じると、開いた本と遅れて返った前後の巻を手放す', async () => {
    const previous = { bookId: 'prev000000000000', title: '第1巻', path: 'C:/本/第1巻' }
    const next = { bookId: 'next000000000000', title: '第3巻', path: 'C:/本/第3巻' }
    const adjacents = deferredCalls<AdjacentBooks>()
    saved.adjacent.mockImplementation(adjacents.call)
    const { router } = await renderViewer('1 / 5', [folder, `/viewer/${book.bookId}`])
    await vi.waitFor(() => expect(adjacents.pending).toHaveLength(1))

    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/folders'))

    await act(async () => adjacents.pending[0]({ previous, next }))
    await vi.waitFor(() => expect(saved.close.mock.calls.flat(2)).toContain(next.bookId))
    expect(saved.close.mock.calls.flat(2).sort()).toEqual([book.bookId, next.bookId, previous.bookId].sort())
  })

  it.each([
    ['開き直した本より先に', [0, 1]],
    ['開き直した本より後に', [1, 0]],
  ])('閉じる前の応答が%s返っても、閉じた直後に開き直した同じ本は手放さない', async (_, order) => {
    const opens = deferredCalls<OpenedBook>()
    saved.open.mockImplementation(opens.call)
    const router = await renderLoading([folder, `/viewer/${book.bookId}`])
    await vi.waitFor(() => expect(opens.pending).toHaveLength(1))

    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/folders'))
    await act(async () => {
      await router.navigate({ to: '/viewer/$bookId', params: { bookId: book.bookId } })
    })
    await vi.waitFor(() => expect(opens.pending).toHaveLength(2))

    for (const index of order) await act(async () => opens.pending[index](book))
    await screen.findByText('1 / 5')
    await act(async () => {})
    expect(saved.close).not.toHaveBeenCalled()

    // 開き直したビューアを閉じれば、その本は手放す。
    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(saved.close).toHaveBeenCalledTimes(1))
    expect(saved.close).toHaveBeenCalledWith([book.bookId])
  })

  it('次の巻へ移った後も、Esc 1 回で本を開いたフォルダの画面へ戻る', async () => {
    const next = { bookId: 'next000000000000', title: '第3巻', path: 'C:/本/第3巻' }
    saved.adjacent.mockResolvedValue({ previous: null, next })
    const { router } = await renderViewer('1 / 5', [folder, `/viewer/${book.bookId}`])
    const toNext = screen.getByRole('button', { name: '次の巻' }) as HTMLButtonElement
    await vi.waitFor(() => expect(toNext.disabled).toBe(false))

    openedBook = { ...book, bookId: next.bookId, title: next.title }
    fireEvent.click(toNext)
    await screen.findByRole('heading', { name: '第3巻' })

    fireEvent.keyDown(window, { key: 'Escape' })
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/folders'))
    expect(router.state.location.search).toEqual({ source: 1, path: '漫画' })
  })
})

describe('前の巻・次の巻', () => {
  const previous = { bookId: 'prev000000000000', title: '第1巻', path: 'C:/本/第1巻' }
  const next = { bookId: 'next000000000000', title: '第3巻', path: 'C:/本/第3巻' }

  it('読み終わりの案内に次の巻の表紙と書名を出し、選ぶとその本を先頭から開く', async () => {
    saved.adjacent.mockResolvedValue({ previous, next })
    openedBook = { ...book, startIndex: 4 }
    const { router } = await renderViewer('5 / 5')
    expect(saved.adjacent).toHaveBeenCalledWith(book.bookId)

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('読み終わりました')).toBeTruthy()
    const card = await screen.findByRole('button', { name: /次の巻を読む/ })
    expect(card.textContent).toContain('第3巻')
    expect(card.querySelector('img')?.getAttribute('src')).toBe(`data:,0`)

    openedBook = { ...book, bookId: next.bookId, title: next.title, startIndex: 0 }
    fireEvent.click(card)
    await screen.findByRole('heading', { name: '第3巻' })
    expect(router.state.location.pathname).toBe(`/viewer/${next.bookId}`)
    expect(router.state.location.search).toEqual({ path: next.path, start: 'first' })
    expect(saved.open).toHaveBeenLastCalledWith(next.path, { fromStart: true })
    expect(screen.getByText('1 / 5')).toBeTruthy()
  })

  it('上端のバーから前後の巻へ移れ、隣の本が無い向きのボタンは押せない', async () => {
    saved.adjacent.mockResolvedValue({ previous, next: null })
    const { router } = await renderViewer()
    const toNext = screen.getByRole('button', { name: '次の巻' }) as HTMLButtonElement
    const toPrevious = screen.getByRole('button', { name: '前の巻' }) as HTMLButtonElement
    await vi.waitFor(() => expect(toPrevious.disabled).toBe(false))
    expect(toNext.disabled).toBe(true)

    fireEvent.click(toPrevious)
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/viewer/${previous.bookId}`))
    expect(router.state.location.search).toEqual({ path: previous.path, start: 'first' })
    await vi.waitFor(() => expect(saved.open).toHaveBeenLastCalledWith(previous.path, { fromStart: true }))
  })

  it('次の巻が無い本は、読み終わりの案内にその旨を出す', async () => {
    openedBook = { ...book, startIndex: 4 }
    await renderViewer('5 / 5')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('次の巻の情報はありません。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /次の巻を読む/ })).toBeNull()
  })
})

describe('PDF のページ', () => {
  // 退避は beforeAll が空実装を置いた後に行う(describe の定義時にはまだ無い)。
  let observer: typeof ResizeObserver
  let ratio: number

  // 表示領域を幅 1000・高さ 800 に見せ、観察を始めたらすぐ知らせる。
  beforeEach(() => {
    observer = globalThis.ResizeObserver
    ratio = window.devicePixelRatio
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
    globalThis.ResizeObserver = class {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe() {
        this.callback([], this as unknown as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    }
    window.devicePixelRatio = 1.5
  })
  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.ResizeObserver = observer
    window.devicePixelRatio = ratio
  })

  it('PDF は表示幅に画素比を掛けた幅でページを要求し、ほかの形式は元画像を要求する', async () => {
    await renderViewer('1 / 5', [`/viewer/${book.bookId}?path=${encodeURIComponent('C:/本/資料.PDF')}`])
    expect(screen.getByAltText('1 ページ').getAttribute('src')).toBe('data:,0@1536')
    cleanup()

    await renderViewer('1 / 5', [`/viewer/${book.bookId}?path=${encodeURIComponent('C:/本/画集.zip')}`])
    expect(screen.getByAltText('1 ページ').getAttribute('src')).toBe('data:,0')
  })
})

describe('長い本', () => {
  it('500 ページ送っても、描く画像と先読みで持つ画像は表示中の近くの分だけで増えない', async ({ annotate }) => {
    const pageCount = 500
    openedBook = {
      ...book,
      pages: Array.from({ length: pageCount }, (_, index) => ({ name: `${index}.png`, width: 1000, height: 1500 })),
    }
    // 先読みが作った画像を覚え、手放した(src を外した)かどうかを最後に見る。
    const created: HTMLImageElement[] = []
    const NativeImage = globalThis.Image
    vi.stubGlobal(
      'Image',
      class extends NativeImage {
        constructor() {
          super()
          created.push(this)
        }
      },
    )
    try {
      await renderViewer(`1 / ${pageCount}`)

      const started = performance.now()
      // 綴じ方向に関わらず次へ進む PageDown で送る。
      for (let turn = 1; turn < pageCount; turn += 1) fireEvent.keyDown(window, { key: 'PageDown' })
      const elapsed = performance.now() - started
      expect(screen.getByText(`${pageCount} / ${pageCount}`)).toBeTruthy()
      await annotate(`[perf] ページ送り ${pageCount - 1} 回: 合計 ${elapsed.toFixed(0)} ms、1 回 ${(elapsed / (pageCount - 1)).toFixed(2)} ms`)

      // 描いているのは表示中のページだけ。先読みで持つのは最後の見開きから 2 つ前までの分だけで、
      // 画像要素は使い回すので、送った回数だけ作ることはない(前のテストが作った要素も使い回されうる)。
      expect(document.querySelectorAll('img')).toHaveLength(1)
      const held = created.filter((image) => image.hasAttribute('src')).map((image) => image.getAttribute('src'))
      for (const src of held) expect(['data:,497', 'data:,498', 'data:,499']).toContain(src)
      expect(created.length).toBeLessThanOrEqual(2 * PRELOAD_RADIUS + 2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
