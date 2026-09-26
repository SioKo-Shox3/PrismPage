//! PDF を 1 冊として読むページソース。ページは PDFium で画像(PNG)にして返す。
//! PDFium の DLL はアプリに同梱し(`src-tauri/pdfium/`)、最初に PDF を開いたときに 1 度だけ読み込む。
//! PDFium は複数スレッドから同時に呼べないので、文書を開く・寸法を読む・画像化するあいだは
//! `PDFIUM_LOCK` を持つ。元の PDF は読むだけで変更しない。

use std::collections::VecDeque;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use pdfium_render::prelude::{
    PdfDocument, PdfRenderConfig, Pdfium, PdfiumError, PdfiumInternalError,
};

use super::PageSource;
use crate::app_error::{AppError, AppResult};
use crate::models::PageInfo;

/// PDF として開く拡張子。
pub const PDF_EXTENSIONS: &[&str] = &["pdf"];

/// 同梱の PDFium を置くフォルダ名(リソースフォルダの下)。`tauri.conf.json` の `bundle.resources` と合わせる。
pub const LIBRARY_DIR_NAME: &str = "pdfium";

/// 大きさの指定が無いときに画像化する大きさ(ページの長い辺の画素数)。
/// `pages()` の寸法もこの大きさで返すので、見開きの計算は PDF のページの縦横比で行われる。
pub const DEFAULT_LONG_EDGE: u32 = 2048;
/// 要求された幅として受け付ける範囲。範囲外は近い端に丸める。
pub const MIN_RENDER_WIDTH: u32 = 16;
pub const MAX_RENDER_WIDTH: u32 = 8192;
/// 画像化した結果の縦横それぞれの上限(細長いページで幅から決まる高さが大きくなりすぎないようにする)。
const MAX_RENDER_EDGE: u32 = 16384;
/// 画像化した結果の画素数の上限(RGBA で 64MB)。超える要求は縦横比を保って縮める。
const MAX_RENDER_PIXELS: u64 = 16 * 1024 * 1024;
/// 1 冊あたりに覚えておく画像化の結果の数と、その PNG の合計バイト数の上限。
const RENDER_CACHE_ENTRIES: usize = 8;
const RENDER_CACHE_BYTES: usize = 64 * 1024 * 1024;

/// PDFium を呼ぶあいだ持つロック。
static PDFIUM_LOCK: Mutex<()> = Mutex::new(());
/// 画像化(PDFium での描画から PNG にするまで)を 1 度に 1 枚にするロック。大きな画素の置き場が
/// 同時にいくつも確保されないようにする。持つ順は `RENDER_SLOT` → `PDFIUM_LOCK`。
static RENDER_SLOT: Mutex<()> = Mutex::new(());
/// 起動時に決めた、同梱の PDFium を置くフォルダ。
static LIBRARY_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 読み込んだ PDFium。読み込みに失敗したときは利用者向けの文言を持つ。
static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

/// 同梱の PDFium を置くフォルダを登録する(起動時に 1 度。2 度目以降は無視する)。
pub fn set_library_dir(dir: PathBuf) {
    let _ = LIBRARY_DIR.set(dir);
}

/// `pdfium.dll` を探す場所。登録したフォルダ → 実行ファイルの隣の `pdfium/` → (開発時)リポジトリの `src-tauri/pdfium/`。
fn library_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = LIBRARY_DIR.get() {
        candidates.push(dir.clone());
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|parent| parent.join(LIBRARY_DIR_NAME)))
    {
        candidates.push(dir);
    }
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join(LIBRARY_DIR_NAME));
    }
    candidates
}

fn load_pdfium() -> Result<Pdfium, String> {
    let library = library_candidates()
        .into_iter()
        .map(|dir| Pdfium::pdfium_platform_library_name_at_path(&dir))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "PDF を表示するためのライブラリ(pdfium.dll)が見つかりません。アプリを入れ直してください。"
                .to_string()
        })?;
    let bindings = Pdfium::bind_to_library(&library).map_err(|error| {
        log::error!("PDFium を読み込めません({}): {error}", library.display());
        "PDF を表示するためのライブラリ(pdfium.dll)を読み込めません。アプリを入れ直してください。"
            .to_string()
    })?;
    Ok(Pdfium::new(bindings))
}

