//! 本の表紙サムネイル。本の 1 ページ目を長辺 `THUMB_LONG_EDGE` px に縮めた JPEG を作り、
//! アプリのデータ領域の `thumbs/` にキャッシュする。元のファイルは読むだけで変更しない。
//!
//! キャッシュのファイル名は `<サムネイル ID>-<元の状態の印>.jpg`。印は元ファイルの更新日時・サイズ
//! (画像フォルダはフォルダと先頭の画像の両方)と `FORMAT_VERSION` から作るので、元が変わると名前が合わなくなり
//! 作り直す。作り直したときは同じ ID の古いファイルを消す。形式を変えるときは `FORMAT_VERSION` を上げる
//! (旧版のファイルは名前が合わないので使われず、その本のサムネイルを作り直すときに消える)。
//!
//! 生成(展開と縮小)は重いので、`Thumbs` が同時に走る数を制限する。
//!
//! `image` で復号できない形式(AVIF)の表紙は縮めずに、1 ページ目の元のバイト列をページ配信と同じ
//! Content-Type で返す(WebView が復号し、フロントが表紙の枠に合わせて縮める)。これはキャッシュに書かない。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, RgbImage};

use crate::app_error::{AppError, AppResult};
use crate::services::source::folder::first_page_file;
use crate::services::source::{mime_type_for_path, open_uncached};

/// サムネイルの長辺(px)。これより小さいページは拡大しない。
pub const THUMB_LONG_EDGE: u32 = 320;
/// キャッシュの形式の版。縮小の方法・大きさ・符号化を変えたら上げる。
const FORMAT_VERSION: u32 = 1;
const JPEG_QUALITY: u8 = 85;
/// 縮めたサムネイルの Content-Type。
pub const THUMB_CONTENT_TYPE: &str = "image/jpeg";
/// サムネイル ID の長さ(`book_id_for_path` と同じ 16 桁の 16 進)。
pub const THUMB_ID_LEN: usize = 16;

/// サムネイルの要求を受ける口。一覧に載せた本の ID と場所の対応と、生成の同時実行数の制限を持つ。
/// 場所は `list_directory` が登録フォルダの配下と確かめた本だけを登録するので、
/// `prism` スキームから任意のパスを読ませることはない。
pub struct Thumbs {
    targets: Mutex<HashMap<String, PathBuf>>,
    limiter: Limiter,
}

impl Thumbs {
    pub fn new(max_parallel: usize) -> Self {
        Self {
            targets: Mutex::new(HashMap::new()),
            limiter: Limiter::new(max_parallel),
        }
    }

    /// 一覧に載せた本を登録する。同じ ID は場所を差し替える。
    pub fn register(&self, thumb_id: String, path: PathBuf) {
        self.lock_targets().insert(thumb_id, path);
    }

    /// 登録済みの本の場所。
    pub fn target(&self, thumb_id: &str) -> Option<PathBuf> {
        self.lock_targets().get(thumb_id).cloned()
    }

    /// 表紙。キャッシュが元の状態と合えばそれを返し、合わなければ作ってキャッシュする。
    pub fn get_or_create(&self, cache_dir: &Path, thumb_id: &str, book: &Path) -> AppResult<Cover> {
        get_or_create(cache_dir, thumb_id, book, &self.limiter)
    }

    fn lock_targets(&self) -> MutexGuard<'_, HashMap<String, PathBuf>> {
        self.targets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 表紙として返すもの。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cover {
    /// 長辺 `THUMB_LONG_EDGE` px に縮めた JPEG。
    Thumbnail(Vec<u8>),
    /// `image` で復号できない形式の 1 ページ目の元のバイト列と、ページ配信と同じ Content-Type。
    Original {
        bytes: Vec<u8>,
        content_type: &'static str,
    },
}

impl Cover {
    pub fn content_type(&self) -> &'static str {
        match self {
            Cover::Thumbnail(_) => THUMB_CONTENT_TYPE,
            Cover::Original { content_type, .. } => content_type,
        }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            Cover::Thumbnail(bytes) | Cover::Original { bytes, .. } => bytes,
        }
    }
}

