//! 登録フォルダの中身をその場で読み、各項目を「フォルダ」と「本」に分けて返す。
//! 読むのは登録フォルダの配下だけで、外を指すパス(`..`・シンボリックリンク・ジャンクション経由)は拒否する。
//! 元のファイルは一覧を作るために読むだけで、変更しない。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::app_error::{AppError, AppResult};
use crate::models::{BookFormat, DirectoryEntry, EntryKind};
use crate::services::source::{book_id_for_path, has_extension, is_supported_image_path, natural_cmp};

pub mod index;

/// 登録するフォルダのパスを正規化する。存在するフォルダでなければ失敗する。
pub fn canonical_source_path(path: &Path) -> AppResult<PathBuf> {
    let canonical = fs::canonicalize(path)?;
    if !canonical.is_dir() {
        return Err(AppError::Message(format!(
            "フォルダではないため登録できません: {}",
            display_path(&canonical)
        )));
    }
    Ok(canonical)
}

/// `target` を登録フォルダ `root` の配下のフォルダとして解決する。相対パスは `root` からの相対とみなす。
/// `..` やリンクをたどった先で判定するので、たどった結果が `root` の外なら `AppError::OutsideSource`。
/// `root` と戻り値はどちらも正規化した絶対パス。
pub fn resolve_within(root: &Path, target: &Path) -> AppResult<(PathBuf, PathBuf)> {
    let root = fs::canonicalize(root)?;
    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let resolved = fs::canonicalize(joined)?;
    if !resolved.starts_with(&root) {
        return Err(AppError::OutsideSource);
    }
    if !resolved.is_dir() {
        return Err(AppError::Message(format!(
            "フォルダではないため一覧を表示できません: {}",
            display_path(&resolved)
        )));
    }
    Ok((root, resolved))
}

/// `root` から `dir` までのフォルダ名の並び(パンくずに使う)。`dir` が `root` なら空。
pub fn relative_segments(root: &Path, dir: &Path) -> Vec<String> {
    dir.strip_prefix(root)
        .map(|relative| {
            relative
                .components()
                .filter_map(|component| match component {
                    Component::Normal(name) => Some(name.to_string_lossy().to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 一覧の項目の分類を並行に行う最小の件数。これより少ないときはスレッドを立てない。
const PARALLEL_CLASSIFY_MIN: usize = 64;
/// 分類に使うスレッドの上限。項目ごとの作業はフォルダの読み取りとファイル情報の問い合わせで、待ちが主になる。
const MAX_CLASSIFY_THREADS: usize = 8;

/// `dir` の直下を読み、フォルダ・本に分けて返す。並びはフォルダが先、それぞれ名前の自然順。
/// シンボリックリンク・ジャンクション(`DirEntry::file_type` はリンク先をたどらない)は、
/// 登録フォルダの外へ出られないよう一覧に載せない。本として扱わないファイルも載せない。
/// 項目ごとの分類(画像フォルダかどうか・更新日時)は、項目が多いときは複数のスレッドで分けて行う。
pub fn list_entries(dir: &Path) -> AppResult<Vec<DirectoryEntry>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        found.push((entry.path(), entry.file_name(), entry.file_type()?));
    }
    let threads = std::thread::available_parallelism()
        .map_or(1, |count| count.get())
        .min(MAX_CLASSIFY_THREADS);
    let mut entries = filter_map_parallel(&found, threads, |(path, name, file_type)| {
        classify(path, name, file_type)
    })?;
    entries.sort_by(|left, right| {
        (left.kind != EntryKind::Folder)
            .cmp(&(right.kind != EntryKind::Folder))
            .then_with(|| natural_cmp(&left.name, &right.name))
    });
    Ok(entries)
}

/// `items` の各要素に `f` を当て、`None` を除いた結果を返す。`PARALLEL_CLASSIFY_MIN` 件以上で
/// `threads` が 2 以上なら、要素を分けて複数のスレッドで行う(結果の順は保たない)。
/// 異常終了したスレッドがあれば、その分を欠いた結果を返さずに失敗させる。
fn filter_map_parallel<T: Sync, R: Send>(
    items: &[T],
    threads: usize,
    f: impl Fn(&T) -> Option<R> + Sync,
) -> AppResult<Vec<R>> {
    let run = |part: &[T]| part.iter().filter_map(&f).collect::<Vec<_>>();
    if items.len() < PARALLEL_CLASSIFY_MIN || threads < 2 {
        return Ok(run(items));
    }
    let chunk = items.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let workers: Vec<_> = items
            .chunks(chunk)
            .map(|part| scope.spawn(move || run(part)))
            .collect();
        let mut results = Vec::with_capacity(items.len());
        for worker in workers {
            let part = worker.join().map_err(|_| {
                AppError::Internal("フォルダの項目を分類できませんでした。".to_string())
            })?;
            results.extend(part);
        }
        Ok(results)
    })
}

/// 直下の 1 項目をフォルダか本に分ける。一覧に載せない項目は `None`。
fn classify(path: &Path, name: &std::ffi::OsStr, file_type: &fs::FileType) -> Option<DirectoryEntry> {
    let name = name.to_string_lossy().to_string();
    let (kind, format) = if file_type.is_symlink() {
        return None;
    } else if file_type.is_dir() {
        if contains_images(path) {
            (EntryKind::Book, Some(BookFormat::Folder))
        } else {
            (EntryKind::Folder, None)
        }
    } else if file_type.is_file() {
        (EntryKind::Book, Some(file_format(path)?))
    } else {
        return None;
    };
    let title = match format {
        Some(format) if format != BookFormat::Folder => path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone()),
        _ => name.clone(),
    };
    let openable = format.map_or(true, BookFormat::is_openable);
    // `DirEntry::metadata` は Windows では列挙時の値で、中身が変わったばかりのフォルダの時刻が古いことがあるので読み直す。
    let modified_at = fs::metadata(path).ok().as_ref().and_then(modified_millis);
    Some(DirectoryEntry {
        name,
        title,
        thumb_id: (kind == EntryKind::Book && openable).then(|| book_id_for_path(path)),
        path: path.to_string_lossy().to_string(),
        kind,
        format,
        openable,
        modified_at,
        // 読書状態は一覧を返す command が記録から埋める。
        page: None,
        page_count: None,
        last_read_at: None,
    })
}

/// ファイル・フォルダの更新日時(UNIX エポックのミリ秒)。読めない・エポックより前なら `None`。
pub fn modified_millis(metadata: &fs::Metadata) -> Option<i64> {
    let elapsed = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(elapsed.as_millis()).ok()
}

/// ファイルが本ならその形式。本として扱わないファイルは `None`。
fn file_format(path: &Path) -> Option<BookFormat> {
    if has_extension(path, &["zip", "cbz"]) {
        Some(BookFormat::Zip)
    } else if has_extension(path, &["epub"]) {
        Some(BookFormat::Epub)
    } else if has_extension(path, &["rar", "cbr"]) {
        Some(BookFormat::Rar)
    } else if has_extension(path, &["pdf"]) {
        Some(BookFormat::Pdf)
    } else {
        None
    }
}

/// フォルダが表示できる画像を直接含むか(含めば画像フォルダの本)。読めないフォルダは含まないとみなす。
fn contains_images(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry.file_type().is_ok_and(|file_type| file_type.is_file())
            && is_supported_image_path(&entry.file_name().to_string_lossy())
    })
}

