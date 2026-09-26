//! ページソース(画像フォルダ・アーカイブ・EPUB など)の置き場。
//! 形式ごとの実装は `PageSource` を満たし、開いた本は `BookCache` にハンドルとして置く。
//! ページの読み出し側(`read_page` 以下)は S-03 の prism スキームが呼ぶまで使われない。
#![allow(dead_code)]

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::app_error::{AppError, AppResult};
use crate::models::{OpenedBook, PageInfo, PageProgression};
use crate::services::store::ItemKind;

pub mod adjacent;
pub mod cache;
pub mod dimensions;
pub mod epub;
pub mod folder;
pub mod pdf;
pub mod rar_archive;
pub mod zip_archive;

pub use adjacent::adjacent_books;
pub use cache::BookCache;

/// 1 冊分のページの読み出し口。開いたままのハンドルとしてキャッシュされるので、
/// 複数スレッドから同時に読まれてもよい形にする。元ファイルは読むだけで変更しない。
pub trait PageSource: Send + Sync {
    /// 表示順に並んだページ一覧(名前・幅・高さ)。
    fn pages(&self) -> &[PageInfo];

    /// `index` 番目のページのバイト列。範囲外は `AppError::PageOutOfRange`。
    fn read_page(&self, index: usize) -> AppResult<Vec<u8>>;

    /// `index` 番目のページを幅 `width` 画素に合わせて読む。大きさを選んで画像化できる形式(PDF)だけが
    /// 大きさを変え、ほかは元の画像(`read_page`)をそのまま返す。
    fn read_page_at_width(&self, index: usize, _width: u32) -> AppResult<Vec<u8>> {
        self.read_page(index)
    }

    /// `index` 番目のページの寸法(幅, 高さ)。範囲外は `None`。
    fn page_size(&self, index: usize) -> Option<(u32, u32)> {
        self.pages()
            .get(index)
            .map(|page| (page.width, page.height))
    }

    /// `index` 番目のページの中身が変わったことを示す目印(中身を読まずに得られるもの)。
    /// 同じ名前・寸法のまま画像が差し替えられても、前の超解像の結果を使わないために使う。
    /// 範囲外・得られないときは `None`。
    fn page_revision(&self, _index: usize) -> Option<u64> {
        None
    }

    /// 本が指定するページを進める向き(EPUB の `page-progression-direction`)。指定が無ければ `None`。
    fn page_progression(&self) -> Option<PageProgression> {
        None
    }
}

/// 拡張子から画像の MIME 型を返す。対応しない拡張子は `None`。
pub fn mime_type_for_path(path: &str) -> Option<&'static str> {
    let (_, extension) = path.rsplit_once('.')?;
    match extension.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// ページとして表示できる画像か(拡張子で判定する。大文字小文字は区別しない)。
pub fn is_supported_image_path(path: &str) -> bool {
    mime_type_for_path(path).is_some()
}

/// 1 ページとして読み込むバイト列の上限。これを超える画像は読まずにエラーにする。
pub const MAX_PAGE_BYTES: u64 = 256 * 1024 * 1024;

/// 自然順の比較(`2.jpg` < `10.jpg`)。数字の並びは数値として、それ以外は大文字小文字を
/// 区別せずに比べる。等しく見えるときは元の文字列で決めて、順序を常に一意にする。
pub fn natural_cmp(left: &str, right: &str) -> Ordering {
    let mut left_chars = left.chars().peekable();
    let mut right_chars = right.chars().peekable();

    loop {
        match (left_chars.peek().copied(), right_chars.peek().copied()) {
            (None, None) => return left.cmp(right),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(l), Some(r)) if l.is_ascii_digit() && r.is_ascii_digit() => {
                let left_digits = take_digits(&mut left_chars);
                let right_digits = take_digits(&mut right_chars);
                let ordering = compare_digit_runs(&left_digits, &right_digits);
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            (Some(l), Some(r)) => {
                let ordering = l.to_lowercase().cmp(r.to_lowercase());
                if ordering != Ordering::Equal {
                    return ordering;
                }
                left_chars.next();
                right_chars.next();
            }
        }
    }
}

