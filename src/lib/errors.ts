import type { AppErrorCode, AppErrorPayload } from '@/types/error'

// command の失敗。`Error` を継ぐので、`error instanceof Error ? error.message : …` と書いた
// 既存の画面はそのまま文言を出せる。種類で分けたいときは `isCommandError` と `code` を使う。
export class CommandError extends Error {
  readonly code: AppErrorCode

  constructor({ code, message }: AppErrorPayload) {
    super(message)
    this.name = 'CommandError'
    this.code = code
  }
}

export function isCommandError(value: unknown): value is CommandError {
  return value instanceof CommandError
}

// Rust の `AppError` が直列化された値か。
export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return typeof record.code === 'string' && typeof record.message === 'string'
}

// command が投げた値を `CommandError` にそろえる。
export function toCommandError(value: unknown): CommandError {
  if (value instanceof CommandError) {
    return value
  }
  if (isAppErrorPayload(value)) {
    return new CommandError(value)
  }
  if (value instanceof Error) {
    return new CommandError({ code: 'unknown', message: value.message })
  }
  return new CommandError({
    code: 'unknown',
    message: typeof value === 'string' && value ? value : '処理に失敗しました。',
  })
}
