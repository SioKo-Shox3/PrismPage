import { describe, expect, it } from 'vitest'

import {
  MAX_ZOOM,
  ZOOM_DOUBLE_CLICK_SCALE,
  clampPan,
  offsetFromScroll,
  panBy,
  scrollFromZoom,
  toggleZoomAt,
  wheelZoomFactor,
  zoomBy,
  zoomTo,
  type Zoom,
} from './zoom'

const content = { width: 800, height: 600 }
const viewport = { width: 1000, height: 800 }
const center = { x: 0, y: 0 }

// 見開きの点(見開きの中心からの位置、拡大率 1 の CSS px)が画面のどこ(表示領域の中心から)に出るか。
function screenPoint(zoom: Zoom, point: { x: number; y: number }) {
  return { x: zoom.x + point.x * zoom.scale, y: zoom.y + point.y * zoom.scale }
}

describe('zoomTo / zoomBy', () => {
  it('指した点の下にある見開きの点は拡大の前後で動かない', () => {
    const anchor = { x: 200, y: -150 }
    const first = zoomTo(null, 2, anchor, content, viewport)!
    // 拡大前の anchor は見開きの点 (200, -150) を指している。
    expect(screenPoint(first, { x: 200, y: -150 })).toEqual(anchor)

    const anchor2 = { x: -100, y: 50 }
    const point = { x: (anchor2.x - first.x) / first.scale, y: (anchor2.y - first.y) / first.scale }
    const second = zoomBy(first, 1.5, anchor2, content, viewport)!
    expect(second.scale).toBeCloseTo(3)
    const moved = screenPoint(second, point)
    expect(moved.x).toBeCloseTo(anchor2.x)
    expect(moved.y).toBeCloseTo(anchor2.y)
  })

  it('拡大率は 1〜MAX_ZOOM に収め、1 に戻ったら拡大を解く', () => {
    expect(zoomTo(null, 100, center, content, viewport)?.scale).toBe(MAX_ZOOM)
    expect(zoomTo(null, 0.2, center, content, viewport)).toBeNull()
    expect(zoomTo(null, Number.NaN, center, content, viewport)).toBeNull()

    const zoomed = zoomBy(null, 1.25, center, content, viewport)
    expect(zoomed?.scale).toBeCloseTo(1.25)
    // 同じ倍率で縮めると浮動小数の誤差があっても解ける。
    expect(zoomBy(zoomed, 1 / 1.25, center, content, viewport)).toBeNull()
  })

  it('縮めた結果の位置は、はみ出した分の範囲に収まる', () => {
    const edge = zoomTo(null, 4, { x: 400, y: 300 }, content, viewport)!
    const smaller = zoomTo(edge, 1.2, { x: -500, y: -400 }, content, viewport)!
    // 1.2 倍の見開き (960×720) は表示領域 (1000×800) に収まるので中央に固定される。
    expect(smaller).toEqual({ scale: 1.2, x: 0, y: 0 })
  })

  it('拡大していない状態から始めるときは渡されたずれを起点にする', () => {
    const tall = { width: 1000, height: 3000 }
    const base = { x: 0, y: offsetFromScroll(1000, tall.height, viewport.height) }
    const zoomed = zoomTo(null, 2, center, tall, viewport, base)!
    // 表示領域の中心にあった見開きの点(上から 1400px)は中心に残る。
    expect(zoomed.y).toBeCloseTo(2 * (1500 - 1400))
  })
})

describe('clampPan / panBy', () => {
  it('はみ出した分の半分まで動かせ、はみ出さない向きは中央に固定する', () => {
    // 2 倍で 1600×1200。横は ±300、縦は ±200 まで。
    const zoom = { scale: 2, x: 0, y: 0 }
    expect(panBy(zoom, 1000, -1000, content, viewport)).toEqual({ scale: 2, x: 300, y: -200 })
    expect(panBy(zoom, -50, 30, content, viewport)).toEqual({ scale: 2, x: -50, y: 30 })

    // 1.1 倍の 880×660 はどちらにもはみ出さない。
    expect(clampPan({ scale: 1.1, x: 40, y: -40 }, content, viewport)).toEqual({ scale: 1.1, x: 0, y: 0 })
  })
})

describe('toggleZoomAt', () => {
  it('拡大していなければ指した点で拡大し、拡大中なら元に戻す', () => {
    const zoomed = toggleZoomAt(null, { x: 100, y: 100 }, content, viewport)
    expect(zoomed).toEqual({ scale: ZOOM_DOUBLE_CLICK_SCALE, x: -100, y: -100 })
    expect(toggleZoomAt(zoomed, { x: 100, y: 100 }, content, viewport)).toBeNull()
  })
})

describe('wheelZoomFactor', () => {
  it('上へ回すと拡大、下へ回すと縮小し、逆向きの同じ量で打ち消し合う', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1)
    expect(wheelZoomFactor(0)).toBe(1)
  })
})

describe('offsetFromScroll / scrollFromZoom', () => {
  it('拡大を始めて解くと、同じスクロール位置に戻る', () => {
    const height = 3000
    for (const scrollTop of [0, 700, 2200]) {
      const base = { x: 0, y: offsetFromScroll(scrollTop, height, viewport.height) }
      const zoomed = zoomTo(null, 3, center, { width: 1000, height }, viewport, base)!
      expect(scrollFromZoom(zoomed, height, viewport.height)).toBeCloseTo(scrollTop)
    }
  })

  it('スクロールしない高さでは中央、戻すスクロール位置は範囲に収める', () => {
    expect(offsetFromScroll(0, 600, 800)).toBe(0)
    expect(scrollFromZoom({ scale: 2, x: 0, y: 5000 }, 3000, 800)).toBe(0)
    expect(scrollFromZoom({ scale: 2, x: 0, y: -5000 }, 3000, 800)).toBe(2200)
  })
})
