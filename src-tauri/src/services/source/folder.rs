//! 画像を直接含むフォルダを 1 冊として読むページソース。
//! 直下のファイルだけを対象にし、サブフォルダ・シンボリックリンク・画像以外は無視する。

use std::fs;
use std::path::{Path, PathBuf};

use super::dimensions::read_dimensions;
use super::{is_supported_image_path, natural_cmp, PageSource, MAX_PAGE_BYTES};
use crate::app_error::{AppError, AppResult};
use crate::models::PageInfo;

pub struct FolderSource {
    pages: Vec<PageInfo>,
    files: Vec<PathBuf>,
}

impl FolderSource {
    /// `root` 直下の画像を自然順に並べ、各画像のヘッダから寸法を読む。
    /// ヘッダを読めない(壊れている・拡張子と中身が違う)ファイルは表示できないので除く。
    pub fn open(root: &Path) -> AppResult<Self> {
        let candidates = sorted_candidates(root)?;
        let mut pages = Vec::with_capacity(candidates.len());
        let mut files = Vec::with_capacity(candidates.len());
        for (name, path) in candidates {
            match page_size(&path) {
                Some((width, height)) => {
                    pages.push(PageInfo {
                        name,
                        width,
                        height,
                        spread: None,
                    });
                    files.push(path);
                }
                None => log::warn!("画像の寸法を読めないため除外します: {}", path.display()),
            }
        }

        if pages.is_empty() {
            return Err(AppError::NoPages);
        }
        Ok(Self { pages, files })
    }
}

/// 本の 1 ページ目になる画像(`FolderSource::open` と同じ規則で、寸法を読めない画像は飛ばす)。
/// 画像が 1 枚も無ければ `None`。
pub fn first_page_file(root: &Path) -> AppResult<Option<PathBuf>> {
    Ok(sorted_candidates(root)?
        .into_iter()
        .map(|(_, path)| path)
        .find(|path| page_size(path).is_some()))
}

/// `root` 直下の画像ファイルを自然順に並べる。
/// DirEntry::file_type はリンク先をたどらないので、リンク経由でフォルダの外を読まない。
fn sorted_candidates(root: &Path) -> AppResult<Vec<(String, PathBuf)>> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_supported_image_path(&name) {
            candidates.push((name, entry.path()));
        }
    }
    candidates.sort_by(|(left, _), (right, _)| natural_cmp(left, right));
    Ok(candidates)
}

fn page_size(path: &Path) -> Option<(u32, u32)> {
    fs::File::open(path)
        .ok()
        .and_then(|file| read_dimensions(file, MAX_PAGE_BYTES))
}

impl PageSource for FolderSource {
    fn pages(&self) -> &[PageInfo] {
        &self.pages
    }

    fn read_page(&self, index: usize) -> AppResult<Vec<u8>> {
        let path = self.files.get(index).ok_or(AppError::PageOutOfRange {
            index,
            count: self.files.len(),
        })?;
        if fs::metadata(path)?.len() > MAX_PAGE_BYTES {
            return Err(AppError::PageTooLarge);
        }
        Ok(fs::read(path)?)
    }

    /// ファイルのサイズと更新日時(読んだ時点のもの)。
    fn page_revision(&self, index: usize) -> Option<u64> {
        let metadata = fs::metadata(self.files.get(index)?).ok()?;
        let modified = metadata
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos() as u64;
        Some(modified ^ metadata.len().rotate_left(40))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::source::test_images;

    #[test]
    fn lists_only_direct_images_in_natural_order_with_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("10.JPG"), test_images::jpeg(1600, 1000)).unwrap();
        fs::write(root.join("2.png"), test_images::png(700, 1000)).unwrap();
        fs::write(root.join("1.gif"), test_images::gif(640, 960)).unwrap();
        fs::write(root.join("notes.txt"), b"not a page").unwrap();
        fs::write(root.join("cover.jpg.txt"), test_images::jpeg(1, 1)).unwrap();
        fs::write(root.join("broken.png"), b"not really a png").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("0.png"), test_images::png(10, 10)).unwrap();

        let source = FolderSource::open(root).unwrap();

        let pages: Vec<_> = source
            .pages()
            .iter()
            .map(|page| (page.name.as_str(), page.width, page.height))
            .collect();
        assert_eq!(
            pages,
            vec![
                ("1.gif", 640, 960),
                ("2.png", 700, 1000),
                ("10.JPG", 1600, 1000)
            ]
        );
        assert_eq!(source.read_page(0).unwrap(), test_images::gif(640, 960));
        assert_eq!(source.page_size(2), Some((1600, 1000)));
        assert_eq!(source.page_size(3), None);
    }

    /// 同じ名前・寸法のまま中身だけを差し替えたファイルは、ページの目印が変わる。
    #[test]
    fn page_revision_changes_when_the_file_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("1.png");
        fs::write(&file, test_images::png(10, 20)).unwrap();
        let source = FolderSource::open(dir.path()).unwrap();
        let original = source.page_revision(0).unwrap();
        assert_eq!(source.page_revision(0), Some(original));
        assert_eq!(source.page_revision(1), None);

        let mut replaced = test_images::png(10, 20);
        replaced.extend_from_slice(b"other");
        fs::write(&file, replaced).unwrap();
        assert_ne!(source.page_revision(0), Some(original));
    }

    #[test]
    fn out_of_range_page_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("1.png"), test_images::png(10, 20)).unwrap();
        let source = FolderSource::open(dir.path()).unwrap();

        let error = source.read_page(1).unwrap_err();
        assert_eq!(error.code(), "page_out_of_range");
    }

    #[test]
    fn folder_without_images_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("readme.txt"), b"text").unwrap();

        let error = FolderSource::open(dir.path()).err().unwrap();
        assert_eq!(error.code(), "no_pages");
    }

    #[test]
    fn opening_does_not_modify_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("1.png"), test_images::png(10, 20)).unwrap();
        let before: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();

        let source = FolderSource::open(dir.path()).unwrap();
        source.read_page(0).unwrap();

        let after: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(before, after);
        assert_eq!(
            fs::read(dir.path().join("1.png")).unwrap(),
            test_images::png(10, 20)
        );
    }
}
