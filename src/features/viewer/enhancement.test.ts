import { describe, expect, it } from 'vitest'

import type { EngineId, EngineStatus } from '@/types/app'

import { enhanceStatusText, prefetchPages, resolveEnhanceSettings, type EnhanceDefaults } from './enhancement'

function status(id: EngineId, ready: boolean, modelName?: string): EngineStatus {
  return { id, label: id, configured: ready, ready, modelName, downloadUrl: '', notes: [] }
}

function defaults(engine: EngineId, overrides: Partial<EnhanceDefaults> = {}): EnhanceDefaults {
  return { engine, models: {}, scale: 2, ...overrides }
}

describe('先読みするページ', () => {
  it('表示中の最後のページの次から指定のページ数で、本の終わりを越えない', () => {
    expect(prefetchPages([2, 3], 20, 4)).toEqual([4, 5, 6, 7])
    expect(prefetchPages([3, 2], 20, 4)).toEqual([4, 5, 6, 7])
    expect(prefetchPages([7], 10, 4)).toEqual([8, 9])
    expect(prefetchPages([9], 10, 4)).toEqual([])
    expect(prefetchPages([], 10, 4)).toEqual([])
    expect(prefetchPages([2], 20, 8)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    expect(prefetchPages([2], 20, 0)).toEqual([])
  })
})

describe('使うエンジンと設定', () => {
  it('設定で選んだエンジンが使えなければ使える別のエンジンにし、どれも無ければ null', () => {
    const statuses = [status('waifu2x', false), status('real-cugan', true, 'models-pro')]
    expect(resolveEnhanceSettings(statuses, defaults('waifu2x'))).toEqual({
      engine: 'real-cugan',
      model: 'models-pro',
      scale: 2,
      denoise: -1,
    })
    expect(resolveEnhanceSettings([status('waifu2x', false)], defaults('waifu2x'))).toBeNull()
  })

  it('対応表に無いモデルは既定のモデルにし、2 倍を持たないモデルはその最小の倍率にする', () => {
    expect(resolveEnhanceSettings([status('waifu2x', true, 'models-se')], defaults('waifu2x'))).toEqual({
      engine: 'waifu2x',
      model: 'models-cunet',
      scale: 2,
      denoise: 0,
    })
    expect(
      resolveEnhanceSettings([status('real-esrgan', true, 'realesrgan-x4plus')], defaults('real-esrgan')),
    ).toEqual({ engine: 'real-esrgan', model: 'realesrgan-x4plus', scale: 4, denoise: undefined })
  })

  it('設定で選んだモデルと倍率を使い、モデルが持たない倍率・対応表に無いモデルは選ばない', () => {
    const cugan = [status('real-cugan', true, 'models-se')]
    expect(
      resolveEnhanceSettings(cugan, defaults('real-cugan', { models: { 'real-cugan': 'models-pro' }, scale: 3 })),
    ).toEqual({ engine: 'real-cugan', model: 'models-pro', scale: 3, denoise: -1 })
    // models-pro は 4 倍を持たないので最小の 2 倍にする。
    expect(
      resolveEnhanceSettings(cugan, defaults('real-cugan', { models: { 'real-cugan': 'models-pro' }, scale: 4 }))?.scale,
    ).toBe(2)
    // 対応表に無いモデルの指定は無視して登録したモデルを使う。
    expect(
      resolveEnhanceSettings(cugan, defaults('real-cugan', { models: { 'real-cugan': '../x' }, scale: 4 })),
    ).toEqual({ engine: 'real-cugan', model: 'models-se', scale: 4, denoise: -1 })
    // 別のエンジン向けに選んだモデルは使わない。
    expect(
      resolveEnhanceSettings(cugan, defaults('waifu2x', { models: { waifu2x: 'models-upconv_7_photo' } }))?.model,
    ).toBe('models-se')
  })
})

describe('上端バーの文言', () => {
  const base = {
    scale: 2,
    visibleTotal: 2,
    visibleDone: 2,
    visibleFailed: 0,
    prefetchTotal: 4,
    prefetchDone: 2,
  }

  it('表示中が済めば「適用中」、先読みが残れば「準備中 n/m」、済めば先読みの文言を出さない', () => {
    expect(enhanceStatusText(base)).toEqual({ current: 'AI 2× 適用中', ahead: '先の 4 ページを準備中 2/4' })
    expect(enhanceStatusText({ ...base, visibleDone: 1 }).current).toBe('AI 2× 処理中')
    expect(enhanceStatusText({ ...base, prefetchDone: 4 }).ahead).toBeNull()
    expect(enhanceStatusText({ ...base, visibleFailed: 1 }).current).toBe('AI 2× 処理できないページがあります')
  })
})
