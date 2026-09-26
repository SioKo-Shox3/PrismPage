import type { HTMLAttributes } from 'react'

import styles from './Badge.module.css'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
}

// 状態や件数を示す小さなラベル。
export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  const classes = [styles.badge, styles[tone], className].filter(Boolean).join(' ')

  return <span className={classes} {...rest} />
}
