import { describe, expect, it } from 'vitest'

import {
  buildSpreads,
  pageToSpreadIndex,
  spreadIndexToPage,
  type SpreadOptions,
  type SpreadPage,
} from './spread'

const portrait: SpreadPage = { width: 1000, height: 1500 }
const landscape: SpreadPage = { width: 2000, height: 1500 }

function portraits(count: number): SpreadPage[] {
  return Array.from({ length: count }, () => ({ ...portrait }))
}

const base: SpreadOptions = {
  mode: 'spread',
  binding: 'right',
  coverSingle: true,
  shift: false,
  viewportAspect: 16 / 9,
}

function pagesOf(pages: SpreadPage[], options: Partial<SpreadOptions> = {}) {
  return buildSpreads(pages, { ...base, ...options }).map((spread) => spread.pages)
}

describe('見開き計算', () => {
  it('表紙単独なら 1 ページ目だけを単独にし、以降を 2 ページずつ組む', () => {
    expect(pagesOf(portraits(5))).toEqual([[0], [1, 2], [3, 4]])
  })

  it('表紙単独を切ると 1 ページ目から組む', () => {
    expect(pagesOf(portraits(4), { coverSingle: false })).toEqual([
      [0, 1],
      [2, 3],
    ])
  })

  it('奇数ページが末尾に余ると最後のページを単独にする', () => {
    expect(pagesOf(portraits(4))).toEqual([[0], [1, 2], [3]])
    expect(pagesOf(portraits(3), { coverSingle: false })).toEqual([[0, 1], [2]])
  })

  it('横長のページは単独にし、その後ろから組み直す', () => {
    const pages = [portrait, portrait, landscape, portrait, portrait, portrait]
    expect(pagesOf(pages, { coverSingle: false })).toEqual([[0, 1], [2], [3, 4], [5]])
    // 組の相手になるはずのページが横長なら、手前のページも単独になる。
    expect(pagesOf([portrait, portrait, landscape, portrait])).toEqual([[0], [1], [2], [3]])
  })

  it('全ページ横長なら全部単独にする', () => {
    const pages = [landscape, landscape, landscape]
    expect(pagesOf(pages, { coverSingle: false })).toEqual([[0], [1], [2]])
  })

  it('1 ページずらすと、表紙の後の最初のページを単独にして組の偶奇を入れ替える', () => {
    expect(pagesOf(portraits(6), { shift: true })).toEqual([[0], [1], [2, 3], [4, 5]])
    expect(pagesOf(portraits(5), { coverSingle: false, shift: true })).toEqual([
      [0],
      [1, 2],
      [3, 4],
    ])
  })

  it('ずらしは組めない位置では消費せず、最初に組める位置で効かせる', () => {
    // 表紙の直後が横長の手前で組めない。
    const pages = [portrait, portrait, landscape, portrait, portrait, portrait, portrait]
    expect(pagesOf(pages, { shift: false })).toEqual([[0], [1], [2], [3, 4], [5, 6]])
    expect(pagesOf(pages, { shift: true })).toEqual([[0], [1], [2], [3], [4, 5], [6]])
    // 表紙の直後が右綴じの左指定ページで組を始められない。
    const withLeft = [portrait, { ...portrait, spread: 'left' as const }, portrait, portrait, portrait]
    expect(pagesOf(withLeft, { shift: false })).toEqual([[0], [1], [2, 3], [4]])
    expect(pagesOf(withLeft, { shift: true })).toEqual([[0], [1], [2], [3, 4]])
  })

  it('右綴じは読む順の先のページを右、左綴じは左に置く', () => {
    const right = buildSpreads(portraits(3), { ...base, binding: 'right' })
    const left = buildSpreads(portraits(3), { ...base, binding: 'left' })
    expect(right[1].layout).toEqual([2, 1])
    expect(left[1].layout).toEqual([1, 2])
  })

  describe('EPUB の左右指定', () => {
    it('指定どおりに組めるページは組む', () => {
      // 右綴じ: 読む順の先が右。
      const pages: SpreadPage[] = [
        { ...portrait, spread: 'right' },
        { ...portrait, spread: 'left' },
        { ...portrait, spread: 'right' },
        { ...portrait, spread: 'left' },
      ]
      const spreads = buildSpreads(pages, { ...base, coverSingle: false })
      expect(spreads.map((spread) => spread.pages)).toEqual([
        [0, 1],
        [2, 3],
      ])
      expect(spreads[0].layout).toEqual([1, 0])
    })

    it('既定の組み方と食い違う指定は指定を優先し、単独のページは指定の側に寄せる', () => {
      // 右綴じで表紙単独なら既定では 1-2 を組むが、1 ページ目に「左」が付いていると
      // 読む順の先(右)に置けないので単独で左に置き、2-3 を組む。
      const pages: SpreadPage[] = [
        { ...portrait },
        { ...portrait, spread: 'left' },
        { ...portrait, spread: 'right' },
        { ...portrait, spread: 'left' },
      ]
      const spreads = buildSpreads(pages, base)
      expect(spreads.map((spread) => spread.pages)).toEqual([[0], [1], [2, 3]])
      expect(spreads[1].layout).toEqual([1, null])
      expect(spreads[2].layout).toEqual([3, 2])
    })

    it('次のページが読む順の先の側を指定していれば、手前のページを単独にする', () => {
      const pages: SpreadPage[] = [
        { ...portrait },
        { ...portrait, spread: 'right' },
        { ...portrait, spread: 'right' },
        { ...portrait, spread: 'left' },
      ]
      const spreads = buildSpreads(pages, { ...base, coverSingle: false })
      expect(spreads.map((spread) => spread.pages)).toEqual([[0], [1], [2, 3]])
      expect(spreads[1].layout).toEqual([null, 1])
    })

    it('左綴じでは左が読む順の先になる', () => {
      const pages: SpreadPage[] = [
        { ...portrait, spread: 'right' },
        { ...portrait, spread: 'left' },
        { ...portrait, spread: 'right' },
      ]
      const spreads = buildSpreads(pages, { ...base, binding: 'left', coverSingle: false })
      expect(spreads.map((spread) => spread.pages)).toEqual([[0], [1, 2]])
      expect(spreads[1].layout).toEqual([1, 2])
    })
  })

  describe('表示モード', () => {
    it('単ページでは全ページを単独にし、左右指定も見ない', () => {
      const pages: SpreadPage[] = [...portraits(3), { ...portrait, spread: 'left' }]
      const spreads = buildSpreads(pages, { ...base, mode: 'single', coverSingle: false })
      expect(spreads.map((spread) => spread.pages)).toEqual([[0], [1], [2], [3]])
      expect(spreads[3].layout).toEqual([3])
    })

    it('自動はウィンドウが横長なら見開き、縦長・正方形なら単ページ', () => {
      expect(pagesOf(portraits(3), { mode: 'auto', viewportAspect: 1.5 })).toEqual([[0], [1, 2]])
      expect(pagesOf(portraits(3), { mode: 'auto', viewportAspect: 0.7 })).toEqual([[0], [1], [2]])
      expect(pagesOf(portraits(3), { mode: 'auto', viewportAspect: 1 })).toEqual([[0], [1], [2]])
      expect(pagesOf(portraits(3), { mode: 'auto', viewportAspect: Number.NaN })).toEqual([
        [0],
        [1],
        [2],
      ])
    })
  })

  it('ページが無ければ空の列を返す', () => {
    expect(buildSpreads([], base)).toEqual([])
  })

  it('どの設定でも全ページがちょうど 1 回、順番どおりに現れる', () => {
    const pages: SpreadPage[] = [
      portrait,
      { ...portrait, spread: 'left' },
      landscape,
      portrait,
      { ...portrait, spread: 'right' },
      portrait,
      landscape,
      portrait,
    ]
    for (const mode of ['single', 'spread', 'auto'] as const) {
      for (const binding of ['right', 'left'] as const) {
        for (const coverSingle of [true, false]) {
          for (const shift of [true, false]) {
            const flat = buildSpreads(pages, { mode, binding, coverSingle, shift, viewportAspect: 1.6 })
              .flatMap((spread) => spread.pages)
            expect(flat).toEqual(pages.map((_, index) => index))
          }
        }
      }
    }
  })
})