/// キャッシュを見て、無ければ `limiter` の枠の中で作る。
fn get_or_create(
    cache_dir: &Path,
    thumb_id: &str,
    book: &Path,
    limiter: &Limiter,
) -> AppResult<Cover> {
    if !is_thumb_id(thumb_id) {
        return Err(AppError::Message(format!(
            "サムネイルの ID が不正です: {thumb_id}"
        )));
    }
    let file = cache_dir.join(cache_file_name(thumb_id, &source_stamp(book)?));
    if let Some(bytes) = read_cached(&file) {
        return Ok(Cover::Thumbnail(bytes));
    }
    let _permit = limiter.acquire();
    // 待っている間に同じ本のサムネイルが作られていれば、それを使う。
    if let Some(bytes) = read_cached(&file) {
        return Ok(Cover::Thumbnail(bytes));
    }
    let cover = render(book)?;
    // 元のバイト列は元の本から毎回読むので、キャッシュに写さない。
    let Cover::Thumbnail(bytes) = &cover else {
        return Ok(cover);
    };
    fs::create_dir_all(cache_dir)?;
    if let Err(error) = write_atomically(cache_dir, &file, bytes) {
        // キャッシュに書けなくても、作ったサムネイルは返す(次の要求でまた作る)。
        log::warn!("サムネイルを保存できません({}): {error}", file.display());
        return Ok(cover);
    }
    remove_stale(cache_dir, thumb_id, &file);
    Ok(cover)
}

fn is_thumb_id(value: &str) -> bool {
    value.len() == THUMB_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn cache_file_name(thumb_id: &str, stamp: &str) -> String {
    format!("{thumb_id}-{stamp}.jpg")
}

/// 空のファイルは書きかけの残りとみなし、無いものとして扱う。
fn read_cached(file: &Path) -> Option<Vec<u8>> {
    fs::read(file).ok().filter(|bytes| !bytes.is_empty())
}

/// 元の状態の印(16 桁の 16 進)。更新日時・サイズ・キャッシュの形式の版から作る。
/// 画像フォルダはフォルダ自体(画像の追加・削除・改名で変わる)と、表紙にする画像(上書きで変わる)の両方を見る。
/// 表紙にする画像は本を開くときと同じ規則で選ぶ(寸法を読めない画像は飛ばす)。
pub fn source_stamp(book: &Path) -> AppResult<String> {
    let mut hasher = Fnv::new();
    hasher.write(&FORMAT_VERSION.to_le_bytes());
    hasher.write(&THUMB_LONG_EDGE.to_le_bytes());
    let metadata = fs::metadata(book)?;
    write_metadata(&mut hasher, &metadata);
    if metadata.is_dir() {
        if let Some(first) = first_page_file(book)? {
            hasher.write(first.to_string_lossy().as_bytes());
            write_metadata(&mut hasher, &fs::metadata(&first)?);
        }
    }
    Ok(format!("{:016x}", hasher.finish()))
}

fn write_metadata(hasher: &mut Fnv, metadata: &fs::Metadata) {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    hasher.write(&modified.to_le_bytes());
    hasher.write(&metadata.len().to_le_bytes());
}

/// 本を開いて 1 ページ目を縮め、JPEG にする。`image` で復号できない形式なら元のバイト列を返す
/// (1 ページの上限 `MAX_PAGE_BYTES` は `read_page` が守る)。
pub fn render(book: &Path) -> AppResult<Cover> {
    let source = open_uncached(book)?;
    let Some(first) = source.pages().first() else {
        return Err(AppError::NoPages);
    };
    let bytes = source.read_page(0)?;
    match image::load_from_memory(&bytes) {
        Ok(image) => Ok(Cover::Thumbnail(encode_jpeg(&flatten(&shrink(image)))?)),
        Err(error) => match undecodable_content_type(&bytes, &first.name) {
            Some(content_type) => Ok(Cover::Original {
                bytes,
                content_type,
            }),
            None => Err(AppError::Message(format!(
                "表紙の画像を読み込めません: {error}"
            ))),
        },
    }
}

/// 中身が `image` の読めない形式で、ページ配信の Content-Type(拡張子から決まる)がその形式と一致するときの
/// Content-Type。壊れた JPEG・PNG などは `None`(元のまま返しても WebView でも読めない)。
fn undecodable_content_type(bytes: &[u8], page_name: &str) -> Option<&'static str> {
    // `image::guess_format` は主要ブランドが `avif` の AVIF しか見分けないので、互換ブランドも先に見る。
    let format = if has_avif_brand(bytes) {
        image::ImageFormat::Avif
    } else {
        image::guess_format(bytes).ok()?
    };
    if format.reading_enabled() {
        return None;
    }
    mime_type_for_path(page_name).filter(|content_type| *content_type == format.to_mime_type())
}

