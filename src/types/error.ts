// Rust の `AppError`(`src-tauri/src/app_error.rs`)が command の失敗として返す形。
// `code` の一覧は `AppError::code` と一致させる。`unknown` はフロント側だけの値で、
// `{ code, message }` の形をしていない失敗(Tauri 自体のエラーなど)に付ける。
export type AppErrorCode =
  | 'app_data_dir_unavailable'
  | 'io'
  | 'not_found'
  | 'zip'
  | 'http'
  | 'serde'
  | 'timeout'
  | 'internal'
  | 'unsupported_format'
  | 'no_pages'
  | 'unsupported_text_epub'
  | 'page_out_of_range'
  | 'page_too_large'
  | 'book_not_open'
  | 'source_not_found'
  | 'outside_source'
  | 'shelf_not_found'
  | 'failed'
  | 'unknown'

export interface AppErrorPayload {
  code: AppErrorCode
  message: string
}