/// 本棚・お気に入りに入れる本。`path` は正規化した絶対パスで、`open_book` が本の行に使う値と同じ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookLocation {
    pub path: PathBuf,
    pub format: BookFormat,
    pub title: String,
}

/// パスを本の場所にする。`open_book` と同じく正規化し、画像ファイルは親フォルダを 1 冊の本とする。
/// 無いパスは `not_found`、画像を直接含まないフォルダ・本として扱わないファイルは `unsupported_format`。
pub fn book_location(path: &Path) -> AppResult<BookLocation> {
    let canonical = fs::canonicalize(path)?;
    let unsupported = || AppError::UnsupportedFormat(display_path(&canonical));
    let metadata = fs::metadata(&canonical)?;
    let (root, format) = if metadata.is_dir() {
        if !contains_images(&canonical) {
            return Err(unsupported());
        }
        (canonical.clone(), BookFormat::Folder)
    } else if !metadata.is_file() {
        return Err(unsupported());
    } else if let Some(format) = file_format(&canonical) {
        (canonical.clone(), format)
    } else if is_supported_image_path(&canonical.to_string_lossy()) {
        let parent = canonical.parent().ok_or_else(unsupported)?.to_path_buf();
        (parent, BookFormat::Folder)
    } else {
        return Err(unsupported());
    };
    let name = if format == BookFormat::Folder {
        root.file_name()
    } else {
        root.file_stem()
    };
    let title = name
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| display_path(&root));
    Ok(BookLocation {
        path: root,
        format,
        title,
    })
}

/// 画面に見せるパス。Windows の正規化で付く `\\?\`(UNC は `\\?\UNC\`)を外す。
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(local) = text.strip_prefix(r"\\?\") {
        local.to_string()
    } else {
        text.to_string()
    }
}

