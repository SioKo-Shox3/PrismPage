//! ZIP / CBZ を 1 冊として読むページソース。
//! アーカイブは開いたまま持ち、ページごとに開き直さない。サブフォルダの画像は
//! パスの自然順で 1 列に並べ、同じ中身の画像が複数あっても間引かない。
//! `..`・絶対パス・ドライブ文字を含むエントリ名は無視する(アーカイブの外を指す名前を使わない)。
//! 同じ名前のエントリが複数あるアーカイブは開かない(どのエントリを読むかが実装ごとに違い、ページが欠ける)。

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use zip::ZipArchive;

use super::dimensions::read_dimensions;
use super::{is_supported_image_path, natural_cmp, PageSource, MAX_PAGE_BYTES};
use crate::app_error::{AppError, AppResult};
use crate::models::PageInfo;

/// 1 つのアーカイブで扱うエントリ数の上限(フォルダ・画像以外を含む)。
pub const MAX_ARCHIVE_ENTRIES: usize = 50_000;

/// アーカイブを読むときの上限。
#[derive(Debug, Clone, Copy)]
pub struct ZipLimits {
    /// エントリ数の上限(中央ディレクトリの記録の数)。超えるアーカイブは開かない。
    pub max_entries: usize,
    /// 1 エントリを展開して読むバイト数の上限。
    pub max_page_bytes: u64,
}

impl Default for ZipLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_page_bytes: MAX_PAGE_BYTES,
        }
    }
}

pub struct ZipSource {
    archive: Mutex<ZipArchive<BufReader<File>>>,
    pages: Vec<PageInfo>,
    /// ページごとのアーカイブ内のエントリ番号。
    entries: Vec<usize>,
    limits: ZipLimits,
}

impl ZipSource {
    pub fn open(path: &Path) -> AppResult<Self> {
        Self::open_with_limits(path, ZipLimits::default())
    }

