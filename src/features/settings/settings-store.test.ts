import { beforeEach, describe, expect, it } from 'vitest'

import { SETTINGS_VERSION, defaultSettings, useSettingsStore } from './settings-store'

const STORAGE_KEY = 'prismpage-settings'

function pickPersisted() {
  const state = useSettingsStore.getState()
  return {
    defaultBinding: state.defaultBinding,
    defaultCoverSingle: state.defaultCoverSingle,
    defaultSpreadMode: state.defaultSpreadMode,
    enhanceModels: state.enhanceModels,
    enhanceNewBooks: state.enhanceNewBooks,
    enhancePrefetchPages: state.enhancePrefetchPages,
    enhanceScale: state.enhanceScale,
    preferredEngine: state.preferredEngine,
    theme: state.theme,
    viewerFullscreen: state.viewerFullscreen,
    wheelReversed: state.wheelReversed,
  }
}

// 旧 AI 画面の項目(version 4 まで保存していた)。
const retiredKeys = [
  'autoEnhanceVisibleImages',
  'autoEnhanceZoomedImage',
  'enhancementEnabled',
  'precomputeBookImages',
  'zoomEnhancementScale',
]

describe('設定ストアの永続化', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.setState({ ...defaultSettings })
  })

  it('version 1 の旧形式は移行せず既定値に置き換え、旧項目を残さない', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          theme: 'sepia',
          fontScale: 1.4,
          lineHeight: 2,
          preferredEngine: 'realesrgan',
          enhancementEnabled: false,
          zoomEnhancementScale: 4,
        },
      }),
    )

    await useSettingsStore.persist.rehydrate()

    const state = useSettingsStore.getState() as unknown as Record<string, unknown>
    expect(pickPersisted()).toEqual(defaultSettings)
    expect(state).not.toHaveProperty('fontScale')
    expect(state).not.toHaveProperty('lineHeight')

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(saved.version).toBe(SETTINGS_VERSION)
    expect(saved.state).toEqual(defaultSettings)
  })

  it('現在の版で保存された設定はそのまま読み戻す', async () => {
    const current = {
      ...defaultSettings,
      theme: 'ink',
      enhanceModels: { 'real-cugan': 'models-pro' },
      enhanceScale: 3,
      enhancePrefetchPages: 8,
      enhanceNewBooks: true,
      viewerFullscreen: false,
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, state: current }),
    )

    await useSettingsStore.persist.rehydrate()

    expect(pickPersisted()).toEqual(current)
  })

  it('version 2 の設定は今もある項目を引き継ぎ、後の版の項目を既定値で補う', async () => {
    const version2 = {
      autoEnhanceVisibleImages: false,
      autoEnhanceZoomedImage: true,
      enhancementEnabled: false,
      precomputeBookImages: true,
      preferredEngine: 'realesrgan',
      theme: 'ink',
      zoomEnhancementScale: 4,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, state: version2 }))

    await useSettingsStore.persist.rehydrate()

    expect(pickPersisted()).toEqual({
      ...defaultSettings,
      preferredEngine: 'realesrgan',
      theme: 'ink',
    })
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(saved.version).toBe(SETTINGS_VERSION)
  })

  it('version 3 の設定はホイールの向きを含めて引き継ぎ、後の版の項目を既定値で補う', async () => {
    const version3 = {
      autoEnhanceVisibleImages: true,
      autoEnhanceZoomedImage: false,
      enhancementEnabled: true,
      precomputeBookImages: false,
      preferredEngine: 'real-cugan',
      theme: 'paper',
      wheelReversed: true,
      zoomEnhancementScale: 3,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 3, state: version3 }))

    await useSettingsStore.persist.rehydrate()

    expect(pickPersisted()).toEqual({
      ...defaultSettings,
      preferredEngine: 'real-cugan',
      theme: 'paper',
      wheelReversed: true,
    })
  })

  it('version 4 の設定は今もある項目を引き継ぎ、旧 AI 画面の項目を捨てて AI の既定値を補う', async () => {
    const version4 = {
      autoEnhanceVisibleImages: true,
      autoEnhanceZoomedImage: false,
      defaultBinding: 'left',
      defaultCoverSingle: false,
      defaultSpreadMode: 'single',
      enhancementEnabled: true,
      precomputeBookImages: false,
      preferredEngine: 'real-esrgan',
      theme: 'ink',
      wheelReversed: true,
      zoomEnhancementScale: 4,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 4, state: version4 }))

    await useSettingsStore.persist.rehydrate()

    expect(pickPersisted()).toEqual({
      ...defaultSettings,
      defaultBinding: 'left',
      defaultCoverSingle: false,
      defaultSpreadMode: 'single',
      preferredEngine: 'real-esrgan',
      theme: 'ink',
      wheelReversed: true,
    })
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(saved.version).toBe(SETTINGS_VERSION)
    for (const key of retiredKeys) expect(saved.state).not.toHaveProperty(key)
  })

  it('version 5 の設定はすべての項目を引き継ぎ、初めて開く本の AI をオフ、ビューアの全画面をオンで補う', async () => {
    const version5 = {
      defaultBinding: 'left',
      defaultCoverSingle: false,
      defaultSpreadMode: 'spread',
      enhanceModels: { 'real-esrgan': 'realesr-animevideov3' },
      enhancePrefetchPages: 8,
      enhanceScale: 3,
      preferredEngine: 'real-esrgan',
      theme: 'ink',
      wheelReversed: true,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 5, state: version5 }))

    await useSettingsStore.persist.rehydrate()

    const migrated = { ...version5, enhanceNewBooks: false, viewerFullscreen: true }
    expect(pickPersisted()).toEqual(migrated)
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(saved.version).toBe(7)
    expect(saved.state).toEqual(migrated)
  })

  it('version 6 の設定はすべての項目を引き継ぎ、ビューアの全画面をオンで補う', async () => {
    const version6 = {
      defaultBinding: 'left',
      defaultCoverSingle: false,
      defaultSpreadMode: 'single',
      enhanceModels: { 'real-cugan': 'models-pro' },
      enhanceNewBooks: true,
      enhancePrefetchPages: 2,
      enhanceScale: 4,
      preferredEngine: 'real-cugan',
      theme: 'paper',
      wheelReversed: true,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 6, state: version6 }))

    await useSettingsStore.persist.rehydrate()

    const migrated = { ...version6, viewerFullscreen: true }
    expect(pickPersisted()).toEqual(migrated)
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(saved.version).toBe(7)
    expect(saved.state).toEqual(migrated)
  })

  it('未知の新しい版は引き継がず既定値に戻す', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SETTINGS_VERSION + 1, state: { ...defaultSettings, theme: 'ink', viewerFullscreen: false } }),
    )

    await useSettingsStore.persist.rehydrate()

    expect(pickPersisted()).toEqual(defaultSettings)
  })
})
