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
  setTheme: (theme: ThemeMode) => void
  setFontScale: (fontScale: number) => void
  setLineHeight: (lineHeight: number) => void
  setPreferredEngine: (preferredEngine: EngineId) => void
  setEnhancementEnabled: (enhancementEnabled: boolean) => void
  setZoomEnhancementScale: (zoomEnhancementScale: number) => void
  setAutoEnhanceZoomedImage: (autoEnhanceZoomedImage: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      fontScale: 100,
      lineHeight: 1.6,
      preferredEngine: 'waifu2x',
      enhancementEnabled: true,
      zoomEnhancementScale: 2,
      autoEnhanceZoomedImage: false,
      setTheme: (theme) => set({ theme }),
      setFontScale: (fontScale) => set({ fontScale }),
      setLineHeight: (lineHeight) => set({ lineHeight }),
      setPreferredEngine: (preferredEngine) => set({ preferredEngine }),
      setEnhancementEnabled: (enhancementEnabled) => set({ enhancementEnabled }),
      setZoomEnhancementScale: (zoomEnhancementScale) => set({ zoomEnhancementScale }),
      setAutoEnhanceZoomedImage: (autoEnhanceZoomedImage) =>
        set({ autoEnhanceZoomedImage }),
    }),
    {
      name: 'prismpage-settings',
    },
  ),
)