    /// アーカイブを開き、画像エントリを自然順に並べて各画像のヘッダから寸法を読む。
    /// 寸法を読めない・展開できない(暗号化など)エントリは表示できないので除く。
    pub fn open_with_limits(path: &Path, limits: ZipLimits) -> AppResult<Self> {
        let mut archive = open_checked_archive(path, limits)?;

        let mut candidates = Vec::new();
        for index in 0..archive.len() {
            let entry = match archive.by_index_raw(index) {
                Ok(entry) => entry,
                Err(error) => {
                    log::warn!("アーカイブのエントリ {index} を読めないため除外します: {error}");
                    continue;
                }
            };
            if !entry.is_file() || entry.is_symlink() {
                continue;
            }
            let Some(name) = safe_entry_name(entry.name()) else {
                log::warn!("安全でないエントリ名を無視します: {}", entry.name());
                continue;
            };
            // 二重の確認として、zip 側の判定でもアーカイブ内に収まる名前だけを通す。
            if entry.enclosed_name().is_none() {
                log::warn!("安全でないエントリ名を無視します: {}", entry.name());
                continue;
            }
            if is_supported_image_path(&name) {
                candidates.push((name, index));
            }
        }
        candidates.sort_by(|(left, _), (right, _)| natural_path_cmp(left, right));

        let mut pages = Vec::with_capacity(candidates.len());
        let mut entries = Vec::with_capacity(candidates.len());
        for (name, index) in candidates {
            let size = archive
                .by_index(index)
                .ok()
                .and_then(|entry| read_dimensions(entry, limits.max_page_bytes));
            match size {
                Some((width, height)) => {
                    pages.push(PageInfo {
                        name,
                        width,
                        height,
                        spread: None,
                    });
                    entries.push(index);
                }
                None => log::warn!("画像の寸法を読めないため除外します: {name}"),
            }
        }

        if pages.is_empty() {
            return Err(AppError::NoPages);
        }
        Ok(Self {
            archive: Mutex::new(archive),
            pages,
            entries,
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

impl PageSource for ZipSource {
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
}

/// エントリの中身の目印(CRC-32 と展開後のサイズ)。中央ディレクトリの記録から得るので中身は読まない。
pub(crate) fn entry_revision(
    archive: &mut ZipArchive<BufReader<File>>,
    index: usize,
) -> Option<u64> {
    let entry = archive.by_index_raw(index).ok()?;
    Some((u64::from(entry.crc32()) << 32) ^ entry.size())
}

/// ZIP を開き、エントリ数の上限と同名エントリの有無を確かめる。ZIP/CBZ と EPUB で共用する。
pub(crate) fn open_checked_archive(
    path: &Path,
    limits: ZipLimits,
) -> AppResult<ZipArchive<BufReader<File>>> {
    let file = File::open(path)?;
    let mut directory_reader = BufReader::new(file.try_clone()?);
    let archive = ZipArchive::new(BufReader::new(file))?;
    let too_many = || {
        AppError::Message(format!(
            "アーカイブのエントリが多すぎるため開けません(上限 {} 件)。",
            limits.max_entries
        ))
    };
    if archive.len() > limits.max_entries {
        return Err(too_many());
    }
    // zip クレートは同名のエントリを 1 件にまとめるので、件数と同名の有無は中央ディレクトリを
    // 自分でたどって確かめる。同名があると読むエントリが実装ごとに変わりページが欠けるため開かない。
    let records = match scan_central_directory(
        &mut directory_reader,
        archive.central_directory_start(),
        limits.max_entries,
    )? {
        DirectoryScan::TooMany => return Err(too_many()),
        DirectoryScan::DuplicateName(name) => {
            return Err(AppError::UnsupportedFormat(format!(
                "同じ名前のエントリが複数あるアーカイブです({name})"
            )))
        }
        DirectoryScan::Ok(records) => records,
    };
    // zip クレートは復号後の名前(CP437 や Unicode Path 拡張フィールドを反映した名前)で同名をまとめるため、
    // 生バイトが違っても 1 件に減ることがある。記録の数と合わなければ欠けたページがあるので開かない。
    if records != archive.len() {
        return Err(AppError::UnsupportedFormat(format!(
            "エントリの数が合わないアーカイブです(記録 {records} 件、読めたのは {} 件)",
            archive.len()
        )));
    }
    Ok(archive)
}

/// `index` 番目のエントリを展開して読む。`max` バイトを超えるものは `PageTooLarge`。
pub(crate) fn read_entry_limited(
    archive: &mut ZipArchive<BufReader<File>>,
    index: usize,
    max: u64,
) -> AppResult<Vec<u8>> {
    let entry = archive.by_index(index)?;
    if entry.size() > max {
        return Err(AppError::PageTooLarge);
    }
    // 宣言された展開後サイズは偽れるので、実際に読む量も上限 + 1 で打ち切って確かめる。
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(AppError::PageTooLarge);
    }
    Ok(bytes)
}

/// エントリ名をアーカイブ内の相対パス(`/` 区切り)に整える。`..`・絶対パス・
/// ドライブ文字や代替データストリームを表す `:`・NUL を含む名前は `None`。
pub(crate) fn safe_entry_name(raw: &str) -> Option<String> {
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains(':') || normalized.contains('\0') {
        return None;
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// 中央ディレクトリをたどった結果。
#[derive(Debug, PartialEq, Eq)]
enum DirectoryScan {
    /// 重複を除く前の記録の数。
    Ok(usize),
    /// 記録の数が上限を超えた。
    TooMany,
    /// 同じ名前(バイト列として一致)の記録が 2 つ以上ある。
    DuplicateName(String),
}

/// 中央ディレクトリの記録の署名。
const CENTRAL_HEADER_SIGNATURE: u32 = 0x0201_4b50;
/// 中央ディレクトリの記録の固定長部分の大きさ。
const CENTRAL_HEADER_LEN: usize = 46;

/// `start` から中央ディレクトリの記録を順に読み、重複を除く前の件数と同名の有無を確かめる。
/// 記録は署名が続く限り数えるので、宣言された件数より多く数えることはあっても少なくはならない。
/// 上限 + 1 件目に達した時点で読むのをやめる。
fn scan_central_directory<R: Read + Seek>(
    reader: &mut R,
    start: u64,
    max_entries: usize,
) -> AppResult<DirectoryScan> {
    reader.seek(SeekFrom::Start(start))?;
    let mut names = HashSet::new();
    let mut header = [0u8; CENTRAL_HEADER_LEN];
    loop {
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error.into()),
        }
        let field16 = |at: usize| u16::from_le_bytes([header[at], header[at + 1]]);
        let signature = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        if signature != CENTRAL_HEADER_SIGNATURE {
            break;
        }
        if names.len() >= max_entries {
            return Ok(DirectoryScan::TooMany);
        }
        let name_len = usize::from(field16(28));
        let skip_len = i64::from(field16(30)) + i64::from(field16(32));
        let mut name = vec![0u8; name_len];
        reader.read_exact(&mut name)?;
        reader.seek(SeekFrom::Current(skip_len))?;
        if let Some(name) = names.replace(name) {
            return Ok(DirectoryScan::DuplicateName(
                String::from_utf8_lossy(&name).into_owned(),
            ));
        }
    }
    Ok(DirectoryScan::Ok(names.len()))
}

/// パスを `/` で区切った段ごとに自然順で比べる(`ch2/10.jpg` < `ch10/1.jpg`)。
pub(crate) fn natural_path_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    let mut left_parts = left.split('/');
    let mut right_parts = right.split('/');
    loop {
        match (left_parts.next(), right_parts.next()) {
            (None, None) => return left.cmp(right),
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(l), Some(r)) => {
                let ordering = natural_cmp(l, r);
                if ordering != std::cmp::Ordering::Equal {
                    return ordering;
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_archives {
    //! テスト用に ZIP をその場で作る。
    use std::io::Write;
    use std::path::Path;

    use zip::write::{FullFileOptions, SimpleFileOptions};
    use zip::{CompressionMethod, ZipWriter};

    /// `(エントリ名, 中身)` を順に書いた ZIP を `path` に作る。名前が `/` で終わればフォルダ。
    pub fn write_zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let mut writer = ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, body) in entries {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(body).unwrap();
            }
        }
        writer.finish().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_archives::write_zip;
    use super::*;
    use crate::services::source::test_images;
    use zip::write::{FullFileOptions, SimpleFileOptions};

    fn names(source: &ZipSource) -> Vec<&str> {
        source
            .pages()
            .iter()
            .map(|page| page.name.as_str())
            .collect()
    }

    #[test]
    fn flattens_subfolders_in_natural_order_without_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.cbz");
        let same = test_images::png(100, 200);
        write_zip(
            &path,
            &[
                ("ch10/", Vec::new()),
                ("ch10/1.png", test_images::png(10, 10)),
                ("ch2/10.jpg", test_images::jpeg(30, 40)),
                ("ch2/2.png", same.clone()),
                ("10.png", test_images::png(50, 60)),
                ("2.png", same.clone()),
                ("ch2/1.gif", test_images::gif(70, 80)),
                ("ch2/notes.txt", b"not a page".to_vec()),
                ("ch2/broken.png", b"not really a png".to_vec()),
                ("ch2\\3.png", same.clone()),
            ],
        );

        let source = ZipSource::open(&path).unwrap();

        assert_eq!(
            names(&source),
            vec![
                "2.png",
                "10.png",
                "ch2/1.gif",
                "ch2/2.png",
                "ch2/3.png",
                "ch2/10.jpg",
                "ch10/1.png"
            ]
        );
        assert_eq!(source.page_size(5), Some((30, 40)));
        // 同じ中身の画像も別ページとして残り、それぞれ読める。
        for index in [0, 3, 4] {
            assert_eq!(source.read_page(index).unwrap(), same);
        }
        assert_eq!(source.read_page(1).unwrap(), test_images::png(50, 60));
        assert_eq!(source.read_page(7).unwrap_err().code(), "page_out_of_range");
    }

    /// 同じ名前・寸法のまま中身だけを差し替えたアーカイブは、ページの目印が変わる。
    #[test]
    fn page_revision_changes_when_the_content_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.cbz");
        let revision = |body: Vec<u8>| {
            write_zip(&path, &[("1.png", body)]);
            let source = ZipSource::open(&path).unwrap();
            assert_eq!(source.page_revision(1), None);
            source.page_revision(0).unwrap()
        };
        let original = revision(test_images::png(10, 20));
        assert_eq!(original, revision(test_images::png(10, 20)));
        let mut replaced = test_images::png(10, 20);
        replaced.extend_from_slice(b"other");
        assert_ne!(original, revision(replaced));
    }

    #[test]
    fn ignores_entries_that_escape_the_archive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.zip");
        let image = test_images::png(10, 10);
        write_zip(
            &path,
            &[
                ("../evil.png", image.clone()),
                ("a/../../evil2.png", image.clone()),
                ("..\\evil3.png", image.clone()),
                ("/abs.png", image.clone()),
                ("\\abs2.png", image.clone()),
                ("C:/drive.png", image.clone()),
                ("c:drive2.png", image.clone()),
                ("sub/C:\\drive3.png", image.clone()),
                ("ok.png", image.clone()),
            ],
        );

        let source = ZipSource::open(&path).unwrap();

        assert_eq!(names(&source), vec!["ok.png"]);
    }

    #[test]
    fn entry_names_are_normalized_or_rejected() {
        assert_eq!(
            safe_entry_name("a/./b\\c.png").as_deref(),
            Some("a/b/c.png")
        );
        for raw in [
            "..",
            "a/../b.png",
            "/x.png",
            "\\x.png",
            "D:x.png",
            "x.png:ads",
            "a\0.png",
            "",
            "./",
        ] {
            assert_eq!(safe_entry_name(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn rejects_archives_with_too_many_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("many.zip");
        let entries: Vec<_> = ["1.png", "2.png", "3.png", "4.png", "5.png"]
            .iter()
            .map(|name| (*name, test_images::png(10, 10)))
            .collect();
        write_zip(&path, &entries);
        let limits = |max_entries| ZipLimits {
            max_entries,
            max_page_bytes: MAX_PAGE_BYTES,
        };

        assert!(ZipSource::open_with_limits(&path, limits(4)).is_err());
        let source = ZipSource::open_with_limits(&path, limits(5)).unwrap();
        assert_eq!(source.pages().len(), 5);
    }

    /// 同じ PNG を `a.png`・`b.png` で書き、ローカルヘッダと中央ディレクトリの `b.png` を
    /// `a.png` に書き換えて、同名のエントリが 2 つある ZIP を作る。
    fn write_zip_with_duplicate_names(path: &Path) {
        write_zip(
            path,
            &[
                ("a.png", test_images::png(10, 10)),
                ("b.png", test_images::png(10, 10)),
            ],
        );
        let mut bytes = std::fs::read(path).unwrap();
        let mut replaced = 0;
        for at in 0..bytes.len() - 4 {
            if &bytes[at..at + 5] == b"b.png" {
                bytes[at] = b'a';
                replaced += 1;
            }
        }
        assert_eq!(replaced, 2);
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn archives_with_duplicate_names_are_not_opened_with_missing_pages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dup.zip");
        write_zip_with_duplicate_names(&path);
        // zip クレートは同名を 1 件にまとめる(ページが 1 枚欠ける)ことを前提として確かめておく。
        let archive = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        assert_eq!(archive.len(), 1);
        let limits = |max_entries| ZipLimits {
            max_entries,
            max_page_bytes: MAX_PAGE_BYTES,
        };

        let error = ZipSource::open_with_limits(&path, limits(2)).err().unwrap();
        assert_eq!(error.code(), "unsupported_format");
        assert!(error.to_string().contains("a.png"), "{error}");
        // 重複を除く前の件数で上限を判定する。
        let error = ZipSource::open_with_limits(&path, limits(1)).err().unwrap();
        assert_eq!(error.code(), "failed");
        assert!(error.to_string().contains("多すぎる"), "{error}");
    }

    /// `bytes` の中の `from` をすべて `to`(同じ長さ)に置き換え、置き換えた数を返す。
    fn replace_all(bytes: &mut [u8], from: &[u8], to: &[u8]) -> usize {
        assert_eq!(from.len(), to.len());
        let mut replaced = 0;
        for at in 0..=bytes.len() - from.len() {
            if &bytes[at..at + from.len()] == from {
                bytes[at..at + to.len()].copy_from_slice(to);
                replaced += 1;
            }
        }
        replaced
    }

    /// 復号後の名前だけが同じ ZIP が、zip クレートでは 1 件にまとめられることを前提として確かめ、
    /// そのうえで開かないことを確かめる。
    fn assert_rejected_as_decoded_duplicate(path: &Path) {
        let archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
        assert_eq!(archive.len(), 1);
        let error = ZipSource::open(path).err().unwrap();
        assert_eq!(error.code(), "unsupported_format");
        assert!(error.to_string().contains("数が合わない"), "{error}");
    }

    #[test]
    fn utf8_and_cp437_names_that_decode_the_same_are_not_opened() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cp437.zip");
        // `é.png` は UTF-8 フラグ付き(C3 A9)で書かれる。ASCII の `Q.png` はフラグ無しで書かれるので、
        // その `Q` を CP437 の `é`(0x82)に書き換える。生バイトは違うが復号後はどちらも `é.png`。
        write_zip(
            &path,
            &[
                ("é.png", test_images::png(10, 10)),
                ("Q.png", test_images::png(20, 20)),
            ],
        );
        let mut bytes = std::fs::read(&path).unwrap();
        assert_eq!(replace_all(&mut bytes, b"Q.png", b"\x82.png"), 2);
        std::fs::write(&path, bytes).unwrap();

        assert_rejected_as_decoded_duplicate(&path);
    }

    /// CRC-32(IEEE)。Unicode Path 拡張フィールドが元の名前の検査値として持つ。
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn unicode_path_extra_field_that_renames_to_an_existing_name_is_not_opened() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unicode-path.zip");
        // zip クレートは 0x7075 を直接書かせないので、仮の ID(0x6666)で書いてから ID だけ書き換える。
        const PLACEHOLDER_ID: u16 = 0x6666;
        let mut field = vec![1u8];
        field.extend_from_slice(&crc32(b"b.png").to_le_bytes());
        field.extend_from_slice(b"a.png");
        let mut options = FullFileOptions::default();
        options
            .add_extra_data(PLACEHOLDER_ID, field.clone().into_boxed_slice(), true)
            .unwrap();
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer
            .start_file("a.png", SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, &test_images::png(10, 10)).unwrap();
        writer.start_file("b.png", options).unwrap();
        std::io::Write::write_all(&mut writer, &test_images::png(20, 20)).unwrap();
        writer.finish().unwrap();

        let mut bytes = std::fs::read(&path).unwrap();
        let mut from = PLACEHOLDER_ID.to_le_bytes().to_vec();
        from.extend_from_slice(&(field.len() as u16).to_le_bytes());
        let mut to = 0x7075u16.to_le_bytes().to_vec();
        to.extend_from_slice(&(field.len() as u16).to_le_bytes());
        assert_eq!(replace_all(&mut bytes, &from, &to), 1);
        std::fs::write(&path, bytes).unwrap();

        assert_rejected_as_decoded_duplicate(&path);
    }

    #[test]
    fn pages_larger_than_the_limit_are_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.zip");
        let mut big = test_images::png(20, 30);
        big.resize(4096, 0);
        write_zip(
            &path,
            &[("1.png", test_images::png(10, 10)), ("2.png", big)],
        );
        let limits = ZipLimits {
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_page_bytes: 1024,
        };

        let source = ZipSource::open_with_limits(&path, limits).unwrap();

        assert_eq!(source.page_size(1), Some((20, 30)));
        assert_eq!(source.read_page(0).unwrap(), test_images::png(10, 10));
        assert_eq!(source.read_page(1).unwrap_err().code(), "page_too_large");
    }

    #[test]
    fn keeps_the_archive_open_instead_of_reopening_it_per_page() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.zip");
        write_zip(
            &path,
            &[
                ("1.png", test_images::png(10, 10)),
                ("2.png", test_images::png(20, 20)),
            ],
        );
        let source = ZipSource::open(&path).unwrap();

        // 開いた後に元のパスから消えても、開いたままのハンドルから読める。
        std::fs::rename(&path, dir.path().join("moved.zip")).unwrap();

        assert_eq!(source.read_page(1).unwrap(), test_images::png(20, 20));
        assert_eq!(source.read_page(0).unwrap(), test_images::png(10, 10));
        assert!(!path.exists());
    }

    #[test]
    fn archive_without_images_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("text.zip");
        write_zip(&path, &[("readme.txt", b"text".to_vec())]);

        assert_eq!(ZipSource::open(&path).err().unwrap().code(), "no_pages");
    }
}
