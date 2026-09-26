//! 起動引数・2 つ目の起動の引数・ウィンドウへのドロップで渡された「開きたい場所」を正規化し、
//! フロントが受け取るまで持っておく。フロントは通知を待ち受けてから取り出すので、待ち受けの前に
//! 届いた分も取りこぼさない(先に積み、通知は「取りに来て」の合図だけにする)。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use crate::services::source::is_supported_image_path;

/// 開きたい場所が積まれたことをフロントへ知らせるイベント。中身は持たず、フロントは
/// `take_pending_open_path` で取り出す。
pub const OPEN_REQUESTED_EVENT: &str = "open-path-requested";

/// 画像以外で本として開く(または開く予定の)ファイルの拡張子。画像の拡張子は
/// `is_supported_image_path` に従う。
const BOOK_FILE_EXTENSIONS: &[&str] = &["zip", "cbz", "epub", "rar", "cbr", "pdf"];

/// フロントがまだ受け取っていない、最後に要求された場所(正規化した絶対パス)。
/// ビューアは 1 冊しか開けないので、新しい要求は古い要求を置き換える。
#[derive(Default)]
pub struct PendingOpenPath(Mutex<Option<String>>);

impl PendingOpenPath {
    fn replace(&self, path: String) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path);
    }

    /// 積まれている場所を取り出す(取り出すと消える)。
    pub fn take(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

/// 本として開ける場所か確かめ、正規化した絶対パスを返す。フォルダ、または対応する拡張子の
/// ファイルだけを通す(存在しない・読めない場所は `None`)。
pub fn normalize_open_path(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    if canonical.is_dir() {
        return Some(canonical);
    }
    if !canonical.is_file() {
        return None;
    }
    let is_book_file = canonical
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|extension| BOOK_FILE_EXTENSIONS.contains(&extension.as_str()));
    (is_book_file || is_supported_image_path(&canonical.to_string_lossy())).then_some(canonical)
}

/// コマンドライン引数を 1 つ正規化する。`-` で始まるものはオプションとして読み飛ばし、
/// 相対パスは起動したときの作業フォルダ(`cwd`)から解決する。
fn normalize_open_arg(raw_arg: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let trimmed = raw_arg.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return None;
    }

    let path = PathBuf::from(trimmed);
    let candidate = if path.is_absolute() {
        path
    } else {
        cwd.unwrap_or_else(|| Path::new(".")).join(path)
    };
    normalize_open_path(&candidate)
}

/// 実行ファイル名を除いた引数から、開ける最初の場所を選ぶ。
pub fn open_path_from_args<I>(args: I, cwd: Option<&Path>) -> Option<String>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    args.into_iter()
        .find_map(|arg| normalize_open_arg(arg.as_ref(), cwd))
        .map(|path| path.to_string_lossy().into_owned())
}

/// ウィンドウへドロップされたパスから、開ける最初の場所を選ぶ。
pub fn open_path_from_dropped(paths: &[PathBuf]) -> Option<String> {
    paths
        .iter()
        .find_map(|path| normalize_open_path(path))
        .map(|path| path.to_string_lossy().into_owned())
}

/// 開きたい場所を積み、フロントへ取りに来るよう知らせる。
pub fn request_open(app: &AppHandle, path: Option<String>) {
    let Some(path) = path else {
        return;
    };
    app.state::<PendingOpenPath>().replace(path);
    if let Err(error) = app.emit(OPEN_REQUESTED_EVENT, ()) {
        log::warn!("開く要求をフロントへ知らせられませんでした: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("一時フォルダを作れる");
        std::fs::create_dir(dir.path().join("巻1")).unwrap();
        for name in [
            "a.CBZ", "b.epub", "c.rar", "d.cbr", "e.pdf", "f.zip", "g.png", "h.txt", "i.exe",
        ] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        dir
    }

    fn canonical(path: PathBuf) -> String {
        std::fs::canonicalize(path)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn accepts_folders_and_supported_files_ignoring_case() {
        let dir = fixture();
        for name in ["巻1", "a.CBZ", "b.epub", "c.rar", "d.cbr", "e.pdf", "f.zip", "g.png"] {
            assert_eq!(
                normalize_open_path(&dir.path().join(name)),
                Some(std::fs::canonicalize(dir.path().join(name)).unwrap()),
                "{name} は開ける場所",
            );
        }
    }

    #[test]
    fn rejects_unsupported_and_missing_paths() {
        let dir = fixture();
        for name in ["h.txt", "i.exe", "無い.cbz", "無いフォルダ"] {
            assert_eq!(normalize_open_path(&dir.path().join(name)), None, "{name}");
        }
    }

    #[test]
    fn args_skip_options_and_resolve_relative_paths_from_cwd() {
        let dir = fixture();
        let args = ["--flag", "-x", "", "\"\"", "h.txt", "\"b.epub\"", "a.CBZ"];
        assert_eq!(
            open_path_from_args(args, Some(dir.path())),
            Some(canonical(dir.path().join("b.epub"))),
        );
    }

    #[test]
    fn args_resolve_parent_segments_to_the_real_location() {
        let dir = fixture();
        let arg = dir.path().join("巻1").join("..").join("g.png");
        assert_eq!(
            open_path_from_args([arg.to_string_lossy()], None),
            Some(canonical(dir.path().join("g.png"))),
        );
    }

    #[test]
    fn args_without_openable_path_request_nothing() {
        let dir = fixture();
        assert_eq!(open_path_from_args(["i.exe", "--x", "h.txt"], Some(dir.path())), None);
        assert_eq!(open_path_from_args(Vec::<String>::new(), Some(dir.path())), None);
    }

    #[test]
    fn dropped_paths_pick_the_first_openable_one() {
        let dir = fixture();
        let dropped = [dir.path().join("h.txt"), dir.path().join("巻1"), dir.path().join("e.pdf")];
        assert_eq!(open_path_from_dropped(&dropped), Some(canonical(dir.path().join("巻1"))));
    }

    #[test]
    fn pending_path_keeps_only_the_latest_request_until_taken() {
        let pending = PendingOpenPath::default();
        assert_eq!(pending.take(), None);
        pending.replace("first".into());
        pending.replace("second".into());
        assert_eq!(pending.take(), Some("second".into()));
        assert_eq!(pending.take(), None);
    }
}