/// 先頭の `ftyp` ボックスの主要ブランドか互換ブランドに `avif` があるか。ボックスの大きさはデータの内側に
/// 収まるときだけ信じる(64 ビットの大きさ・4 の倍数でない大きさは AVIF と見なさない)。
fn has_avif_brand(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if size < 16 || size > bytes.len() || size % 4 != 0 {
        return false;
    }
    let major = &bytes[8..12];
    major == b"avif" || bytes[16..size].chunks_exact(4).any(|brand| brand == b"avif")
}

/// 長辺が `THUMB_LONG_EDGE` を超えるときだけ、縦横比を保って縮める。
fn shrink(image: DynamicImage) -> DynamicImage {
    let (width, height) = image.dimensions();
    let long_edge = width.max(height);
    if long_edge <= THUMB_LONG_EDGE {
        return image;
    }
    let scale = |edge: u32| {
        ((u64::from(edge) * u64::from(THUMB_LONG_EDGE) + u64::from(long_edge) / 2)
            / u64::from(long_edge))
        .max(1) as u32
    };
    image.resize_exact(
        scale(width),
        scale(height),
        image::imageops::FilterType::Triangle,
    )
}

/// JPEG は透明を持てないので、透明な部分は白の上に重ねる。
fn flatten(image: &DynamicImage) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());
    for (source, target) in rgba.pixels().zip(rgb.pixels_mut()) {
        let [r, g, b, a] = source.0;
        let blend = |channel: u8| {
            ((u16::from(channel) * u16::from(a) + 255 * (255 - u16::from(a)) + 127) / 255) as u8
        };
        target.0 = [blend(r), blend(g), blend(b)];
    }
    rgb
}

fn encode_jpeg(image: &RgbImage) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY)
        .encode_image(image)
        .map_err(|error| AppError::Internal(format!("サムネイルを符号化できません: {error}")))?;
    Ok(bytes)
}

/// 一時ファイルに書いてから置き換える。途中で失敗しても書きかけのファイルは残らない
/// (一時ファイルは `NamedTempFile` が消す)。
fn write_atomically(dir: &Path, file: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(file).map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

/// 同じ ID の、`keep` 以外のキャッシュファイル(元の状態が古いもの・旧版のもの)を消す。
fn remove_stale(dir: &Path, thumb_id: &str, keep: &Path) {
    let prefix = format!("{thumb_id}-");
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path != keep && name.starts_with(&prefix) && name.ends_with(".jpg") {
            if let Err(error) = fs::remove_file(&path) {
                log::warn!("古いサムネイルを消せません({}): {error}", path.display());
            }
        }
    }
}

/// 同時に走る数を `max` までに抑える計数セマフォ。
struct Limiter {
    max: usize,
    running: Mutex<usize>,
    released: Condvar,
}

impl Limiter {
    fn new(max: usize) -> Self {
        Self {
            max: max.max(1),
            running: Mutex::new(0),
            released: Condvar::new(),
        }
    }

    /// 枠が空くまで待って 1 つ取る。返り値を落とすと枠を返す。
    fn acquire(&self) -> Permit<'_> {
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while *running >= self.max {
            running = self
                .released
                .wait(running)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *running += 1;
        Permit(self)
    }
}

