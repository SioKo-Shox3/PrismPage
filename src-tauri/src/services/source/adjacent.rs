//! 同じフォルダで自然順に隣り合う、同じ種類の本(前の巻・次の巻)を求める。

use std::fs;
use std::path::{Path, PathBuf};

use std::sync::Arc;

use super::pdf::PDF_EXTENSIONS;
use super::rar_archive::{RarSource, RAR_EXTENSIONS};
use super::{
    book_id_for_path, book_title, has_extension, is_zip_archive_path, natural_cmp, open_source,
    BookCache,
};
use crate::app_error::AppResult;
use crate::models::{AdjacentBook, AdjacentBooks};
use crate::services::store::ItemKind;

/// 前の巻・次の巻を求める。候補は近い順に開いてみて、最初に開けた本を選ぶ。
/// 開けない本(画像の無いフォルダ・文章中心の EPUB など)は飛ばし、候補を使い切るまで探す。
/// 開いた本は `cache` に置かれるので、返した `book_id` で表紙(先頭ページ)を配信できる。
/// RAR/CBR は丸ごと展開せず、表紙だけを展開したソースを置く(その本を開くと丸ごと展開したソースに差し替わる)。
pub fn adjacent_books(root: &Path, kind: ItemKind, cache: &BookCache) -> AppResult<AdjacentBooks> {
    let (before, after) = sibling_books(root, kind)?;
    Ok(AdjacentBooks {
        previous: first_openable(&before, cache),
        next: first_openable(&after, cache),
    })
}

/// `root` と同じフォルダにある同じ種類の本を名前の自然順に並べ、`root` より前の本と後ろの本を
/// それぞれ近い順に返す。フォルダの本はフォルダ、ZIP/CBZ は ZIP/CBZ、EPUB は EPUB、RAR/CBR は RAR/CBR、PDF は PDF だけを数える。
/// シンボリックリンク(`DirEntry::file_type` はリンク先をたどらない)は数えない。
pub fn sibling_books(root: &Path, kind: ItemKind) -> AppResult<(Vec<PathBuf>, Vec<PathBuf>)> {
    let (Some(parent), Some(own)) = (root.parent(), root.file_name()) else {
        return Ok((Vec::new(), Vec::new()));
    };
    let own = own.to_string_lossy().to_string();

    let mut siblings = Vec::new();
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        let same_kind = match kind {
            ItemKind::Folder => file_type.is_dir(),
            ItemKind::Zip => file_type.is_file() && is_zip_archive_path(&path),
            ItemKind::Epub => file_type.is_file() && has_extension(&path, &["epub"]),
            ItemKind::Rar => file_type.is_file() && has_extension(&path, RAR_EXTENSIONS),
            ItemKind::Pdf => file_type.is_file() && has_extension(&path, PDF_EXTENSIONS),
        };
        if same_kind {
            siblings.push((entry.file_name().to_string_lossy().to_string(), path));
        }
    }
    siblings.sort_by(|(left, _), (right, _)| natural_cmp(left, right));

    let Some(position) = siblings.iter().position(|(name, _)| *name == own) else {
        return Ok((Vec::new(), Vec::new()));
    };
    let after = siblings.split_off(position + 1);
    siblings.pop();
    Ok((
        siblings.into_iter().rev().map(|(_, path)| path).collect(),
        after.into_iter().map(|(_, path)| path).collect(),
    ))
}

fn first_openable(candidates: &[PathBuf], cache: &BookCache) -> Option<AdjacentBook> {
    candidates
        .iter()
        .find_map(|path| {
            if has_extension(path, RAR_EXTENSIONS) {
                return open_rar_cover(path, cache).ok();
            }
            let opened = open_source(path, cache).ok()?;
            Some(AdjacentBook {
                book_id: opened.book.book_id,
                title: opened.book.title,
                path: opened.root.to_string_lossy().to_string(),
            })
        })
}