/// 読み込んだ PDFium と、呼び出しのあいだ持つロック。
fn pdfium() -> AppResult<(&'static Pdfium, MutexGuard<'static, ()>)> {
    let pdfium = PDFIUM
        .get_or_init(load_pdfium)
        .as_ref()
        .map_err(|message| AppError::Message(message.clone()))?;
    let guard = PDFIUM_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok((pdfium, guard))
}

/// PDFium の失敗を利用者向けの失敗にする。
fn pdf_error(path: &Path, error: PdfiumError) -> AppError {
    match error {
        PdfiumError::PdfiumLibraryInternalError(
            PdfiumInternalError::PasswordError | PdfiumInternalError::SecurityError,
        ) => AppError::Message("パスワードで保護された PDF は開けません。".into()),
        PdfiumError::PdfiumLibraryInternalError(
            PdfiumInternalError::FormatError | PdfiumInternalError::FileError,
        ) => AppError::UnsupportedFormat(path.display().to_string()),
        PdfiumError::IoError(error) => AppError::Io(error),
        other => {
            log::warn!("PDF を読めません({}): {other}", path.display());
            AppError::Message(format!("PDF を読めません: {}", path.display()))
        }
    }
}

pub struct PdfSource {
    path: PathBuf,
    /// 開いたままの文書。落とすときは `PDFIUM_LOCK` を持って閉じる(`Drop`)。
    document: Option<PdfDocument<'static>>,
    pages: Vec<PageInfo>,
    /// ページの大きさ(ポイント。回転を反映した表示上の幅, 高さ)。
    page_points: Vec<(f32, f32)>,
    /// ファイルの更新時刻と大きさから作った目印。PDF を差し替えると変わる。
    revision: Option<u64>,
    /// 画像化した結果((ページ, 幅, 高さ) → PNG)。新しいものを後ろに置き、あふれたら前から捨てる。
    rendered: Mutex<RenderCache>,
    /// `rendered` に置く PNG の合計バイト数の上限。
    cache_limit: usize,
}

/// 画像化した結果を引く鍵(ページ, 幅, 高さ)。
type RenderKey = (usize, u32, u32);
/// 画像化した結果の置き場(鍵と PNG の組)。
type RenderCache = VecDeque<(RenderKey, Arc<Vec<u8>>)>;

impl PdfSource {
    /// PDF を開き、全ページの大きさを読む。ページが無ければ `AppError::NoPages`。
    pub fn open(path: &Path) -> AppResult<Self> {
        let metadata = std::fs::metadata(path)?;
        let (pdfium, _guard) = pdfium()?;
        let document = pdfium
            .load_pdf_from_file(path, None)
            .map_err(|error| pdf_error(path, error))?;
        let count = usize::try_from(document.pages().len()).unwrap_or(0);
        let mut pages = Vec::with_capacity(count);
        let mut page_points = Vec::with_capacity(count);
        for index in 0..count {
            let size = document
                .pages()
                .page_size(index as i32)
                .map_err(|error| pdf_error(path, error))?;
            let points = (size.width().value, size.height().value);
            // 大きさの無いページを飛ばすと番号がずれるので、そういうページを含む PDF は開かない。
            let (width, height) = default_pixel_size(points)
                .ok_or_else(|| AppError::UnsupportedFormat(path.display().to_string()))?;
            pages.push(PageInfo {
                name: page_name(index, count),
                width,
                height,
                spread: None,
            });
            page_points.push(points);
        }
        if pages.is_empty() {
            return Err(AppError::NoPages);
        }
        Ok(Self {
            path: path.to_path_buf(),
            document: Some(document),
            pages,
            page_points,
            revision: file_revision(&metadata),
            rendered: Mutex::new(VecDeque::new()),
            cache_limit: RENDER_CACHE_BYTES,
        })
    }

