import type { OpenedBook, PageInfo, PageProgression, ViewSettings } from '@/types/app'

import { pageToSpreadIndex, type Binding, type Spread, type SpreadMode } from './spread'
import type { Zoom } from './zoom'

// ビューアの状態機械。表示中の位置・読み終わり・合わせ方・UI の表示を 1 つの reducer で持つ。
// 見開きの列は状態に持たず、本と表示設定と画面の大きさから毎回導く(位置はページ番号で持つので、
// 列が組み変わっても同じページを含む見開きに留まる)。

// 合わせ方。`screen` は見開き全体を画面に収め、`width` は画面の幅に合わせて縦にスクロールする。
export type FitMode = 'screen' | 'width'

// 操作が止まってから UI を隠すまでの時間。
export const UI_HIDE_DELAY_MS = 2500

// ポインタが入ると UI を出す、画面の上端・下端の帯の高さ(CSS px)。
export const UI_EDGE_BAND_PX = 64

// 先読みする前後の見開きの数。
export const PRELOAD_RADIUS = 2

// 見開きの組み方(綴じ方向以外)。
export interface SpreadView {
  mode: SpreadMode
  coverSingle: boolean
  shift: boolean
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; book: OpenedBook; binding: Binding }
  | { status: 'error'; message: string }

export interface ViewerState {
  load: LoadState
  // 表示中の見開きに含まれるページ(読む順で最初のページ)。
  page: number
  // 最後の見開きの次(読み終わりの案内)にいる。
  finished: boolean
  view: SpreadView
  fit: FitMode
  // 拡大表示(null は拡大していない)。ページや組み方・合わせ方・画面の大きさが変わると解く。
  zoom: Zoom | null
  viewport: { width: number; height: number }
  ui: {
    visible: boolean
    // ポインタが UI の上にある間は隠さない。
    held: boolean
    // ポインタが上端・下端の帯にある間は出したまま隠さない。
    edge: boolean
    // 中央クリックで出した UI は、もう一度の中央クリックかページ送りまで隠さない。
    pinned: boolean
    // 操作のたびに増やし、隠すまでの時間を数え直す合図にする。
    activity: number
  }
}

export type ViewerAction =
  // `defaults` は表示設定を保存していない本に使う既定値(設定画面の値)。
  | { type: 'opened'; book: OpenedBook; defaults: ViewSettings }
  | { type: 'failed'; message: string }
  | { type: 'next'; spreads: readonly Spread[] }
  | { type: 'prev'; spreads: readonly Spread[] }
  | { type: 'first'; spreads: readonly Spread[] }
  | { type: 'last'; spreads: readonly Spread[] }
  | { type: 'seek'; page: number }
  // 見開きと単ページを入れ替える。`twoPages` は今 2 ページ並べて出しているか。
  | { type: 'toggleSpread'; twoPages: boolean }
  | { type: 'toggleBinding' }
  | { type: 'toggleShift' }
  | { type: 'toggleCoverSingle' }
  | { type: 'setFit'; fit: FitMode }
  | { type: 'setZoom'; zoom: Zoom | null }
  | { type: 'resized'; width: number; height: number }
  // ポインタが上端・下端の帯に入った・出た。
  | { type: 'edgeBand'; inside: boolean }
  // 出ている UI の上以外でポインタが動いた(帯の出入りは無い)。隠すまでの時間を数え直す。
  | { type: 'pointerActive' }
  | { type: 'hideUi' }
  | { type: 'toggleUi' }
  | { type: 'holdUi'; held: boolean }

export const initialViewerState: ViewerState = {
  load: { status: 'loading' },
  page: 0,
  finished: false,
  view: { mode: 'auto', coverSingle: true, shift: false },
  fit: 'screen',
  zoom: null,
  viewport: { width: 0, height: 0 },
  ui: { visible: true, held: false, edge: false, pinned: false, activity: 0 },
}

