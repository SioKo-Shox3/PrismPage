//! `prism` URI スキーム。開いた本のページ画像を WebView へ渡す唯一の口。
//! 受け付けるのは開いた本の ID とページ番号(とバリアント)だけで、ファイルのパスは受け取らない。
//! Windows では `http://prism.localhost/<パス>`、ほかの環境では `prism://localhost/<パス>` で届く。
//!
//! パスの形:
//! - `/page/<bookId>/<index>` — ページの元画像
//! - `/page/<bookId>/<index>/thumb` — ページのサムネイル(未実装のため 404)
//! - `/page/<bookId>/<index>/width/<px>` — 幅を指定したページ。大きさを選んで画像化できる形式(PDF)だけが
//!   その幅で画像化し、ほかの形式は元画像を返す
//! - `/page/<bookId>/<index>/enhanced/<key>` — 超解像の結果(PNG)。まだ無ければ元画像を返す。
//!   どちらを返したかは応答ヘッダ `X-Prism-Variant`(`enhanced` / `original`)で分かる
//! - `/thumb/<thumbId>` — 本の表紙サムネイル(JPEG。`image` で復号できない AVIF の表紙は元のページをそのまま)。
//!   ID は `list_directory` が一覧に載せた本のものだけを受け付ける

use std::path::{Path, PathBuf};

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::app_error::{AppError, AppResult};
use crate::services::engines::cache::{cache_entry_path, ENHANCED_CACHE_DIR};
use crate::services::source::{mime_type_for_path, BookCache};
use crate::services::thumbs::{Thumbs, THUMB_ID_LEN};

/// スキーム名。フロントの `pageUrl`(`src/lib/tauri.ts`)と一致させる。
pub const SCHEME: &str = "prism";

/// 本 ID の長さ(`book_id_for_path` が作る 16 桁の 16 進)。
const BOOK_ID_LEN: usize = 16;
/// ページ番号として受け付ける桁数の上限。
const MAX_INDEX_DIGITS: usize = 9;
/// 幅の指定として受け付ける桁数の上限(値の範囲はページソースが丸める)。
const MAX_WIDTH_DIGITS: usize = 5;
/// 超解像の結果を区別するキーの長さの上限。
const MAX_VARIANT_KEY_LEN: usize = 64;
/// 表紙サムネイルのキャッシュを置く、アプリのデータ領域の下のフォルダ名。
const THUMB_CACHE_DIR: &str = "thumbs";
/// 返した画像の版を示す応答ヘッダ。
const VARIANT_HEADER: &str = "x-prism-variant";

/// ページのどの版を返すか。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageVariant {
    Original,
    Thumbnail,
    /// 幅を指定したページ(画素)。
    Width(u32),
    /// 超解像の結果。キーはエンジン・モデル・倍率・ノイズ除去の組(`cache::cache_key`)。
    Enhanced(String),
}

/// 解析済みの要求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRequest {
    pub book_id: String,
    pub index: usize,
    pub variant: PageVariant,
}

/// 要求のパスを解析する。決まった形以外(任意のパス・`..`・パーセント符号化・余分な段)は `None`。
pub fn parse_path(path: &str) -> Option<PageRequest> {
    let rest = path.strip_prefix('/')?;
    let segments: Vec<&str> = rest.split('/').collect();
    let (book_id, index, variant) = match segments.as_slice() {
        ["page", book_id, index] => (*book_id, *index, PageVariant::Original),
        ["page", book_id, index, "thumb"] => (*book_id, *index, PageVariant::Thumbnail),
        ["page", book_id, index, "width", width] => {
            (*book_id, *index, PageVariant::Width(parse_width(width)?))
        }
        ["page", book_id, index, "enhanced", key] if is_variant_key(key) => {
            (*book_id, *index, PageVariant::Enhanced((*key).to_string()))
        }
        _ => return None,
    };
    if !is_book_id(book_id) {
        return None;
    }
    Some(PageRequest {
        book_id: book_id.to_string(),
        index: parse_index(index)?,
        variant,
    })
}