    /// `index` 番目のページを幅 `width` 画素(範囲外は丸める)の PNG にする。同じ要求には覚えた結果を返す。
    pub fn render_page(&self, index: usize, width: u32) -> AppResult<Arc<Vec<u8>>> {
        let Some(&points) = self.page_points.get(index) else {
            return Err(AppError::PageOutOfRange {
                index,
                count: self.pages.len(),
            });
        };
        self.render_at(index, pixel_size_for_width(points, width))
    }

    /// `index` 番目のページを `(幅, 高さ)` 画素の PNG にする。同じ要求には覚えた結果を返す。
    fn render_at(&self, index: usize, (width, height): (u32, u32)) -> AppResult<Arc<Vec<u8>>> {
        let key = (index, width, height);
        if let Some(bytes) = self.cached(key) {
            return Ok(bytes);
        }
        let _slot = RENDER_SLOT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 順番を待つあいだに同じ要求が画像化を終えていれば、それを使う。
        if let Some(bytes) = self.cached(key) {
            return Ok(bytes);
        }
        let bytes = Arc::new(self.render_uncached(index, width, height)?);
        self.remember(key, bytes.clone());
        Ok(bytes)
    }

    /// 画像化した結果を覚える。枚数か合計バイト数が上限を超えたら古いものから捨て、
    /// 1 枚で上限を超える結果は覚えない。
    fn remember(&self, key: RenderKey, bytes: Arc<Vec<u8>>) {
        if bytes.len() > self.cache_limit {
            return;
        }
        let mut rendered = self.rendered_lock();
        rendered.retain(|(cached_key, _)| *cached_key != key);
        rendered.push_back((key, bytes));
        let mut total: usize = rendered.iter().map(|(_, bytes)| bytes.len()).sum();
        while rendered.len() > RENDER_CACHE_ENTRIES || total > self.cache_limit {
            let Some((_, dropped)) = rendered.pop_front() else {
                break;
            };
            total -= dropped.len();
        }
    }

    fn cached(&self, key: RenderKey) -> Option<Arc<Vec<u8>>> {
        let mut rendered = self.rendered_lock();
        let position = rendered
            .iter()
            .position(|(cached_key, _)| *cached_key == key)?;
        // 使った結果を後ろへ回し、捨てられにくくする。
        let entry = rendered.remove(position)?;
        let bytes = entry.1.clone();
        rendered.push_back(entry);
        Some(bytes)
    }

    fn rendered_lock(&self) -> MutexGuard<'_, RenderCache> {
        self.rendered
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn render_uncached(&self, index: usize, width: u32, height: u32) -> AppResult<Vec<u8>> {
        let image = {
            let (_, _guard) = pdfium()?;
            let document = self
                .document
                .as_ref()
                .ok_or_else(|| AppError::Internal("PDF が閉じられています。".into()))?;
            let page = document
                .pages()
                .get(index as i32)
                .map_err(|error| pdf_error(&self.path, error))?;
            let config = PdfRenderConfig::new()
                .set_target_size(width as i32, height as i32)
                .render_form_data(true);
            let bitmap = page
                .render_with_config(&config)
                .map_err(|error| pdf_error(&self.path, error))?;
            bitmap
                .as_image()
                .map_err(|error| pdf_error(&self.path, error))?
                .to_rgb8()
        };
        let mut bytes = Vec::new();
        PngEncoder::new_with_quality(
            Cursor::new(&mut bytes),
            CompressionType::Fast,
            FilterType::Adaptive,
        )
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|error| AppError::Internal(format!("ページの画像を作れません: {error}")))?;
        Ok(bytes)
    }
}

impl Drop for PdfSource {
    fn drop(&mut self) {
        if let Some(document) = self.document.take() {
            let _guard = PDFIUM_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            drop(document);
        }
    }
}

impl PageSource for PdfSource {
    fn pages(&self) -> &[PageInfo] {
        &self.pages
    }

    /// 大きさの指定が無いときは `pages()` の寸法で画像化する。
    fn read_page(&self, index: usize) -> AppResult<Vec<u8>> {
        let Some(page) = self.pages.get(index) else {
            return Err(AppError::PageOutOfRange {
                index,
                count: self.pages.len(),
            });
        };
        self.render_at(index, (page.width, page.height))
            .map(|bytes| bytes.as_ref().clone())
    }