fn take_digits(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while let Some(ch) = chars.peek().copied().filter(char::is_ascii_digit) {
        digits.push(ch);
        chars.next();
    }
    digits
}

/// 数字の並びを桁あふれなしに数値として比べる(先頭の 0 は無視し、桁数 → 辞書順)。
fn compare_digit_runs(left: &str, right: &str) -> Ordering {
    let left_trimmed = left.trim_start_matches('0');
    let right_trimmed = right.trim_start_matches('0');
    left_trimmed
        .len()
        .cmp(&right_trimmed.len())
        .then_with(|| left_trimmed.cmp(right_trimmed))
}

/// 本の ID。正規化した絶対パスから決まるので、同じ本を開き直しても同じ値になる。
/// URI に載せるため 16 桁の 16 進(FNV-1a 64bit)にする。
pub fn book_id_for_path(canonical_path: &Path) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let hash = canonical_path
        .to_string_lossy()
        .bytes()
        .fold(OFFSET, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(PRIME)
        });
    format!("{hash:016x}")
}

/// パスが指す本を開く。フォルダはそのまま 1 冊、ZIP/CBZ・EPUB・RAR/CBR・PDF はファイル 1 つを 1 冊、
/// 画像ファイルは親フォルダを 1 冊としてその画像を開始ページにする。
/// 開いた本は `cache` に置き、同じ本はハンドルを差し替える。
pub fn open_book(path: &Path, cache: &BookCache) -> AppResult<OpenedBook> {
    open_source(path, cache).map(|opened| opened.book)
}

/// `open_book` の結果に、本の識別と保存に使う情報を足したもの。
pub struct OpenedSource {
    pub book: OpenedBook,
    /// 本の正規化した絶対パス(画像ファイルから開いたときは親フォルダ)。
    pub root: PathBuf,
    pub kind: ItemKind,
    /// 画像ファイルを指定して開き、`book.start_index` がその画像を指している。
    pub explicit_start: bool,
}

/// `open_book` と同じく本を開き、本の識別と保存に使う情報も返す。
pub fn open_source(path: &Path, cache: &BookCache) -> AppResult<OpenedSource> {
    let canonical = std::fs::canonicalize(path)?;
    let unsupported = || AppError::UnsupportedFormat(canonical.display().to_string());

    let (root, kind, source, start_name): (PathBuf, ItemKind, Arc<dyn PageSource>, Option<String>) =
        if canonical.is_dir() {
            let source = folder::FolderSource::open(&canonical)?;
            (canonical.clone(), ItemKind::Folder, Arc::new(source), None)
        } else if !canonical.is_file() {
            return Err(unsupported());
        } else if is_zip_archive_path(&canonical) {
            let source = zip_archive::ZipSource::open(&canonical)?;
            (canonical.clone(), ItemKind::Zip, Arc::new(source), None)
        } else if has_extension(&canonical, &["epub"]) {
            let source = epub::EpubSource::open(&canonical)?;
            (canonical.clone(), ItemKind::Epub, Arc::new(source), None)
        } else if has_extension(&canonical, rar_archive::RAR_EXTENSIONS) {
            let source = rar_archive::RarSource::open(&canonical)?;
            (canonical.clone(), ItemKind::Rar, Arc::new(source), None)
        } else if has_extension(&canonical, pdf::PDF_EXTENSIONS) {
            let source = pdf::PdfSource::open(&canonical)?;
            (canonical.clone(), ItemKind::Pdf, Arc::new(source), None)
        } else if is_supported_image_path(&canonical.to_string_lossy()) {
            let parent = canonical
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(unsupported)?;
            let name = canonical
                .file_name()
                .map(|name| name.to_string_lossy().to_string());
            let source = folder::FolderSource::open(&parent)?;
            (parent, ItemKind::Folder, Arc::new(source), name)
        } else {
            return Err(unsupported());
        };

    let explicit_start = start_name.is_some();
    let start_index = match start_name {
        None => 0,
        // 指定した画像が表示できずに一覧から外れたときは、別の画像で開かずに失敗させる。
        Some(name) => source
            .pages()
            .iter()
            .position(|page| page.name == name)
            .ok_or_else(unsupported)?,
    };

    let book = OpenedBook {
        book_id: book_id_for_path(&root),
        title: book_title(&root),
        start_index,
        page_progression: source.page_progression(),
        pages: source.pages().to_vec(),
        view_settings: None,
    };
    cache.insert(book.book_id.clone(), source);
    Ok(OpenedSource {
        book,
        root,
        kind,
        explicit_start,
    })
}

