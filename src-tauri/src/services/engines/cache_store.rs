//! 超解像キャッシュの容量の管理。使用量の集計、上限を超えた分を古いものから消す処理、全消去と、
//! 上限の設定の保存(アプリのデータ領域の `enhanced-cache.json`)を置く。
//! 消すのはキャッシュのフォルダの中の通常のファイルだけで、リンクはたどらない。処理中のジョブの作業フォルダは触らない。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::app_error::{AppError, AppResult};

use super::enhance::WORK_DIR;

/// 上限の既定値(2 GiB)。
pub const DEFAULT_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 設定できる上限の範囲。小さすぎると表示中のページの結果まで消えるので下限を置く。
pub const MIN_LIMIT_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_LIMIT_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

/// 保存形式の版。形を変えたら上げ、`load_limit` で旧版の扱いを決める。
const SETTINGS_VERSION: u32 = 1;

/// 集計・削除を同時に走らせない(ジョブの後始末と設定画面の操作が重なりうる)。
static CACHE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CacheUsage {
    pub bytes: u64,
    pub files: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    version: u32,
    limit_bytes: u64,
}

/// 保存した上限を読む。無い・壊れている・版が違う・範囲外の保存は既定値にする(version 1 だけを読む)。
pub fn load_limit(path: &Path) -> u64 {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StoredSettings>(&bytes).ok())
        .filter(|stored| stored.version == SETTINGS_VERSION)
        .map(|stored| stored.limit_bytes)
        .filter(|limit| validate_limit(*limit).is_ok())
        .unwrap_or(DEFAULT_LIMIT_BYTES)
}

/// 上限を保存する。一時ファイルに書いてから置き換え、書きかけの設定を残さない。
pub fn save_limit(path: &Path, limit_bytes: u64) -> AppResult<()> {
    validate_limit(limit_bytes)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Message("キャッシュ設定の保存先が不正です。".into()))?;
    fs::create_dir_all(parent)?;
    let body = serde_json::to_vec_pretty(&StoredSettings {
        version: SETTINGS_VERSION,
        limit_bytes,
    })
    .map_err(|error| AppError::Message(format!("キャッシュ設定を保存できません: {error}")))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    io::Write::write_all(&mut temp, &body)?;
    temp.persist(path)
        .map_err(|error| AppError::from(error.error))?;
    Ok(())
}

pub fn validate_limit(limit_bytes: u64) -> AppResult<()> {
    if (MIN_LIMIT_BYTES..=MAX_LIMIT_BYTES).contains(&limit_bytes) {
        Ok(())
    } else {
        Err(AppError::Message(
            "キャッシュの上限は 256 MB から 1 TB の間で指定してください。".into(),
        ))
    }
}

