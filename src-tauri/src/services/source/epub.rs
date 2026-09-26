//! 画像中心の EPUB を 1 冊として読むページソース。
//! container.xml → OPF → spine の順にたどり、各項目(XHTML・SVG 文書)の `img`・SVG の `image` が指す画像を
//! spine 順にページにする。同じ画像が複数の項目から参照されても間引かない(ハッシュでの重複除去はしない)。
//! EPUB 内のパスは `join_zip_path` で正規化し、アーカイブの外・絶対パス・ドライブ文字を指すものは使わない。
//! 画像を含まない項目が多数を占める EPUB は文章中心とみなして開かない。

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use percent_encoding::percent_decode_str;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use zip::ZipArchive;

use super::dimensions::read_dimensions;
use super::zip_archive::{entry_revision, open_checked_archive, read_entry_limited, ZipLimits};
use super::{is_supported_image_path, PageSource};
use crate::app_error::{AppError, AppResult};
use crate::models::{PageInfo, PageProgression, PageSpread};

/// container.xml・OPF・XHTML を読むときの上限。これを超える文書は読まない。
const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

pub struct EpubSource {
    archive: Mutex<ZipArchive<BufReader<File>>>,
    pages: Vec<PageInfo>,
    /// ページごとのアーカイブ内のエントリ番号。
    entries: Vec<usize>,
    page_progression: Option<PageProgression>,
    limits: ZipLimits,
}

impl EpubSource {
    pub fn open(path: &Path) -> AppResult<Self> {
        Self::open_with_limits(path, ZipLimits::default())
    }

    /// EPUB を開き、spine 順に各項目の画像をページとして並べて寸法を読む。
    /// 安全でないパス・アーカイブに無い画像・寸法を読めない画像はページにしない。
    pub fn open_with_limits(path: &Path, limits: ZipLimits) -> AppResult<Self> {
        let mut archive = open_checked_archive(path, limits)?;
        let container_xml = read_document(&mut archive, "META-INF/container.xml")?
            .ok_or_else(|| not_epub("META-INF/container.xml がありません"))?;
        let opf_path = parse_container_rootfile(&container_xml)?;
        let opf_xml = read_document(&mut archive, &opf_path)?
            .ok_or_else(|| not_epub(&format!("OPF({opf_path})がありません")))?;
        let package = parse_package(&opf_xml)?;
        let opf_dir = parent_zip_dir(&opf_path);

        let mut pages = Vec::new();
        let mut entries = Vec::new();
        // 表示する内容を持つ項目の数と、そのうち画像を 1 枚もページにできなかった項目の数。
        let mut content_items = 0usize;
        let mut items_without_images = 0usize;

        for itemref in &package.spine {
            let Some(item) = package.manifest.get(&itemref.idref) else {
                continue;
            };
            let Ok(item_path) = join_zip_path(Some(&opf_dir), &item.href) else {
                log::warn!("EPUB の安全でない項目パスを無視します: {}", item.href);
                continue;
            };

            // SVG 文書(EPUB 3 の SVG content document)も XHTML と同じく中の `image` をページにする。
            let image_paths = if is_html_item(item, &item_path) || is_svg_item(item) {
                match read_document(&mut archive, &item_path)? {
                    Some(xml) => item_image_paths(&xml, &item_path),
                    None => {
                        log::warn!("EPUB の項目がアーカイブにありません: {item_path}");
                        continue;
                    }
                }
            } else if is_supported_image_path(&item_path) {
                // spine に画像が直接並ぶ EPUB もあるので、その項目自体を 1 ページにする。
                vec![item_path]
            } else {
                continue;
            };

            content_items += 1;
            let before = pages.len();
            for asset_path in image_paths {
                let Some(index) = file_entry_index(&mut archive, &asset_path) else {
                    log::warn!("EPUB 内に画像がありません: {asset_path}");
                    continue;
                };
                let size = archive
                    .by_index(index)
                    .ok()
                    .and_then(|entry| read_dimensions(entry, limits.max_page_bytes));
                match size {
                    Some((width, height)) => {
                        pages.push(PageInfo {
                            name: asset_path,
                            width,
                            height,
                            spread: itemref.spread,
                        });
                        entries.push(index);
                    }
                    None => log::warn!("画像の寸法を読めないため除外します: {asset_path}"),
                }
            }
            if pages.len() == before {
                items_without_images += 1;
            }
        }

        if items_without_images * 2 > content_items {
            return Err(AppError::UnsupportedTextEpub);
        }
        if pages.is_empty() {
            return Err(AppError::NoPages);
        }
        Ok(Self {
            archive: Mutex::new(archive),
            pages,
            entries,
            page_progression: package.page_progression,
            limits,
        })
    }

