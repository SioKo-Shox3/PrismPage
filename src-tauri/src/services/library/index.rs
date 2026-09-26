//! 登録フォルダ全体の書名・パスの検索索引。
//! 索引はフォルダごとの記録(更新日時と直下の名前)の集まりで、作り直すときは更新日時が前回と同じフォルダの
//! 直下を読み直さず前回の記録を使う(差分更新)。フォルダの更新日時は直下の項目の追加・削除・名前の変更で変わる。
//! 載せる項目とたどる範囲はフォルダ画面の一覧と同じで、画像フォルダ(本)の中とリンクの先はたどらない。
//! 索引はアプリのデータ領域の `search-index.json` にだけ書き、元のファイルには書かない。

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::app_error::AppResult;
use crate::models::{BookFormat, EntryKind};
use crate::services::source::{is_supported_image_path, natural_cmp};

use super::file_format;

/// 保存する索引の形式の版。形式を変えたら上げる。版の違う保存は読み捨てて作り直す
/// (索引は元のフォルダから作り直せるので移行しない)。
pub const INDEX_VERSION: u32 = 1;
const INDEX_FILE: &str = "search-index.json";

/// 1 つのフォルダの記録。`modified` はフォルダの更新日時(UNIX エポックからの秒・ナノ秒)、
/// `has_images` は表示できる画像を直接含むか(含めば画像フォルダの本)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FolderRecord {
    modified: Option<(u64, u32)>,
    has_images: bool,
    folders: Vec<String>,
    books: Vec<(String, BookFormat)>,
}

/// 1 つの登録フォルダの索引。`folders` のキーは登録フォルダからの相対パス(`/` 区切り。登録フォルダそのものは空文字)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceIndex {
    root: String,
    folders: HashMap<String, FolderRecord>,
}

/// 検索の対象になる 1 項目。`folder` は項目のあるフォルダの登録フォルダからの相対パス(`/` 区切り)、
/// `path` は正規化した絶対パス(`list_entries` が返す場所と同じ)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedEntry {
    pub name: String,
    pub title: String,
    pub folder: String,
    pub path: PathBuf,
    pub kind: EntryKind,
    pub format: Option<BookFormat>,
    title_key: String,
    path_key: String,
}

impl IndexedEntry {
    /// 登録フォルダからの相対パス(`/` 区切り)。
    pub fn relative_path(&self) -> String {
        child_path(&self.folder, &self.name)
    }
}

/// 登録フォルダ `root`(正規化した絶対パス)を走査して索引を作る。`previous` が同じ登録フォルダの索引なら、
/// 更新日時が変わっていないフォルダは読み直さない。戻り値の 2 つ目は直下を読み直したフォルダの数。
/// 更新日時は直下を読む前に取るので、読む途中で変わったフォルダは次の走査で読み直される。
pub fn scan_source(root: &Path, previous: Option<&SourceIndex>) -> (SourceIndex, usize) {
    let root_text = root.to_string_lossy().to_string();
    let previous = previous.filter(|index| index.root == root_text);
    let mut folders = HashMap::new();
    let mut reread = 0;
    let mut pending = vec![String::new()];
    while let Some(relative) = pending.pop() {
        let dir = join_relative(root, &relative);
        let modified = fs::metadata(&dir).ok().and_then(|metadata| {
            let elapsed = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
            Some((elapsed.as_secs(), elapsed.subsec_nanos()))
        });
        let reused = previous
            .and_then(|index| index.folders.get(&relative))
            .filter(|record| modified.is_some() && record.modified == modified)
            .cloned();
        let record = match reused {
            Some(record) => record,
            None => {
                // 読めないフォルダは載せない(一覧でも中身の無いフォルダとして扱われる)。次の走査でまた読む。
                let Some(record) = read_folder(&dir, modified) else {
                    continue;
                };
                reread += 1;
                record
            }
        };
        // 画像フォルダは 1 冊の本なので中のフォルダはたどらない。登録フォルダそのものは画像があってもたどる。
        if relative.is_empty() || !record.has_images {
            pending.extend(record.folders.iter().map(|name| child_path(&relative, name)));
        }
        folders.insert(relative, record);
    }
    (
        SourceIndex {
            root: root_text,
            folders,
        },
        reread,
    )
}

