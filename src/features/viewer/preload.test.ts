import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PRELOAD_RADIUS } from './viewer-state'

// 作った画像要素を数える。使い回しの在庫はモジュールの状態なので、テストごとに読み込み直す。
let created: HTMLImageElement[] = []

beforeEach(() => {
  created = []
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
  // jsdom は画像のデコードを持たない。
  HTMLImageElement.prototype.decode = () => Promise.resolve()
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ページ画像の先読み', () => {
  it('500 ページ送っても、作る画像要素は先読みの幅の分で止まり、手放した要素は読み込みを止めている', async () => {
    const { PagePreloader } = await import('./preload')
    const preloader = new PagePreloader()
    const span = 2 * PRELOAD_RADIUS + 1
    const urls = (page: number) =>
      Array.from({ length: span }, (_, offset) => page + offset - PRELOAD_RADIUS)
        .filter((index) => index >= 0 && index < 500)
        .map((index) => `page-${index}`)

    for (let page = 0; page < 500; page += 1) preloader.retain(urls(page))

    // 1 ページずつずらすと、入れ替わる間だけ 1 枚多く要る。
    expect(created.length).toBeLessThanOrEqual(span + 1)
    const held = created.filter((image) => image.hasAttribute('src')).map((image) => image.getAttribute('src'))
    expect(held.sort()).toEqual(urls(499).sort())

    preloader.clear()
    expect(created.filter((image) => image.hasAttribute('src'))).toEqual([])
  })

  it('手放した要素を次の読み込みに使い回す', async () => {
    const { acquireImage, releaseImage } = await import('./preload')
    const first = acquireImage('a')
    releaseImage(first)
    expect(first.hasAttribute('src')).toBe(false)
    const second = acquireImage('b')
    expect(second).toBe(first)
    expect(second.getAttribute('src')).toBe('b')
    expect(created).toHaveLength(1)
  })
})
