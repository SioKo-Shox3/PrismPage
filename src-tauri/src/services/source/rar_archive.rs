//! RAR / CBR を 1 冊として読むページソース。
//! RAR は途中から読み出せない(固体圧縮では前のエントリを展開しないと次を読めない)ので、開いた時点で
//! 画像エントリをすべて一時フォルダへ展開し、以後はそのファイルを読む。一時フォルダはソースを手放すと消す。
//! 展開先のファイル名はエントリ名から作らず連番にする(アーカイブ内の名前が展開先の場所を決めない)。
//! エントリ名は表示と並び順にだけ使い、`..`・絶対パス・ドライブ文字を含むものは ZIP と同じく無視する。
//! RAR の読み出しは UnRAR のソース(unrar クレートが同梱)を使う。
//! UnRAR にはファイルを作らせない。中身はメモリへ読み出し(UnRAR の検査モード)、展開先へはこちらで書く。
//! リンク(シンボリックリンク・ジャンクション・ハードリンク・ファイル参照)のエントリは、
//! 読み出す前にヘッダーのリンク種別を見て一覧から外す。

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::OnceLock;

use tempfile::TempDir;
use unrar::{Archive, FileHeader};

use super::dimensions::read_dimensions;
use super::zip_archive::{natural_path_cmp, safe_entry_name, MAX_ARCHIVE_ENTRIES};
use super::{is_supported_image_path, PageSource, MAX_PAGE_BYTES};
use crate::app_error::{AppError, AppResult};
use crate::models::PageInfo;

/// RAR として読むアーカイブの拡張子。
pub const RAR_EXTENSIONS: &[&str] = &["rar", "cbr"];

/// 1 冊を展開して一時フォルダに置くバイト数の上限(宣言された展開後サイズの合計)。
pub const MAX_EXTRACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// 一時フォルダの名前の頭。起動時の掃除はこの頭のフォルダだけを消す。
const EXTRACT_DIR_PREFIX: &str = "book-";

/// 表紙を探すときに試す画像の数。寸法を読めない画像が続く本は表紙無しにする。
const MAX_COVER_TRIES: usize = 8;

/// 展開するときの上限。
#[derive(Debug, Clone, Copy)]
pub struct RarLimits {
    /// エントリ数の上限(フォルダ・画像以外を含む)。超えるアーカイブは開かない。
    pub max_entries: usize,
    /// 1 エントリの展開後サイズの上限。超える画像は除く。
    pub max_page_bytes: u64,
    /// 展開する画像の展開後サイズの合計の上限。超えるアーカイブは開かない。
    pub max_total_bytes: u64,
}

impl Default for RarLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_ARCHIVE_ENTRIES,
            max_page_bytes: MAX_PAGE_BYTES,
            max_total_bytes: MAX_EXTRACT_BYTES,
        }
    }
}

static EXTRACT_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 展開用の一時フォルダの親を決め、前回の実行が残した一時フォルダを消す(アプリの起動時に 1 回呼ぶ)。
/// 異常終了で `Drop` が走らなかった分の後片付け。二重起動は単一インスタンスで防いでいるので、
/// ほかのプロセスが使っている一時フォルダは無い。
pub fn init_extract_root(root: PathBuf) {
    remove_leftovers(&root);
    let _ = EXTRACT_ROOT.set(root);
}

/// 展開用の一時フォルダの親。`init_extract_root` の前はシステムの一時フォルダの下を使う。
fn extract_root() -> PathBuf {
    EXTRACT_ROOT
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("PrismPage").join("rar"))
}

/// `root` の直下にある展開用の一時フォルダ(`EXTRACT_DIR_PREFIX` で始まるもの)を消す。
/// ほかのファイル・フォルダには触らない。
pub(crate) fn remove_leftovers(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let is_extract_dir = entry
            .file_name()
            .to_string_lossy()
            .starts_with(EXTRACT_DIR_PREFIX)
            && entry.file_type().is_ok_and(|kind| kind.is_dir());
        if is_extract_dir {
            if let Err(error) = fs::remove_dir_all(entry.path()) {
                log::warn!(
                    "前回の展開用の一時フォルダを消せませんでした({}): {error}",
                    entry.path().display()
                );
            }
        }
    }
}

pub struct RarSource {
    pages: Vec<PageInfo>,
    /// ページごとの展開したファイル。
    files: Vec<PathBuf>,
    /// ページごとの中身の目印(CRC-32 と展開後のサイズ)。
    revisions: Vec<u64>,
    max_page_bytes: u64,
    /// 展開先。落とすとフォルダごと消える。
    dir: TempDir,
}

impl RarSource {
    pub fn open(path: &Path) -> AppResult<Self> {
        Self::open_in(path, &extract_root(), RarLimits::default())
    }

    /// `root` の下に一時フォルダを作って画像エントリを展開し、エントリ名の自然順に並べる。
    /// 寸法を読めない・展開できない(暗号化など)エントリは表示できないので除く。
    /// 失敗したときは一時フォルダを消してから返す。
    pub fn open_in(path: &Path, root: &Path, limits: RarLimits) -> AppResult<Self> {
        Self::open_filtered(path, root, limits, None)
    }

    /// 表紙(本を開いたときの 1 ページ目)だけを展開して開く。サムネイル用で、ページは 1 つだけになる。
    /// 1 冊を丸ごと展開しないよう、先にエントリ名だけを読んで自然順の先頭から 1 枚ずつ試す。
    pub fn open_cover(path: &Path) -> AppResult<Self> {
        Self::open_cover_in(path, &extract_root(), RarLimits::default())
    }