    fn read_page_at_width(&self, index: usize, width: u32) -> AppResult<Vec<u8>> {
        self.render_page(index, width)
            .map(|bytes| bytes.as_ref().clone())
    }

    fn page_revision(&self, index: usize) -> Option<u64> {
        (index < self.pages.len())
            .then_some(self.revision)
            .flatten()
    }
}

/// ページの名前。拡張子で PNG と分かるようにし、ページ数の桁に揃えて 0 を詰める(`0001.png`)。
fn page_name(index: usize, count: usize) -> String {
    let digits = count.to_string().len().max(4);
    format!("{:0digits$}.png", index + 1)
}

/// 大きさの指定が無いときの画素数(長い辺を `DEFAULT_LONG_EDGE` に合わせる)。大きさの無いページは `None`。
fn default_pixel_size(points: (f32, f32)) -> Option<(u32, u32)> {
    let (width, height) = points;
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return None;
    }
    let target = if width >= height {
        DEFAULT_LONG_EDGE
    } else {
        (DEFAULT_LONG_EDGE as f32 * width / height).round() as u32
    };
    Some(pixel_size_for_width(points, target))
}

/// 幅 `width`(`MIN_RENDER_WIDTH`〜`MAX_RENDER_WIDTH` に丸める)で画像化するときの画素数。
/// 高さはページの縦横比から決め、高さが `MAX_RENDER_EDGE` を、画素数が `MAX_RENDER_PIXELS` を超えるときは
/// 縦横比を保って収まるまで縮める。
fn pixel_size_for_width((points_width, points_height): (f32, f32), width: u32) -> (u32, u32) {
    let width = f64::from(width.clamp(MIN_RENDER_WIDTH, MAX_RENDER_WIDTH));
    let height = (width * f64::from(points_height) / f64::from(points_width))
        .round()
        .max(1.0);
    let scale = (f64::from(MAX_RENDER_EDGE) / height)
        .min((MAX_RENDER_PIXELS as f64 / (width * height)).sqrt())
        .min(1.0);
    if scale >= 1.0 {
        return (width as u32, height as u32);
    }
    (
        (width * scale).floor().max(1.0) as u32,
        (height * scale).floor().max(1.0) as u32,
    )
}

/// ファイルの更新時刻(ミリ秒)と大きさを混ぜた目印。更新時刻を得られなければ `None`。
fn file_revision(metadata: &std::fs::Metadata) -> Option<u64> {
    let modified = crate::services::library::modified_millis(metadata)?;
    Some((modified as u64).rotate_left(32) ^ metadata.len())
}

#[cfg(test)]
pub(crate) mod test_pdfs {
    //! テスト用の最小の PDF。ページごとに大きさ・回転・左半分を塗る色を決められる。

    use std::path::Path;

    /// テストの PDF の 1 ページ。
    pub struct TestPage {
        /// MediaBox の幅と高さ(ポイント)。
        pub size: (u32, u32),
        /// `/Rotate`(0・90・180・270)。
        pub rotate: u32,
        /// 左半分を塗る色(RGB。0〜1)。
        pub left_color: (f32, f32, f32),
    }

