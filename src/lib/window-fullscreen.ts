import { getCurrentWindow } from '@tauri-apps/api/window'

import { isTauriRuntime } from '@/lib/tauri'

// アプリのウィンドウの全画面。Tauri 上ではウィンドウそのものを全画面にする(利用者の操作が無くても呼べる)。
// ブラウザ(モック)では DOM の全画面に落とす。DOM の全画面は利用者の操作の直後でないと断られ、
// 断られたときは失敗として返す。

// ウィンドウが全画面か。
export async function isWindowFullscreen(): Promise<boolean> {
  if (isTauriRuntime) return getCurrentWindow().isFullscreen()
  return typeof document !== 'undefined' && document.fullscreenElement != null
}

// ウィンドウを全画面にする(true)か、ウィンドウに戻す(false)。
export async function setWindowFullscreen(fullscreen: boolean): Promise<void> {
  if (isTauriRuntime) {
    await getCurrentWindow().setFullscreen(fullscreen)
    return
  }
  if (typeof document === 'undefined') return
  if (fullscreen) {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.()
  } else if (document.fullscreenElement) {
    await document.exitFullscreen?.()
  }
}