    pub fn open_cover_in(path: &Path, root: &Path, limits: RarLimits) -> AppResult<Self> {
        for name in list_image_names(path, limits)?.iter().take(MAX_COVER_TRIES) {
            match Self::open_filtered(path, root, limits, Some(name)) {
                Err(AppError::NoPages) => continue,
                result => return result,
            }
        }
        Err(AppError::NoPages)
    }

    /// `only` を渡すとその名前のエントリだけを展開する。
    fn open_filtered(
        path: &Path,
        root: &Path,
        limits: RarLimits,
        only: Option<&str>,
    ) -> AppResult<Self> {
        fs::create_dir_all(root)?;
        let dir = tempfile::Builder::new()
            .prefix(EXTRACT_DIR_PREFIX)
            .tempdir_in(root)?;
        // UnRAR の包みが想定外の戻り値で panic しても、アプリを落とさずこの本を開けないだけにする。
        let extracted = panic::catch_unwind(AssertUnwindSafe(|| {
            extract_images(path, dir.path(), limits, only)
        }))
        .unwrap_or_else(|_| Err(AppError::Message("RAR の展開が異常終了しました。".into())))?;

        let mut pages = Vec::with_capacity(extracted.len());
        let mut files = Vec::with_capacity(extracted.len());
        let mut revisions = Vec::with_capacity(extracted.len());
        for image in extracted {
            let size = File::open(&image.file)
                .ok()
                .and_then(|file| read_dimensions(file, limits.max_page_bytes));
            match size {
                Some((width, height)) => {
                    pages.push(PageInfo {
                        name: image.name,
                        width,
                        height,
                        spread: None,
                    });
                    files.push(image.file);
                    revisions.push(image.revision);
                }
                None => {
                    log::warn!("画像の寸法を読めないため除外します: {}", image.name);
                    let _ = fs::remove_file(&image.file);
                }
            }
        }
        if pages.is_empty() {
            return Err(AppError::NoPages);
        }
        Ok(Self {
            pages,
            files,
            revisions,
            max_page_bytes: limits.max_page_bytes,
            dir,
        })
    }

    /// 展開先の一時フォルダ(テスト用)。
    #[cfg(test)]
    fn dir(&self) -> &Path {
        self.dir.path()
    }
}

impl PageSource for RarSource {
    fn pages(&self) -> &[PageInfo] {
        &self.pages
    }

    fn read_page(&self, index: usize) -> AppResult<Vec<u8>> {
        let file = self.files.get(index).ok_or(AppError::PageOutOfRange {
            index,
            count: self.files.len(),
        })?;
        if fs::metadata(file)?.len() > self.max_page_bytes {
            return Err(AppError::PageTooLarge);
        }
        Ok(fs::read(file)?)
    }

    fn page_revision(&self, index: usize) -> Option<u64> {
        self.revisions.get(index).copied()
    }
}

/// 展開した画像 1 枚。
struct ExtractedImage {
    /// アーカイブ内の名前(`/` 区切りに整えたもの)。
    name: String,
    file: PathBuf,
    revision: u64,
}

/// アーカイブを先頭から読み、画像エントリを `dir` の下へ連番の名前で展開する。並びはエントリ名の自然順。
/// `only` を渡すとその名前のエントリだけを展開する。
fn extract_images(
    path: &Path,
    dir: &Path,
    limits: RarLimits,
    only: Option<&str>,
) -> AppResult<Vec<ExtractedImage>> {
    // 中身を読む前に、各エントリのリンク種別を読んでおく。
    let kinds = read_entry_kinds(path, limits)?;
    let mut archive = Archive::new(path)
        .open_for_processing()
        .map_err(|error| rar_error(path, &error))?;
    let mut names = HashSet::new();
    let mut images = Vec::new();
    let mut entry_count = 0usize;
    let mut total_bytes = 0u64;

    loop {
        let Some(header) = archive
            .read_header()
            .map_err(|error| rar_error(path, &error))?
        else {
            break;
        };
        entry_count += 1;
        if entry_count > limits.max_entries {
            return Err(too_many_entries(limits));
        }
        let entry = header.entry();
        let redir_type = redir_type_of(&kinds, entry_count - 1, entry)?;
        let Some(name) = image_entry_name(entry, redir_type, &mut names, limits)? else {
            archive = header.skip().map_err(|error| rar_error(path, &error))?;
            continue;
        };
        if only.is_some_and(|only| only != name) {
            archive = header.skip().map_err(|error| rar_error(path, &error))?;
            continue;
        }
        total_bytes = total_bytes.saturating_add(entry.unpacked_size);
        if total_bytes > limits.max_total_bytes {
            return Err(AppError::Message(format!(
                "展開後の大きさが上限({} GiB)を超えるため開けません。",
                limits.max_total_bytes / (1024 * 1024 * 1024)
            )));
        }

        let revision = (u64::from(entry.file_crc) << 32) ^ entry.unpacked_size;
        let extension = name.rsplit_once('.').map_or("", |(_, extension)| extension);
        let file = dir.join(format!(
            "{:06}.{}",
            images.len(),
            extension.to_ascii_lowercase()
        ));
        // 検査モードで中身をメモリへ読み出すので、UnRAR はファイル・リンクを作らず属性も変えない。
        match header.read() {
            Ok((bytes, next)) => {
                archive = next;
                if bytes.len() as u64 > limits.max_page_bytes {
                    log::warn!("展開した画像が大きすぎるため除外します: {name}");
                    continue;
                }
                write_new_file(&file, &bytes)?;
                images.push(ExtractedImage {
                    name,
                    file,
                    revision,
                });
            }
            // 展開に失敗(CRC 不一致など)すると読み口を失うので、そこで打ち切って展開できた分で開く。
            Err(error) => {
                log::warn!("RAR のエントリを展開できません({name}): {error}");
                if images.is_empty() {
                    return Err(rar_error(path, &error));
                }
                break;
            }
        }
    }

    images.sort_by(|left, right| natural_path_cmp(&left.name, &right.name));
    Ok(images)
}