    /// 読み出し中の panic で毒されても、アーカイブの読み口は次の by_index で位置を合わせ直すので使い続ける。
    fn lock(&self) -> MutexGuard<'_, ZipArchive<BufReader<File>>> {
        self.archive
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl PageSource for EpubSource {
    fn pages(&self) -> &[PageInfo] {
        &self.pages
    }

    fn read_page(&self, index: usize) -> AppResult<Vec<u8>> {
        let entry_index = *self.entries.get(index).ok_or(AppError::PageOutOfRange {
            index,
            count: self.entries.len(),
        })?;
        read_entry_limited(&mut self.lock(), entry_index, self.limits.max_page_bytes)
    }

    fn page_revision(&self, index: usize) -> Option<u64> {
        entry_revision(&mut self.lock(), *self.entries.get(index)?)
    }

    fn page_progression(&self) -> Option<PageProgression> {
        self.page_progression
    }
}

fn not_epub(reason: &str) -> AppError {
    AppError::UnsupportedFormat(format!("EPUB として読めません({reason})"))
}

/// 名前が完全に一致するファイルのエントリ番号。フォルダ・シンボリックリンクは `None`。
fn file_entry_index(archive: &mut ZipArchive<BufReader<File>>, path: &str) -> Option<usize> {
    let index = archive.index_for_name(path)?;
    let entry = archive.by_index_raw(index).ok()?;
    (entry.is_file() && !entry.is_symlink()).then_some(index)
}

/// EPUB 内の文書(XML)を文字列で読む。エントリが無ければ `None`。
fn read_document(
    archive: &mut ZipArchive<BufReader<File>>,
    path: &str,
) -> AppResult<Option<String>> {
    let Some(index) = file_entry_index(archive, path) else {
        return Ok(None);
    };
    let bytes = read_entry_limited(archive, index, MAX_DOCUMENT_BYTES).map_err(|error| {
        match error {
            AppError::PageTooLarge => not_epub(&format!("{path} が大きすぎます")),
            other => other,
        }
    })?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// 項目(XHTML)が参照する画像を、項目の置き場所を基準に正規化したパスで出現順に返す。
/// アーカイブの外を指すなど安全でない参照と、ページにできない形式の画像は除く。
fn item_image_paths(xml: &str, item_path: &str) -> Vec<String> {
    let refs = match parse_xhtml_image_refs(xml) {
        Ok(refs) => refs,
        Err(error) => {
            log::warn!("EPUB の項目を解析できないため画像なしとして扱います({item_path}): {error}");
            return Vec::new();
        }
    };
    let item_dir = parent_zip_dir(item_path);
    refs.iter()
        .filter_map(|image_ref| match join_zip_path(Some(&item_dir), image_ref) {
            Ok(path) => Some(path),
            Err(_) => {
                log::warn!("EPUB の安全でない画像パスを無視します: {image_ref}");
                None
            }
        })
        .filter(|path| is_supported_image_path(path))
        .collect()
}

struct ManifestItem {
    href: String,
    media_type: Option<String>,
}

/// spine の 1 項目。
struct SpineItem {
    idref: String,
    /// `properties` の `page-spread-left/right`(`rendition:` 付きも同じ)。
    spread: Option<PageSpread>,
}

/// OPF から読み取った、ページ化に必要な情報。
struct Package {
    manifest: HashMap<String, ManifestItem>,
    spine: Vec<SpineItem>,
    page_progression: Option<PageProgression>,
}

fn strip_fragment_query(reference: &str) -> &str {
    reference
        .split(['#', '?'])
        .next()
        .unwrap_or_default()
        .trim()
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn join_zip_path(base_dir: Option<&str>, reference: &str) -> AppResult<String> {
    let reference = strip_fragment_query(reference);
    if reference.is_empty() {
        return Err(AppError::Message("EPUB 内の画像パスが空です。".into()));
    }

    let decoded = percent_decode_str(reference)
        .decode_utf8()
        .map_err(|_| AppError::Message("EPUB 内のパスを UTF-8 として解釈できません。".into()))?;
    let decoded = decoded.trim();

    if decoded.is_empty()
        || decoded.starts_with('/')
        || decoded.starts_with('\\')
        || decoded.contains('\\')
        || decoded.contains('\0')
        || has_windows_drive_prefix(decoded)
    {
        return Err(AppError::Message("EPUB 内に危険なパスが含まれています。".into()));
    }

    let mut parts = Vec::new();
    if let Some(base_dir) = base_dir {
        for part in base_dir.split('/').filter(|part| !part.is_empty()) {
            if part == "." || part == ".." || part.contains('\\') {
                return Err(AppError::Message(
                    "EPUB 内の基準パスが不正です。".into(),
                ));
            }
            parts.push(part.to_string());
        }
    }

    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(AppError::Message(
                        "EPUB 内のパスがアーカイブ外を参照しています。".into(),
                    ));
                }
            }
            value => parts.push(value.to_string()),
        }
    }

    if parts.is_empty() {
        return Err(AppError::Message("EPUB 内のパスを解決できません。".into()));
    }

    Ok(parts.join("/"))
}

