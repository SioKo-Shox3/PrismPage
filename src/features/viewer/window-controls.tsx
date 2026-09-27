import { useEffect, useState } from 'react'
import { Copy, Minus, X } from 'lucide-react'

import { closeWindow, isWindowFullscreen, minimizeWindow, onWindowResized } from '@/lib/window-fullscreen'

import { leaveViewerFullscreen, subscribeViewerFullscreen } from './fullscreen-session'
import styles from './viewer-page.module.css'

// ウィンドウが全画面か。ビューアの全画面の切り替えが済むたびと、ウィンドウの大きさが変わったときに読み直す。
function useWindowFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    let alive = true
    // 読み直しが重なっても、後から始めたものの結果だけを使う。
    let latest = 0
    const refresh = () => {
      const request = ++latest
      void isWindowFullscreen()
        .then((value) => {
          if (alive && request === latest) setFullscreen(value)
        })
        .catch(() => {})
    }
    refresh()
    const unsubscribe = subscribeViewerFullscreen(refresh)
    const unlisten = onWindowResized(refresh)
    return () => {
      alive = false
      unsubscribe()
      unlisten()
    }
  }, [])
  return fullscreen
}

// 全画面の間だけ情報バーの右端に出すウィンドウ操作(Windows のタイトルバーと同じ並び)。
// 全画面ではタイトルバーが無いので、最小化・ウィンドウに戻す・アプリを閉じるをここから行う。
export function WindowControls() {
  const fullscreen = useWindowFullscreen()
  if (!fullscreen) return null
  return (
    <div className={styles.windowControls} role="group" aria-label="ウィンドウの操作">
      <button
        type="button"
        className={styles.windowButton}
        aria-label="最小化"
        title="最小化"
        onClick={() => void minimizeWindow().catch(() => {})}
      >
        <Minus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles.windowButton}
        aria-label="ウィンドウに戻す"
        title="ウィンドウに戻す"
        onClick={() => leaveViewerFullscreen()}
      >
        <Copy size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${styles.windowButton} ${styles.windowClose}`}
        aria-label="アプリを閉じる"
        title="閉じる"
        onClick={() => void closeWindow().catch(() => {})}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