// 本の綴じ方向を見開き計算の綴じ方向に変える。指定の無い本は右綴じ(設定の既定値)。
export function bindingOf(progression: PageProgression | undefined): Binding {
  return progression === 'ltr' ? 'left' : 'right'
}

// 開いた本の表示設定。保存してあればそれを使う。無ければ設定画面の既定値で、
// 綴じ方向だけは本(EPUB)が指定していればそちらを優先する。
export function initialViewSettings(book: OpenedBook, defaults: ViewSettings): ViewSettings {
  if (book.viewSettings) return book.viewSettings
  return {
    ...defaults,
    binding: book.pageProgression ? bindingOf(book.pageProgression) : defaults.binding,
  }
}

// 今の表示設定(本ごとに保存する形)。本を開く前は null。
export function currentViewSettings(state: ViewerState): ViewSettings | null {
  if (state.load.status !== 'ready') return null
  return {
    spreadMode: state.view.mode,
    binding: state.load.binding,
    coverSingle: state.view.coverSingle,
  }
}

// 表示を組み変える操作も「操作」に数え、UI を隠すまでの時間を数え直す(表示・非表示は変えない)。
// 表示する見開きや組み方が変わるので拡大も解く。
function touched(state: ViewerState): ViewerState {
  return { ...state, zoom: null, ui: { ...state.ui, activity: state.ui.activity + 1 } }
}

// ページ送り。UI は出さず、中央クリックで出した UI も隠す。ポインタが帯か UI の上にある間だけは出したままにする。
function paged(state: ViewerState): ViewerState {
  const moved = touched(state)
  const { ui } = moved
  return { ...moved, ui: { ...ui, visible: ui.visible && (ui.edge || ui.held), pinned: false } }
}

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case 'opened': {
      const { book } = action
      const last = book.pages.length - 1
      const page = Math.min(Math.max(0, book.startIndex), Math.max(0, last))
      const settings = initialViewSettings(book, action.defaults)
      return {
        ...state,
        load: { status: 'ready', book, binding: settings.binding },
        view: { mode: settings.spreadMode, coverSingle: settings.coverSingle, shift: false },
        page,
        finished: false,
        zoom: null,
      }
    }
    case 'failed':
      return { ...state, load: { status: 'error', message: action.message } }
    case 'next': {
      if (state.finished) return state
      const index = pageToSpreadIndex(action.spreads, state.page)
      if (index < 0) return state
      // 最後の見開きの次は先頭へ戻らず、読み終わりの案内へ進む。
      if (index >= action.spreads.length - 1) return paged({ ...state, finished: true })
      return paged({ ...state, page: action.spreads[index + 1].pages[0] })
    }
    case 'prev': {
      if (state.finished) return paged({ ...state, finished: false })
      const index = pageToSpreadIndex(action.spreads, state.page)
      if (index <= 0) return state
      return paged({ ...state, page: action.spreads[index - 1].pages[0] })
    }
    case 'first':
    case 'last': {
      const spread = action.type === 'first' ? action.spreads[0] : action.spreads.at(-1)
      if (!spread) return state
      return paged({ ...state, page: spread.pages[0], finished: false })
    }
    case 'seek': {
      // スライダーの操作。UI の上での操作なので、出ている UI は出したままにして時間を数え直す。
      if (state.load.status !== 'ready') return state
      const last = state.load.book.pages.length - 1
      if (last < 0) return state
      const page = Math.min(Math.max(0, Math.trunc(action.page)), last)
      return touched({ ...state, page, finished: false })
    }
    case 'toggleSpread':
      return touched({ ...state, view: { ...state.view, mode: action.twoPages ? 'single' : 'spread' } })
    case 'toggleBinding': {
      if (state.load.status !== 'ready') return state
      const binding: Binding = state.load.binding === 'right' ? 'left' : 'right'
      return touched({ ...state, load: { ...state.load, binding } })
    }
    case 'toggleShift':
      return touched({ ...state, view: { ...state.view, shift: !state.view.shift } })
    case 'toggleCoverSingle':
      return touched({ ...state, view: { ...state.view, coverSingle: !state.view.coverSingle } })
    case 'setFit':
      return state.fit === action.fit ? state : { ...state, fit: action.fit, zoom: null }
    case 'setZoom':
      // 読み終わりの案内や本を開く前は拡大しない。
      if (action.zoom && (state.finished || state.load.status !== 'ready')) return state
      return { ...state, zoom: action.zoom }
    case 'resized':
      if (state.viewport.width === action.width && state.viewport.height === action.height) {
        return state
      }
      return { ...state, viewport: { width: action.width, height: action.height }, zoom: null }
    case 'edgeBand':
      if (state.ui.edge === action.inside) return state
      if (action.inside) return { ...state, ui: { ...state.ui, edge: true, visible: true } }
      // 帯から出たところから、隠すまでの時間を数え始める。
      return { ...state, ui: { ...state.ui, edge: false, activity: state.ui.activity + 1 } }
    case 'pointerActive':
      if (!uiHides(state.ui)) return state
      return { ...state, ui: { ...state.ui, activity: state.ui.activity + 1 } }
    case 'hideUi':
      if (!uiHides(state.ui)) return state
      return { ...state, ui: { ...state.ui, visible: false } }
    case 'toggleUi':
      if (state.ui.visible) return { ...state, ui: { ...state.ui, visible: false, pinned: false } }
      return { ...state, ui: { ...state.ui, visible: true, pinned: true, activity: state.ui.activity + 1 } }
    case 'holdUi':
      if (state.ui.held === action.held) return state
      return { ...state, ui: { ...state.ui, held: action.held, visible: true } }
  }
}

