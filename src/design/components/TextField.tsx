import { useId } from 'react'
import type { InputHTMLAttributes } from 'react'

import styles from './TextField.module.css'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string
  hint?: string
  error?: string
}

// ラベル付きの 1 行入力。error があるときは hint より優先して表示し、aria-invalid を立てる。
export function TextField({ label, hint, error, className, ...rest }: TextFieldProps) {
  const id = useId()
  const messageId = `${id}-message`
  const message = error ?? hint

  return (
    <div className={[styles.field, className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        {...rest}
      />
      {message ? (
        <p id={messageId} className={error ? styles.error : styles.hint}>
          {message}
        </p>
      ) : null}
    </div>
  )
}
