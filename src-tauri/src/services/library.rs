use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::PathBuf;

use base64::prelude::{BASE64_STANDARD, Engine};
use percent_encoding::percent_decode_str;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use uuid::Uuid;
use zip::ZipArchive;

use crate::app_error::{AppError, AppResult};
use crate::models::{
    ImportedBook, ScanBookImagesRequest, ScanBookImagesResponse, ScannedBookImage,
};
use crate::services::app_data_dir;

fn library_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let path = app_data_dir(app)?.join("library");
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn normalize_book_id(book_id: &str) -> AppResult<String> {
    Uuid::parse_str(book_id)
        .map(|id| id.to_string())
        .map_err(|_| AppError::Message("書籍 ID の形式が不正です。".into()))
}

pub fn library_book_path(app: &AppHandle, id: &str) -> AppResult<PathBuf> {
    let id = normalize_book_id(id)?;
    Ok(library_dir(app)?.join(format!("{id}.epub")))
}

pub fn import_epub_from_path(app: &AppHandle, path: &str) -> AppResult<ImportedBook> {
    let source_path = PathBuf::from(path);

    if !source_path.is_file() {
        return Err(AppError::Message("選択した EPUB ファイルが見つかりません。".into()));
    }

    let source_path = fs::canonicalize(&source_path)?;

    if !source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
    {
        return Err(AppError::Message("EPUB ファイルだけを取り込めます。".into()));
    }

    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::Message("EPUB ファイル名を解決できませんでした。".into()))?
        .to_string();

    let id = Uuid::new_v4().to_string();
    let destination_path = library_dir(app)?.join(format!("{id}.epub"));
    fs::copy(&source_path, &destination_path)?;

    let size = destination_path.metadata()?.len();

    Ok(ImportedBook {
        id,
        file_name,
        source_path: source_path.to_string_lossy().to_string(),
        stored_path: destination_path.to_string_lossy().to_string(),
        size,
    })
}

pub fn read_book_base64(app: &AppHandle, id: &str) -> AppResult<String> {
    let file_path = library_book_path(app, id)?;

    if !file_path.exists() {
        return Err(AppError::Message("指定された EPUB はライブラリに存在しません。".into()));
    }

    let bytes = fs::read(file_path)?;
    Ok(BASE64_STANDARD.encode(bytes))
}

struct ManifestItem {
    href: String,
    media_type: Option<String>,
}

