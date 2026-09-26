use tauri::{AppHandle, Manager};

use crate::app_error::AppResult;
use crate::launch::PendingOpenPath;

/// 起動引数・2 つ目の起動・ウィンドウへのドロップで要求され、フロントがまだ受け取っていない
/// 場所(正規化した絶対パス)を取り出す。無ければ `None`。
#[tauri::command]
pub fn take_pending_open_path(app: AppHandle) -> AppResult<Option<String>> {
    Ok(app.state::<PendingOpenPath>().take())
}
