import { useEffect } from 'react'

import { useSettingsStore } from '@/features/settings/settings-store'

export function ThemeEffect() {
  const theme = useSettingsStore((state) => state.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return null
}