struct PendingBookImage {
    asset_path: String,
    image_hash: String,
    mime_type: String,
    spine_index: u32,
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

fn mime_type_for_path(path: &str) -> Option<&'static str> {
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn is_supported_image_path(path: &str) -> bool {
    mime_type_for_path(path).is_some()
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

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_zip_entry_bytes(archive: &mut ZipArchive<File>, path: &str) -> AppResult<Vec<u8>> {
    let mut file = archive.by_name(path)?;
    if file.is_dir() {
        return Err(AppError::Message("EPUB 内のディレクトリは画像として扱えません。".into()));
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn read_zip_entry_text(archive: &mut ZipArchive<File>, path: &str) -> AppResult<String> {
    let bytes = read_zip_entry_bytes(archive, path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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

fn parse_opf_manifest_and_spine(
    xml: &str,
) -> AppResult<(HashMap<String, ManifestItem>, Vec<String>)> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut manifest = HashMap::new();
    let mut spine = Vec::new();

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
                if name_matches(event.name().as_ref(), b"itemref") =>
            {
                if let Some(idref) = attr_value(&reader, &event, &[b"idref"])? {
                    spine.push(idref);
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

    Ok((manifest, spine))
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

fn push_unique_image(
    archive: &mut ZipArchive<File>,
    asset_path: String,
    spine_index: u32,
    seen_hashes: &mut HashSet<String>,
    images: &mut Vec<PendingBookImage>,
) -> AppResult<()> {
    if !is_supported_image_path(&asset_path) {
        return Ok(());
    }

    let bytes = read_zip_entry_bytes(archive, &asset_path)?;
    let image_hash = sha256_hex(&bytes);
    if !seen_hashes.insert(image_hash.clone()) {
        return Ok(());
    }

    let mime_type = mime_type_for_path(&asset_path)
        .unwrap_or("application/octet-stream")
        .to_string();
    images.push(PendingBookImage {
        asset_path,
        image_hash,
        mime_type,
        spine_index,
    });
    Ok(())
}

fn scan_images_from_opf(archive: &mut ZipArchive<File>) -> AppResult<Vec<PendingBookImage>> {
    let container_xml = read_zip_entry_text(archive, "META-INF/container.xml")?;
    let opf_path = parse_container_rootfile(&container_xml)?;
    let opf_xml = read_zip_entry_text(archive, &opf_path)?;
    let (manifest, spine) = parse_opf_manifest_and_spine(&opf_xml)?;
    let opf_dir = parent_zip_dir(&opf_path);
    let mut images = Vec::new();
    let mut seen_hashes = HashSet::new();

    for (spine_index, idref) in spine.iter().enumerate() {
        let Some(item) = manifest.get(idref) else {
            continue;
        };
        let chapter_path = join_zip_path(Some(&opf_dir), &item.href)?;

        if !is_html_item(item, &chapter_path) {
            continue;
        }

        let chapter_xml = read_zip_entry_text(archive, &chapter_path)?;
        let chapter_dir = parent_zip_dir(&chapter_path);
        for image_ref in parse_xhtml_image_refs(&chapter_xml)? {
            let Ok(asset_path) = join_zip_path(Some(&chapter_dir), &image_ref) else {
                continue;
            };
            push_unique_image(
                archive,
                asset_path,
                spine_index as u32,
                &mut seen_hashes,
                &mut images,
            )?;
        }
    }

    if images.is_empty() {
        return Err(AppError::Message(
            "OPF spine から画像を検出できませんでした。".into(),
        ));
    }

    Ok(images)
}

fn fallback_scan_images(archive: &mut ZipArchive<File>) -> AppResult<Vec<PendingBookImage>> {
    let mut paths = Vec::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        if file.is_dir() {
            continue;
        }

        let Ok(asset_path) = normalize_epub_asset_path(file.name()) else {
            continue;
        };

        if is_supported_image_path(&asset_path) {
            paths.push(asset_path);
        }
    }
    paths.sort();
    paths.dedup();

    let mut images = Vec::new();
    let mut seen_hashes = HashSet::new();
    for asset_path in paths {
        push_unique_image(archive, asset_path, 0, &mut seen_hashes, &mut images)?;
    }

    Ok(images)
}

pub fn read_book_asset_image_bytes(
    app: &AppHandle,
    book_id: &str,
    asset_path: &str,
) -> AppResult<(String, String, Vec<u8>)> {
    let asset_path = normalize_epub_asset_path(asset_path)?;
    let mime_type = mime_type_for_path(&asset_path)
        .ok_or_else(|| AppError::Message("指定されたEPUB assetは画像ではありません。".into()))?
        .to_string();
    let book_path = library_book_path(app, book_id)?;
    let file = File::open(book_path)?;
    let mut archive = ZipArchive::new(file)?;
    let bytes = read_zip_entry_bytes(&mut archive, &asset_path)?;

    Ok((asset_path, mime_type, bytes))
}

pub fn scan_book_images(
    app: &AppHandle,
    request: ScanBookImagesRequest,
) -> AppResult<ScanBookImagesResponse> {
    let book_id = normalize_book_id(&request.book_id)?;
    let book_path = library_book_path(app, &book_id)?;
    if !book_path.exists() {
        return Err(AppError::Message("指定された EPUB はライブラリに存在しません。".into()));
    }

    let file = File::open(book_path)?;
    let mut archive = ZipArchive::new(file)?;
    let pending_images = scan_images_from_opf(&mut archive).or_else(|_| fallback_scan_images(&mut archive))?;

    let mut cached_images = 0_usize;
    let mut images = Vec::new();
    for (order, image) in pending_images.into_iter().enumerate() {
        let cached = crate::services::engines::enhanced_image_cache_exists(
            app,
            &book_id,
            request.engine_id,
            request.scale,
            &image.image_hash,
        )?;

        if cached {
            cached_images += 1;
        }

        images.push(ScannedBookImage {
            asset_path: image.asset_path,
            image_hash: image.image_hash,
            mime_type: image.mime_type,
            spine_index: image.spine_index,
            order: order as u32,
            cached,
        });
    }

    Ok(ScanBookImagesResponse {
        book_id,
        engine_id: request.engine_id,
        scale: request.scale,
        total_images: images.len(),
        cached_images,
        images,
    })
}

pub fn image_sha256_hex(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

#[cfg(test)]
mod tests {
    use super::{join_zip_path, parse_xhtml_image_refs};

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
