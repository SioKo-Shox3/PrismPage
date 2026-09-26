import styles from './ProgressLine.module.css'

export interface ProgressLineProps {
  // 0〜1 の進み具合。null は長さの分からない処理中を表す。
  value: number | null
  label: string
  className?: string
}

// 細い 1 本線の進捗表示。ビューア下端の読書位置や処理の進み具合に使う。
export function ProgressLine({ value, label, className }: ProgressLineProps) {
  const clamped = value === null ? null : Math.min(1, Math.max(0, value))
  const percent = clamped === null ? undefined : Math.round(clamped * 100)

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={[styles.track, className].filter(Boolean).join(' ')}
    >
      <div
        className={clamped === null ? styles.indeterminate : styles.bar}
        style={clamped === null ? undefined : { transform: `scaleX(${clamped})` }}
      />
    </div>
  )
}
