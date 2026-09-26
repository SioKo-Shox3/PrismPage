import { useEffect, useSyncExternalStore } from 'react'

import { useSettingsStore } from '@/features/settings/settings-store'
import { resolveTheme } from '@/features/settings/theme'

const darkQuery = '(prefers-color-scheme: dark)'

function subscribeSystemTheme(onChange: () => void) {
  const media = window.matchMedia(darkQuery)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function getSystemPrefersDark() {
  return window.matchMedia(darkQuery).matches
}

// 設定のテーマを <html data-theme> に反映する。OS の明暗が変わったときも追従する。描画は持たない。
export function ThemeEffect() {
  const theme = useSettingsStore((state) => state.theme)
  const systemPrefersDark = useSyncExternalStore(subscribeSystemTheme, getSystemPrefersDark)
  const resolved = resolveTheme(theme, systemPrefersDark)

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  return null
}
