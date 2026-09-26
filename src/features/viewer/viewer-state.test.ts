import { describe, expect, it } from 'vitest'

import type { OpenedBook, OpenMode, ViewSettings } from '@/types/app'

import { buildSpreads, type Spread } from './spread'
import {
  bindingOf,
  currentViewSettings,
  fitSpread,
  initialViewerState,
  preloadPages,
  uiHides,
  viewerReducer,
  type ViewerState,
} from './viewer-state'

function book(pageCount: number, startIndex = 0, openMode: OpenMode = 'book'): OpenedBook {
  return {
    bookId: '0123456789abcdef',
    title: 'テスト',
    startIndex,
    openMode,
    pages: Array.from({ length: pageCount }, (_, index) => ({
      name: `${index}.png`,
      width: 1000,
      height: 1500,
    })),
  }
}

// 表紙単独・見開きで 5 ページ: [0] [1,2] [3,4]
const spreads: Spread[] = buildSpreads(book(5).pages, {
  mode: 'spread',
  binding: 'right',
  coverSingle: true,
  shift: false,
  viewportAspect: 16 / 9,
})

const defaultView: ViewSettings = { spreadMode: 'auto', binding: 'right', coverSingle: true }

function opened(pageCount = 5, startIndex = 0, openMode: OpenMode = 'book'): ViewerState {
  return viewerReducer(initialViewerState, {
    type: 'opened',
    book: book(pageCount, startIndex, openMode),
    defaults: defaultView,
  })
}

