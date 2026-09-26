import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

import { IconButton } from './IconButton'
import styles from './Dialog.module.css'

export interface DialogProps {
  open: boolean
  title: string
  onClose: () => void
  children?: ReactNode
  // 下端に右寄せで並べる操作(Button など)。
  actions?: ReactNode
}

// モーダルの確認・入力ダイアログ。ネイティブの <dialog> を使い、Esc と背景クリックで閉じる。
export function Dialog({ open, title, onClose, children, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) {
      return
    }
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Esc ではブラウザに閉じさせず、開閉を open プロパティに一本化する。
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      {open ? (
        <div className={styles.body}>
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <IconButton icon={X} label="閉じる" size="sm" onClick={onClose} />
          </header>
          {children ? <div className={styles.content}>{children}</div> : null}
          {actions ? <footer className={styles.actions}>{actions}</footer> : null}
        </div>
      ) : null}
    </dialog>
  )
}
