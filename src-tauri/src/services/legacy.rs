//! 旧版が残したデータ(アプリのデータ領域直下の `library/` フォルダ)の確認と削除。
//! 設定画面の明示操作からだけ呼ぶ。消すのはデータ領域直下の `library/` だけで、
//! 別の場所を指すリンク(シンボリックリンク・ジャンクション)になっていれば辿らずに拒否する。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::app_error::{AppError, AppResult};

/// 旧版が本の一覧などを置いていたフォルダの名前。
pub const LEGACY_LIBRARY_DIR: &str = "library";

/// 旧 `library/` フォルダの中身の概要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyDirSummary {
    pub path: PathBuf,
    pub file_count: u64,
    pub total_bytes: u64,
}

/// `data_dir` 直下の旧 `library/` フォルダを調べる。無ければ `None`。
pub fn inspect(data_dir: &Path) -> AppResult<Option<LegacyDirSummary>> {
    let target = data_dir.join(LEGACY_LIBRARY_DIR);
    if !is_plain_dir(&target)? {
        return Ok(None);
    }
    let mut summary = LegacyDirSummary {
        path: target.clone(),
        file_count: 0,
        total_bytes: 0,
    };
    add_dir_usage(&target, &mut summary)?;
    Ok(Some(summary))
}

/// `data_dir` 直下の旧 `library/` フォルダを中身ごと消す。消したら真、もともと無ければ偽。
pub fn remove(data_dir: &Path) -> AppResult<bool> {
    let target = data_dir.join(LEGACY_LIBRARY_DIR);
    if !is_plain_dir(&target)? {
        return Ok(false);
    }
    // std の remove_dir_all は中のリンクを辿らず、リンクそのものだけを消す。
    fs::remove_dir_all(&target).map_err(|error| {
        AppError::Message(format!(
            "旧バージョンのデータを削除しきれませんでした(一部が残っています): {error}"
        ))
    })?;
    Ok(true)
}

/// `path` がリンクでない実際のフォルダなら真、無ければ偽。リンクやファイルなら消さずに失敗を返す。
fn is_plain_dir(path: &Path) -> AppResult<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(AppError::Message(
            "旧バージョンのデータのフォルダが別の場所へのリンクになっているため、削除しません。".into(),
        ));
    }
    if !file_type.is_dir() {
        return Err(AppError::Message(
            "旧バージョンのデータの場所がフォルダではないため、削除しません。".into(),
        ));
    }
    Ok(true)
}

/// フォルダの下のファイル数と合計サイズを足す。リンクは辿らず 1 件として数える。
fn add_dir_usage(dir: &Path, summary: &mut LegacyDirSummary) -> AppResult<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() && !file_type.is_symlink() {
            add_dir_usage(&entry.path(), summary)?;
        } else {
            summary.file_count += 1;
            if file_type.is_file() {
                summary.total_bytes += entry.metadata()?.len();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_dir_is_reported_as_none_and_not_removed() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(inspect(data.path()).unwrap(), None);
        assert!(!remove(data.path()).unwrap());
    }

    #[test]
    fn counts_and_removes_only_the_legacy_dir() {
        let data = tempfile::tempdir().unwrap();
        let legacy = data.path().join(LEGACY_LIBRARY_DIR);
        fs::create_dir_all(legacy.join("covers")).unwrap();
        fs::write(legacy.join("library.json"), b"12345").unwrap();
        fs::write(legacy.join("covers").join("a.jpg"), b"123").unwrap();
        fs::write(data.path().join("prismpage.sqlite3"), b"db").unwrap();
        fs::create_dir_all(data.path().join("enhance-cache")).unwrap();

        let summary = inspect(data.path()).unwrap().unwrap();
        assert_eq!(summary.path, legacy);
        assert_eq!(summary.file_count, 2);
        assert_eq!(summary.total_bytes, 8);

        assert!(remove(data.path()).unwrap());
        assert!(!legacy.exists());
        assert!(data.path().join("prismpage.sqlite3").exists());
        assert!(data.path().join("enhance-cache").exists());
        assert_eq!(inspect(data.path()).unwrap(), None);
    }

    #[test]
    fn refuses_a_file_with_the_legacy_name() {
        let data = tempfile::tempdir().unwrap();
        let legacy = data.path().join(LEGACY_LIBRARY_DIR);
        fs::write(&legacy, b"not a dir").unwrap();
        assert!(remove(data.path()).is_err());
        assert!(legacy.exists());
    }
}