/// ビューアを閉じた本を `cache` から外し、外したハンドルを返す。無い本 ID は飛ばす。
/// ハンドルを落とすと(読み出し中の所がほかに無ければ)RAR の一時フォルダなどの後片付けが走る。
pub fn close_books(cache: &BookCache, book_ids: &[String]) -> Vec<Arc<dyn PageSource>> {
    book_ids
        .iter()
        .filter_map(|book_id| cache.remove(book_id))
        .collect()
}

/// 本(フォルダ・ZIP/CBZ・EPUB・RAR/CBR・PDF)を `BookCache` に置かずに開く。サムネイルのように 1 ページだけ読むときに使う。
/// RAR/CBR は 1 冊を丸ごと展開しないよう、1 ページ目だけを持つソースを返す。
/// 画像ファイル単体は本として扱わない(`open_source` と違い親フォルダへ広げない)。
pub fn open_uncached(canonical: &Path) -> AppResult<Box<dyn PageSource>> {
    if canonical.is_dir() {
        Ok(Box::new(folder::FolderSource::open(canonical)?))
    } else if canonical.is_file() && is_zip_archive_path(canonical) {
        Ok(Box::new(zip_archive::ZipSource::open(canonical)?))
    } else if canonical.is_file() && has_extension(canonical, &["epub"]) {
        Ok(Box::new(epub::EpubSource::open(canonical)?))
    } else if canonical.is_file() && has_extension(canonical, rar_archive::RAR_EXTENSIONS) {
        Ok(Box::new(rar_archive::RarSource::open_cover(canonical)?))
    } else if canonical.is_file() && has_extension(canonical, pdf::PDF_EXTENSIONS) {
        Ok(Box::new(pdf::PdfSource::open(canonical)?))
    } else {
        Err(AppError::UnsupportedFormat(canonical.display().to_string()))
    }
}

/// ZIP として読むアーカイブか(拡張子 `.zip`・`.cbz`)。
fn is_zip_archive_path(path: &Path) -> bool {
    has_extension(path, &["zip", "cbz"])
}

/// 拡張子が `extensions` のいずれかか(大文字小文字は区別しない)。
pub(crate) fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|extension| extensions.contains(&extension.as_str()))
}

/// 本の題名。フォルダはフォルダ名、アーカイブは拡張子を除いたファイル名。
fn book_title(root: &Path) -> String {
    let name = if root.is_file() {
        root.file_stem()
    } else {
        root.file_name()
    };
    name.map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| root.display().to_string())
}

#[cfg(test)]
pub(crate) mod test_images {
    //! テスト用の合成画像。寸法の読み取りに必要なヘッダだけを持つ最小のバイト列。

