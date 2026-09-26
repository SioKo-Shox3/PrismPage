import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { Binding, EngineId, SpreadMode, ThemeMode } from '@/types/app'

// 永続化する設定の形式の版。形を変えたら上げ、migrate で旧版の扱いを決める。
export const SETTINGS_VERSION = 5

export interface PersistedSettings {
  theme: ThemeMode
  // AI 超解像の既定のエンジン。使えなければビューアは登録済みの別のエンジンを使う。
  preferredEngine: EngineId
  // エンジンごとの既定のモデル(選んでいないエンジンは登録したモデルか、エンジンの既定のモデル)。
  enhanceModels: Partial<Record<EngineId, string>>
  // 既定の倍率。モデルが持たない倍率ならビューアはそのモデルの最小の倍率にする。
  enhanceScale: number
  // 表示中のページの次に先回りで処理するページ数。
  enhancePrefetchPages: number
  // ビューアのホイールの向きを反転する(既定は下へ回すと次のページ)。
  wheelReversed: boolean
  // 表示設定を保存していない本の、見開き・綴じ方向・表紙単独の既定値。
  // 綴じ方向は、本(EPUB)が指定していればそちらを優先する。
  defaultSpreadMode: SpreadMode
  defaultBinding: Binding
  defaultCoverSingle: boolean
}

interface SettingsState extends PersistedSettings {
  setTheme: (theme: ThemeMode) => void
  setPreferredEngine: (preferredEngine: EngineId) => void
  setEnhanceModel: (engine: EngineId, model: string) => void
  setEnhanceScale: (enhanceScale: number) => void
  setEnhancePrefetchPages: (enhancePrefetchPages: number) => void
  setWheelReversed: (wheelReversed: boolean) => void
  setDefaultSpreadMode: (defaultSpreadMode: SpreadMode) => void
  setDefaultBinding: (defaultBinding: Binding) => void
  setDefaultCoverSingle: (defaultCoverSingle: boolean) => void
}

export const defaultSettings: PersistedSettings = {
  defaultBinding: 'right',
  defaultCoverSingle: true,
  defaultSpreadMode: 'auto',
  enhanceModels: {},
  enhancePrefetchPages: 4,
  enhanceScale: 2,
  preferredEngine: 'waifu2x',
  theme: 'system',
  wheelReversed: false,
}

// 保存済みの設定が現在の版と違うときに呼ばれる。
// version 2〜4 は今もある項目を引き継ぎ、後の版で足した項目(3 のホイールの向き、4 の見開き・綴じ方向・
// 表紙単独の既定値、5 の AI のモデル・倍率・先読み数)を既定値で補う。旧 AI 画面の項目
// (enhancementEnabled・zoomEnhancementScale・precomputeBookImages・autoEnhance*)は使わないので捨てる。
// version 1 以前(テーマ dark/light/sepia、本文スケールなど旧リーダー用の項目を含む形式)は
// 移行せず既定値に置き換える。未知の新しい版も同じく既定値に戻す。
export function migrateSettings(persisted: unknown, version: number): PersistedSettings {
  if (version >= 2 && version <= 4 && typeof persisted === 'object' && persisted !== null) {
    const source = persisted as Record<string, unknown>
    const kept = Object.fromEntries(
      Object.keys(defaultSettings)
        .filter((key) => key in source)
        .map((key) => [key, source[key]]),
    ) as Partial<PersistedSettings>
    return { ...defaultSettings, ...kept }
  }
  return { ...defaultSettings }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultSettings,
      setTheme: (theme) => set({ theme }),
      setPreferredEngine: (preferredEngine) => set({ preferredEngine }),
      setEnhanceModel: (engine, model) =>
        set((state) => ({ enhanceModels: { ...state.enhanceModels, [engine]: model } })),
      setEnhanceScale: (enhanceScale) => set({ enhanceScale }),
      setEnhancePrefetchPages: (enhancePrefetchPages) => set({ enhancePrefetchPages }),
      setWheelReversed: (wheelReversed) => set({ wheelReversed }),
      setDefaultSpreadMode: (defaultSpreadMode) => set({ defaultSpreadMode }),
      setDefaultBinding: (defaultBinding) => set({ defaultBinding }),
      setDefaultCoverSingle: (defaultCoverSingle) => set({ defaultCoverSingle }),
    }),
    {
      name: 'prismpage-settings',
      version: SETTINGS_VERSION,
      migrate: migrateSettings,
      partialize: (state): PersistedSettings => ({
        defaultBinding: state.defaultBinding,
        defaultCoverSingle: state.defaultCoverSingle,
        defaultSpreadMode: state.defaultSpreadMode,
        enhanceModels: state.enhanceModels,
        enhancePrefetchPages: state.enhancePrefetchPages,
        enhanceScale: state.enhanceScale,
        preferredEngine: state.preferredEngine,
        theme: state.theme,
        wheelReversed: state.wheelReversed,
      }),
    },
  ),
)