/// エントリの中身を読まずに、展開する画像の名前を自然順に並べて返す。
fn list_image_names(path: &Path, limits: RarLimits) -> AppResult<Vec<String>> {
    let kinds = read_entry_kinds(path, limits)?;
    let listing = Archive::new(path)
        .open_for_listing()
        .map_err(|error| rar_error(path, &error))?;
    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for (count, entry) in listing.enumerate() {
        if count >= limits.max_entries {
            return Err(too_many_entries(limits));
        }
        let entry = entry.map_err(|error| rar_error(path, &error))?;
        let redir_type = redir_type_of(&kinds, count, &entry)?;
        if let Some(name) = image_entry_name(&entry, redir_type, &mut seen, limits)? {
            names.push(name);
        }
    }
    names.sort_by(|left, right| natural_path_cmp(left, right));
    Ok(names)
}

/// 展開する画像エントリなら、`/` 区切りに整えた名前。フォルダ・リンク・画像以外・安全でない名前・
/// 分割アーカイブの続きの断片・暗号化・大きすぎるものは `None`。同じ名前が 2 度目に出たらエラー。
/// `redir_type` はそのエントリのリンク種別(`read_entry_kinds` で読んだもの)。
fn image_entry_name(
    entry: &FileHeader,
    redir_type: u32,
    seen: &mut HashSet<String>,
    limits: RarLimits,
) -> AppResult<Option<String>> {
    if !entry.is_file() {
        return Ok(None);
    }
    if is_link_entry(redir_type) {
        log::warn!(
            "リンクのエントリは展開しません: {}",
            entry.filename.to_string_lossy()
        );
        return Ok(None);
    }
    let raw_name = entry.filename.to_string_lossy();
    let Some(name) = safe_entry_name(&raw_name) else {
        log::warn!("安全でないエントリ名を無視します: {raw_name}");
        return Ok(None);
    };
    // 分割アーカイブの続きの断片は、先頭の巻から読んだときに 1 つのエントリとして読まれる。
    if !is_supported_image_path(&name) || entry.is_split_before() {
        return Ok(None);
    }
    if !seen.insert(name.clone()) {
        return Err(AppError::UnsupportedFormat(format!(
            "同じ名前のエントリが複数あるアーカイブです({name})"
        )));
    }
    if entry.unpacked_size > limits.max_page_bytes || entry.is_encrypted() {
        log::warn!("大きすぎるか暗号化された画像を除外します: {name}");
        return Ok(None);
    }
    Ok(Some(name))
}

fn too_many_entries(limits: RarLimits) -> AppError {
    AppError::Message(format!(
        "アーカイブのエントリが多すぎるため開けません(上限 {} 件)。",
        limits.max_entries
    ))
}

/// 展開先に新しいファイルを作って書く。同じ名前が既にあれば上書きせず失敗する。
/// 書き損じたら、ここで作った途中のファイルだけを消す。
fn write_new_file(file: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut out = File::create_new(file)?;
    if let Err(error) = out.write_all(bytes) {
        drop(out);
        let _ = fs::remove_file(file);
        return Err(error.into());
    }
    Ok(())
}

/// UnRAR のリンク種別(`RedirType`)の「リンクでない」。1 以上は Unix のシンボリックリンク・
/// Windows のシンボリックリンク・ジャンクション・ハードリンク・ファイル参照(`FSREDIR_*`)。
const REDIR_NONE: u32 = 0;

/// リンク種別がリンク・ファイル参照か。知らない種別もリンクとして扱い、展開しない。
fn is_link_entry(redir_type: u32) -> bool {
    redir_type != REDIR_NONE
}

/// ヘッダーだけを読んだエントリ 1 件。
#[derive(Debug)]
struct EntryKind {
    name: String,
    redir_type: u32,
}

/// `index` 番目のエントリのリンク種別。ヘッダーだけを読んだときと名前が食い違えば
/// (読む間にアーカイブが変わった)開かない。
fn redir_type_of(kinds: &[EntryKind], index: usize, entry: &FileHeader) -> AppResult<u32> {
    match kinds.get(index) {
        Some(kind) if kind.name == entry.filename.to_string_lossy() => Ok(kind.redir_type),
        _ => Err(AppError::Message(
            "RAR を読んでいる間に中身が変わったため開けません。".into(),
        )),
    }
}