    /// 幅・高さだけが正しい最小の PNG(IHDR まで)。
    pub fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes
    }

    /// 幅・高さだけが正しい最小の AVIF(`ftyp` と、`meta`/`iprp`/`ipco` の中の `ispe`)。画素は持たない。
    pub fn avif(width: u32, height: u32) -> Vec<u8> {
        fn boxed(tag: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(tag);
            bytes.extend_from_slice(body);
            bytes
        }
        let mut ispe = vec![0; 4];
        ispe.extend_from_slice(&width.to_be_bytes());
        ispe.extend_from_slice(&height.to_be_bytes());
        let ipco = boxed(b"ipco", &boxed(b"ispe", &ispe));
        let mut meta = vec![0; 4];
        meta.extend_from_slice(&boxed(b"iprp", &ipco));
        let mut bytes = boxed(b"ftyp", b"avif\0\0\0\0avifmif1");
        bytes.extend_from_slice(&boxed(b"meta", &meta));
        bytes.extend_from_slice(&boxed(b"mdat", &[0; 16]));
        bytes
    }

    /// 幅・高さだけが正しい最小の GIF(論理画面記述子まで)。
    pub fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0]);
        bytes
    }

    /// 幅・高さだけが正しい最小の BMP(BITMAPINFOHEADER まで)。高さが負なら上から下へ並ぶ BMP。
    pub fn bmp(width: i32, height: i32) -> Vec<u8> {
        let mut bytes = b"BM".to_vec();
        bytes.extend_from_slice(&54u32.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(&54u32.to_le_bytes());
        bytes.extend_from_slice(&40u32.to_le_bytes());
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&24u16.to_le_bytes());
        bytes.extend_from_slice(&[0; 24]);
        bytes
    }

    /// 幅・高さだけが正しい最小の JPEG(SOI + SOF0)。
    pub fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08];
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        bytes.extend_from_slice(&[0xff, 0xd9]);
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn natural_order_compares_digit_runs_as_numbers() {
        let mut names = vec![
            "10.jpg",
            "2.jpg",
            "1.jpg",
            "b.png",
            "A.png",
            "page002.png",
            "page10.png",
            "01.jpg",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            vec![
                "01.jpg",
                "1.jpg",
                "2.jpg",
                "10.jpg",
                "A.png",
                "b.png",
                "page002.png",
                "page10.png"
            ]
        );
    }

    #[test]
    fn natural_order_handles_huge_numbers_without_overflow() {
        assert_eq!(
            natural_cmp(
                "99999999999999999999999.jpg",
                "100000000000000000000000.jpg"
            ),
            Ordering::Less
        );
    }

    #[test]
    fn supported_extensions_ignore_case() {
        for name in [
            "a.JPG", "a.jpeg", "a.Png", "a.WEBP", "a.avif", "a.GIF", "a.bmp",
        ] {
            assert!(is_supported_image_path(name), "{name}");
        }
        for name in ["a.txt", "a.jpg.txt", "a.svg", "jpg", "a.tiff"] {
            assert!(!is_supported_image_path(name), "{name}");
        }
    }

    #[test]
    fn opening_a_folder_caches_the_handle_under_a_stable_id() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("2.png"), test_images::png(100, 150)).unwrap();
        fs::write(dir.path().join("10.png"), test_images::png(300, 150)).unwrap();
        let cache = BookCache::new(4);

        let book = open_book(dir.path(), &cache).unwrap();
        let names: Vec<_> = book.pages.iter().map(|page| page.name.as_str()).collect();
        assert_eq!(names, vec!["2.png", "10.png"]);
        assert_eq!((book.pages[1].width, book.pages[1].height), (300, 150));
        assert_eq!(book.start_index, 0);

        let handle = cache
            .get(&book.book_id)
            .expect("開いた本がキャッシュにある");
        assert_eq!(handle.read_page(1).unwrap(), test_images::png(300, 150));
        assert_eq!(handle.page_size(0), Some((100, 150)));

        let reopened = open_book(dir.path(), &cache).unwrap();
        assert_eq!(reopened.book_id, book.book_id);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn opening_a_cbr_caches_the_extracted_book() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vol.CBR");
        rar_archive::test_archives::write_rar(
            &path,
            &[
                ("10.png", test_images::png(30, 40)),
                ("2.png", test_images::png(10, 20)),
            ],
        );
        let cache = BookCache::new(4);

        let opened = open_source(&path, &cache).unwrap();
        assert_eq!(opened.kind, ItemKind::Rar);
        assert_eq!(opened.book.title, "vol");
        let names: Vec<_> = opened.book.pages.iter().map(|page| page.name.as_str()).collect();
        assert_eq!(names, vec!["2.png", "10.png"]);
        let handle = cache.get(&opened.book.book_id).unwrap();
        assert_eq!(handle.read_page(1).unwrap(), test_images::png(30, 40));

        // サムネイル用は 1 ページ目だけを持つ。
        let cover = open_uncached(&fs::canonicalize(&path).unwrap()).unwrap();
        assert_eq!(cover.pages().len(), 1);
        assert_eq!(cover.read_page(0).unwrap(), test_images::png(10, 20));
    }

    #[test]
    fn opening_a_pdf_caches_it_with_its_page_sizes() {
        use pdf::test_pdfs::{page, write_pdf};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("画集.PDF");
        write_pdf(&path, &[page(600, 300), page(200, 300)]);
        let cache = BookCache::new(4);

        let opened = open_source(&path, &cache).unwrap();

        assert_eq!(opened.kind, ItemKind::Pdf);
        assert_eq!(opened.book.title, "画集");
        // 見開きの計算に使う寸法は PDF のページの縦横比のまま。
        let sizes: Vec<_> = opened
            .book
            .pages
            .iter()
            .map(|page| (page.width, page.height))
            .collect();
        assert_eq!(sizes, vec![(2048, 1024), (1365, 2048)]);
        let handle = cache.get(&opened.book.book_id).unwrap();
        let bytes = handle.read_page(1).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (1365, 2048));

        // サムネイル用にも開ける。
        let cover = open_uncached(&fs::canonicalize(&path).unwrap()).unwrap();
        assert_eq!(cover.pages().len(), 2);
    }

    #[test]
    fn opening_an_image_opens_its_folder_at_that_page() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["1.jpg", "2.jpg", "10.jpg"] {
            fs::write(dir.path().join(name), test_images::jpeg(800, 1200)).unwrap();
        }
        let cache = BookCache::new(4);

        let from_image = open_book(&dir.path().join("10.jpg"), &cache).unwrap();
        let from_folder = open_book(dir.path(), &cache).unwrap();

        assert_eq!(from_image.start_index, 2);
        assert_eq!(from_image.pages.len(), 3);
        assert_eq!(from_image.book_id, from_folder.book_id);
    }

    #[test]
    fn opening_an_image_that_cannot_be_shown_fails_instead_of_opening_another() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("1.png"), test_images::png(10, 10)).unwrap();
        fs::write(dir.path().join("2.png"), b"broken header").unwrap();
        let cache = BookCache::new(4);

        let error = open_book(&dir.path().join("2.png"), &cache).unwrap_err();

        assert_eq!(error.code(), "unsupported_format");
        assert!(cache.is_empty());
    }

    #[test]
    fn top_down_bmp_has_its_real_size() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("1.bmp"), test_images::bmp(1, -2)).unwrap();
        let cache = BookCache::new(4);

        let book = open_book(dir.path(), &cache).unwrap();

        assert_eq!((book.pages[0].width, book.pages[0].height), (1, 2));
    }

    #[test]
    fn opening_a_cbz_caches_the_archive_under_a_stable_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("第1巻.CBZ");
        zip_archive::test_archives::write_zip(
            &path,
            &[
                ("vol/2.png", test_images::png(20, 20)),
                ("vol/1.png", test_images::png(10, 10)),
            ],
        );
        let cache = BookCache::new(4);

        let book = open_book(&path, &cache).unwrap();

        assert_eq!(book.title, "第1巻");
        assert_eq!(book.start_index, 0);
        let names: Vec<_> = book.pages.iter().map(|page| page.name.as_str()).collect();
        assert_eq!(names, vec!["vol/1.png", "vol/2.png"]);
        let handle = cache
            .get(&book.book_id)
            .expect("開いた本がキャッシュにある");
        assert_eq!(handle.read_page(1).unwrap(), test_images::png(20, 20));
        assert_eq!(open_book(&path, &cache).unwrap().book_id, book.book_id);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn rejects_missing_paths_and_unsupported_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("notes.txt"), b"text").unwrap();
        let cache = BookCache::new(4);

        let missing = open_book(&dir.path().join("missing"), &cache).unwrap_err();
        assert_eq!(missing.code(), "not_found");
        let unsupported = open_book(&dir.path().join("notes.txt"), &cache).unwrap_err();
        assert_eq!(unsupported.code(), "unsupported_format");
        assert!(cache.is_empty());
    }
}