/// 登録フォルダの表示名。フォルダ名が無い(ドライブの根など)ときは画面に見せるパス。
pub fn source_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| display_path(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::source::test_images;
    use crate::services::source::zip_archive::test_archives::write_zip;

    fn image_folder(parent: &Path, name: &str) {
        let folder = parent.join(name);
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("001.png"), test_images::png(10, 15)).unwrap();
    }

    /// フォルダへのリンクを作る。シンボリックリンクに権限が要る環境ではジャンクションで代える。
    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return;
        }
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "ジャンクションを作れない");
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn summary(entries: &[DirectoryEntry]) -> Vec<(String, EntryKind, Option<BookFormat>, bool)> {
        entries
            .iter()
            .map(|entry| (entry.name.clone(), entry.kind, entry.format, entry.openable))
            .collect()
    }

    #[test]
    fn library_parallel_classification_fails_instead_of_dropping_a_panicked_part() {
        let items: Vec<usize> = (0..PARALLEL_CLASSIFY_MIN * 2).collect();
        let mut kept = filter_map_parallel(&items, 4, |item| (item % 2 == 0).then_some(*item)).unwrap();
        kept.sort_unstable();
        assert_eq!(kept, (0..PARALLEL_CLASSIFY_MIN * 2).step_by(2).collect::<Vec<_>>());

        let failed = filter_map_parallel(&items, 4, |item| {
            assert!(*item != 5, "分類中の異常終了");
            Some(*item)
        });
        assert!(matches!(failed, Err(AppError::Internal(_))));
    }

    #[test]
    fn library_entries_are_classified_and_ordered_naturally() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        image_folder(root, "第10巻");
        image_folder(root, "第2巻");
        // 画像を直接含まないフォルダは本ではなくフォルダ(サブフォルダの本は数えない)。
        fs::create_dir(root.join("series")).unwrap();
        image_folder(&root.join("series"), "vol1");
        fs::create_dir(root.join("Empty")).unwrap();
        let page = || vec![("1.png", test_images::png(10, 15))];
        write_zip(&root.join("vol10.zip"), &page());
        write_zip(&root.join("vol2.CBZ"), &page());
        write_zip(&root.join("vol1.zip"), &page());
        fs::write(root.join("art.epub"), b"epub").unwrap();
        fs::write(root.join("b.rar"), b"rar").unwrap();
        fs::write(root.join("c.CBR"), b"cbr").unwrap();
        fs::write(root.join("d.pdf"), b"pdf").unwrap();
        // 本として扱わないファイルと、フォルダ直下のばらの画像は載せない。
        fs::write(root.join("notes.txt"), b"x").unwrap();
        fs::write(root.join("cover.png"), test_images::png(10, 15)).unwrap();

        let entries = list_entries(root).unwrap();
        use BookFormat as F;
        use EntryKind::{Book, Folder};
        assert_eq!(
            summary(&entries),
            [
                ("Empty".into(), Folder, None, true),
                ("series".into(), Folder, None, true),
                ("art.epub".into(), Book, Some(F::Epub), true),
                ("b.rar".into(), Book, Some(F::Rar), true),
                ("c.CBR".into(), Book, Some(F::Rar), true),
                ("d.pdf".into(), Book, Some(F::Pdf), true),
                ("vol1.zip".into(), Book, Some(F::Zip), true),
                ("vol2.CBZ".into(), Book, Some(F::Zip), true),
                ("vol10.zip".into(), Book, Some(F::Zip), true),
                ("第2巻".into(), Book, Some(F::Folder), true),
                ("第10巻".into(), Book, Some(F::Folder), true),
            ]
        );
        let titles: Vec<_> = entries.iter().map(|entry| entry.title.as_str()).collect();
        assert_eq!(titles[2], "art");
        assert_eq!(titles[9], "第2巻");
        assert_eq!(PathBuf::from(&entries[6].path), root.join("vol1.zip"));
    }

    #[test]
    fn library_entries_carry_modified_time_and_paths_that_match_book_locations() {
        let base = tempfile::tempdir().unwrap();
        // 一覧は正規化したフォルダを読む(`list_directory` と同じ)。
        let root = fs::canonicalize(base.path()).unwrap();
        image_folder(&root, "画像");
        write_zip(&root.join("vol1.cbz"), &[("1.png", test_images::png(10, 15))]);
        fs::write(root.join("art.epub"), b"epub").unwrap();

        let entries = list_entries(&root).unwrap();
        assert_eq!(entries.len(), 3);
        for entry in &entries {
            let metadata = fs::metadata(&entry.path).unwrap();
            assert_eq!(entry.modified_at, modified_millis(&metadata), "{}", entry.name);
            assert!(entry.modified_at.is_some_and(|time| time > 0));
            // 読書状態は本の行の場所で引くので、一覧の場所は本を開くときの場所と一致しなければならない。
            let location = book_location(Path::new(&entry.path)).unwrap();
            assert_eq!(location.path.to_string_lossy(), entry.path);
        }
    }

    #[test]
    fn library_resolves_subfolders_and_returns_breadcrumb_segments() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("library");
        fs::create_dir_all(root.join("作者").join("シリーズ")).unwrap();

        let (canonical_root, dir) = resolve_within(&root, Path::new("作者/シリーズ")).unwrap();
        assert_eq!(
            dir,
            fs::canonicalize(root.join("作者").join("シリーズ")).unwrap()
        );
        assert_eq!(
            relative_segments(&canonical_root, &dir),
            ["作者", "シリーズ"]
        );

        // 配下で `..` を使っても、行き先が登録フォルダの中なら許す。
        let (_, back) = resolve_within(&root, &root.join("作者").join("..")).unwrap();
        assert_eq!(back, canonical_root);
        assert!(relative_segments(&canonical_root, &back).is_empty());
    }

    #[test]
    fn library_rejects_paths_outside_the_source() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("library");
        let outside = base.path().join("outside");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir(&outside).unwrap();
        image_folder(&outside, "secret");

        let rejects = |target: &Path| match resolve_within(&root, target) {
            Err(AppError::OutsideSource) => {}
            other => panic!("{} を拒否しない: {other:?}", target.display()),
        };
        rejects(Path::new(".."));
        rejects(Path::new("sub/../../outside"));
        rejects(&root.join("..").join("outside"));
        rejects(&outside);
        // 登録フォルダより上のフォルダ(共通の親)も外。
        rejects(base.path());

        // 配下に置いたリンクがフォルダの外を指すなら、たどった先で判定して拒否する。
        link_dir(&outside, &root.join("link"));
        rejects(Path::new("link"));
        rejects(&root.join("link").join("secret"));
        // 一覧にもリンクは載せない。
        let names: Vec<_> = list_entries(&root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["sub"]);

        // 存在しないパスとファイルはフォルダとして開けない。
        let missing = resolve_within(&root, Path::new("missing")).unwrap_err();
        assert_eq!(missing.code(), "not_found");
        fs::write(root.join("a.zip"), b"zip").unwrap();
        assert!(matches!(
            resolve_within(&root, Path::new("a.zip")),
            Err(AppError::Message(_))
        ));
    }

    #[test]
    fn library_source_path_must_be_an_existing_folder() {
        let base = tempfile::tempdir().unwrap();
        let canonical = canonical_source_path(base.path()).unwrap();
        assert_eq!(canonical, fs::canonicalize(base.path()).unwrap());
        fs::write(base.path().join("a.txt"), b"x").unwrap();
        assert!(canonical_source_path(&base.path().join("a.txt")).is_err());
        assert!(canonical_source_path(&base.path().join("missing")).is_err());
    }

    #[test]
    fn library_display_path_drops_the_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\Books")), r"C:\Books");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\nas\share")),
            r"\\nas\share"
        );
        assert_eq!(display_path(Path::new(r"C:\Books")), r"C:\Books");
    }

    #[test]
    fn library_book_location_matches_the_book_that_open_book_records() {
        let dir = tempfile::tempdir().unwrap();
        image_folder(dir.path(), "画集");
        let folder = fs::canonicalize(dir.path().join("画集")).unwrap();
        let zip = dir.path().join("第1巻.cbz");
        write_zip(&zip, &[("1.png", test_images::png(4, 4))]);
        fs::write(dir.path().join("資料.pdf"), b"%PDF").unwrap();
        fs::write(dir.path().join("メモ.txt"), b"text").unwrap();
        fs::create_dir(dir.path().join("空")).unwrap();

        let location = book_location(&folder).unwrap();
        assert_eq!((location.format, location.title.as_str()), (BookFormat::Folder, "画集"));
        // 画像ファイルは親フォルダの本になる(open_book と同じ)。
        let first_image = fs::read_dir(&folder).unwrap().next().unwrap().unwrap().path();
        assert_eq!(book_location(&first_image).unwrap(), location);

        let location = book_location(&zip).unwrap();
        assert_eq!(location.path, fs::canonicalize(&zip).unwrap());
        assert_eq!((location.format, location.title.as_str()), (BookFormat::Zip, "第1巻"));
        assert_eq!(
            book_location(&dir.path().join("資料.pdf")).unwrap().format,
            BookFormat::Pdf
        );

        for path in ["メモ.txt", "空"] {
            let error = book_location(&dir.path().join(path)).unwrap_err();
            assert_eq!(error.code(), "unsupported_format", "{path}");
        }
        assert_eq!(
            book_location(&dir.path().join("無い.cbz")).unwrap_err().code(),
            "not_found"
        );
    }
}
