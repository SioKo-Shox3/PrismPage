import type { ReactNode } from 'react'
import { X } from 'lucide-react'

import { IconButton } from './IconButton'
import styles from './Toast.module.css'

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface ToastProps {
  title: string
  message?: ReactNode
  tone?: ToastTone
  actions?: ReactNode
  onDismiss?: () => void
}

// 画面の隅に出す短い通知。失敗の通知は role="alert" で読み上げを割り込ませる。
export function Toast({ title, message, tone = 'neutral', actions, onDismiss }: ToastProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={[styles.toast, styles[tone]].join(' ')}
    >
      <div className={styles.copy}>
        <strong className={styles.title}>{title}</strong>
        {message ? <div className={styles.message}>{message}</div> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton icon={X} label="通知を閉じる" size="sm" onClick={onDismiss} />
      ) : null}
    </div>
  )
}

// 通知を積み重ねて表示する置き場。画面右下に固定する。
export function ToastRegion({ children }: { children?: ReactNode }) {
  return <div className={styles.region}>{children}</div>
}