/// UnRAR の `RARHeaderDataEx`(`dll.hpp`)。UnRAR 側は 1 バイト境界に詰めて宣言しているが、
/// `unrar_sys::HeaderDataEx` は詰めていないため、最初のポインタより後ろ(`RedirType` を含む)の位置がずれる。
/// そのため同じ並びを詰めて宣言し直して使う。
#[repr(C, packed)]
struct RarHeaderDataEx {
    arc_name: [std::ffi::c_char; 1024],
    arc_name_w: [unrar_sys::WCHAR; 1024],
    file_name: [std::ffi::c_char; 1024],
    file_name_w: [unrar_sys::WCHAR; 1024],
    flags: u32,
    pack_size: u32,
    pack_size_high: u32,
    unp_size: u32,
    unp_size_high: u32,
    host_os: u32,
    file_crc: u32,
    file_time: u32,
    unp_ver: u32,
    method: u32,
    file_attr: u32,
    cmt_buf: *mut std::ffi::c_char,
    cmt_buf_size: u32,
    cmt_size: u32,
    cmt_state: u32,
    dict_size: u32,
    hash_type: u32,
    hash: [std::ffi::c_char; 32],
    redir_type: u32,
    redir_name: *mut unrar_sys::WCHAR,
    redir_name_size: u32,
    dir_target: u32,
    mtime_low: u32,
    mtime_high: u32,
    ctime_low: u32,
    ctime_high: u32,
    atime_low: u32,
    atime_high: u32,
    arc_name_ex: *mut unrar_sys::WCHAR,
    arc_name_ex_size: u32,
    file_name_ex: *mut unrar_sys::WCHAR,
    file_name_ex_size: u32,
    reserved: [u32; 982],
}

impl RarHeaderDataEx {
    /// すべて 0 の値(UnRAR は未使用の領域が 0 であることを求める)。
    fn zeroed() -> Self {
        // 整数・整数の配列・生ポインタだけなので、すべて 0 のビット列は正しい値。
        unsafe { std::mem::zeroed() }
    }
}

/// UnRAR で開いたアーカイブ。落とすと閉じる。
struct NativeArchive(NonNull<unrar_sys::Handle>);

impl Drop for NativeArchive {
    fn drop(&mut self) {
        unsafe { unrar_sys::RARCloseArchive(self.0.as_ptr()) };
    }
}

/// エントリの名前とリンク種別を並び順に読む。一覧用に開いてヘッダーだけを読み、中身は読まない。
/// unrar クレートはリンク種別を返さないので、同梱の UnRAR を直接呼ぶ。
fn read_entry_kinds(path: &Path, limits: RarLimits) -> AppResult<Vec<EntryKind>> {
    let archive = open_native_for_listing(path)?;
    let mut kinds = Vec::new();
    loop {
        let mut header = RarHeaderDataEx::zeroed();
        let code = unsafe {
            unrar_sys::RARReadHeaderEx(
                archive.0.as_ptr(),
                (&mut header as *mut RarHeaderDataEx).cast(),
            )
        };
        if code == unrar_sys::ERAR_END_ARCHIVE {
            break;
        }
        if code != unrar_sys::ERAR_SUCCESS {
            return Err(native_error(path, code));
        }
        if kinds.len() >= limits.max_entries {
            return Err(too_many_entries(limits));
        }
        // 詰めた構造体のフィールドは参照を取らず、値として写してから使う。
        let file_name_w = header.file_name_w;
        kinds.push(EntryKind {
            name: wide_to_string(&file_name_w),
            redir_type: header.redir_type,
        });
        let code = unsafe {
            unrar_sys::RARProcessFile(
                archive.0.as_ptr(),
                unrar_sys::RAR_SKIP,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if code != unrar_sys::ERAR_SUCCESS {
            return Err(native_error(path, code));
        }
    }
    Ok(kinds)
}

fn open_native_for_listing(path: &Path) -> AppResult<NativeArchive> {
    #[cfg(windows)]
    let name: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    };
    #[cfg(not(windows))]
    let name = {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| AppError::UnsupportedFormat(path.display().to_string()))?
    };
    let mut data = unrar_sys::OpenArchiveDataEx {
        archive_name: std::ptr::null(),
        archive_name_w: std::ptr::null(),
        open_mode: unrar_sys::RAR_OM_LIST,
        open_result: 0,
        comment_buffer: std::ptr::null_mut(),
        comment_buffer_size: 0,
        comment_size: 0,
        comment_state: 0,
        flags: 0,
        callback: None,
        user_data: 0,
        op_flags: 0,
        comment_buffer_w: std::ptr::null_mut(),
        reserved: [0; 25],
    };
    #[cfg(windows)]
    {
        data.archive_name_w = name.as_ptr().cast();
    }
    #[cfg(not(windows))]
    {
        data.archive_name = name.as_ptr();
    }
    // UnRAR は `open_result` などを書き戻すので、書き込める指し先として渡す。
    let handle = unsafe { unrar_sys::RAROpenArchiveEx(std::ptr::addr_of_mut!(data)) };
    let handle = NonNull::new(handle.cast_mut()).map(NativeArchive);
    match handle {
        Some(archive) if data.open_result == 0 => Ok(archive),
        _ => Err(native_error(path, data.open_result as i32)),
    }
}