describe('ページ番号と見開き番号の変換', () => {
  const spreads = buildSpreads(
    [portrait, portrait, portrait, landscape, portrait, portrait, portrait],
    base,
  )
  // [[0], [1, 2], [3], [4, 5], [6]]

  it('ページ番号から、そのページを含む見開きの番号を返す', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((page) => pageToSpreadIndex(spreads, page))).toEqual([
      0, 1, 1, 2, 3, 3, 4,
    ])
  })

  it('見開きの番号から、その見開きで読む順の最初のページを返す', () => {
    expect([0, 1, 2, 3, 4].map((index) => spreadIndexToPage(spreads, index))).toEqual([
      0, 1, 3, 4, 6,
    ])
  })

  it('逆変換して戻すと同じ見開きになる', () => {
    for (let index = 0; index < spreads.length; index += 1) {
      expect(pageToSpreadIndex(spreads, spreadIndexToPage(spreads, index))).toBe(index)
    }
  })

  it('範囲外・整数でない番号は -1 を返す', () => {
    expect(pageToSpreadIndex(spreads, -1)).toBe(-1)
    expect(pageToSpreadIndex(spreads, 7)).toBe(-1)
    expect(pageToSpreadIndex(spreads, 1.5)).toBe(-1)
    expect(pageToSpreadIndex([], 0)).toBe(-1)
    expect(spreadIndexToPage(spreads, -1)).toBe(-1)
    expect(spreadIndexToPage(spreads, 5)).toBe(-1)
    expect(spreadIndexToPage(spreads, 0.5)).toBe(-1)
  })
})
