pub mod books;
pub mod collections;
pub mod engines;
pub mod history;
pub mod legacy;
pub mod library;
pub mod search;
pub mod sources;

use crate::app_error::{AppError, AppResult};

/// 重い処理(ファイル走査・外部プロセス・通信)を WebView のスレッドから外して実行する。
pub(crate) async fn run_blocking<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::Internal(format!("裏の処理が異常終了しました: {error}")))?
}