/// フォルダの直下を読む。リンク(シンボリックリンク・ジャンクション)は載せない。
fn read_folder(dir: &Path, modified: Option<(u64, u32)>) -> Option<FolderRecord> {
    let entries = fs::read_dir(dir).ok()?;
    let mut record = FolderRecord {
        modified,
        has_images: false,
        folders: Vec::new(),
        books: Vec::new(),
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_symlink() {
            continue;
        } else if file_type.is_dir() {
            record.folders.push(name);
        } else if file_type.is_file() {
            if let Some(format) = file_format(Path::new(&name)) {
                record.books.push((name, format));
            } else if is_supported_image_path(&name) {
                record.has_images = true;
            }
        }
    }
    Some(record)
}

/// 索引から検索の対象を並べる。載せるのはフォルダ画面の一覧に出る項目(フォルダ・画像フォルダ・本のファイル)。
pub fn entries_of(index: &SourceIndex) -> Vec<IndexedEntry> {
    let root = Path::new(&index.root);
    let mut entries = Vec::new();
    for (relative, record) in &index.folders {
        if !relative.is_empty() && record.has_images {
            continue;
        }
        for name in &record.folders {
            // 読めなかったフォルダは画像を含まないフォルダとみなす(`list_entries` と同じ)。
            let is_book = index
                .folders
                .get(&child_path(relative, name))
                .is_some_and(|child| child.has_images);
            let (kind, format) = if is_book {
                (EntryKind::Book, Some(BookFormat::Folder))
            } else {
                (EntryKind::Folder, None)
            };
            entries.push(indexed_entry(root, relative, name, name, kind, format));
        }
        for (name, format) in &record.books {
            let title = Path::new(name)
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
                .unwrap_or_else(|| name.clone());
            entries.push(indexed_entry(root, relative, name, &title, EntryKind::Book, Some(*format)));
        }
    }
    entries
}

fn indexed_entry(
    root: &Path,
    folder: &str,
    name: &str,
    title: &str,
    kind: EntryKind,
    format: Option<BookFormat>,
) -> IndexedEntry {
    let relative = child_path(folder, name);
    IndexedEntry {
        name: name.to_string(),
        title: title.to_string(),
        folder: folder.to_string(),
        path: join_relative(root, &relative),
        kind,
        format,
        title_key: fold_for_search(title),
        path_key: fold_for_search(&relative),
    }
}

/// 検索のための正規化。全角の英数字・記号・空白を半角に、半角カナを全角に(濁点・半濁点は 1 文字にまとめる)し、
/// 小文字にそろえる。
pub fn fold_for_search(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let code = c as u32;
        let c = match code {
            0xFF01..=0xFF5E => char::from_u32(code - 0xFEE0).unwrap_or(c),
            0x3000 => ' ',
            0xFF61..=0xFF9F => {
                let base = HALFWIDTH_KANA[(code - 0xFF61) as usize];
                let mark = chars.peek().map(|next| *next as u32);
                match (combine_mark(base, mark), mark) {
                    (Some(combined), Some(_)) => {
                        chars.next();
                        combined
                    }
                    _ => base,
                }
            }
            _ => c,
        };
        folded.extend(c.to_lowercase());
    }
    folded
}

/// 半角カナ(U+FF61〜U+FF9F)に対応する全角の文字。
const HALFWIDTH_KANA: [char; 63] = [
    '。', '「', '」', '、', '・', 'ヲ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ', 'ッ', 'ー', 'ア', 'イ', 'ウ',
    'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ', 'タ', 'チ', 'ツ', 'テ', 'ト', 'ナ', 'ニ',
    'ヌ', 'ネ', 'ノ', 'ハ', 'ヒ', 'フ', 'ヘ', 'ホ', 'マ', 'ミ', 'ム', 'メ', 'モ', 'ヤ', 'ユ', 'ヨ', 'ラ', 'リ', 'ル',
    'レ', 'ロ', 'ワ', 'ン', '゛', '゜',
];