/// 表紙サムネイルの要求なら、そのサムネイル ID。形が合わなければ `None`。
pub fn parse_thumb_path(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/thumb/")?;
    (id.len() == THUMB_ID_LEN && is_hex_id(id)).then_some(id)
}

fn is_book_id(value: &str) -> bool {
    value.len() == BOOK_ID_LEN && is_hex_id(value)
}

fn is_hex_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 10 進の数字だけを受け付ける(符号・空白・先頭の 0 の付いた別表記は同じページを複数の URL で指すので拒む)。
fn parse_index(value: &str) -> Option<usize> {
    if value.is_empty()
        || value.len() > MAX_INDEX_DIGITS
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return None;
    }
    value.parse().ok()
}

/// 幅の指定。1 以上の 10 進の数字だけを受け付ける(先頭の 0 の付いた別表記は拒む)。
fn parse_width(value: &str) -> Option<u32> {
    if value.is_empty()
        || value.len() > MAX_WIDTH_DIGITS
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value.starts_with('0')
    {
        return None;
    }
    value.parse().ok()
}

fn is_variant_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_VARIANT_KEY_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// 要求に答える。WebView のスレッドから外して呼ぶ(ページの読み出しはファイルを読む)。
/// `enhanced_root` は超解像の結果を置くフォルダ。結果がある版の要求にはそれを、無ければ元画像を返す。
pub fn respond(
    cache: &BookCache,
    enhanced_root: Option<&Path>,
    method: &Method,
    path: &str,
) -> Response<Vec<u8>> {
    if method != Method::GET && method != Method::HEAD {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "GET だけを受け付けます。");
    }
    let Some(request) = parse_path(path) else {
        return error_response(StatusCode::BAD_REQUEST, "不正な要求です。");
    };
    let Some(source) = cache.get(&request.book_id) else {
        return error_response(StatusCode::NOT_FOUND, "開いていない本です。");
    };
    let Some(page) = source.pages().get(request.index) else {
        return error_response(StatusCode::NOT_FOUND, "そのページはありません。");
    };
    if request.variant == PageVariant::Thumbnail {
        return error_response(StatusCode::NOT_FOUND, "そのページの版はまだありません。");
    }
    if let (PageVariant::Enhanced(key), Some(root)) = (&request.variant, enhanced_root) {
        let enhanced = cache_entry_path(
            root,
            &request.book_id,
            request.index,
            page,
            source.page_revision(request.index),
            key,
        )
            .ok()
            .and_then(|path| std::fs::read(path).ok());
        if let Some(bytes) = enhanced {
            return image_response(method, "image/png", "enhanced", bytes);
        }
    }
    let content_type = mime_type_for_path(&page.name).unwrap_or("application/octet-stream");
    let read = match request.variant {
        PageVariant::Width(width) => source.read_page_at_width(request.index, width),
        _ => source.read_page(request.index),
    };
    let bytes = match read {
        Ok(bytes) => bytes,
        Err(error) => {
            log::warn!(
                "ページを配信できません({}/{}): {error}",
                request.book_id,
                request.index
            );
            return error_response(status_for_error(&error), &error.to_string());
        }
    };
    image_response(method, content_type, "original", bytes)
}

