import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { EngineId, ThemeMode } from '@/types/app'

interface SettingsState {
  theme: ThemeMode
  fontScale: number
  lineHeight: number
  preferredEngine: EngineId
  enhancementEnabled: boolean
  zoomEnhancementScale: number
  autoEnhanceZoomedImage: boolean
  autoEnhanceVisibleImages: boolean
  setTheme: (theme: ThemeMode) => void
  setFontScale: (fontScale: number) => void
  setLineHeight: (lineHeight: number) => void
  setPreferredEngine: (preferredEngine: EngineId) => void
  setEnhancementEnabled: (enhancementEnabled: boolean) => void
  setZoomEnhancementScale: (zoomEnhancementScale: number) => void
  setAutoEnhanceZoomedImage: (autoEnhanceZoomedImage: boolean) => void
  setAutoEnhanceVisibleImages: (autoEnhanceVisibleImages: boolean) => void
}

type PersistedSettings = Partial<
  Omit<
    SettingsState,
    | 'setTheme'
    | 'setFontScale'
    | 'setLineHeight'
    | 'setPreferredEngine'
    | 'setEnhancementEnabled'
    | 'setZoomEnhancementScale'
    | 'setAutoEnhanceZoomedImage'
    | 'setAutoEnhanceVisibleImages'
  >
>

const defaultSettings = {
  autoEnhanceVisibleImages: true,
  autoEnhanceZoomedImage: true,
  enhancementEnabled: true,
  fontScale: 100,
  lineHeight: 1.6,
  preferredEngine: 'waifu2x' as EngineId,
  theme: 'dark' as ThemeMode,
  zoomEnhancementScale: 2,
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaultSettings,
      setTheme: (theme) => set({ theme }),
      setFontScale: (fontScale) => set({ fontScale }),
      setLineHeight: (lineHeight) => set({ lineHeight }),
      setPreferredEngine: (preferredEngine) => set({ preferredEngine }),
      setEnhancementEnabled: (enhancementEnabled) => set({ enhancementEnabled }),
      setZoomEnhancementScale: (zoomEnhancementScale) => set({ zoomEnhancementScale }),
      setAutoEnhanceZoomedImage: (autoEnhanceZoomedImage) =>
        set({ autoEnhanceZoomedImage }),
      setAutoEnhanceVisibleImages: (autoEnhanceVisibleImages) =>
        set({ autoEnhanceVisibleImages }),
    }),
    {
      merge: (persistedState, currentState) => {
        const persisted =
          typeof persistedState === 'object' && persistedState !== null
            ? (persistedState as PersistedSettings)
            : {}

        return {
          ...currentState,
          ...persisted,
          autoEnhanceVisibleImages:
            persisted.autoEnhanceVisibleImages ?? defaultSettings.autoEnhanceVisibleImages,
          autoEnhanceZoomedImage:
            persisted.autoEnhanceZoomedImage ?? defaultSettings.autoEnhanceZoomedImage,
        }
      },
      name: 'prismpage-settings',
    },
  ),
)