/// 全角にしたカナ `base` と、続く半角の濁点(U+FF9E)・半濁点(U+FF9F)を 1 文字にする。まとめられなければ `None`。
/// `base` は半角カナから移した清音なので、全角では濁音が +1、半濁音が +2 の位置にある
/// (カ〜トの間にある小さいッだけは濁音を持たない)。
fn combine_mark(base: char, mark: Option<u32>) -> Option<char> {
    let offset = match (mark?, base) {
        (0xFF9E, 'ウ') => return Some('ヴ'),
        (0xFF9E, 'ッ') => return None,
        (0xFF9E, 'カ'..='ト' | 'ハ'..='ホ') => 1,
        (0xFF9F, 'ハ'..='ホ') => 2,
        _ => return None,
    };
    char::from_u32(base as u32 + offset)
}

/// 検索語を正規化し、空白で区切った語の並びにする。
pub fn query_terms(query: &str) -> Vec<String> {
    fold_for_search(query)
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

/// 項目が検索語に合うか。すべての語が書名か登録フォルダからの相対パスのどこかに含まれれば合う。
/// 合うときは書名だけで合ったか(並びで前に出す)を返す。
pub fn matches(entry: &IndexedEntry, terms: &[String]) -> Option<bool> {
    if terms.is_empty() || !terms.iter().all(|term| entry.path_key.contains(term.as_str())) {
        return None;
    }
    Some(terms.iter().all(|term| entry.title_key.contains(term.as_str())))
}

/// 1 つの登録フォルダの検索。`within` があればそのフォルダ(登録フォルダからの相対パス)の中だけを探す。
/// 並びは書名で合った項目が先、次に相対パスの自然順。
pub fn search_entries<'a>(
    entries: &'a [IndexedEntry],
    terms: &[String],
    within: Option<&str>,
) -> Vec<(bool, &'a IndexedEntry)> {
    let within = within.map(normalize_relative).filter(|path| !path.is_empty());
    let mut hits: Vec<_> = entries
        .iter()
        .filter(|entry| match &within {
            Some(folder) => {
                entry.folder == *folder
                    || entry
                        .folder
                        .strip_prefix(folder.as_str())
                        .is_some_and(|rest| rest.starts_with('/'))
            }
            None => true,
        })
        .filter_map(|entry| matches(entry, terms).map(|by_title| (by_title, entry)))
        .collect();
    hits.sort_by(|left, right| compare_hits(left, right));
    hits
}

/// 検索結果の並び。書名で合った項目が先、次に相対パスの自然順(全角の数字も数として比べるよう正規化した値で比べる)。
pub fn compare_hits(left: &(bool, &IndexedEntry), right: &(bool, &IndexedEntry)) -> Ordering {
    right
        .0
        .cmp(&left.0)
        .then_with(|| natural_cmp(&left.1.path_key, &right.1.path_key))
        .then_with(|| natural_cmp(&left.1.relative_path(), &right.1.relative_path()))
}