pub fn normalize_epub_asset_path(asset_path: &str) -> AppResult<String> {
    join_zip_path(None, asset_path)
}

fn parent_zip_dir(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

fn is_html_item(item: &ManifestItem, path: &str) -> bool {
    item.media_type
        .as_deref()
        .is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("xhtml") || value.contains("html")
        })
        || path
            .rsplit('.')
            .next()
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "xhtml" | "html" | "htm"
                )
            })
}

fn is_svg_item(item: &ManifestItem) -> bool {
    item.media_type
        .as_deref()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("image/svg+xml"))
}

fn name_matches(raw: &[u8], expected: &[u8]) -> bool {
    raw == expected
        || raw
            .rsplit(|byte| *byte == b':')
            .next()
            .is_some_and(|local_name| local_name == expected)
}

fn attr_value(
    reader: &Reader<&[u8]>,
    event: &BytesStart<'_>,
    expected_keys: &[&[u8]],
) -> AppResult<Option<String>> {
    for attribute in event.attributes().with_checks(false) {
        let attribute = attribute
            .map_err(|error| AppError::Message(format!("EPUB XML 属性の解析に失敗しました: {error}")))?;
        let key = attribute.key.as_ref();

        if expected_keys
            .iter()
            .any(|expected| name_matches(key, expected))
        {
            let value = attribute
                .decode_and_unescape_value(reader.decoder())
                .map_err(|error| {
                    AppError::Message(format!("EPUB XML 属性値の解析に失敗しました: {error}"))
                })?;
            return Ok(Some(value.into_owned()));
        }
    }

    Ok(None)
}