fn image_response(
    method: &Method,
    content_type: &str,
    variant: &str,
    bytes: Vec<u8>,
) -> Response<Vec<u8>> {
    let length = bytes.len();
    let body = if method == Method::HEAD {
        Vec::new()
    } else {
        bytes
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        // 同じ本 ID でも開き直すと中身が変わりうる(超解像の版は元画像から結果に変わる)ので、使うたびに確かめさせる。
        .header(header::CACHE_CONTROL, "no-cache")
        .header(VARIANT_HEADER, variant)
        .body(body)
        .unwrap_or_else(|_| internal_error())
}

/// 表紙サムネイルの要求に答える。`cache_dir` はサムネイルのキャッシュを置くフォルダ。
/// 生成は `Thumbs` が同時実行数を抑えるので、枠が空くまでこのスレッドで待つ。
pub fn respond_thumb(
    thumbs: &Thumbs,
    cache_dir: AppResult<PathBuf>,
    method: &Method,
    path: &str,
) -> Response<Vec<u8>> {
    if method != Method::GET && method != Method::HEAD {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "GET だけを受け付けます。");
    }
    let Some(thumb_id) = parse_thumb_path(path) else {
        return error_response(StatusCode::BAD_REQUEST, "不正な要求です。");
    };
    let Some(book) = thumbs.target(thumb_id) else {
        return error_response(StatusCode::NOT_FOUND, "一覧に無い本です。");
    };
    let cover = match cache_dir.and_then(|dir| thumbs.get_or_create(&dir, thumb_id, &book)) {
        Ok(cover) => cover,
        Err(error) => {
            log::warn!("表紙を作れません({}): {error}", book.display());
            let status = match &error {
                AppError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    StatusCode::NOT_FOUND
                }
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            };
            return error_response(status, &error.to_string());
        }
    };
    let content_type = cover.content_type();
    let bytes = cover.into_bytes();
    let length = bytes.len();
    let body = if method == Method::HEAD {
        Vec::new()
    } else {
        bytes
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        // 元の本が変わると同じ URL で中身が変わるので、使うたびに確かめさせる。
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap_or_else(|_| internal_error())
}

fn status_for_error(error: &AppError) -> StatusCode {
    match error {
        AppError::PageOutOfRange { .. } => StatusCode::NOT_FOUND,
        AppError::PageTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        AppError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| internal_error())
}

fn internal_error() -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    response
}