struct Entry {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

/// キャッシュのフォルダの中の結果ファイルを集める。作業フォルダとリンクは除く。フォルダが無ければ空。
fn collect_entries(root: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let items = match fs::read_dir(&dir) {
            Ok(items) => items,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for item in items {
            let item = item?;
            if dir == root && item.file_name() == WORK_DIR {
                continue;
            }
            // `DirEntry::metadata` はリンクをたどらない。
            let metadata = match item.metadata() {
                Ok(metadata) => metadata,
                // 集めている間に消されたものは数えない。
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if metadata.is_dir() {
                pending.push(item.path());
            } else if metadata.is_file() {
                entries.push(Entry {
                    path: item.path(),
                    size: metadata.len(),
                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                });
            }
        }
    }
    Ok(entries)
}

fn sum(entries: &[Entry]) -> CacheUsage {
    CacheUsage {
        bytes: entries.iter().map(|entry| entry.size).sum(),
        files: entries.len() as u64,
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // 中身の無い排他なので、途中で落ちたスレッドがあっても続けてよい。
    CACHE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// キャッシュの使用量。
pub fn usage(root: &Path) -> AppResult<CacheUsage> {
    let _guard = lock();
    Ok(sum(&collect_entries(root)?))
}

/// 合計が `limit_bytes` 以下になるまで、更新日時の古いものから消す。消したあとの使用量を返す。
/// 結果は使うたびに更新日時を新しくする(`touch`)ので、古いもの = 長く使っていないもの。
pub fn prune(root: &Path, limit_bytes: u64) -> AppResult<CacheUsage> {
    let _guard = lock();
    let mut entries = collect_entries(root)?;
    let mut total = sum(&entries);
    if total.bytes <= limit_bytes {
        return Ok(total);
    }
    entries.sort_by(|a, b| {
        a.modified
            .cmp(&b.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
    for entry in &entries {
        if total.bytes <= limit_bytes {
            break;
        }
        match fs::remove_file(&entry.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                log::warn!(
                    "超解像キャッシュを消せません({}): {error}",
                    entry.path.display()
                );
                continue;
            }
        }
        total.bytes -= entry.size;
        total.files -= 1;
        remove_empty_parents(root, &entry.path);
    }
    Ok(total)
}

/// 消したファイルの親フォルダを、空になっていればキャッシュのフォルダの手前まで消す。
fn remove_empty_parents(root: &Path, file: &Path) {
    let mut current = file.parent();
    while let Some(dir) = current {
        if dir == root || !dir.starts_with(root) {
            break;
        }
        // 空でなければ失敗するので、それで止まる。
        if fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

/// キャッシュをすべて消す。処理中のジョブの作業フォルダは残す。
pub fn clear(root: &Path) -> AppResult<CacheUsage> {
    let _guard = lock();
    let items = match fs::read_dir(root) {
        Ok(items) => items,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(CacheUsage::default()),
        Err(error) => return Err(error.into()),
    };
    for item in items {
        let item = item?;
        if item.file_name() == WORK_DIR {
            continue;
        }
        let file_type = item.file_type()?;
        let result = if file_type.is_symlink() {
            // リンク自体だけを消す(リンク先は消さない)。フォルダへのリンクは remove_dir で消える。
            fs::remove_file(item.path()).or_else(|_| fs::remove_dir(item.path()))
        } else if file_type.is_dir() {
            fs::remove_dir_all(item.path())
        } else {
            fs::remove_file(item.path())
        };
        match result {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(sum(&collect_entries(root)?))
}

/// 使った結果の更新日時を今にする(上限を超えたときに消える順を後ろへ回す)。失敗しても処理は続ける。
pub fn touch(path: &Path) {
    let result = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(SystemTime::now()));
    if let Err(error) = result {
        log::debug!(
            "超解像キャッシュの更新日時を更新できません({}): {error}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn write(root: &Path, relative: &str, size: usize, age_secs: u64) -> PathBuf {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![0u8; size]).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(age_secs))
            .unwrap();
        path
    }

    #[test]
    fn usage_counts_results_but_not_the_work_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("enhanced");
        assert_eq!(usage(&root).unwrap(), CacheUsage::default());
        write(&root, "0123456789abcdef/0-aaaa/k1.png", 100, 0);
        write(&root, "0123456789abcdef/1-bbbb/k1.png", 50, 0);
        write(&root, ".work/job-1/out.png", 1000, 0);
        assert_eq!(
            usage(&root).unwrap(),
            CacheUsage {
                bytes: 150,
                files: 2
            }
        );
    }

    #[test]
    fn prune_removes_oldest_until_under_limit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("enhanced");
        let oldest = write(&root, "aaaaaaaaaaaaaaaa/0-x/k.png", 100, 300);
        let middle = write(&root, "bbbbbbbbbbbbbbbb/0-x/k.png", 100, 200);
        let newest = write(&root, "aaaaaaaaaaaaaaaa/1-x/k.png", 100, 100);
        let work = write(&root, ".work/job-1/out.png", 1000, 900);

        // 上限以下なら何も消さない。
        assert_eq!(
            prune(&root, 300).unwrap(),
            CacheUsage {
                bytes: 300,
                files: 3
            }
        );
        assert!(oldest.is_file());

        assert_eq!(
            prune(&root, 150).unwrap(),
            CacheUsage {
                bytes: 100,
                files: 1
            }
        );
        assert!(!oldest.exists());
        assert!(!middle.exists());
        assert!(newest.is_file());
        // 処理中の作業フォルダは古くても消さない。
        assert!(work.is_file());
        // 空になったフォルダは片付け、キャッシュのフォルダ自体は残す。
        assert!(!root.join("bbbbbbbbbbbbbbbb").exists());
        assert!(!root.join("aaaaaaaaaaaaaaaa/0-x").exists());
        assert!(root.join("aaaaaaaaaaaaaaaa/1-x").is_dir());
        assert!(root.is_dir());
    }

    #[test]
    fn touched_results_are_removed_last() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("enhanced");
        let used = write(&root, "aaaaaaaaaaaaaaaa/0-x/k.png", 100, 300);
        let unused = write(&root, "aaaaaaaaaaaaaaaa/1-x/k.png", 100, 200);
        touch(&used);
        prune(&root, 100).unwrap();
        assert!(used.is_file());
        assert!(!unused.exists());
    }

    #[test]
    fn clear_removes_results_but_keeps_the_work_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("enhanced");
        write(&root, "aaaaaaaaaaaaaaaa/0-x/k.png", 100, 0);
        write(&root, "stray.png", 10, 0);
        let work = write(&root, ".work/job-1/out.png", 1000, 0);
        assert_eq!(clear(&root).unwrap(), CacheUsage::default());
        assert!(!root.join("aaaaaaaaaaaaaaaa").exists());
        assert!(!root.join("stray.png").exists());
        assert!(work.is_file());
        // フォルダが無くても失敗しない。
        assert_eq!(
            clear(&dir.path().join("missing")).unwrap(),
            CacheUsage::default()
        );
    }

    /// キャッシュの中のリンクはたどらない(外のファイルを数えも消しもしない)。
    #[cfg(windows)]
    #[test]
    fn links_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("enhanced");
        let outside = dir.path().join("outside");
        let kept = write(&outside, "book.png", 500, 1000);
        fs::create_dir_all(&root).unwrap();
        // ディレクトリジャンクションは管理者権限なしで作れる。
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
        assert_eq!(usage(&root).unwrap(), CacheUsage::default());
        prune(&root, 0).unwrap();
        clear(&root).unwrap();
        assert!(kept.is_file());
    }

    #[test]
    fn limit_is_saved_versioned_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enhanced-cache.json");
        assert_eq!(load_limit(&path), DEFAULT_LIMIT_BYTES);
        save_limit(&path, MIN_LIMIT_BYTES).unwrap();
        assert_eq!(load_limit(&path), MIN_LIMIT_BYTES);
        assert!(save_limit(&path, MIN_LIMIT_BYTES - 1).is_err());
        assert!(save_limit(&path, MAX_LIMIT_BYTES + 1).is_err());
        assert_eq!(load_limit(&path), MIN_LIMIT_BYTES);
        // 版の違う保存・壊れた保存は既定値にする。
        fs::write(&path, br#"{"version":2,"limitBytes":1073741824}"#).unwrap();
        assert_eq!(load_limit(&path), DEFAULT_LIMIT_BYTES);
        fs::write(&path, b"{").unwrap();
        assert_eq!(load_limit(&path), DEFAULT_LIMIT_BYTES);
    }
}