struct Permit<'a>(&'a Limiter);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut running = self
            .0
            .running
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *running -= 1;
        self.0.released.notify_one();
    }
}

/// FNV-1a 64bit(`book_id_for_path` と同じ)。
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = (self.0 ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use image::{ImageFormat, Rgba, RgbaImage};

    use super::*;

    const ID: &str = "0123456789abcdef";

    fn png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let image = RgbaImage::from_pixel(width, height, Rgba(color));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn decode(bytes: &[u8]) -> DynamicImage {
        image::load_from_memory_with_format(bytes, ImageFormat::Jpeg).unwrap()
    }

    fn center(image: &DynamicImage) -> [u8; 3] {
        let pixel = image.to_rgb8().get_pixel(image.width() / 2, image.height() / 2).0;
        pixel
    }

    fn assert_near(actual: [u8; 3], expected: [u8; 3]) {
        for (a, e) in actual.iter().zip(expected) {
            assert!(a.abs_diff(e) <= 8, "{actual:?} != {expected:?}");
        }
    }

    fn cache_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn set_modified(path: &Path, time: SystemTime) {
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }

    /// 1 ページ目(自然順)が赤の縦長、2 ページ目が青の画像フォルダ。
    fn folder_book() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("book");
        fs::create_dir(&book).unwrap();
        fs::write(book.join("10.png"), png(40, 40, [0, 0, 255, 255])).unwrap();
        fs::write(book.join("2.png"), png(640, 1280, [255, 0, 0, 255])).unwrap();
        (dir, fs::canonicalize(book).unwrap())
    }

    #[test]
    fn thumbs_are_made_from_the_first_page_with_a_320px_long_edge() {
        let (_dir, book) = folder_book();

        let thumb = decode(&render(&book).unwrap().into_bytes());

        assert_eq!((thumb.width(), thumb.height()), (160, 320));
        assert_near(center(&thumb), [255, 0, 0]);
    }

    #[test]
    fn thumbs_keep_the_aspect_of_landscape_pages() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("1.png"), png(1000, 300, [0, 128, 0, 255])).unwrap();

        let thumb = decode(&render(dir.path()).unwrap().into_bytes());

        assert_eq!((thumb.width(), thumb.height()), (320, 96));
    }

    #[test]
    fn thumbs_do_not_enlarge_small_pages_and_flatten_transparency_on_white() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("1.png"), png(100, 50, [0, 0, 0, 0])).unwrap();

        let thumb = decode(&render(dir.path()).unwrap().into_bytes());

        assert_eq!((thumb.width(), thumb.height()), (100, 50));
        assert_near(center(&thumb), [255, 255, 255]);
    }

    #[test]
    fn thumbs_are_made_from_zip_books() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.cbz");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("b.png", options).unwrap();
        writer.write_all(&png(20, 20, [0, 0, 255, 255])).unwrap();
        writer.start_file("a.png", options).unwrap();
        writer.write_all(&png(400, 800, [255, 0, 0, 255])).unwrap();
        writer.finish().unwrap();

        let thumb = decode(&render(&path).unwrap().into_bytes());

        assert_eq!((thumb.width(), thumb.height()), (160, 320));
        assert_near(center(&thumb), [255, 0, 0]);
    }

    fn jpeg(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
        let image = RgbImage::from_pixel(width, height, image::Rgb(color));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Jpeg).unwrap();
        bytes.into_inner()
    }

    fn cbz(path: &Path, name: &str, bytes: &[u8]) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap();
    }

    #[test]
    fn thumbs_of_jpeg_and_png_first_pages_are_shrunk_jpegs_in_the_cache() {
        for (name, bytes) in [
            ("1.jpg", jpeg(400, 800, [255, 0, 0])),
            ("1.png", png(400, 800, [255, 0, 0, 255])),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let book = dir.path().join("book");
            fs::create_dir(&book).unwrap();
            fs::write(book.join(name), &bytes).unwrap();
            let cache = dir.path().join("thumbs");

            let cover = get_or_create(&cache, ID, &book, &Limiter::new(1)).unwrap();

            assert_eq!(cover.content_type(), "image/jpeg", "{name}");
            assert!(matches!(cover, Cover::Thumbnail(_)), "{name}");
            let thumb = decode(&cover.into_bytes());
            assert_eq!((thumb.width(), thumb.height()), (160, 320), "{name}");
            assert_eq!(cache_files(&cache).len(), 1, "{name}");
        }
    }

    #[test]
    fn thumbs_of_avif_first_pages_are_the_original_bytes_and_not_cached() {
        let avif = crate::services::source::test_images::avif(1200, 1800);
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("1.avif"), &avif).unwrap();
        fs::write(folder.join("2.png"), png(8, 8, [0, 0, 255, 255])).unwrap();
        let zip = dir.path().join("book.cbz");
        cbz(&zip, "001.avif", &avif);
        let epub = dir.path().join("book.epub");
        crate::services::source::zip_archive::test_archives::write_zip(
            &epub,
            &[
                ("mimetype", b"application/epub+zip".to_vec()),
                (
                    "META-INF/container.xml",
                    br#"<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>"#.to_vec(),
                ),
                (
                    "OPS/book.opf",
                    br#"<package><manifest><item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="p1"/></spine></package>"#.to_vec(),
                ),
                (
                    "OPS/p1.xhtml",
                    br#"<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="cover.avif"/></body></html>"#.to_vec(),
                ),
                ("OPS/cover.avif", avif.clone()),
            ],
        );
        let cache = dir.path().join("thumbs");

        for book in [folder, zip, epub] {
            let cover = get_or_create(&cache, ID, &book, &Limiter::new(1)).unwrap();

            assert_eq!(cover.content_type(), "image/avif", "{}", book.display());
            assert_eq!(cover.into_bytes(), avif, "{}", book.display());
        }
        assert!(cache_files(&cache).is_empty());
    }

    #[test]
    fn thumbs_of_avif_with_avif_only_in_compatible_brands_are_the_original_bytes() {
        // 主要ブランドが mif1 で互換ブランドに avif を持つ AVIF も、元のバイト列を image/avif で返す。
        let mut avif = crate::services::source::test_images::avif(1200, 1800);
        assert_eq!(&avif[8..24], b"avif\0\0\0\0avifmif1");
        avif[8..24].copy_from_slice(b"mif1\0\0\0\0mif1avif");
        assert!(image::guess_format(&avif).is_err());
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("1.avif"), &avif).unwrap();
        let cache = dir.path().join("thumbs");

        let cover = get_or_create(&cache, ID, &folder, &Limiter::new(1)).unwrap();

        assert_eq!(cover.content_type(), "image/avif");
        assert_eq!(cover.into_bytes(), avif);
        assert!(cache_files(&cache).is_empty());
    }

    #[test]
    fn thumbs_avif_brand_check_stays_inside_the_ftyp_box() {
        // 互換ブランドの avif が ftyp の大きさの外にあるとき・大きさがデータを超えるときは AVIF と見なさない。
        let mut outside = 16u32.to_be_bytes().to_vec();
        outside.extend_from_slice(b"ftypmif1\0\0\0\0avif");
        assert!(!has_avif_brand(&outside));
        let mut too_long = 64u32.to_be_bytes().to_vec();
        too_long.extend_from_slice(b"ftypmif1\0\0\0\0avif");
        assert!(!has_avif_brand(&too_long));
        let mut inside = 20u32.to_be_bytes().to_vec();
        inside.extend_from_slice(b"ftypmif1\0\0\0\0avif");
        assert!(has_avif_brand(&inside));
    }

    #[test]
    fn thumbs_of_broken_images_named_avif_still_fail() {
        // AVIF の拡張子でも中身が PNG なら、壊れた PNG として失敗する(元のまま返さない)。
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("1.avif"),
            crate::services::source::test_images::png(10, 10),
        )
        .unwrap();

        assert!(render(dir.path()).is_err());
    }

    #[test]
    fn thumbs_fail_for_books_without_decodable_pages() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("1.png"),
            crate::services::source::test_images::png(10, 10),
        )
        .unwrap();

        assert!(render(dir.path()).is_err());
        let empty = tempfile::tempdir().unwrap();
        assert!(render(empty.path()).is_err());
    }

    #[test]
    fn thumbs_are_cached_and_reused_while_the_source_is_unchanged() {
        let (dir, book) = folder_book();
        let cache = dir.path().join("thumbs");
        let limiter = Limiter::new(2);

        let first = get_or_create(&cache, ID, &book, &limiter).unwrap().into_bytes();
        let files = cache_files(&cache);
        assert_eq!(files.len(), 1);
        assert!(files[0].starts_with(&format!("{ID}-")) && files[0].ends_with(".jpg"));
        assert_eq!(fs::read(cache.join(&files[0])).unwrap(), first);

        // キャッシュの中身を差し替えると、それがそのまま返る(作り直していない)。
        fs::write(cache.join(&files[0]), b"cached").unwrap();
        assert_eq!(get_or_create(&cache, ID, &book, &limiter).unwrap().into_bytes(), b"cached");
    }

    #[test]
    fn thumbs_are_remade_when_the_first_page_changes_size() {
        let (dir, book) = folder_book();
        let cache = dir.path().join("thumbs");
        let limiter = Limiter::new(2);
        get_or_create(&cache, ID, &book, &limiter).unwrap();
        let before = cache_files(&cache);
        fs::write(cache.join(&before[0]), b"cached").unwrap();

        fs::write(book.join("2.png"), png(800, 400, [0, 255, 0, 255])).unwrap();
        let thumb = decode(&get_or_create(&cache, ID, &book, &limiter).unwrap().into_bytes());

        assert_eq!((thumb.width(), thumb.height()), (320, 160));
        assert_near(center(&thumb), [0, 255, 0]);
        let after = cache_files(&cache);
        assert_eq!(after.len(), 1, "古いキャッシュが残っている: {after:?}");
        assert_ne!(after, before);
    }

    #[test]
    fn thumbs_are_remade_when_only_the_modified_time_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.zip");
        let write_zip = |color: [u8; 4]| {
            let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
            writer
                .start_file("1.png", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored))
                .unwrap();
            writer.write_all(&png(8, 8, color)).unwrap();
            writer.finish().unwrap();
        };
        write_zip([255, 0, 0, 255]);
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        set_modified(&path, base);
        let cache = dir.path().join("thumbs");
        let limiter = Limiter::new(1);
        get_or_create(&cache, ID, &path, &limiter).unwrap();
        let before = cache_files(&cache);
        fs::write(cache.join(&before[0]), b"cached").unwrap();
        let stamp = source_stamp(&path).unwrap();

        // 同じ大きさの別の中身に置き換え、更新日時だけを変える。
        let size = fs::metadata(&path).unwrap().len();
        write_zip([0, 0, 255, 255]);
        assert_eq!(fs::metadata(&path).unwrap().len(), size);
        set_modified(&path, base + Duration::from_secs(60));

        assert_ne!(source_stamp(&path).unwrap(), stamp);
        let thumb = decode(&get_or_create(&cache, ID, &path, &limiter).unwrap().into_bytes());
        assert_near(center(&thumb), [0, 0, 255]);
        assert_eq!(cache_files(&cache).len(), 1);
    }

    #[test]
    fn thumbs_are_remade_when_the_cover_after_a_broken_first_file_is_overwritten() {
        // 自然順の先頭が壊れた画像なら、表紙は 2 枚目。その 2 枚目の上書きを見逃さない。
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("book");
        fs::create_dir(&book).unwrap();
        fs::write(book.join("1.png"), b"not really a png").unwrap();
        fs::write(book.join("2.png"), png(8, 8, [255, 0, 0, 255])).unwrap();
        let book = fs::canonicalize(book).unwrap();
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        set_modified(&book.join("2.png"), base);
        let cache = dir.path().join("thumbs");
        let limiter = Limiter::new(1);
        assert_near(
            center(&decode(&get_or_create(&cache, ID, &book, &limiter).unwrap().into_bytes())),
            [255, 0, 0],
        );

        // 同じ名前・同じ大きさで中身だけ上書きする(フォルダの項目は変わらない)。
        fs::write(book.join("2.png"), png(8, 8, [0, 0, 255, 255])).unwrap();
        set_modified(&book.join("2.png"), base + Duration::from_secs(60));

        assert_near(
            center(&decode(&get_or_create(&cache, ID, &book, &limiter).unwrap().into_bytes())),
            [0, 0, 255],
        );
    }

    #[test]
    fn thumbs_stamp_is_stable_and_tracks_the_folder_contents() {
        let (_dir, book) = folder_book();
        let stamp = source_stamp(&book).unwrap();
        assert_eq!(source_stamp(&book).unwrap(), stamp);

        // 先頭より前に来る画像が増えると、先頭が変わる。
        fs::write(book.join("1.png"), png(10, 10, [0, 0, 0, 255])).unwrap();
        assert_ne!(source_stamp(&book).unwrap(), stamp);
    }

    #[test]
    fn thumbs_ignore_empty_leftover_cache_files() {
        let (dir, book) = folder_book();
        let cache = dir.path().join("thumbs");
        fs::create_dir(&cache).unwrap();
        let file = cache.join(cache_file_name(ID, &source_stamp(&book).unwrap()));
        fs::write(&file, b"").unwrap();

        let bytes = get_or_create(&cache, ID, &book, &Limiter::new(1)).unwrap().into_bytes();

        assert!(!bytes.is_empty());
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }

    #[test]
    fn thumbs_reject_malformed_ids_without_touching_the_cache() {
        let (dir, book) = folder_book();
        let cache = dir.path().join("thumbs");
        for id in ["", "../../x", "0123456789ABCDEF", "0123456789abcdef0"] {
            assert!(get_or_create(&cache, id, &book, &Limiter::new(1)).is_err(), "{id:?}");
        }
        assert!(!cache.exists());
    }

    #[test]
    fn thumbs_do_not_modify_the_book() {
        let (_dir, book) = folder_book();
        let before: Vec<(String, u64, SystemTime)> = fs::read_dir(&book)
            .unwrap()
            .flatten()
            .map(|entry| {
                let metadata = entry.metadata().unwrap();
                (
                    entry.file_name().to_string_lossy().to_string(),
                    metadata.len(),
                    metadata.modified().unwrap(),
                )
            })
            .collect();
        let cache = tempfile::tempdir().unwrap();

        get_or_create(cache.path(), ID, &book, &Limiter::new(1)).unwrap();

        let after: Vec<(String, u64, SystemTime)> = fs::read_dir(&book)
            .unwrap()
            .flatten()
            .map(|entry| {
                let metadata = entry.metadata().unwrap();
                (
                    entry.file_name().to_string_lossy().to_string(),
                    metadata.len(),
                    metadata.modified().unwrap(),
                )
            })
            .collect();
        assert_eq!(after, before);
    }

    #[test]
    fn thumbs_limiter_caps_the_number_of_parallel_generations() {
        let limiter = Arc::new(Limiter::new(2));
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (limiter, running, peak) = (limiter.clone(), running.clone(), peak.clone());
                std::thread::spawn(move || {
                    let _permit = limiter.acquire();
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(20));
                    running.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn thumbs_registry_serves_only_registered_books() {
        let (dir, book) = folder_book();
        let thumbs = Thumbs::new(1);
        assert_eq!(thumbs.target(ID), None);

        thumbs.register(ID.into(), book.clone());

        assert_eq!(thumbs.target(ID), Some(book.clone()));
        let bytes = thumbs
            .get_or_create(&dir.path().join("thumbs"), ID, &book)
            .unwrap().into_bytes();
        assert_eq!(decode(&bytes).height(), 320);
    }
}