/// `register_asynchronous_uri_scheme_protocol` に渡す処理。読み出しは裏のスレッドで行う。
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let response = if path.starts_with("/thumb/") {
            let thumbs = app.state::<Thumbs>();
            let cache_dir = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join(THUMB_CACHE_DIR))
                .map_err(|_| AppError::AppDataDirUnavailable);
            respond_thumb(&thumbs, cache_dir, &method, &path)
        } else {
            let enhanced_root = app
                .path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join(ENHANCED_CACHE_DIR));
            respond(
                &app.state::<BookCache>(),
                enhanced_root.as_deref(),
                &method,
                &path,
            )
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::app_error::AppResult;
    use crate::models::PageInfo;
    use crate::services::source::PageSource;

    const BOOK: &str = "0123456789abcdef";

    struct Fake {
        pages: Vec<PageInfo>,
        bodies: Vec<AppResult<Vec<u8>>>,
    }

    impl PageSource for Fake {
        fn pages(&self) -> &[PageInfo] {
            &self.pages
        }

        fn read_page(&self, index: usize) -> AppResult<Vec<u8>> {
            match &self.bodies[index] {
                Ok(bytes) => Ok(bytes.clone()),
                Err(AppError::PageTooLarge) => Err(AppError::PageTooLarge),
                Err(_) => Err(AppError::Internal("読めない".into())),
            }
        }
    }

    fn page(name: &str) -> PageInfo {
        PageInfo {
            name: name.into(),
            width: 10,
            height: 20,
            spread: None,
        }
    }

    fn cache() -> BookCache {
        let cache = BookCache::new(4);
        cache.insert(
            BOOK.into(),
            Arc::new(Fake {
                pages: vec![
                    page("1.png"),
                    page("sub/2.JPG"),
                    page("3.png"),
                    page("4.webp"),
                ],
                bodies: vec![
                    Ok(b"png-bytes".to_vec()),
                    Ok(b"jpeg-bytes".to_vec()),
                    Err(AppError::PageTooLarge),
                    Err(AppError::Internal(String::new())),
                ],
            }),
        );
        cache
    }

    fn get(cache: &BookCache, path: &str) -> Response<Vec<u8>> {
        respond(cache, None, &Method::GET, path)
    }

    fn variant(response: &Response<Vec<u8>>) -> &str {
        response.headers()[VARIANT_HEADER].to_str().unwrap()
    }

    fn content_type(response: &Response<Vec<u8>>) -> &str {
        response.headers()[header::CONTENT_TYPE].to_str().unwrap()
    }

    #[test]
    fn serves_page_bytes_with_the_content_type() {
        let cache = cache();

        let response = get(&cache, &format!("/page/{BOOK}/0"));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(content_type(&response), "image/png");
        assert_eq!(response.body(), b"png-bytes");

        let response = get(&cache, &format!("/page/{BOOK}/1"));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(content_type(&response), "image/jpeg");
        assert_eq!(response.body(), b"jpeg-bytes");
    }

    #[test]
    fn head_returns_headers_without_the_body() {
        let response = respond(&cache(), None, &Method::HEAD, &format!("/page/{BOOK}/0"));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "9");
        assert!(response.body().is_empty());
    }

    #[test]
    fn arbitrary_paths_are_rejected_with_400() {
        let cache = cache();
        for path in [
            "/",
            "",
            "/C:/Windows/win.ini",
            "/C%3A%5CWindows%5Cwin.ini",
            "/page/C:/0",
            "/page/../../etc/passwd",
            &format!("/page/{BOOK}/../0"),
            &format!("/page/{BOOK}/0/../../x"),
            &format!("/page/{BOOK}/%30"),
            &format!("/page/{BOOK}/0/"),
            &format!("/page/{BOOK}//0"),
            &format!("/page/{BOOK}"),
            &format!("/page/{BOOK}/-1"),
            &format!("/page/{BOOK}/+1"),
            &format!("/page/{BOOK}/01"),
            &format!("/page/{BOOK}/1e3"),
            &format!("/page/{BOOK}/9999999999999999999999"),
            &format!("/page/{BOOK}/0/original"),
            &format!("/page/{BOOK}/0/enhanced/"),
            &format!("/page/{BOOK}/0/enhanced/X2"),
            &format!("/page/{BOOK}/0/enhanced/a/b"),
            &format!("/page/{BOOK}/0/width"),
            &format!("/page/{BOOK}/0/width/"),
            &format!("/page/{BOOK}/0/width/0"),
            &format!("/page/{BOOK}/0/width/0800"),
            &format!("/page/{BOOK}/0/width/-800"),
            &format!("/page/{BOOK}/0/width/800px"),
            &format!("/page/{BOOK}/0/width/123456"),
            &format!("/page/{BOOK}/0/width/800/x"),
            "/page/0123456789ABCDEF/0",
            "/page/0123456789abcde/0",
            "/page/0123456789abcdef0/0",
            &format!("/Page/{BOOK}/0"),
            &format!("/thumb/{BOOK}"),
        ] {
            assert_eq!(
                get(&cache, path).status(),
                StatusCode::BAD_REQUEST,
                "{path:?}"
            );
        }
    }

    #[test]
    fn unknown_books_and_pages_are_404() {
        let cache = cache();

        assert_eq!(
            get(&cache, "/page/fedcba9876543210/0").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get(&cache, &format!("/page/{BOOK}/4")).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get(&cache, &format!("/page/{BOOK}/999999999")).status(),
            StatusCode::NOT_FOUND
        );
    }

    const KEY: &str = "real-cugan-modelsse-0a1b2c3d-x2-dm1";

    #[test]
    fn enhanced_variant_serves_the_result_when_present_and_the_original_otherwise() {
        let cache = cache();
        let dir = tempfile::tempdir().unwrap();
        let result = cache_entry_path(dir.path(), BOOK, 1, &page("sub/2.JPG"), None, KEY).unwrap();
        std::fs::create_dir_all(result.parent().unwrap()).unwrap();
        std::fs::write(&result, b"enhanced-png").unwrap();
        let enhanced = |index: usize| {
            respond(
                &cache,
                Some(dir.path()),
                &Method::GET,
                &format!("/page/{BOOK}/{index}/enhanced/{KEY}"),
            )
        };

        let processed = enhanced(1);
        assert_eq!(processed.status(), StatusCode::OK);
        assert_eq!(content_type(&processed), "image/png");
        assert_eq!(variant(&processed), "enhanced");
        assert_eq!(processed.body(), b"enhanced-png");

        let unprocessed = enhanced(0);
        assert_eq!(unprocessed.status(), StatusCode::OK);
        assert_eq!(content_type(&unprocessed), "image/png");
        assert_eq!(variant(&unprocessed), "original");
        assert_eq!(unprocessed.body(), b"png-bytes");

        // 別のキーの結果は返さない。
        let other = respond(
            &cache,
            Some(dir.path()),
            &Method::GET,
            &format!("/page/{BOOK}/1/enhanced/waifu2x-x2"),
        );
        assert_eq!(variant(&other), "original");
        assert_eq!(other.body(), b"jpeg-bytes");

        // 元の表示も版を示す。
        assert_eq!(variant(&get(&cache, &format!("/page/{BOOK}/1"))), "original");
    }

    #[test]
    fn variants_are_parsed_and_thumbnails_are_not_served_yet() {
        assert_eq!(
            parse_path(&format!("/page/{BOOK}/3/thumb")),
            Some(PageRequest {
                book_id: BOOK.into(),
                index: 3,
                variant: PageVariant::Thumbnail
            })
        );
        assert_eq!(
            parse_path(&format!("/page/{BOOK}/0/enhanced/real-cugan-x2")),
            Some(PageRequest {
                book_id: BOOK.into(),
                index: 0,
                variant: PageVariant::Enhanced("real-cugan-x2".into())
            })
        );
        let cache = cache();
        assert_eq!(
            get(&cache, &format!("/page/{BOOK}/0/thumb")).status(),
            StatusCode::NOT_FOUND
        );
        let fallback = get(&cache, &format!("/page/{BOOK}/0/enhanced/real-cugan-x2"));
        assert_eq!(fallback.status(), StatusCode::OK);
        assert_eq!(fallback.body(), b"png-bytes");
    }

    #[test]
    fn methods_other_than_get_and_head_are_rejected() {
        let response = respond(&cache(), None, &Method::POST, &format!("/page/{BOOK}/0"));

        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn read_failures_map_to_status_codes() {
        let cache = cache();

        let too_large = get(&cache, &format!("/page/{BOOK}/2"));
        assert_eq!(too_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(content_type(&too_large).starts_with("text/plain"));
        assert_eq!(
            get(&cache, &format!("/page/{BOOK}/3")).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    fn thumb_book() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("book");
        std::fs::create_dir(&book).unwrap();
        let image = image::RgbImage::from_pixel(64, 128, image::Rgb([200, 10, 10]));
        image.save(book.join("1.png")).unwrap();
        (dir, book)
    }

    #[test]
    fn serves_thumbs_of_registered_books_as_jpeg() {
        let (dir, book) = thumb_book();
        let thumbs = Thumbs::new(1);
        thumbs.register(BOOK.into(), book);
        let cache_dir = dir.path().join("thumbs");

        let response = respond_thumb(
            &thumbs,
            Ok(cache_dir.clone()),
            &Method::GET,
            &format!("/thumb/{BOOK}"),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(content_type(&response), "image/jpeg");
        let thumb = image::load_from_memory(response.body()).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (64, 128));
        assert_eq!(std::fs::read_dir(cache_dir).unwrap().count(), 1);
    }

    #[test]
    fn thumbs_of_avif_covers_are_served_as_the_original_page() {
        let avif = crate::services::source::test_images::avif(640, 960);
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("book");
        std::fs::create_dir(&book).unwrap();
        std::fs::write(book.join("1.avif"), &avif).unwrap();
        let thumbs = Thumbs::new(1);
        thumbs.register(BOOK.into(), book);
        let cache_dir = dir.path().join("thumbs");

        let response = respond_thumb(
            &thumbs,
            Ok(cache_dir.clone()),
            &Method::GET,
            &format!("/thumb/{BOOK}"),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(content_type(&response), "image/avif");
        assert_eq!(response.body(), &avif);
        assert!(!cache_dir.exists());
    }

    #[test]
    fn thumbs_of_unlisted_books_and_malformed_ids_are_refused() {
        let (dir, book) = thumb_book();
        let thumbs = Thumbs::new(1);
        thumbs.register(BOOK.into(), book);
        let thumb = |path: &str| {
            respond_thumb(&thumbs, Ok(dir.path().join("thumbs")), &Method::GET, path).status()
        };

        assert_eq!(thumb("/thumb/fedcba9876543210"), StatusCode::NOT_FOUND);
        for path in [
            "/thumb/",
            "/thumb/0123456789ABCDEF",
            "/thumb/0123456789abcde",
            &format!("/thumb/{BOOK}/0"),
            &format!("/thumb/{BOOK}/../x"),
            "/thumb/C:/Windows/win.ini",
            "/thumb/..%2F..%2Fx",
        ] {
            assert_eq!(thumb(path), StatusCode::BAD_REQUEST, "{path:?}");
        }
        assert!(!dir.path().join("thumbs").exists());
    }

    #[test]
    fn thumbs_that_cannot_be_made_are_not_500() {
        let dir = tempfile::tempdir().unwrap();
        let thumbs = Thumbs::new(1);
        thumbs.register(BOOK.into(), dir.path().join("missing"));
        let empty = tempfile::tempdir().unwrap();
        thumbs.register("fedcba9876543210".into(), empty.path().to_path_buf());
        let cache_dir = dir.path().join("thumbs");

        let missing = respond_thumb(&thumbs, Ok(cache_dir.clone()), &Method::GET, &format!("/thumb/{BOOK}"));
        let no_pages = respond_thumb(&thumbs, Ok(cache_dir), &Method::GET, "/thumb/fedcba9876543210");

        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(no_pages.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn serves_pages_of_a_real_opened_folder() {
        let dir = tempfile::tempdir().unwrap();
        let image = crate::services::source::test_images::png(12, 34);
        std::fs::write(dir.path().join("1.png"), &image).unwrap();
        let cache = BookCache::new(2);
        let opened = crate::services::source::open_book(dir.path(), &cache).unwrap();

        let response = get(&cache, &format!("/page/{}/0", opened.book_id));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(content_type(&response), "image/png");
        assert_eq!(response.body(), &image);

        // 画像の本は幅を指定されても元画像を返す。
        let sized = get(&cache, &format!("/page/{}/0/width/6", opened.book_id));
        assert_eq!(sized.status(), StatusCode::OK);
        assert_eq!(sized.body(), &image);
    }

    #[test]
    fn serves_pdf_pages_rendered_at_the_requested_width() {
        use crate::services::source::pdf::test_pdfs::{page, write_pdf};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.pdf");
        write_pdf(&path, &[page(200, 300)]);
        let cache = BookCache::new(2);
        let opened = crate::services::source::open_book(&path, &cache).unwrap();
        let size = |response: &Response<Vec<u8>>| {
            let image = image::load_from_memory(response.body()).unwrap();
            (image.width(), image.height())
        };

        let original = get(&cache, &format!("/page/{}/0", opened.book_id));
        assert_eq!(original.status(), StatusCode::OK);
        assert_eq!(content_type(&original), "image/png");
        assert_eq!(size(&original), (opened.pages[0].width, opened.pages[0].height));

        let sized = get(&cache, &format!("/page/{}/0/width/400", opened.book_id));
        assert_eq!(sized.status(), StatusCode::OK);
        assert_eq!(content_type(&sized), "image/png");
        assert_eq!(size(&sized), (400, 600));
    }
}