/// 相対パスの区切りを `/` にそろえ、空の区切りを除く。
pub fn normalize_relative(path: &str) -> String {
    path.split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn child_path(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

fn join_relative(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

/// 保存する索引の中身。
#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    sources: HashMap<i64, SourceIndex>,
}

/// 保存した索引を読む。無い・壊れている・版が違うときは空(作り直す)。
pub fn load_indexes(data_dir: &Path) -> HashMap<i64, SourceIndex> {
    let Ok(bytes) = fs::read(data_dir.join(INDEX_FILE)) else {
        return HashMap::new();
    };
    match serde_json::from_slice::<IndexFile>(&bytes) {
        Ok(file) if file.version == INDEX_VERSION => file.sources,
        // 版の違う保存・読めない保存は捨てる。次の保存で今の版に書き換わる。
        _ => HashMap::new(),
    }
}

/// 索引を保存する。一時ファイルに書いてから置き換え、失敗したら一時ファイルを消す。
pub fn save_indexes(data_dir: &Path, sources: &HashMap<i64, SourceIndex>) -> AppResult<()> {
    #[derive(Serialize)]
    struct IndexFileRef<'a> {
        version: u32,
        sources: &'a HashMap<i64, SourceIndex>,
    }
    let bytes = serde_json::to_vec(&IndexFileRef {
        version: INDEX_VERSION,
        sources,
    })
    .map_err(|error| crate::app_error::AppError::Internal(format!("索引を書き出せません: {error}")))?;
    let target = data_dir.join(INDEX_FILE);
    let temporary = data_dir.join(format!("{INDEX_FILE}.tmp"));
    let written = fs::write(&temporary, bytes).and_then(|()| fs::rename(&temporary, &target));
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

/// 読み込んだ 1 つの登録フォルダの索引と、そこから並べた検索の対象。
struct LoadedSource {
    index: SourceIndex,
    entries: Vec<IndexedEntry>,
}

#[derive(Default)]
struct IndexState {
    /// 保存した索引を読み込んだか。
    loaded: bool,
    sources: HashMap<i64, LoadedSource>,
    /// 走査中の登録フォルダ。
    scanning: HashSet<i64>,
}

/// アプリ全体で 1 つの検索索引。走査は裏のスレッドで行い、検索は走査の途中でも前回の索引で答える。
#[derive(Default)]
pub struct LibraryIndex {
    state: Mutex<IndexState>,
    /// 保存を 1 つずつにする(一時ファイルの取り合いを防ぐ)。
    saving: Mutex<()>,
}

/// 1 つの登録フォルダの検索結果。`by_title` は書名で合ったか。
pub struct SourceHits {
    pub source_id: i64,
    pub hits: Vec<(bool, IndexedEntry)>,
}

impl LibraryIndex {
    /// 保存した索引をまだ読んでいなければ読む。
    pub fn load(&self, data_dir: &Path) {
        if self.lock().loaded {
            return;
        }
        let loaded = load_indexes(data_dir);
        let mut state = self.lock();
        if state.loaded {
            return;
        }
        state.loaded = true;
        for (id, index) in loaded {
            let entries = entries_of(&index);
            state.sources.entry(id).or_insert(LoadedSource { index, entries });
        }
    }

    /// 走査を始める。同じ登録フォルダを走査中なら偽(二重に走査しない)。
    pub fn begin_scan(&self, source_id: i64) -> bool {
        self.lock().scanning.insert(source_id)
    }

    /// 走査を始めずに取りやめる(走査の準備に失敗した、登録が外された)。前回の索引は残す。
    pub fn cancel_scan(&self, source_id: i64) {
        self.lock().scanning.remove(&source_id);
    }

    /// 索引を作り直す。`targets` の登録フォルダ(`(ID, 場所)`)を先にすべて走査中にしてから保存した索引を読み、
    /// 1 つずつ走査して保存する。先にすべてを走査中にするので、前のフォルダを読んでいる間に後のフォルダを探しても
    /// 作っている途中と分かる。ほかのスレッドが走査中のフォルダは飛ばす。`claimed` は呼び出し側がすでに走査中にした
    /// ID(`targets` に無ければ取りやめる)。`registered` は今の登録フォルダの ID で、ほかの索引は捨てる。
    /// `still_registered` が偽を返したフォルダ(走査の間に登録が外された)の索引は捨てる。
    pub fn refresh(
        &self,
        data_dir: &Path,
        registered: &[i64],
        targets: &[(i64, PathBuf)],
        claimed: Option<i64>,
        still_registered: impl Fn(i64, &Path) -> bool,
    ) -> AppResult<()> {
        let targets: Vec<&(i64, PathBuf)> = targets
            .iter()
            .filter(|(id, _)| claimed == Some(*id) || self.begin_scan(*id))
            .collect();
        if let Some(id) = claimed {
            if !targets.iter().any(|(target, _)| *target == id) {
                self.cancel_scan(id);
            }
        }
        self.load(data_dir);
        self.retain(|id| registered.contains(&id));
        for (id, root) in targets {
            let previous = self.previous(*id);
            let (scanned, _) = scan_source(root, previous.as_ref());
            let keep = still_registered(*id, root);
            self.finish_scan(*id, keep.then_some(scanned));
        }
        self.save(data_dir)
    }

    /// 前回の索引(差分更新に使う)。
    pub fn previous(&self, source_id: i64) -> Option<SourceIndex> {
        self.lock()
            .sources
            .get(&source_id)
            .map(|source| source.index.clone())
    }

    /// 走査を終える。`index` が `None` なら(走査の間に登録が外された)索引を捨てる。
    pub fn finish_scan(&self, source_id: i64, index: Option<SourceIndex>) {
        let loaded = index.map(|index| LoadedSource {
            entries: entries_of(&index),
            index,
        });
        let mut state = self.lock();
        state.scanning.remove(&source_id);
        match loaded {
            Some(loaded) => {
                state.sources.insert(source_id, loaded);
            }
            None => {
                state.sources.remove(&source_id);
            }
        }
    }

    /// 登録が無くなったフォルダの索引を捨てる。
    pub fn retain(&self, keep: impl Fn(i64) -> bool) {
        self.lock().sources.retain(|id, _| keep(*id));
    }

    /// 索引を作っている途中か(保存を読む前、または対象の登録フォルダを走査中)。`source_id` が無ければすべてが対象。
    pub fn is_indexing(&self, source_id: Option<i64>) -> bool {
        let state = self.lock();
        !state.loaded
            || match source_id {
                Some(id) => state.scanning.contains(&id),
                None => !state.scanning.is_empty(),
            }
    }

    /// `sources` の順に登録フォルダを探す。`within` は `(登録フォルダ ID, 相対パス)` で、そのフォルダの中だけを探す。
    pub fn search(&self, sources: &[i64], terms: &[String], within: Option<(i64, &str)>) -> Vec<SourceHits> {
        let state = self.lock();
        sources
            .iter()
            .filter(|id| within.is_none_or(|(scope, _)| scope == **id))
            .filter_map(|id| {
                let source = state.sources.get(id)?;
                let hits = search_entries(&source.entries, terms, within.map(|(_, path)| path))
                    .into_iter()
                    .map(|(by_title, entry)| (by_title, entry.clone()))
                    .collect();
                Some(SourceHits {
                    source_id: *id,
                    hits,
                })
            })
            .collect()
    }

    /// 今の索引を保存する。保存した索引をまだ読んでいなければ、読む前の空の索引で上書きしないよう何もしない。
    pub fn save(&self, data_dir: &Path) -> AppResult<()> {
        let _saving = self.saving.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot: HashMap<i64, SourceIndex> = {
            let state = self.lock();
            if !state.loaded {
                return Ok(());
            }
            state
                .sources
                .iter()
                .map(|(id, source)| (*id, source.index.clone()))
                .collect()
        };
        save_indexes(data_dir, &snapshot)
    }

    fn lock(&self) -> MutexGuard<'_, IndexState> {
        // 持っているのは作り直せる索引だけなので、他のスレッドが panic した後もそのまま使う。
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::library::list_entries;
    use crate::services::source::test_images;
    use crate::services::source::zip_archive::test_archives::write_zip;

    fn image_folder(parent: &Path, name: &str) {
        let folder = parent.join(name);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("001.png"), test_images::png(4, 6)).unwrap();
    }

    fn search(index: &SourceIndex, query: &str, within: Option<&str>) -> Vec<String> {
        let entries = entries_of(index);
        search_entries(&entries, &query_terms(query), within)
            .into_iter()
            .map(|(_, entry)| entry.relative_path())
            .collect()
    }

    /// 蔵書の見本。漫画/光の階段 に巻が並び、画集は画像フォルダの本。
    fn sample_library() -> (tempfile::TempDir, PathBuf) {
        let base = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(base.path()).unwrap();
        let series = root.join("漫画").join("光の階段");
        fs::create_dir_all(&series).unwrap();
        write_zip(&series.join("第１巻.cbz"), &[("1.png", test_images::png(4, 6))]);
        write_zip(&series.join("第2巻.zip"), &[("1.png", test_images::png(4, 6))]);
        fs::write(series.join("メモ.txt"), b"x").unwrap();
        image_folder(&root, "画集 ＡＲＴ Works");
        // 画像フォルダの中のフォルダは本の一部なのでたどらない。
        image_folder(&root.join("画集 ＡＲＴ Works"), "おまけ");
        fs::write(root.join("ｶﾞｲﾄﾞﾌﾞｯｸ.epub"), b"epub").unwrap();
        fs::write(root.join("資料.PDF"), b"pdf").unwrap();
        // 登録フォルダの直下のばらの画像は本として載せない。
        fs::write(root.join("cover.png"), test_images::png(4, 6)).unwrap();
        (base, root)
    }

    #[test]
    fn library_search_folds_width_and_case() {
        assert_eq!(fold_for_search("ＰｒｉｓｍＰａｇｅ　Vol.１"), "prismpage vol.1");
        assert_eq!(fold_for_search("ｶﾞｲﾄﾞﾌﾞｯｸ"), "ガイドブック");
        assert_eq!(fold_for_search("ﾊﾟﾝﾀﾞ ｳﾞｧｲｵﾘﾝ"), "パンダ ヴァイオリン");
        // まとめられない濁点はそのまま全角の記号にする。
        assert_eq!(fold_for_search("ｱﾞ"), "ア゛");
        assert_eq!(query_terms(" 光の　階段  ＶＯＬ "), ["光の", "階段", "vol"]);
    }

    #[test]
    fn library_index_lists_the_same_entries_as_the_folder_listing() {
        let (_base, root) = sample_library();
        let (index, _) = scan_source(&root, None);
        let mut indexed: Vec<_> = entries_of(&index)
            .into_iter()
            .filter(|entry| entry.folder.is_empty())
            .map(|entry| (entry.path, entry.kind, entry.format, entry.title))
            .collect();
        indexed.sort_by(|left, right| left.0.cmp(&right.0));
        let mut listed: Vec<_> = list_entries(&root)
            .unwrap()
            .into_iter()
            .map(|entry| (PathBuf::from(entry.path), entry.kind, entry.format, entry.title))
            .collect();
        listed.sort_by(|left, right| left.0.cmp(&right.0));
        assert_eq!(indexed, listed);

        let series = root.join("漫画").join("光の階段");
        let mut nested: Vec<_> = entries_of(&index)
            .into_iter()
            .filter(|entry| entry.folder == "漫画/光の階段")
            .map(|entry| entry.path)
            .collect();
        nested.sort();
        let mut listed: Vec<_> = list_entries(&series)
            .unwrap()
            .into_iter()
            .map(|entry| PathBuf::from(entry.path))
            .collect();
        listed.sort();
        assert_eq!(nested, listed);
    }

    #[test]
    fn library_search_matches_titles_and_paths_as_substrings() {
        let (_base, root) = sample_library();
        let (index, _) = scan_source(&root, None);

        // 大文字小文字・全角半角を問わない部分一致。
        assert_eq!(search(&index, "art", None), ["画集 ＡＲＴ Works"]);
        assert_eq!(search(&index, "ガイド", None), ["ｶﾞｲﾄﾞﾌﾞｯｸ.epub"]);
        assert_eq!(search(&index, "第1", None), ["漫画/光の階段/第１巻.cbz"]);
        assert_eq!(search(&index, "pdf", None), ["資料.PDF"]);
        // パスでも合う。書名で合った項目(フォルダ自身)が先に並ぶ。
        assert_eq!(
            search(&index, "光の階段", None),
            ["漫画/光の階段", "漫画/光の階段/第１巻.cbz", "漫画/光の階段/第2巻.zip"]
        );
        // 語はすべて含まれなければならない。
        assert_eq!(search(&index, "階段 ２巻", None), ["漫画/光の階段/第2巻.zip"]);
        // 本でないファイル・画像フォルダの中・ばらの画像は探さない。
        for query in ["メモ", "おまけ", "cover", "", "   "] {
            assert!(search(&index, query, None).is_empty(), "{query}");
        }
    }

    #[test]
    fn library_search_within_a_folder_only_looks_below_it() {
        let (_base, root) = sample_library();
        image_folder(&root.join("漫画外"), "第1巻");
        let (index, _) = scan_source(&root, None);

        assert_eq!(search(&index, "第1", None), ["漫画/光の階段/第１巻.cbz", "漫画外/第1巻"]);
        assert_eq!(search(&index, "第1", Some("漫画")), ["漫画/光の階段/第１巻.cbz"]);
        assert_eq!(search(&index, "第1", Some("/漫画/光の階段/")), ["漫画/光の階段/第１巻.cbz"]);
        // 名前が前方で重なるだけのフォルダ(漫画外)は中に含めない。
        assert_eq!(search(&index, "第1", Some("漫画外")), ["漫画外/第1巻"]);
        assert!(search(&index, "第1", Some("無いフォルダ")).is_empty());
        // 登録フォルダそのものを指すと全体を探す。
        assert_eq!(search(&index, "第1", Some("")).len(), 2);
    }

    #[test]
    fn library_rescan_reads_only_changed_folders() {
        let (_base, root) = sample_library();
        let (first, reread) = scan_source(&root, None);
        // 登録フォルダ・漫画・光の階段・画集(画像フォルダの中は読まない)。
        assert_eq!(reread, 4);

        let (second, reread) = scan_source(&root, Some(&first));
        assert_eq!(reread, 0);
        assert_eq!(second, first);

        // 巻を足すと、そのフォルダだけを読み直して新しい巻が見つかる。
        let series = root.join("漫画").join("光の階段");
        write_zip(&series.join("第3巻.cbz"), &[("1.png", test_images::png(4, 6))]);
        let (third, reread) = scan_source(&root, Some(&second));
        assert_eq!(reread, 1);
        assert_eq!(search(&third, "第3巻", None), ["漫画/光の階段/第3巻.cbz"]);

        // フォルダを消すと、その中の項目も索引から消える。
        fs::remove_dir_all(root.join("漫画")).unwrap();
        let (fourth, reread) = scan_source(&root, Some(&third));
        assert_eq!(reread, 1);
        assert!(search(&fourth, "階段", None).is_empty());

        // 別の登録フォルダの索引は前回として使わない。
        let other = tempfile::tempdir().unwrap();
        let (_, reread) = scan_source(&fs::canonicalize(other.path()).unwrap(), Some(&fourth));
        assert_eq!(reread, 1);
    }

    #[cfg(windows)]
    #[test]
    fn library_index_does_not_follow_links() {
        let base = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(base.path()).unwrap().join("library");
        let outside = root.parent().unwrap().join("outside");
        fs::create_dir(&root).unwrap();
        image_folder(&outside, "secret");
        let link = root.join("link");
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        }
        let (index, _) = scan_source(&root, None);
        assert!(search(&index, "secret", None).is_empty());
        assert!(search(&index, "link", None).is_empty());
    }

    #[test]
    fn library_index_is_saved_and_old_versions_are_discarded() {
        let (_base, root) = sample_library();
        let data = tempfile::tempdir().unwrap();
        let (index, _) = scan_source(&root, None);
        let sources = HashMap::from([(7, index.clone())]);
        save_indexes(data.path(), &sources).unwrap();
        assert_eq!(load_indexes(data.path()), sources);
        assert!(!data.path().join("search-index.json.tmp").exists());

        // 読み込んだ索引は前回として使え、変わっていなければ読み直さない。
        let loaded = LibraryIndex::default();
        assert!(loaded.is_indexing(None));
        loaded.load(data.path());
        assert!(!loaded.is_indexing(None));
        let (_, reread) = scan_source(&root, loaded.previous(7).as_ref());
        assert_eq!(reread, 0);
        let hits = loaded.search(&[7], &query_terms("第2巻"), None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hits[0].1.path, root.join("漫画").join("光の階段").join("第2巻.zip"));

        // 版の違う保存と壊れた保存は読み捨てる。
        let file = data.path().join("search-index.json");
        let text = fs::read_to_string(&file).unwrap();
        fs::write(&file, text.replacen("\"version\":1", "\"version\":999", 1)).unwrap();
        assert!(load_indexes(data.path()).is_empty());
        fs::write(&file, b"{broken").unwrap();
        assert!(load_indexes(data.path()).is_empty());
    }

    #[test]
    fn library_refresh_marks_later_sources_indexing_while_earlier_ones_scan() {
        let (_base, root) = sample_library();
        let data = tempfile::tempdir().unwrap();
        let index = LibraryIndex::default();
        let seen = std::cell::RefCell::new(Vec::new());
        index
            .refresh(
                data.path(),
                &[1, 2],
                &[(1, root.clone()), (2, root.clone())],
                None,
                |id, _| {
                    // 1 の走査を終える直前に 2 だけを探すと、2 はまだ作っている途中で結果は無い。
                    let hits = index.search(&[1, 2], &query_terms("画集"), Some((2, ""))).len();
                    seen.borrow_mut().push((id, index.is_indexing(Some(2)), hits));
                    true
                },
            )
            .unwrap();
        assert_eq!(*seen.borrow(), [(1, true, 0), (2, true, 0)]);
        assert!(!index.is_indexing(None));
        assert_eq!(index.search(&[1, 2], &query_terms("画集"), Some((2, "")))[0].hits.len(), 1);
        assert_eq!(load_indexes(data.path()).len(), 2);
    }

    #[test]
    fn library_refresh_skips_sources_scanned_elsewhere_and_releases_unregistered_claims() {
        let (_base, root) = sample_library();
        let data = tempfile::tempdir().unwrap();
        let index = LibraryIndex::default();
        // 1 は別のスレッドが走査中。3 は呼び出し側が走査中にしたが、もう登録に無い。
        assert!(index.begin_scan(1));
        assert!(index.begin_scan(3));
        let scanned = std::cell::RefCell::new(Vec::new());
        index
            .refresh(data.path(), &[1, 2], &[(1, root.clone()), (2, root.clone())], Some(3), |id, _| {
                scanned.borrow_mut().push(id);
                true
            })
            .unwrap();
        assert_eq!(*scanned.borrow(), [2]);
        assert!(index.is_indexing(Some(1)));
        assert!(!index.is_indexing(Some(3)));

        // 走査の間に登録が外されたフォルダの索引は捨てる。
        index
            .refresh(data.path(), &[2], &[(2, root.clone())], None, |_, _| false)
            .unwrap();
        assert!(index.search(&[2], &query_terms("画集"), None).is_empty());
    }

    #[test]
    fn library_index_scans_once_and_drops_removed_sources() {
        let (_base, root) = sample_library();
        let index = LibraryIndex::default();
        index.load(tempfile::tempdir().unwrap().path());
        assert!(index.begin_scan(1));
        assert!(!index.begin_scan(1), "同じ登録フォルダを二重に走査しない");
        assert!(index.is_indexing(Some(1)));
        assert!(!index.is_indexing(Some(2)));
        index.finish_scan(1, Some(scan_source(&root, None).0));
        assert!(!index.is_indexing(None));
        assert_eq!(index.search(&[1], &query_terms("画集"), None)[0].hits.len(), 1);
        // 別の登録フォルダだけを探す指定では、ほかの登録フォルダは探さない。
        assert!(index.search(&[1], &query_terms("画集"), Some((2, ""))).is_empty());

        // 走査の間に登録が外されたら、終えるときに索引を捨てる。
        assert!(index.begin_scan(1));
        index.finish_scan(1, None);
        assert!(index.search(&[1], &query_terms("画集"), None).is_empty());

        index.finish_scan(3, Some(scan_source(&root, None).0));
        index.retain(|id| id != 3);
        assert!(index.search(&[3], &query_terms("画集"), None).is_empty());
    }
}