describe('ビューアの状態', () => {
  it('最後の見開きの次は先頭に戻らず読み終わりになり、それ以上は進まない', () => {
    let state = opened()
    state = viewerReducer(state, { type: 'next', spreads })
    state = viewerReducer(state, { type: 'next', spreads })
    expect(state).toMatchObject({ page: 3, finished: false })

    state = viewerReducer(state, { type: 'next', spreads })
    expect(state).toMatchObject({ page: 3, finished: true })
    expect(viewerReducer(state, { type: 'next', spreads })).toBe(state)
  })

  it('読み終わりから戻ると最後の見開きへ、先頭の見開きからは前へ戻らない', () => {
    let state = opened()
    for (let step = 0; step < 3; step += 1) state = viewerReducer(state, { type: 'next', spreads })
    state = viewerReducer(state, { type: 'prev', spreads })
    expect(state).toMatchObject({ page: 3, finished: false })

    const first = opened()
    expect(viewerReducer(first, { type: 'prev', spreads })).toBe(first)
  })

  it('画像ファイルを直接開いたときは、最後の見開きの次は最初へ、最初の見開きの前は最後へ回り、読み終わりにならない', () => {
    let state = opened(5, 3, 'image')
    state = viewerReducer(state, { type: 'next', spreads })
    expect(state).toMatchObject({ page: 0, finished: false })

    state = viewerReducer(state, { type: 'prev', spreads })
    expect(state).toMatchObject({ page: 3, finished: false })

    // 見開きの途中のページにいても、最後の見開きの前は 1 つ前の見開きへ普通に戻る。
    state = viewerReducer(state, { type: 'prev', spreads })
    expect(state).toMatchObject({ page: 1, finished: false })
  })

  it('画像ファイルを直接開いても、最初・最後へ飛ぶ操作は回らずその見開きへ移る', () => {
    const state = opened(5, 2, 'image')
    expect(viewerReducer(state, { type: 'first', spreads })).toMatchObject({ page: 0, finished: false })
    expect(viewerReducer(state, { type: 'last', spreads })).toMatchObject({ page: 3, finished: false })
  })

  it('見開きの途中のページから始めても、そのページを含む見開きから前後へ動く', () => {
    const state = opened(5, 2)
    expect(viewerReducer(state, { type: 'next', spreads }).page).toBe(3)
    expect(viewerReducer(state, { type: 'prev', spreads }).page).toBe(0)
  })

  it('開始ページが範囲外なら範囲内に収める', () => {
    expect(opened(5, 99).page).toBe(4)
    expect(opened(5, -1).page).toBe(0)
  })

  it('UI はポインタが上にある間は隠さない', () => {
    const held = viewerReducer(opened(), { type: 'holdUi', held: true })
    expect(viewerReducer(held, { type: 'hideUi' }).ui.visible).toBe(true)
    const released = viewerReducer(held, { type: 'holdUi', held: false })
    expect(viewerReducer(released, { type: 'hideUi' }).ui.visible).toBe(false)
  })

  it('ページ送りは UI を出さず、ポインタが帯にある間だけ出したままにする', () => {
    const hidden = viewerReducer(opened(), { type: 'hideUi' })
    for (const action of [
      { type: 'next', spreads },
      { type: 'last', spreads },
      { type: 'seek', page: 3 },
    ] as const) {
      const moved = viewerReducer(hidden, action)
      expect(moved.page).not.toBe(hidden.page)
      expect(moved.ui.visible).toBe(false)
    }

    const inBand = viewerReducer(hidden, { type: 'edgeBand', inside: true })
    expect(inBand.ui.visible).toBe(true)
    const movedInBand = viewerReducer(inBand, { type: 'next', spreads })
    expect(movedInBand.ui.visible).toBe(true)
    expect(viewerReducer(movedInBand, { type: 'hideUi' }).ui.visible).toBe(true)
  })

  it('帯から出ると隠せるようになり、中央クリックで出した UI はページ送りまで隠さない', () => {
    const inBand = viewerReducer(viewerReducer(opened(5, 3), { type: 'hideUi' }), { type: 'edgeBand', inside: true })
    const left = viewerReducer(inBand, { type: 'edgeBand', inside: false })
    expect(uiHides(left.ui)).toBe(true)
    expect(left.ui.activity).toBeGreaterThan(inBand.ui.activity)
    expect(viewerReducer(left, { type: 'hideUi' }).ui.visible).toBe(false)

    const pinned = viewerReducer(viewerReducer(left, { type: 'hideUi' }), { type: 'toggleUi' })
    expect(pinned.ui).toMatchObject({ visible: true, pinned: true })
    expect(viewerReducer(pinned, { type: 'hideUi' }).ui.visible).toBe(true)
    // 組み方の切り替えはページ送りではないので出したまま。
    expect(viewerReducer(pinned, { type: 'toggleShift' }).ui.visible).toBe(true)
    const moved = viewerReducer(pinned, { type: 'prev', spreads })
    expect(moved.ui).toMatchObject({ visible: false, pinned: false })
  })

  it('帯の外でのポインタの動きは隠すまでの時間だけを数え直し、隠れた UI は出さない', () => {
    const shown = viewerReducer(viewerReducer(opened(), { type: 'hideUi' }), { type: 'toggleUi' })
    const unpinned = { ...shown, ui: { ...shown.ui, pinned: false } }
    const moved = viewerReducer(unpinned, { type: 'pointerActive' })
    expect(moved.ui.activity).toBeGreaterThan(unpinned.ui.activity)
    expect(moved.ui.visible).toBe(true)

    const hidden = viewerReducer(unpinned, { type: 'hideUi' })
    expect(viewerReducer(hidden, { type: 'pointerActive' })).toBe(hidden)
  })

  it('スライダーでのシークは出ている UI を隠さない', () => {
    const pinned = viewerReducer(viewerReducer(opened(), { type: 'hideUi' }), { type: 'toggleUi' })
    const sought = viewerReducer(pinned, { type: 'seek', page: 3 })
    expect(sought.page).toBe(3)
    expect(sought.ui).toMatchObject({ visible: true, pinned: true })
  })

  it('Home / End は最初・最後の見開きへ動き、読み終わりから抜ける', () => {
    let state = opened(5, 2)
    state = viewerReducer(state, { type: 'last', spreads })
    expect(state).toMatchObject({ page: 3, finished: false })
    state = viewerReducer(state, { type: 'next', spreads })
    expect(state.finished).toBe(true)
    state = viewerReducer(state, { type: 'first', spreads })
    expect(state).toMatchObject({ page: 0, finished: false })
  })

  it('シークは指定のページへ動き、範囲外は範囲内に収める', () => {
    const state = opened()
    expect(viewerReducer(state, { type: 'seek', page: 3 }).page).toBe(3)
    expect(viewerReducer(state, { type: 'seek', page: 99 }).page).toBe(4)
    expect(viewerReducer(state, { type: 'seek', page: -5 }).page).toBe(0)
    expect(viewerReducer(initialViewerState, { type: 'seek', page: 2 })).toBe(initialViewerState)
  })

  it('見開き切り替えは今の表示の逆を指定し、綴じ方向とずらしは反転する', () => {
    const state = opened()
    expect(viewerReducer(state, { type: 'toggleSpread', twoPages: true }).view.mode).toBe('single')
    expect(viewerReducer(state, { type: 'toggleSpread', twoPages: false }).view.mode).toBe('spread')

    const flipped = viewerReducer(state, { type: 'toggleBinding' })
    expect(flipped.load).toMatchObject({ binding: 'left' })
    expect(viewerReducer(flipped, { type: 'toggleBinding' }).load).toMatchObject({ binding: 'right' })

    expect(viewerReducer(state, { type: 'toggleShift' }).view.shift).toBe(true)
  })

  it('中央のクリックで UI を出し入れする', () => {
    const hidden = viewerReducer(opened(), { type: 'toggleUi' })
    expect(hidden.ui.visible).toBe(false)
    const shown = viewerReducer(hidden, { type: 'toggleUi' })
    expect(shown.ui.visible).toBe(true)
    expect(shown.ui.activity).toBeGreaterThan(hidden.ui.activity)
  })

  it('拡大はページ・組み方・合わせ方・画面の大きさが変わると解け、UI の出し入れでは解けない', () => {
    const zoom = { scale: 2, x: 10, y: -10 }
    const zoomed = viewerReducer(opened(), { type: 'setZoom', zoom })
    expect(zoomed.zoom).toEqual(zoom)
    expect(viewerReducer(zoomed, { type: 'toggleUi' }).zoom).toEqual(zoom)
    expect(viewerReducer(zoomed, { type: 'edgeBand', inside: true }).zoom).toEqual(zoom)

    expect(viewerReducer(zoomed, { type: 'next', spreads }).zoom).toBeNull()
    expect(viewerReducer(zoomed, { type: 'seek', page: 3 }).zoom).toBeNull()
    expect(viewerReducer(zoomed, { type: 'toggleShift' }).zoom).toBeNull()
    expect(viewerReducer(zoomed, { type: 'setFit', fit: 'width' }).zoom).toBeNull()
    expect(viewerReducer(zoomed, { type: 'resized', width: 800, height: 600 }).zoom).toBeNull()
  })

  it('本を開く前と読み終わりの案内では拡大しない', () => {
    const zoom = { scale: 2, x: 0, y: 0 }
    expect(viewerReducer(initialViewerState, { type: 'setZoom', zoom }).zoom).toBeNull()
    const finished = viewerReducer(viewerReducer(opened(), { type: 'last', spreads }), { type: 'next', spreads })
    expect(finished.finished).toBe(true)
    expect(viewerReducer(finished, { type: 'setZoom', zoom }).zoom).toBeNull()
  })

  it('綴じ方向の指定が無い本は右綴じにする', () => {
    expect(bindingOf(undefined)).toBe('right')
    expect(bindingOf('rtl')).toBe('right')
    expect(bindingOf('ltr')).toBe('left')
  })
})

