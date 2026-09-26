use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

/// command の失敗をフロントへ渡す型。`{ code, message }` に直列化され、
/// フロントは `code` で種類を判別し、`message` をそのまま利用者に見せる。
/// `code` の一覧は `src/types/error.ts` の `AppErrorCode` と一致させる。
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
    /// 開こうとしたパスが本として扱える形式ではない。
    #[error("この形式は開けません: {0}")]
    UnsupportedFormat(String),
    /// 本として開けたが、表示できるページが 1 枚もない。
    #[error("表示できる画像が見つかりません。")]
    NoPages,
    /// 画像を含まない項目が多数を占める(文章中心の)EPUB。
    #[error("文章中心の EPUB には対応していません。")]
    UnsupportedTextEpub,
    /// 存在しないページ番号が要求された。
    #[error("ページ {index} はありません(全 {count} ページ)。")]
    PageOutOfRange { index: usize, count: usize },
    /// ページの画像が大きすぎて読み込めない。
    #[error("ページの画像が大きすぎるため読み込めません。")]
    PageTooLarge,
    /// 開いていない本の ID が渡された。
    #[error("本が開かれていません。もう一度開いてください。")]
    BookNotOpen,
    /// 登録されていない登録フォルダの ID が渡された。
    #[error("登録フォルダが見つかりません。登録し直してください。")]
    SourceNotFound,
    /// 登録フォルダの外を指すパスが渡された(`..`・リンク経由を含む)。
    #[error("登録フォルダの外は表示できません。")]
    OutsideSource,
    /// 無い本棚の ID が渡された(別の画面で消された場合を含む)。
    #[error("本棚が見つかりません。消された可能性があります。")]
    ShelfNotFound,
    /// 外部プロセスが制限時間内に終わらなかった。
    #[error("{0}")]
    Timeout(String),
    /// 裏の処理が途中で異常終了した(スレッドの panic など)。
    #[error("{0}")]
    Internal(String),
    /// 上記に当てはまらない、利用者向けの文言を持つ失敗。
    #[error("{0}")]
    Message(String),
}

impl AppError {
    /// フロントが判別に使う機械向けの種類名。
    pub fn code(&self) -> &'static str {
        match self {
            Self::AppDataDirUnavailable => "app_data_dir_unavailable",
            Self::Io(error) if error.kind() == std::io::ErrorKind::NotFound => "not_found",
            Self::Io(_) => "io",
            Self::Zip(_) => "zip",
            Self::Http(_) => "http",
            Self::Serde(_) => "serde",
            Self::UnsupportedFormat(_) => "unsupported_format",
            Self::NoPages => "no_pages",
            Self::UnsupportedTextEpub => "unsupported_text_epub",
            Self::PageOutOfRange { .. } => "page_out_of_range",
            Self::PageTooLarge => "page_too_large",
            Self::BookNotOpen => "book_not_open",
            Self::SourceNotFound => "source_not_found",
            Self::OutsideSource => "outside_source",
            Self::ShelfNotFound => "shelf_not_found",
            Self::Timeout(_) => "timeout",
            Self::Internal(_) => "internal",
            Self::Message(_) => "failed",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;

    #[test]
    fn serializes_to_code_and_message() {
        let value = serde_json::to_value(AppError::Timeout("時間切れです。".into())).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "code": "timeout", "message": "時間切れです。" })
        );
    }

    #[test]
    fn io_not_found_has_its_own_code() {
        let missing = AppError::from(std::io::Error::from(std::io::ErrorKind::NotFound));
        let denied = AppError::from(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(missing.code(), "not_found");
        assert_eq!(denied.code(), "io");
    }
}
