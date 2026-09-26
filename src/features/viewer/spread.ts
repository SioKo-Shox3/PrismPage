import type { Binding, PageInfo, PageSpread, SpreadMode } from '@/types/app'

// 見開き計算。ページの寸法と見開き指定、表示設定から「1 画面に出すページの組」の列を作る。
// React にも Tauri にも依存しない純粋関数だけを置く。

// 表示モード(`auto` はウィンドウが横長のときだけ見開き)と綴じ方向(右綴じは読む順の先のページを右に置く)。
// 本ごとに保存する値と同じ語なので、型は `@/types/app` に置く。
export type { Binding, SpreadMode }

// 見開き計算に要るページの情報。
export type SpreadPage = Pick<PageInfo, 'width' | 'height' | 'spread'>

export interface SpreadOptions {
  mode: SpreadMode
  binding: Binding
  // 1 ページ目(表紙)を単独で出す。
  coverSingle: boolean
  // 組み合わせを 1 ページずらす。表紙の後の最初に組める位置のページを単独にして、以降の組の偶奇を入れ替える。
  shift: boolean
  // ウィンドウの幅 / 高さ。`auto` のときだけ見る。
  viewportAspect: number
}

export interface Spread {
  // 読む順のページ番号(1 個か 2 個)。
  pages: number[]
  // 画面の左から並べたページ番号。見開き表示で左右指定のあるページを単独で出すときは、空く側を null にする。
  layout: (number | null)[]
}

// 横長のページ。見開きでは必ず単独で出す。
export function isLandscape(page: SpreadPage): boolean {
  return page.width > page.height
}

// 設定と画面の縦横比から、2 ページ並べて出すかを決める。
export function usesTwoPages(mode: SpreadMode, viewportAspect: number): boolean {
  if (mode === 'single') return false
  if (mode === 'spread') return true
  return Number.isFinite(viewportAspect) && viewportAspect > 1
}

// 見開きの列を返す。ページが無ければ空の列。
export function buildSpreads(pages: readonly SpreadPage[], options: SpreadOptions): Spread[] {
  const spreads: Spread[] = []

  if (!usesTwoPages(options.mode, options.viewportAspect)) {
    for (let index = 0; index < pages.length; index += 1) {
      spreads.push({ pages: [index], layout: [index] })
    }
    return spreads
  }

  // 読む順で先に来るページを置く側。右綴じなら右。
  const leadSide: PageSpread = options.binding === 'right' ? 'right' : 'left'
  const trailSide: PageSpread = leadSide === 'right' ? 'left' : 'right'
  let shiftPending = options.shift

  const single = (index: number) => {
    const side = pages[index].spread
    const layout = side === 'left' ? [index, null] : side === 'right' ? [null, index] : [index]
    spreads.push({ pages: [index], layout })
  }

  let index = 0
  while (index < pages.length) {
    const page = pages[index]

    if (index === 0 && options.coverSingle) {
      single(index)
      index += 1
      continue
    }
    if (isLandscape(page)) {
      single(index)
      index += 1
      continue
    }
    const next = pages[index + 1]
    const canPair =
      next !== undefined &&
      !isLandscape(next) &&
      page.spread !== trailSide &&
      next.spread !== leadSide
    if (!canPair) {
      single(index)
      index += 1
      continue
    }
    // ずらしは、組を作れる最初の位置で 1 回だけ効かせる。組めない位置では消費しない。
    if (shiftPending) {
      shiftPending = false
      single(index)
      index += 1
      continue
    }

    const layout = leadSide === 'right' ? [index + 1, index] : [index, index + 1]
    spreads.push({ pages: [index, index + 1], layout })
    index += 2
  }

  return spreads
}

// ページ番号を、そのページを含む見開きの番号に変える。範囲外は -1。
export function pageToSpreadIndex(spreads: readonly Spread[], page: number): number {
  if (!Number.isInteger(page)) return -1
  let low = 0
  let high = spreads.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const pagesOfSpread = spreads[middle].pages
    const first = pagesOfSpread[0]
    const last = pagesOfSpread[pagesOfSpread.length - 1]
    if (page < first) {
      high = middle - 1
    } else if (page > last) {
      low = middle + 1
    } else {
      return middle
    }
  }
  return -1
}

// 見開きの番号を、その見開きで読む順の最初のページ番号に変える。範囲外は -1。
export function spreadIndexToPage(spreads: readonly Spread[], spreadIndex: number): number {
  if (!Number.isInteger(spreadIndex) || spreadIndex < 0 || spreadIndex >= spreads.length) {
    return -1
  }
  return spreads[spreadIndex].pages[0]
}
