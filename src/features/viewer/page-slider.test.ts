import { describe, expect, it } from 'vitest'

import { buildSpreads, pageToSpreadIndex } from './spread'
import { sliderEnds, sliderIndexAt, sliderKeyIndex, sliderRatio } from './page-slider'

describe('スライダーの位置', () => {
  it('左綴じは左端が先頭、右端が最後', () => {
    expect(sliderRatio(0, 5, 'left')).toBe(0)
    expect(sliderRatio(2, 5, 'left')).toBe(0.5)
    expect(sliderRatio(4, 5, 'left')).toBe(1)
    expect(sliderIndexAt(0, 5, 'left')).toBe(0)
    expect(sliderIndexAt(0.5, 5, 'left')).toBe(2)
    expect(sliderIndexAt(1, 5, 'left')).toBe(4)
  })

  it('右綴じは右端が先頭、左端が最後', () => {
    expect(sliderRatio(0, 5, 'right')).toBe(1)
    expect(sliderRatio(4, 5, 'right')).toBe(0)
    expect(sliderIndexAt(1, 5, 'right')).toBe(0)
    expect(sliderIndexAt(0.2, 5, 'right')).toBe(3)
    expect(sliderIndexAt(0, 5, 'right')).toBe(4)
  })

  it('位置と見開きの番号は行き来しても変わらない', () => {
    for (const binding of ['left', 'right'] as const) {
      for (let index = 0; index < 7; index += 1) {
        expect(sliderIndexAt(sliderRatio(index, 7, binding), 7, binding)).toBe(index)
      }
    }
  })

  it('範囲外は端に収め、見開きが 1 つなら先頭の端、無ければ -1', () => {
    expect(sliderIndexAt(-0.5, 5, 'left')).toBe(0)
    expect(sliderIndexAt(3, 5, 'left')).toBe(4)
    expect(sliderIndexAt(Number.NaN, 5, 'left')).toBe(0)
    expect(sliderIndexAt(-0.5, 5, 'right')).toBe(4)
    expect(sliderRatio(0, 1, 'left')).toBe(0)
    expect(sliderRatio(0, 1, 'right')).toBe(1)
    expect(sliderIndexAt(0.7, 1, 'right')).toBe(0)
    expect(sliderIndexAt(0.5, 0, 'left')).toBe(-1)
  })

  it('見開きの列では見開き単位で動き、見開きの先のページへ移れる', () => {
    const pages = Array.from({ length: 7 }, (_, index) => ({ name: `${index}.png`, width: 1000, height: 1500 }))
    // 表紙単独の見開き: [0] [1,2] [3,4] [5,6]
    const spreads = buildSpreads(pages, {
      mode: 'spread',
      coverSingle: true,
      shift: false,
      binding: 'right',
      viewportAspect: 1.6,
    })
    expect(spreads).toHaveLength(4)
    const index = pageToSpreadIndex(spreads, 4)
    expect(index).toBe(2)
    expect(sliderRatio(index, spreads.length, 'right')).toBeCloseTo(1 / 3)
    expect(spreads[sliderIndexAt(1 / 3, spreads.length, 'right')].pages[0]).toBe(3)
  })
})

describe('スライダーのキー', () => {
  it('← / → は綴じ方向に合わせ、端で止まる', () => {
    expect(sliderKeyIndex('ArrowLeft', 1, 5, 'right')).toBe(2)
    expect(sliderKeyIndex('ArrowRight', 1, 5, 'right')).toBe(0)
    expect(sliderKeyIndex('ArrowRight', 1, 5, 'left')).toBe(2)
    expect(sliderKeyIndex('ArrowLeft', 1, 5, 'left')).toBe(0)
    expect(sliderKeyIndex('ArrowLeft', 4, 5, 'right')).toBe(4)
    expect(sliderKeyIndex('ArrowLeft', 0, 5, 'left')).toBe(0)
  })

  it('Home は先頭、End は最後、ほかのキーは扱わない', () => {
    expect(sliderKeyIndex('Home', 3, 5, 'right')).toBe(0)
    expect(sliderKeyIndex('End', 0, 5, 'left')).toBe(4)
    expect(sliderKeyIndex('ArrowUp', 2, 5, 'left')).toBeNull()
    expect(sliderKeyIndex('Home', 0, 0, 'left')).toBeNull()
  })
})

describe('スライダーの端の文字', () => {
  it('先頭の側に現在のページ、終わりの側に総ページ', () => {
    expect(sliderEnds('left', '3', '10')).toEqual({ left: '3', right: '10' })
    expect(sliderEnds('right', '3', '10')).toEqual({ left: '10', right: '3' })
  })
})