/// UnRAR の返す NUL 終端のワイド文字列を読む。
fn wide_to_string(wide: &[unrar_sys::WCHAR]) -> String {
    let units = wide.iter().take_while(|unit| **unit != 0);
    #[cfg(windows)]
    {
        String::from_utf16_lossy(&units.copied().collect::<Vec<u16>>())
    }
    #[cfg(not(windows))]
    {
        units
            .map(|unit| char::from_u32(*unit as u32).unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    }
}

fn native_error(path: &Path, code: i32) -> AppError {
    AppError::UnsupportedFormat(format!(
        "RAR を読めません({}): UnRAR のエラー {code}",
        path.display()
    ))
}

fn rar_error(path: &Path, error: &unrar::error::UnrarError) -> AppError {
    AppError::UnsupportedFormat(format!("RAR を読めません({}): {error}", path.display()))
}

#[cfg(test)]
pub(crate) mod test_archives {
    //! テスト用に RAR 4 形式の無圧縮アーカイブをその場で作る(RAR を作る道具が無くても試せるように)。
    use std::path::Path;

    const MARKER: &[u8] = b"Rar!\x1a\x07\x00";

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    /// 種類・フラグ・本体からブロックを作る。先頭の CRC は種類以降の CRC-32 の下位 16 ビット。
    fn block(kind: u8, flags: u16, body: &[u8]) -> Vec<u8> {
        let size = u16::try_from(7 + body.len()).unwrap();
        let mut rest = vec![kind];
        rest.extend_from_slice(&flags.to_le_bytes());
        rest.extend_from_slice(&size.to_le_bytes());
        rest.extend_from_slice(body);
        let mut out = (crc32(&rest) as u16).to_le_bytes().to_vec();
        out.extend_from_slice(&rest);
        out
    }

    /// RAR 4 の Unicode 名。互換用の名前(ASCII 以外は `_`)・NUL・上位バイト 0・
    /// 「2 バイトそのまま」を 4 文字ずつ示すフラグ(0xaa)と UTF-16 の文字を続ける。
    fn encode_name(name: &str) -> Vec<u8> {
        let mut out: Vec<u8> = name
            .chars()
            .map(|ch| if ch.is_ascii() { ch as u8 } else { b'_' })
            .collect();
        out.push(0);
        out.push(0);
        let units: Vec<u16> = name.encode_utf16().collect();
        for chunk in units.chunks(4) {
            out.push(0xaa);
            for unit in chunk {
                out.extend_from_slice(&unit.to_le_bytes());
            }
        }
        out
    }

    /// `(エントリ名, 中身)` を順に書いた RAR を `path` に作る。名前が `/` で終われば(`/` を除いた名前の)フォルダ。
    pub fn write_rar(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let mut out = MARKER.to_vec();
        out.extend(block(0x73, 0, &[0; 6]));
        for (name, data) in entries {
            let is_dir = name.ends_with('/');
            let stored_name = encode_name(name.trim_end_matches('/'));
            let data: &[u8] = if is_dir { &[] } else { data };
            // 0x8000: 本体の後にデータが続く / 0x0200: 名前が Unicode / 0x00e0: フォルダ。
            let flags = 0x8000 | 0x0200 | if is_dir { 0x00e0 } else { 0 };
            let mut body = Vec::new();
            body.extend_from_slice(&(data.len() as u32).to_le_bytes()); // 格納サイズ
            body.extend_from_slice(&(data.len() as u32).to_le_bytes()); // 展開後サイズ
            body.push(2); // 作った OS(Windows)
            body.extend_from_slice(&crc32(data).to_le_bytes());
            body.extend_from_slice(&0x5921_0000u32.to_le_bytes()); // 更新日時(DOS 形式)
            body.push(29); // 展開に要る版
            body.push(0x30); // 無圧縮
            body.extend_from_slice(&(stored_name.len() as u16).to_le_bytes());
            body.extend_from_slice(&(if is_dir { 0x10u32 } else { 0x20 }).to_le_bytes());
            body.extend_from_slice(&stored_name);
            out.extend(block(0x74, flags, &body));
            out.extend_from_slice(data);
        }
        out.extend(block(0x7b, 0x4000, &[]));
        std::fs::write(path, out).unwrap();
    }

    /// RAR 5 のエントリ 1 件。`link` があれば `(リンク種別, 参照先)` のリンクで、中身を持たない。
    pub struct Rar5Entry<'a> {
        pub name: &'a str,
        pub data: Vec<u8>,
        pub link: Option<(u32, &'a str)>,
    }

    /// RAR 5 の可変長整数(7 ビットずつ、続きがあれば最上位ビットを立てる)。
    fn vint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return out;
            }
            out.push(byte | 0x80);
        }
    }

    /// RAR 5 のヘッダー。先頭は「ヘッダーの大きさ」以降の CRC-32、続けて大きさ・種類・フラグ・本体。
    fn block5(kind: u64, flags: u64, body: &[u8]) -> Vec<u8> {
        let mut rest = vint(kind);
        rest.extend(vint(flags));
        rest.extend_from_slice(body);
        let mut sized = vint(rest.len() as u64);
        sized.extend(rest);
        let mut out = crc32(&sized).to_le_bytes().to_vec();
        out.extend(sized);
        out
    }

    /// RAR 5 形式の無圧縮アーカイブを `path` に作る(リンクのエントリを試すため)。
    pub fn write_rar5(path: &Path, entries: &[Rar5Entry]) {
        let mut out = b"Rar!\x1a\x07\x01\x00".to_vec();
        out.extend(block5(1, 0, &vint(0)));
        for entry in entries {
            let data: &[u8] = if entry.link.is_some() {
                &[]
            } else {
                &entry.data
            };
            let mut extra = Vec::new();
            if let Some((redir_type, target)) = entry.link {
                // 種類 5: リンク(リンク種別・フラグ・参照先の名前)。
                let mut record = vint(5);
                record.extend(vint(u64::from(redir_type)));
                record.extend(vint(0));
                record.extend(vint(target.len() as u64));
                record.extend_from_slice(target.as_bytes());
                extra.extend(vint(record.len() as u64));
                extra.extend(record);
            }
            let mut body = Vec::new();
            // 0x0001: 追加領域あり / 0x0002: データ領域あり。
            let mut flags = 0;
            if !extra.is_empty() {
                flags |= 0x0001;
                body.extend(vint(extra.len() as u64));
            }
            if !data.is_empty() {
                flags |= 0x0002;
                body.extend(vint(data.len() as u64));
            }
            body.extend(vint(0x0004)); // ファイルのフラグ: CRC-32 あり
            body.extend(vint(data.len() as u64)); // 展開後サイズ
            body.extend(vint(0x20)); // 属性
            body.extend_from_slice(&crc32(data).to_le_bytes());
            body.extend(vint(0)); // 圧縮の情報: 無圧縮
            body.extend(vint(0)); // 作った OS(Windows)
            body.extend(vint(entry.name.len() as u64));
            body.extend_from_slice(entry.name.as_bytes());
            body.extend(extra);
            out.extend(block5(2, flags, &body));
            out.extend_from_slice(data);
        }
        out.extend(block5(5, 0, &vint(0)));
        std::fs::write(path, out).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_archives::{write_rar, write_rar5, Rar5Entry};
    use super::*;
    use crate::services::source::test_images::{jpeg, png};

    fn entries_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn reads_image_entries_in_natural_order_from_a_temporary_folder() {
        let work = tempfile::tempdir().unwrap();
        let book = work.path().join("本.cbr");
        write_rar(
            &book,
            &[
                ("第1話/10.png", png(3, 4)),
                ("第1話/", Vec::new()),
                ("第1話/2.jpg", jpeg(5, 6)),
                ("readme.txt", b"text".to_vec()),
                ("第1話/表紙.png", png(7, 8)),
            ],
        );
        let root = work.path().join("extract");
        let source = RarSource::open_in(&book, &root, RarLimits::default()).unwrap();

        let pages: Vec<(&str, u32, u32)> = source
            .pages()
            .iter()
            .map(|page| (page.name.as_str(), page.width, page.height))
            .collect();
        assert_eq!(
            pages,
            vec![
                ("第1話/2.jpg", 5, 6),
                ("第1話/10.png", 3, 4),
                ("第1話/表紙.png", 7, 8)
            ]
        );
        assert_eq!(source.read_page(1).unwrap(), png(3, 4));
        assert!(source.dir().starts_with(&root));
        assert!(matches!(
            source.read_page(3),
            Err(AppError::PageOutOfRange { index: 3, count: 3 })
        ));
        // 中身が同じページは同じ目印、違えば違う目印。
        assert_ne!(source.page_revision(0), source.page_revision(1));
        assert!(source.page_revision(3).is_none());
    }

    #[test]
    fn dropping_the_source_removes_its_temporary_folder() {
        let work = tempfile::tempdir().unwrap();
        let book = work.path().join("a.rar");
        write_rar(&book, &[("1.png", png(2, 2)), ("2.png", png(2, 3))]);
        let root = work.path().join("extract");

        let source = RarSource::open_in(&book, &root, RarLimits::default()).unwrap();
        let dir = source.dir().to_path_buf();
        assert_eq!(entries_in(&dir).len(), 2);
        drop(source);

        assert!(!dir.exists());
        assert!(entries_in(&root).is_empty());
        // 元のアーカイブには触らない。
        assert!(book.is_file());
    }

    #[test]
    fn failing_to_open_leaves_no_temporary_folder() {
        let work = tempfile::tempdir().unwrap();
        let root = work.path().join("extract");

        let no_images = work.path().join("text.rar");
        write_rar(&no_images, &[("a.txt", b"a".to_vec())]);
        assert!(matches!(
            RarSource::open_in(&no_images, &root, RarLimits::default()),
            Err(AppError::NoPages)
        ));

        let broken = work.path().join("broken.rar");
        fs::write(&broken, b"Rar!\x1a\x07\x00not a real archive").unwrap();
        assert!(RarSource::open_in(&broken, &root, RarLimits::default()).is_err());

        let unreadable_image = work.path().join("bad-image.rar");
        write_rar(&unreadable_image, &[("1.png", b"not a png".to_vec())]);
        assert!(matches!(
            RarSource::open_in(&unreadable_image, &root, RarLimits::default()),
            Err(AppError::NoPages)
        ));

        assert!(entries_in(&root).is_empty());
    }

    /// アーカイブの外を指す名前のエントリは読まず、展開先の外にも何も書かない。
    #[test]
    fn entries_pointing_outside_the_archive_are_ignored() {
        let work = tempfile::tempdir().unwrap();
        let book = work.path().join("evil.rar");
        write_rar(
            &book,
            &[
                ("../escape.png", png(2, 2)),
                ("a/../../escape2.png", png(2, 2)),
                ("C:/abs.png", png(2, 2)),
                ("/rooted.png", png(2, 2)),
                ("ok.png", png(4, 4)),
            ],
        );
        let root = work.path().join("nested").join("extract");
        let source = RarSource::open_in(&book, &root, RarLimits::default()).unwrap();

        // ドライブ文字は UnRAR が `C_` に置き換えて、アーカイブ内の相対名として読む。
        let names: Vec<&str> = source
            .pages()
            .iter()
            .map(|page| page.name.as_str())
            .collect();
        assert_eq!(names, vec!["C_/abs.png", "ok.png"]);
        // 展開先は連番の名前だけで、展開先の外(作業フォルダ・展開先の親)には何も増えない。
        assert_eq!(entries_in(source.dir()), vec!["000000.png", "000001.png"]);
        assert_eq!(entries_in(work.path()), vec!["evil.rar", "nested"]);
        assert_eq!(entries_in(&work.path().join("nested")), vec!["extract"]);
    }

    #[test]
    fn archives_over_the_limits_are_not_opened() {
        let work = tempfile::tempdir().unwrap();
        let root = work.path().join("extract");
        let book = work.path().join("many.rar");
        write_rar(
            &book,
            &[
                ("1.png", png(2, 2)),
                ("2.png", png(2, 2)),
                ("3.png", png(2, 2)),
            ],
        );

        let few_entries = RarLimits {
            max_entries: 2,
            ..RarLimits::default()
        };
        assert!(RarSource::open_in(&book, &root, few_entries).is_err());

        let small_total = RarLimits {
            max_total_bytes: png(2, 2).len() as u64 * 2,
            ..RarLimits::default()
        };
        assert!(RarSource::open_in(&book, &root, small_total).is_err());

        // 1 枚の上限を超える画像は除き、残りで開く。
        let big = work.path().join("big.rar");
        let mut padded = png(1, 1);
        padded.extend_from_slice(&[0; 1024]);
        write_rar(&big, &[("big.png", padded), ("small.png", png(1, 1))]);
        let small_pages = RarLimits {
            max_page_bytes: png(1, 1).len() as u64,
            ..RarLimits::default()
        };
        let source = RarSource::open_in(&big, &root, small_pages).unwrap();
        let names: Vec<&str> = source
            .pages()
            .iter()
            .map(|page| page.name.as_str())
            .collect();
        assert_eq!(names, vec!["small.png"]);
        drop(source);

        assert!(entries_in(&root).is_empty());
    }

    #[test]
    fn duplicate_names_are_rejected() {
        let work = tempfile::tempdir().unwrap();
        let book = work.path().join("dup.rar");
        write_rar(&book, &[("a/1.png", png(2, 2)), ("a\\1.png", png(3, 3))]);
        let root = work.path().join("extract");
        assert!(matches!(
            RarSource::open_in(&book, &root, RarLimits::default()),
            Err(AppError::UnsupportedFormat(_))
        ));
        assert!(entries_in(&root).is_empty());
    }

    /// 表紙用には、本を開いたときの 1 ページ目(寸法を読めない画像は飛ばす)だけを展開する。
    #[test]
    fn the_cover_is_extracted_alone() {
        let work = tempfile::tempdir().unwrap();
        let book = work.path().join("a.cbr");
        write_rar(
            &book,
            &[
                ("10.png", png(3, 3)),
                ("1.png", b"not a png".to_vec()),
                ("2.png", png(2, 5)),
                ("0.txt", b"text".to_vec()),
            ],
        );
        let root = work.path().join("extract");

        let cover = RarSource::open_cover_in(&book, &root, RarLimits::default()).unwrap();
        let pages: Vec<(&str, u32, u32)> = cover
            .pages()
            .iter()
            .map(|page| (page.name.as_str(), page.width, page.height))
            .collect();
        assert_eq!(pages, vec![("2.png", 2, 5)]);
        assert_eq!(cover.read_page(0).unwrap(), png(2, 5));
        assert_eq!(entries_in(cover.dir()).len(), 1);
        let full = RarSource::open_in(&book, &root, RarLimits::default()).unwrap();
        assert_eq!(full.pages()[0].name, "2.png");
        drop((cover, full));
        assert!(entries_in(&root).is_empty());

        let no_images = work.path().join("text.rar");
        write_rar(&no_images, &[("a.txt", b"a".to_vec())]);
        assert!(matches!(
            RarSource::open_cover_in(&no_images, &root, RarLimits::default()),
            Err(AppError::NoPages)
        ));
        assert!(entries_in(&root).is_empty());
    }

    fn image(name: &str, data: Vec<u8>) -> Rar5Entry<'_> {
        Rar5Entry {
            name,
            data,
            link: None,
        }
    }

    fn link<'a>(name: &'a str, redir_type: u32, target: &'a str) -> Rar5Entry<'a> {
        Rar5Entry {
            name,
            data: Vec::new(),
            link: Some((redir_type, target)),
        }
    }

    #[test]
    fn only_entries_without_a_redirection_are_regular() {
        assert!(!is_link_entry(0));
        // Unix / Windows のシンボリックリンク・ジャンクション・ハードリンク・ファイル参照と、知らない種別。
        for redir_type in 1..=6 {
            assert!(is_link_entry(redir_type));
        }
    }

    /// ヘッダーだけを読んで、エントリごとのリンク種別を並び順に返す。
    #[test]
    fn entry_kinds_report_the_redirection_type() {
        let work = tempfile::tempdir().unwrap();
        let book = work.path().join("links.rar");
        write_rar5(
            &book,
            &[
                image("1.png", png(2, 2)),
                link("hard.png", 4, "1.png"),
                link("sym.png", 2, "C:\\outside.png"),
            ],
        );
        let kinds: Vec<(String, u32)> = read_entry_kinds(&book, RarLimits::default())
            .unwrap()
            .into_iter()
            .map(|kind| (kind.name, kind.redir_type))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("1.png".to_string(), 0),
                ("hard.png".to_string(), 4),
                ("sym.png".to_string(), 2)
            ]
        );
    }

    /// アーカイブの外の画像を指すリンクのエントリは展開せず一覧から外し、参照先には触らない。
    /// 展開は展開先の一時フォルダの中だけで、作業フォルダ(cwd)にも何も作らない。
    #[test]
    fn link_entries_are_not_extracted_and_their_targets_are_untouched() {
        let work = tempfile::tempdir().unwrap();
        let outside = work.path().join("outside.png");
        fs::write(&outside, png(9, 9)).unwrap();
        let mut permissions = fs::metadata(&outside).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&outside, permissions).unwrap();
        let before = fs::metadata(&outside).unwrap();
        let outside_abs = outside.to_string_lossy().to_string();
        let outside_abs = outside_abs.as_str();

        let book = work.path().join("links.rar");
        write_rar5(
            &book,
            &[
                link("hard-abs.png", 4, outside_abs),
                link("hard-rel.png", 4, "outside.png"),
                link("hard-up.png", 4, "../outside.png"),
                link("copy.png", 5, outside_abs),
                link("unix.png", 1, outside_abs),
                link("win.png", 2, outside_abs),
                link("junction.png", 3, outside_abs),
                image("ok.png", png(4, 4)),
            ],
        );
        let root = work.path().join("extract");
        let source = RarSource::open_in(&book, &root, RarLimits::default()).unwrap();

        let names: Vec<&str> = source
            .pages()
            .iter()
            .map(|page| page.name.as_str())
            .collect();
        assert_eq!(names, vec!["ok.png"]);
        assert_eq!(entries_in(source.dir()), vec!["000000.png"]);
        // 表紙用の一覧からも外れる。
        assert_eq!(
            list_image_names(&book, RarLimits::default()).unwrap(),
            vec!["ok.png"]
        );

        // 参照先の中身・大きさ・更新日時・属性は変わらない。
        let after = fs::metadata(&outside).unwrap();
        assert_eq!(fs::read(&outside).unwrap(), png(9, 9));
        assert_eq!(after.len(), before.len());
        assert_eq!(after.modified().unwrap(), before.modified().unwrap());
        assert!(after.permissions().readonly());
        // 作業フォルダ・展開先の親には何も増えない。
        assert_eq!(
            entries_in(work.path()),
            vec!["extract", "links.rar", "outside.png"]
        );
        let cwd = std::env::current_dir().unwrap();
        for name in [
            "hard-abs.png",
            "hard-rel.png",
            "copy.png",
            "unix.png",
            "win.png",
            "junction.png",
        ] {
            assert!(!cwd.join(name).exists());
        }

        drop(source);
        let mut permissions = fs::metadata(&outside).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&outside, permissions).unwrap();
    }

    /// リンク種別の判定は名前の判定より前に行う(リンクと同じ名前の画像があっても、リンクは数えない)。
    #[test]
    fn links_are_excluded_before_names_are_checked() {
        let work = tempfile::tempdir().unwrap();
        let book = work.path().join("same-name.rar");
        write_rar5(
            &book,
            &[link("a.png", 4, "b.png"), image("a.png", png(3, 5))],
        );
        let root = work.path().join("extract");
        let source = RarSource::open_in(&book, &root, RarLimits::default()).unwrap();
        assert_eq!(source.pages().len(), 1);
        assert_eq!(source.read_page(0).unwrap(), png(3, 5));
    }

    /// ビューアを閉じる経路(`close_books`)で本がキャッシュから外れ、一時フォルダが消える。
    /// 超解像の処理などがハンドルを持っている間は残し、手放されたときに消す。
    #[test]
    fn closing_the_book_releases_it_from_the_cache_and_removes_its_folder() {
        use crate::services::source::{close_books, BookCache};
        use std::sync::Arc;

        let work = tempfile::tempdir().unwrap();
        let book = work.path().join("a.cbr");
        write_rar(&book, &[("1.png", png(2, 2))]);
        let neighbor = work.path().join("b.cbr");
        write_rar(&neighbor, &[("1.png", png(2, 2))]);
        let root = work.path().join("extract");
        let cache = BookCache::new(4);

        let opened = RarSource::open_in(&book, &root, RarLimits::default()).unwrap();
        let opened_dir = opened.dir().to_path_buf();
        cache.insert("book".into(), Arc::new(opened));
        let cover = RarSource::open_cover_in(&neighbor, &root, RarLimits::default()).unwrap();
        let cover_dir = cover.dir().to_path_buf();
        cache.insert("next".into(), Arc::new(cover));
        cache.insert(
            "other".into(),
            Arc::new(RarSource::open_in(&book, &root, RarLimits::default()).unwrap()),
        );

        // 読み出し中のハンドルがある間は消さない。
        let reading = cache.get("book").unwrap();
        let released = close_books(&cache, &["book".into(), "next".into(), "missing".into()]);
        assert_eq!(released.len(), 2);
        assert!(cache.get("book").is_none() && cache.get("next").is_none());
        assert!(cache.get("other").is_some());
        drop(released);
        assert!(opened_dir.is_dir());
        assert!(!cover_dir.exists());

        drop(reading);
        assert!(!opened_dir.exists());
        assert_eq!(entries_in(&root).len(), 1);
        assert!(book.is_file() && neighbor.is_file());
    }

    /// 起動時の掃除は展開用の一時フォルダだけを消し、ほかのものには触らない。
    #[test]
    fn leftovers_from_a_previous_run_are_removed() {
        let work = tempfile::tempdir().unwrap();
        let root = work.path().join("extract");
        fs::create_dir_all(root.join("book-old").join("sub")).unwrap();
        fs::write(root.join("book-old").join("000000.png"), b"x").unwrap();
        fs::create_dir_all(root.join("keep")).unwrap();
        fs::write(root.join("book-file.txt"), b"x").unwrap();

        remove_leftovers(&root);

        assert_eq!(entries_in(&root), vec!["book-file.txt", "keep"]);
        // 無いフォルダを渡しても何もしない。
        remove_leftovers(&work.path().join("missing"));
    }
}