fn parse_container_rootfile(xml: &str) -> AppResult<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    loop {
        match reader
            .read_event()
            .map_err(|error| AppError::Message(format!("container.xml の解析に失敗しました: {error}")))?
        {
            Event::Start(event) | Event::Empty(event)
                if name_matches(event.name().as_ref(), b"rootfile") =>
            {
                if let Some(path) = attr_value(&reader, &event, &[b"full-path"])? {
                    return normalize_epub_asset_path(&path);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Err(AppError::Message(
        "container.xml に OPF rootfile が見つかりません。".into(),
    ))
}

/// itemref の `properties` から見開きの置き場所を読む。`page-spread-center` などは指定なしとして扱う。
fn parse_spread(properties: &str) -> Option<PageSpread> {
    properties
        .split_ascii_whitespace()
        .find_map(|property| match property {
            "page-spread-left" | "rendition:page-spread-left" => Some(PageSpread::Left),
            "page-spread-right" | "rendition:page-spread-right" => Some(PageSpread::Right),
            _ => None,
        })
}

/// spine の `page-progression-direction`。`default` と未知の値は本の指定なしとして扱う。
fn parse_progression(value: &str) -> Option<PageProgression> {
    match value.trim().to_ascii_lowercase().as_str() {
        "rtl" => Some(PageProgression::Rtl),
        "ltr" => Some(PageProgression::Ltr),
        _ => None,
    }
}

fn parse_package(xml: &str) -> AppResult<Package> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut manifest = HashMap::new();
    let mut spine = Vec::new();
    let mut page_progression = None;

    loop {
        match reader
            .read_event()
            .map_err(|error| AppError::Message(format!("OPF の解析に失敗しました: {error}")))?
        {
            Event::Start(event) | Event::Empty(event)
                if name_matches(event.name().as_ref(), b"item") =>
            {
                let id = attr_value(&reader, &event, &[b"id"])?;
                let href = attr_value(&reader, &event, &[b"href"])?;
                if let (Some(id), Some(href)) = (id, href) {
                    manifest.insert(
                        id,
                        ManifestItem {
                            href,
                            media_type: attr_value(&reader, &event, &[b"media-type"])?,
                        },
                    );
                }
            }
            Event::Start(event) | Event::Empty(event)
                if name_matches(event.name().as_ref(), b"spine") =>
            {
                if let Some(value) =
                    attr_value(&reader, &event, &[b"page-progression-direction"])?
                {
                    page_progression = parse_progression(&value);
                }
            }
            Event::Start(event) | Event::Empty(event)
                if name_matches(event.name().as_ref(), b"itemref") =>
            {
                if let Some(idref) = attr_value(&reader, &event, &[b"idref"])? {
                    let spread = attr_value(&reader, &event, &[b"properties"])?
                        .as_deref()
                        .and_then(parse_spread);
                    spine.push(SpineItem { idref, spread });
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    if manifest.is_empty() || spine.is_empty() {
        return Err(AppError::Message(
            "OPF manifest/spine を読み取れませんでした。".into(),
        ));
    }

    Ok(Package {
        manifest,
        spine,
        page_progression,
    })
}

fn parse_xhtml_image_refs(xml: &str) -> AppResult<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut refs = Vec::new();

    loop {
        match reader
            .read_event()
            .map_err(|error| AppError::Message(format!("XHTML の解析に失敗しました: {error}")))?
        {
            Event::Start(event) | Event::Empty(event)
                if name_matches(event.name().as_ref(), b"img") =>
            {
                if let Some(src) = attr_value(&reader, &event, &[b"src"])? {
                    refs.push(src);
                }
            }
            Event::Start(event) | Event::Empty(event)
                if name_matches(event.name().as_ref(), b"image") =>
            {
                if let Some(href) = attr_value(&reader, &event, &[b"href"])? {
                    refs.push(href);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(refs)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::services::source::test_images;
    use crate::services::source::zip_archive::test_archives::write_zip;
    use crate::services::source::{open_book, BookCache};

    const CONTAINER: &str =
        r#"<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>"#;

    /// container.xml と OPF(`OPS/book.opf`)に `files` を加えた EPUB を一時フォルダに作る。
    fn write_epub(dir: &Path, opf: &str, files: Vec<(&str, Vec<u8>)>) -> PathBuf {
        let path = dir.join("本.epub");
        let mut entries = vec![
            ("mimetype", b"application/epub+zip".to_vec()),
            ("META-INF/container.xml", CONTAINER.as_bytes().to_vec()),
            ("OPS/book.opf", opf.as_bytes().to_vec()),
        ];
        entries.extend(files);
        write_zip(&path, &entries);
        path
    }

    fn xhtml(body: &str) -> Vec<u8> {
        format!(r#"<html xmlns="http://www.w3.org/1999/xhtml"><body>{body}</body></html>"#)
            .into_bytes()
    }

    fn names(source: &EpubSource) -> Vec<&str> {
        source.pages().iter().map(|page| page.name.as_str()).collect()
    }

    #[test]
    fn pages_follow_spine_order_without_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_epub(
            dir.path(),
            r#"<package><manifest>
                <item id="p1" href="Text/p1.xhtml" media-type="application/xhtml+xml"/>
                <item id="p2" href="Text/p2.xhtml" media-type="application/xhtml+xml"/>
                <item id="css" href="style.css" media-type="text/css"/>
            </manifest><spine><itemref idref="p2"/><itemref idref="css"/><itemref idref="p1"/></spine></package>"#,
            vec![
                ("OPS/Text/p1.xhtml", xhtml(r#"<img src="../Images/a.jpg"/>"#)),
                (
                    "OPS/Text/p2.xhtml",
                    xhtml(
                        r#"<img src="../Images/b.png"/><svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../Images/c.gif"/></svg><img src="../Images/a.jpg"/><img src="../../../escape.jpg"/><img src="../Images/missing.png"/>"#,
                    ),
                ),
                ("OPS/Images/a.jpg", test_images::jpeg(600, 800)),
                ("OPS/Images/b.png", test_images::png(10, 20)),
                ("OPS/Images/c.gif", test_images::gif(30, 40)),
                ("escape.jpg", test_images::jpeg(1, 1)),
            ],
        );

        let source = EpubSource::open(&path).unwrap();

        assert_eq!(
            names(&source),
            vec![
                "OPS/Images/b.png",
                "OPS/Images/c.gif",
                "OPS/Images/a.jpg",
                "OPS/Images/a.jpg"
            ]
        );
        assert_eq!(source.page_size(1), Some((30, 40)));
        assert_eq!(source.read_page(3).unwrap(), test_images::jpeg(600, 800));
        assert_eq!(source.page_progression(), None);
        assert!(matches!(
            source.read_page(4),
            Err(AppError::PageOutOfRange { index: 4, count: 4 })
        ));
    }

    #[test]
    fn fixed_layout_spreads_and_progression_are_carried() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_epub(
            dir.path(),
            r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
            <metadata><meta property="rendition:layout">pre-paginated</meta></metadata>
            <manifest>
                <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
                <item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/>
                <item id="p2" href="p2.xhtml" media-type="application/xhtml+xml"/>
            </manifest>
            <spine page-progression-direction="rtl">
                <itemref idref="cover" properties="rendition:page-spread-center"/>
                <itemref idref="p1" properties="page-spread-right"/>
                <itemref idref="p2" linear="yes" properties="rendition:layout-pre-paginated rendition:page-spread-left"/>
            </spine></package>"#,
            vec![
                ("OPS/cover.xhtml", xhtml(r#"<img src="i/0.png"/>"#)),
                ("OPS/p1.xhtml", xhtml(r#"<img src="i/1.png"/>"#)),
                ("OPS/p2.xhtml", xhtml(r#"<svg><image href="i/2.png"/></svg>"#)),
                ("OPS/i/0.png", test_images::png(10, 10)),
                ("OPS/i/1.png", test_images::png(10, 10)),
                ("OPS/i/2.png", test_images::png(10, 10)),
            ],
        );
        let cache = BookCache::new(4);

        let book = open_book(&path, &cache).unwrap();

        assert_eq!(book.title, "本");
        assert_eq!(book.page_progression, Some(PageProgression::Rtl));
        let spreads: Vec<_> = book.pages.iter().map(|page| page.spread).collect();
        assert_eq!(
            spreads,
            vec![None, Some(PageSpread::Right), Some(PageSpread::Left)]
        );
        let json = serde_json::to_value(&book).unwrap();
        assert_eq!(json["pageProgression"], "rtl");
        assert_eq!(json["pages"][1]["spread"], "right");
        assert!(json["pages"][0].get("spread").is_none());
        assert!(cache.get(&book.book_id).is_some());
    }

    #[test]
    fn text_centric_epub_is_rejected_with_its_own_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_epub(
            dir.path(),
            r#"<package><manifest>
                <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
                <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
                <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
            </manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>"#,
            vec![
                ("OPS/c1.xhtml", xhtml(r#"<img src="cover.png"/>"#)),
                ("OPS/c2.xhtml", xhtml("<p>第一章</p>")),
                ("OPS/c3.xhtml", xhtml("<p>第二章</p>")),
                ("OPS/cover.png", test_images::png(10, 10)),
            ],
        );
        let cache = BookCache::new(4);

        let error = open_book(&path, &cache).unwrap_err();

        assert_eq!(error.code(), "unsupported_text_epub");
        assert!(cache.is_empty());
    }

    #[test]
    fn epub_where_half_the_items_have_images_is_opened() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_epub(
            dir.path(),
            r#"<package><manifest>
                <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
                <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
            </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#,
            vec![
                ("OPS/c1.xhtml", xhtml(r#"<img src="1.png"/>"#)),
                ("OPS/c2.xhtml", xhtml("<p>あとがき</p>")),
                ("OPS/1.png", test_images::png(10, 10)),
            ],
        );

        let source = EpubSource::open(&path).unwrap();

        assert_eq!(names(&source), vec!["OPS/1.png"]);
    }

    #[test]
    fn items_whose_path_escapes_the_archive_are_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_epub(
            dir.path(),
            r#"<package><manifest>
                <item id="bad" href="../../outside.xhtml" media-type="application/xhtml+xml"/>
                <item id="drive" href="C:/Windows/win.xhtml" media-type="application/xhtml+xml"/>
                <item id="ok" href="ok.xhtml" media-type="application/xhtml+xml"/>
            </manifest><spine><itemref idref="bad"/><itemref idref="drive"/><itemref idref="ok"/></spine></package>"#,
            vec![
                ("outside.xhtml", xhtml(r#"<img src="OPS/1.png"/>"#)),
                ("OPS/ok.xhtml", xhtml(r#"<img src="1.png"/>"#)),
                ("OPS/1.png", test_images::png(10, 10)),
            ],
        );

        let source = EpubSource::open(&path).unwrap();

        assert_eq!(names(&source), vec!["OPS/1.png"]);
    }

    #[test]
    fn svg_documents_in_spine_become_pages() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_epub(
            dir.path(),
            r#"<package><manifest>
                <item id="p" href="p.svg" media-type="image/svg+xml"/>
                <item id="bad" href="bad.svg" media-type="image/svg+xml"/>
            </manifest><spine><itemref idref="p"/><itemref idref="bad"/></spine></package>"#,
            vec![
                (
                    "OPS/p.svg",
                    br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="p.png"/></svg>"#
                        .to_vec(),
                ),
                (
                    "OPS/bad.svg",
                    br#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../../escape.png"/><image href="/abs.png"/></svg>"#
                        .to_vec(),
                ),
                ("OPS/p.png", test_images::png(10, 20)),
                ("escape.png", test_images::png(1, 1)),
                ("abs.png", test_images::png(1, 1)),
            ],
        );

        let source = EpubSource::open(&path).unwrap();

        assert_eq!(names(&source), vec!["OPS/p.png"]);
        assert_eq!(source.page_size(0), Some((10, 20)));
    }

    #[test]
    fn svg_documents_without_images_count_toward_text_centric() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_epub(
            dir.path(),
            r#"<package><manifest>
                <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
                <item id="s1" href="s1.svg" media-type="image/svg+xml"/>
                <item id="s2" href="s2.svg" media-type="image/svg+xml"/>
            </manifest><spine><itemref idref="c1"/><itemref idref="s1"/><itemref idref="s2"/></spine></package>"#,
            vec![
                ("OPS/c1.xhtml", xhtml(r#"<img src="1.png"/>"#)),
                ("OPS/s1.svg", "<svg><text>文</text></svg>".as_bytes().to_vec()),
                ("OPS/s2.svg", "<svg><text>章</text></svg>".as_bytes().to_vec()),
                ("OPS/1.png", test_images::png(10, 10)),
            ],
        );

        let error = EpubSource::open(&path).err().unwrap();

        assert_eq!(error.code(), "unsupported_text_epub");
    }

    #[test]
    fn archive_without_container_is_not_an_epub() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("壊れた.epub");
        write_zip(&path, &[("OPS/1.png", test_images::png(10, 10))]);

        let error = EpubSource::open(&path).err().unwrap();

        assert_eq!(error.code(), "unsupported_format");
    }

    #[test]
    fn normalizes_safe_relative_zip_paths() {
        assert_eq!(
            join_zip_path(Some("OPS/Text"), "../Images/page%201.jpg").unwrap(),
            "OPS/Images/page 1.jpg"
        );
    }

    #[test]
    fn rejects_zip_paths_that_escape_root() {
        assert!(join_zip_path(Some("OPS"), "../../secret.png").is_err());
        assert!(join_zip_path(None, "%2e%2e/secret.png").is_err());
        assert!(join_zip_path(None, "C:/secret.png").is_err());
        assert!(join_zip_path(None, "OPS\\secret.png").is_err());
    }

    #[test]
    fn parses_img_and_svg_image_refs() {
        let refs = parse_xhtml_image_refs(
            r#"<html><body><img src="../Images/a.png"/><svg><image xlink:href="b.jpg"/></svg></body></html>"#,
        )
        .unwrap();

        assert_eq!(refs, vec!["../Images/a.png", "b.jpg"]);
    }
}
