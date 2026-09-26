import type { ButtonHTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'

import styles from './IconButton.module.css'

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon
  // 読み上げとツールチップに使う名前。アイコンだけのボタンには必須。
  label: string
  variant?: 'ghost' | 'secondary'
  size?: 'sm' | 'md'
  pressed?: boolean
}

// アイコンだけのボタン。label は aria-label と title の両方に入る。
export function IconButton({
  icon: Icon,
  label,
  variant = 'ghost',
  size = 'md',
  pressed,
  type = 'button',
  className,
  ...rest
}: IconButtonProps) {
  const classes = [styles.iconButton, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      className={classes}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      {...rest}
    >
      <Icon size={size === 'sm' ? 16 : 18} aria-hidden="true" />
    </button>
  )
}