/// RAR/CBR の表紙だけを展開して `cache` に置く。
fn open_rar_cover(path: &Path, cache: &BookCache) -> AppResult<AdjacentBook> {
    let canonical = fs::canonicalize(path)?;
    let source = RarSource::open_cover(&canonical)?;
    let book_id = book_id_for_path(&canonical);
    cache.insert(book_id.clone(), Arc::new(source));
    Ok(AdjacentBook {
        book_id,
        title: book_title(&canonical),
        path: canonical.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::source::test_images;
    use crate::services::source::rar_archive::test_archives::write_rar;
    use crate::services::source::zip_archive::test_archives::write_zip;

    fn image_folder(parent: &Path, name: &str) -> PathBuf {
        let folder = parent.join(name);
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("1.png"), test_images::png(10, 15)).unwrap();
        folder
    }

    fn names(paths: &[PathBuf]) -> Vec<String> {
        paths
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn folder_books_are_ordered_naturally_and_only_folders_count() {
        let shelf = tempfile::tempdir().unwrap();
        for name in ["第10巻", "第2巻", "第1巻", "第3巻"] {
            image_folder(shelf.path(), name);
        }
        write_zip(
            &shelf.path().join("第2巻.5.zip"),
            &[("1.png", test_images::png(10, 15))],
        );
        fs::write(shelf.path().join("第2巻.png"), test_images::png(10, 15)).unwrap();
        let root = fs::canonicalize(shelf.path().join("第2巻")).unwrap();

        let (before, after) = sibling_books(&root, ItemKind::Folder).unwrap();
        assert_eq!(names(&before), ["第1巻"]);
        assert_eq!(names(&after), ["第3巻", "第10巻"]);

        let last = fs::canonicalize(shelf.path().join("第10巻")).unwrap();
        let (before, after) = sibling_books(&last, ItemKind::Folder).unwrap();
        assert_eq!(names(&before), ["第3巻", "第2巻", "第1巻"]);
        assert!(after.is_empty());
    }

    /// RAR の隣の巻は表紙だけを展開してキャッシュに置き、その ID で表紙を読める。
    #[test]
    fn rar_neighbors_are_found_and_their_covers_are_cached() {
        let shelf = tempfile::tempdir().unwrap();
        let page = |size| vec![("1.png", test_images::png(size, size))];
        write_rar(&shelf.path().join("vol1.rar"), &page(11));
        write_rar(&shelf.path().join("vol2.cbr"), &page(12));
        // 画像の無いアーカイブは開けないので飛ばす。
        write_rar(&shelf.path().join("vol3.rar"), &[("a.txt", b"x".to_vec())]);
        write_rar(&shelf.path().join("vol4.CBR"), &page(14));
        write_zip(&shelf.path().join("vol2a.zip"), &page(20));
        let cache = BookCache::new(8);
        let root = fs::canonicalize(shelf.path().join("vol2.cbr")).unwrap();

        let adjacent = adjacent_books(&root, ItemKind::Rar, &cache).unwrap();
        let previous = adjacent.previous.unwrap();
        let next = adjacent.next.unwrap();
        assert_eq!((previous.title.as_str(), next.title.as_str()), ("vol1", "vol4"));
        let cover = cache.get(&next.book_id).unwrap();
        assert_eq!(cover.read_page(0).unwrap(), test_images::png(14, 14));
    }

    #[test]
    fn archive_books_skip_other_kinds_and_unopenable_neighbors() {
        let shelf = tempfile::tempdir().unwrap();
        let page = || vec![("1.png", test_images::png(10, 15))];
        write_zip(&shelf.path().join("vol1.cbz"), &page());
        write_zip(&shelf.path().join("vol2.zip"), &page());
        // 画像の無いアーカイブは開けないので飛ばす。
        write_zip(
            &shelf.path().join("vol3.zip"),
            &[("readme.txt", b"x".to_vec())],
        );
        write_zip(&shelf.path().join("vol4.ZIP"), &page());
        // 種類の違う本・フォルダは ZIP の隣に数えない。
        fs::write(shelf.path().join("vol3.epub"), b"not an archive").unwrap();
        image_folder(shelf.path(), "vol2a");
        let cache = BookCache::new(8);
        let root = fs::canonicalize(shelf.path().join("vol2.zip")).unwrap();

        let adjacent = adjacent_books(&root, ItemKind::Zip, &cache).unwrap();
        let previous = adjacent.previous.unwrap();
        let next = adjacent.next.unwrap();
        assert_eq!(previous.title, "vol1");
        assert_eq!(next.title, "vol4");
        assert_eq!(
            PathBuf::from(&next.path),
            fs::canonicalize(shelf.path().join("vol4.ZIP")).unwrap()
        );
        // 表紙を配信できるよう、選んだ本はキャッシュに置かれている。
        assert!(cache.get(&next.book_id).is_some());
        assert!(cache.get(&previous.book_id).is_some());
    }

    #[test]
    fn neighbors_are_found_past_many_unopenable_candidates() {
        let shelf = tempfile::tempdir().unwrap();
        image_folder(shelf.path(), "01");
        for index in 2..=9 {
            fs::create_dir(shelf.path().join(format!("{index:02}"))).unwrap();
        }
        image_folder(shelf.path(), "10");
        let cache = BookCache::new(4);

        let first = fs::canonicalize(shelf.path().join("01")).unwrap();
        let adjacent = adjacent_books(&first, ItemKind::Folder, &cache).unwrap();
        assert!(adjacent.previous.is_none());
        assert_eq!(adjacent.next.unwrap().title, "10");

        let last = fs::canonicalize(shelf.path().join("10")).unwrap();
        let adjacent = adjacent_books(&last, ItemKind::Folder, &cache).unwrap();
        assert_eq!(adjacent.previous.unwrap().title, "01");
        assert!(adjacent.next.is_none());
    }

    #[test]
    fn first_and_only_books_have_no_neighbors() {
        let shelf = tempfile::tempdir().unwrap();
        let only = image_folder(shelf.path(), "only");
        let root = fs::canonicalize(&only).unwrap();
        let adjacent = adjacent_books(&root, ItemKind::Folder, &BookCache::new(4)).unwrap();
        assert!(adjacent.previous.is_none() && adjacent.next.is_none());
    }
}