    /// `pages` を持つ PDF のバイト列を組み立てる(相互参照表の位置も計算する)。
    pub fn pdf_bytes(pages: &[TestPage]) -> Vec<u8> {
        let page_count = pages.len();
        // 1: カタログ、2: ページツリー、3 + 2i: ページ、4 + 2i: 内容。
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!(
                "<< /Type /Pages /Kids [{}] /Count {page_count} >>",
                (0..page_count)
                    .map(|index| format!("{} 0 R", 3 + 2 * index))
                    .collect::<Vec<_>>()
                    .join(" ")
            ),
        ];
        for (index, page) in pages.iter().enumerate() {
            let (width, height) = page.size;
            let (red, green, blue) = page.left_color;
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Rotate {} /Contents {} 0 R >>",
                page.rotate,
                4 + 2 * index
            ));
            let content = format!("{red} {green} {blue} rg 0 0 {} {height} re f", width / 2);
            objects.push(format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ));
        }

        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = bytes.len();
        bytes.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for offset in offsets {
            bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        bytes.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        bytes
    }

    pub fn write_pdf(path: &Path, pages: &[TestPage]) {
        std::fs::write(path, pdf_bytes(pages)).unwrap();
    }

    /// 赤で左半分を塗った、回転なしのページ。
    pub fn page(width: u32, height: u32) -> TestPage {
        TestPage {
            size: (width, height),
            rotate: 0,
            left_color: (1.0, 0.0, 0.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_pdfs::{page, write_pdf, TestPage};
    use super::*;

    fn decode(bytes: &[u8]) -> image::RgbImage {
        image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
            .expect("PNG として読める")
            .to_rgb8()
    }

    #[test]
    fn pages_have_the_pdf_page_proportions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("資料.pdf");
        write_pdf(
            &path,
            &[
                page(200, 300),
                page(600, 300),
                // 横長の MediaBox を 90 度回したページは縦長に表示される。
                TestPage {
                    size: (400, 200),
                    rotate: 90,
                    left_color: (0.0, 0.0, 1.0),
                },
            ],
        );

        let source = PdfSource::open(&path).unwrap();

        let pages: Vec<_> = source
            .pages()
            .iter()
            .map(|page| (page.name.as_str(), page.width, page.height))
            .collect();
        assert_eq!(
            pages,
            vec![
                ("0001.png", 1365, 2048),
                ("0002.png", 2048, 1024),
                ("0003.png", 1024, 2048),
            ]
        );
    }

    #[test]
    fn renders_a_page_at_the_requested_width_and_caches_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.pdf");
        write_pdf(&path, &[page(200, 300), page(600, 300)]);
        let source = PdfSource::open(&path).unwrap();

        let first = source.render_page(0, 400).unwrap();
        let image = decode(&first);
        assert_eq!(image.dimensions(), (400, 600));
        // 左半分は赤く塗られ、右半分は白い背景のまま。
        assert_eq!(image.get_pixel(50, 300).0, [255, 0, 0]);
        assert_eq!(image.get_pixel(350, 300).0, [255, 255, 255]);

        // 同じ要求は覚えた結果を返し、別の幅は別に画像化する。
        assert!(Arc::ptr_eq(&first, &source.render_page(0, 400).unwrap()));
        assert_eq!(
            decode(&source.render_page(0, 100).unwrap()).dimensions(),
            (100, 150)
        );

        // 大きさの指定が無いときは `pages()` の寸法で画像化する。
        let default = decode(&source.read_page(1).unwrap());
        assert_eq!(default.dimensions(), (2048, 1024));
        assert_eq!(
            decode(&source.read_page_at_width(1, 300).unwrap()).dimensions(),
            (300, 150)
        );
    }

    #[test]
    fn remembered_results_are_bounded_by_total_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.pdf");
        write_pdf(&path, &[page(200, 300), page(200, 300), page(200, 300)]);
        let mut source = PdfSource::open(&path).unwrap();
        let one = source.render_page(0, 200).unwrap().len();
        // 2 枚分に少し足りない上限にすると、新しい 1 枚だけが残る。
        source.cache_limit = one * 2 - 1;
        source.rendered_lock().clear();

        let first = source.render_page(0, 200).unwrap();
        let second = source.render_page(1, 200).unwrap();

        let rendered = source.rendered_lock();
        let keys: Vec<_> = rendered.iter().map(|(key, _)| *key).collect();
        assert_eq!(keys, vec![(1, 200, 300)]);
        assert!(Arc::ptr_eq(&rendered[0].1, &second));
        drop(rendered);
        assert!(!Arc::ptr_eq(&first, &source.render_page(0, 200).unwrap()));

        // 1 枚で上限を超える結果は覚えない。
        source.cache_limit = one - 1;
        source.rendered_lock().clear();
        source.render_page(2, 200).unwrap();
        assert!(source.rendered_lock().is_empty());
    }

    #[test]
    fn rotated_pages_are_rendered_as_displayed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rotated.pdf");
        write_pdf(
            &path,
            &[TestPage {
                size: (400, 200),
                rotate: 90,
                left_color: (0.0, 0.0, 1.0),
            }],
        );
        let source = PdfSource::open(&path).unwrap();

        let image = decode(&source.render_page(0, 100).unwrap());

        assert_eq!(image.dimensions(), (100, 200));
        // MediaBox の左半分は時計回りに 90 度回ると上半分になる。
        assert_eq!(image.get_pixel(50, 50).0, [0, 0, 255]);
        assert_eq!(image.get_pixel(50, 150).0, [255, 255, 255]);
    }

    #[test]
    fn requested_widths_are_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.pdf");
        write_pdf(&path, &[page(200, 300)]);
        let source = PdfSource::open(&path).unwrap();

        assert_eq!(
            decode(&source.render_page(0, 0).unwrap()).dimensions(),
            (16, 24)
        );
        // 大きすぎる要求は画素数の上限に収まるよう縦横比を保って縮める。
        let (width, height) = pixel_size_for_width((200.0, 300.0), u32::MAX);
        assert!(u64::from(width) * u64::from(height) <= MAX_RENDER_PIXELS);
        assert_eq!((width, height), (3344, 5016));
        // 細長いページは高さの上限に合わせて幅を縮める。
        assert_eq!(pixel_size_for_width((10.0, 1000.0), 8192), (163, 16384));
        assert_eq!(
            source.render_page(1, 100).unwrap_err().code(),
            "page_out_of_range"
        );
    }

    #[test]
    fn rejects_broken_files_and_keeps_the_original_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let broken = dir.path().join("broken.pdf");
        std::fs::write(&broken, b"%PDF-1.4\nnot a pdf").unwrap();
        assert_eq!(
            PdfSource::open(&broken).err().map(|error| error.code()),
            Some("unsupported_format")
        );

        let path = dir.path().join("book.pdf");
        write_pdf(&path, &[page(200, 300)]);
        let before = std::fs::read(&path).unwrap();
        let source = PdfSource::open(&path).unwrap();
        source.render_page(0, 200).unwrap();
        drop(source);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn revision_changes_when_the_file_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.pdf");
        write_pdf(&path, &[page(200, 300)]);
        let before = PdfSource::open(&path).unwrap().page_revision(0);
        write_pdf(&path, &[page(200, 300), page(200, 300)]);
        let after = PdfSource::open(&path).unwrap().page_revision(0);

        assert!(before.is_some());
        assert_ne!(before, after);
    }

    #[test]
    fn the_bundle_ships_the_library_where_it_is_loaded_from() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(manifest.join("tauri.conf.json")).unwrap(),
        )
        .unwrap();
        let resources = config["bundle"]["resources"]
            .as_object()
            .expect("bundle.resources は元と置き場所の対応");
        let dll = Pdfium::pdfium_platform_library_name();
        let source = format!("{LIBRARY_DIR_NAME}/{}", dll.to_string_lossy());
        assert_eq!(
            resources.get(&source).and_then(|target| target.as_str()),
            Some(source.as_str()),
            "DLL はリソースフォルダの {LIBRARY_DIR_NAME}/ に置く"
        );
        assert!(manifest.join(&source).is_file());
        for license in [
            format!("{LIBRARY_DIR_NAME}/LICENSE"),
            format!("{LIBRARY_DIR_NAME}/NOTICE.txt"),
            format!("{LIBRARY_DIR_NAME}/licenses/*"),
        ] {
            assert!(resources.contains_key(&license), "{license} を同梱する");
        }
        assert!(manifest
            .join(LIBRARY_DIR_NAME)
            .join("licenses")
            .join("pdfium.txt")
            .is_file());
        // FreeType と IJG のライセンスはバイナリ配布の文書に利用表明を求める。
        let notice = std::fs::read_to_string(manifest.join(LIBRARY_DIR_NAME).join("NOTICE.txt"))
            .unwrap()
            .replace("\r\n", "\n");
        for statement in [
            "Portions of this software are copyright © ",
            "The FreeType Project\n  (www.freetype.org). All rights reserved.",
            "based in part on the work of the FreeType Team",
            "This software is based in part on the work of the Independent JPEG Group.",
        ] {
            assert!(
                notice.contains(statement),
                "NOTICE.txt に {statement:?} を載せる"
            );
        }
    }
}
