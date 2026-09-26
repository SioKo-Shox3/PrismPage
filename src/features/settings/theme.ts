import type { ResolvedTheme, ThemeMode } from '@/types/app'

// 設定画面に並べるテーマの選択肢。
export const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'paper', label: '紙' },
  { value: 'ink', label: '墨' },
  { value: 'system', label: 'システムに合わせる' },
]

// 「システムに合わせる」は OS の明暗設定に追従し、暗色なら「墨」、明色なら「紙」にする。
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') {
    return systemPrefersDark ? 'ink' : 'paper'
  }
  return mode
}
