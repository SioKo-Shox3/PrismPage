import { getCurrentWindow } from '@tauri-apps/api/window'

import { isTauriRuntime } from '@/lib/tauri'

// アプリのウィンドウの全画面。Tauri 上ではウィンドウそのものを全画面にする(利用者の操作が無くても呼べる)。
// ブラウザ(モック)では DOM の全画面に落とす。DOM の全画面は利用者の操作の直後でないと断られ、
// 断られたときは失敗として返す。

// 画面の撮影(`scripts/shots`)用。ブラウザ(モック)で localStorage のこの値が '1' なら、全画面として扱う。
const MOCK_FULLSCREEN_KEY = 'prismpage-mock-fullscreen'

function mockFullscreenForced(): boolean {
  try {
    return localStorage.getItem(MOCK_FULLSCREEN_KEY) === '1'
  } catch {
    // localStorage を使えない環境では扱わない。
    return false
  }
}

// ウィンドウが全画面か。
export async function isWindowFullscreen(): Promise<boolean> {
  if (isTauriRuntime) return getCurrentWindow().isFullscreen()
  if (typeof document === 'undefined') return false
  return document.fullscreenElement != null || mockFullscreenForced()
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

// ウィンドウを最小化する。ブラウザ(モック)では何もしない。
export async function minimizeWindow(): Promise<void> {
  if (isTauriRuntime) await getCurrentWindow().minimize()
}

// ウィンドウを閉じてアプリを終える(Windows のタイトルバーの × と同じ)。ブラウザ(モック)では何もしない。
export async function closeWindow(): Promise<void> {
  if (isTauriRuntime) await getCurrentWindow().close()
}

// ウィンドウの大きさが変わったら知らせる(全画面の出入りを含む)。返した関数で知らせるのをやめる。
// ブラウザ(モック)では画面の大きさの変化と DOM の全画面の出入りを知らせる。
export function onWindowResized(listener: () => void): () => void {
  if (isTauriRuntime) {
    let stopped = false
    let unlisten: (() => void) | null = null
    void getCurrentWindow()
      .onResized(() => listener())
      .then((stop) => {
        if (stopped) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      stopped = true
      unlisten?.()
    }
  }
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('resize', listener)
  document.addEventListener('fullscreenchange', listener)
  return () => {
    window.removeEventListener('resize', listener)
    document.removeEventListener('fullscreenchange', listener)
  }
}