describe('本ごとの表示設定', () => {
  const open = (overrides: Partial<OpenedBook>, defaults: ViewSettings = defaultView) =>
    viewerReducer(initialViewerState, { type: 'opened', book: { ...book(5), ...overrides }, defaults })

  it('保存が無い本は設定画面の既定値で開き、綴じ方向だけは EPUB の指定を優先する', () => {
    const defaults: ViewSettings = { spreadMode: 'single', binding: 'left', coverSingle: false }
    expect(currentViewSettings(open({}, defaults))).toEqual(defaults)
    expect(currentViewSettings(open({ pageProgression: 'rtl' }, defaults))).toEqual({
      ...defaults,
      binding: 'right',
    })
  })

  it('保存してある表示設定は既定値と EPUB の指定より優先する', () => {
    const saved: ViewSettings = { spreadMode: 'spread', binding: 'left', coverSingle: false }
    const state = open({ pageProgression: 'rtl', viewSettings: saved })
    expect(currentViewSettings(state)).toEqual(saved)
    expect(state.view.shift).toBe(false)
  })

  it('T・B・表紙単独の切り替えが保存する形に表れる', () => {
    let state = open({})
    state = viewerReducer(state, { type: 'toggleSpread', twoPages: false })
    state = viewerReducer(state, { type: 'toggleBinding' })
    state = viewerReducer(state, { type: 'toggleCoverSingle' })
    expect(currentViewSettings(state)).toEqual({ spreadMode: 'spread', binding: 'left', coverSingle: false })
    expect(currentViewSettings(initialViewerState)).toBeNull()
  })
})

describe('先読み', () => {
  it('表示中の見開きと前後 2 見開きのページだけを、近い順に返す', () => {
    const many = buildSpreads(book(12).pages, {
      mode: 'spread',
      binding: 'right',
      coverSingle: true,
      shift: false,
      viewportAspect: 16 / 9,
    })
    // [0] [1,2] [3,4] [5,6] [7,8] [9,10] [11]
    expect(preloadPages(many, 3)).toEqual([5, 6, 7, 8, 3, 4, 9, 10, 1, 2])
    expect(preloadPages(many, 0)).toEqual([0, 1, 2, 3, 4])
    expect(preloadPages(many, 6)).toEqual([11, 9, 10, 7, 8])
  })
})

describe('合わせ方', () => {
  const pages = book(3).pages
  const pair: Spread = { pages: [1, 2], layout: [2, 1] }

  it('画面に合わせると見開き全体が画面に収まる', () => {
    const slots = fitSpread(pair, pages, 'screen', { width: 1600, height: 900 })
    expect(slots.map((slot) => slot.height)).toEqual([900, 900])
    expect(slots.reduce((sum, slot) => sum + slot.width, 0)).toBeLessThanOrEqual(1600)

    const narrow = fitSpread(pair, pages, 'screen', { width: 800, height: 900 })
    expect(narrow.reduce((sum, slot) => sum + slot.width, 0)).toBeLessThanOrEqual(800)
    expect(narrow[0].height).toBeLessThanOrEqual(900)
  })

  it('幅に合わせると画面の幅いっぱいに広げ、高さは画面を超えてよい', () => {
    const slots = fitSpread(pair, pages, 'width', { width: 1600, height: 900 })
    const total = slots.reduce((sum, slot) => sum + slot.width, 0)
    expect(total).toBeGreaterThan(1596)
    expect(total).toBeLessThanOrEqual(1600)
    expect(slots[0].height).toBeGreaterThan(900)
  })

  it('片側が空く見開きは、空きをページと同じ大きさにする', () => {
    const slots = fitSpread({ pages: [1], layout: [null, 1] }, pages, 'screen', {
      width: 1600,
      height: 900,
    })
    expect(slots[0]).toEqual({ ...slots[1], page: null })
  })
})
