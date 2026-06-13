use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("アプリデータディレクトリの初期化に失敗しました。")]
    AppDataDirUnavailable,
    #[error("ファイル操作に失敗しました: {0}")]
    Io(#[from] std::io::Error),
    #[error("ZIP アーカイブの処理に失敗しました: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("HTTP 通信に失敗しました: {0}")]
    Http(#[from] reqwest::Error),
    #[error("設定データの変換に失敗しました: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}