// 出ている UI が、操作が止まったら隠れる状態か(ポインタが帯や UI の上に無く、中央クリックで出したものでもない)。
export function uiHides(ui: ViewerState['ui']): boolean {
  return ui.visible && !ui.held && !ui.edge && !ui.pinned
}

// 先読みするページを優先順に返す。表示中の見開き、次、前、2 つ先、2 つ前の順。
export function preloadPages(
  spreads: readonly Spread[],
  spreadIndex: number,
  radius: number = PRELOAD_RADIUS,
): number[] {
  const pages: number[] = []
  const add = (index: number) => {
    if (index >= 0 && index < spreads.length) pages.push(...spreads[index].pages)
  }
  add(spreadIndex)
  for (let distance = 1; distance <= radius; distance += 1) {
    add(spreadIndex + distance)
    add(spreadIndex - distance)
  }
  return pages
}

export interface SlotBox {
  // null は見開きの空いた側。
  page: number | null
  width: number
  height: number
}

// 寸法の読めないページに使う縦横比(幅 / 高さ)。
const FALLBACK_ASPECT = 0.7

function aspectOf(page: PageInfo | undefined): number {
  if (!page || page.width <= 0 || page.height <= 0) return FALLBACK_ASPECT
  return page.width / page.height
}

// 見開きの各ページを同じ高さにそろえ、合わせ方に従って画面上の大きさ(CSS px)を決める。
// 空いた側は、並ぶページと同じ大きさの空きにする。
export function fitSpread(
  spread: Spread,
  pages: readonly PageInfo[],
  fit: FitMode,
  viewport: { width: number; height: number },
): SlotBox[] {
  const filled = spread.layout.find((page): page is number => page !== null)
  const aspects = spread.layout.map((page) => aspectOf(pages[page ?? filled ?? -1]))
  const totalAspect = aspects.reduce((sum, aspect) => sum + aspect, 0)
  const byWidth = viewport.width / totalAspect
  const height = Math.max(0, Math.floor(fit === 'width' ? byWidth : Math.min(byWidth, viewport.height)))
  return spread.layout.map((page, index) => ({
    page,
    width: Math.floor(height * aspects[index]),
    height,
  }))
}
