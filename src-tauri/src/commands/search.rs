//! 登録フォルダ全体の検索と、検索索引の作り直し(起動時と登録時に裏のスレッドで差分更新する)。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::app_error::{AppError, AppResult};
use crate::commands::run_blocking;
use crate::models::{EntryKind, LibrarySearchHit, LibrarySearchResult};
use crate::services::app_data_dir;
use crate::services::library::{self, index};
use crate::services::library::index::LibraryIndex;
use crate::services::source::book_id_for_path;
use crate::services::store::SharedStore;
use crate::services::thumbs::Thumbs;

/// 1 回の検索で返す件数の上限。
const MAX_HITS: usize = 300;

/// 書名・登録フォルダからの相対パスで本とフォルダを探す。大文字小文字・全角半角の違いは無視し、
/// 空白で区切った語をすべて含む項目を返す。`source_id` と `path`(登録フォルダからの相対パス)を渡すと
/// そのフォルダの中だけを探す。索引を作っている途中は前回の索引で答え、`indexing` を立てる。
#[tauri::command]
pub async fn search_library(
    app: AppHandle,
    query: String,
    source_id: Option<i64>,
    path: Option<String>,
) -> AppResult<LibrarySearchResult> {
    run_blocking(move || {
        let sources = app
            .state::<SharedStore>()
            .with(&app, |store| store.sources())?;
        if let Some(id) = source_id {
            if !sources.iter().any(|source| source.id == id) {
                return Err(AppError::SourceNotFound);
            }
        }
        let terms = index::query_terms(&query);
        let search_index = app.state::<LibraryIndex>();
        let indexing = search_index.is_indexing(source_id);
        if terms.is_empty() {
            return Ok(LibrarySearchResult {
                hits: Vec::new(),
                truncated: false,
                indexing,
            });
        }
        let ids: Vec<i64> = sources.iter().map(|source| source.id).collect();
        let within = source_id.map(|id| (id, path.as_deref().unwrap_or("")));
        let mut found: Vec<(usize, bool, index::IndexedEntry)> = search_index
            .search(&ids, &terms, within)
            .into_iter()
            .flat_map(|source_hits| {
                let position = ids
                    .iter()
                    .position(|id| *id == source_hits.source_id)
                    .unwrap_or(usize::MAX);
                source_hits
                    .hits
                    .into_iter()
                    .map(move |(by_title, entry)| (position, by_title, entry))
            })
            .collect();
        // 書名で合った項目を先に、次に登録した順・相対パスの自然順で並べる。
        found.sort_by(|left, right| {
            right
                .1
                .cmp(&left.1)
                .then_with(|| left.0.cmp(&right.0))
                .then_with(|| index::compare_hits(&(left.1, &left.2), &(right.1, &right.2)))
        });
        let truncated = found.len() > MAX_HITS;
        found.truncate(MAX_HITS);

        let thumbs = app.state::<Thumbs>();
        let hits = found
            .into_iter()
            .map(|(position, _, entry)| {
                let source = &sources[position];
                let openable = entry.format.map_or(true, |format| format.is_openable());
                let thumb_id = (entry.kind == EntryKind::Book && openable)
                    .then(|| book_id_for_path(&entry.path));
                // 表紙は prism スキームがこの ID で要求する。スキームは登録した本の場所しか読まない。
                if let Some(thumb_id) = &thumb_id {
                    thumbs.register(thumb_id.clone(), entry.path.clone());
                }
                LibrarySearchHit {
                    source_id: source.id,
                    source_name: library::source_name(Path::new(&source.path)),
                    name: entry.name,
                    title: entry.title,
                    path: entry.path.to_string_lossy().to_string(),
                    folder: entry.folder,
                    kind: entry.kind,
                    format: entry.format,
                    openable,
                    thumb_id,
                }
            })
            .collect();
        Ok(LibrarySearchResult {
            hits,
            truncated,
            indexing,
        })
    })
    .await
}

/// 検索索引を裏のスレッドで差分更新する。`only` を渡すとその登録フォルダだけ、無ければすべての登録フォルダ。
/// 失敗しても画面は止めず、ログにだけ残す(検索は前回の索引で答える)。
pub fn spawn_index_refresh(app: AppHandle, only: Option<i64>) {
    // 登録したフォルダはスレッドを立てる前に走査中にする(登録の直後に探しても、索引を作っている途中と分かる)。
    let claimed = only.filter(|id| app.state::<LibraryIndex>().begin_scan(*id));
    if only.is_some() && claimed.is_none() {
        // 同じ登録フォルダをほかのスレッドが走査中。
        return;
    }
    std::thread::spawn(move || {
        if let Err(error) = refresh_index(&app, only, claimed) {
            log::warn!("検索索引を更新できませんでした: {error}");
        }
    });
}

fn refresh_index(app: &AppHandle, only: Option<i64>, claimed: Option<i64>) -> AppResult<()> {
    let search_index = app.state::<LibraryIndex>();
    let store = app.state::<SharedStore>();
    let prepared = store
        .with(app, |store| store.sources())
        .and_then(|sources| Ok((sources, app_data_dir(app)?)));
    let (sources, data_dir) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            if let Some(id) = claimed {
                search_index.cancel_scan(id);
            }
            return Err(error);
        }
    };
    let registered: Vec<i64> = sources.iter().map(|source| source.id).collect();
    let targets: Vec<(i64, PathBuf)> = sources
        .iter()
        .filter(|source| only.is_none_or(|id| id == source.id))
        .map(|source| (source.id, PathBuf::from(&source.path)))
        .collect();
    search_index.refresh(&data_dir, &registered, &targets, claimed, |id, root| {
        store
            .with(app, |store| store.source(id))
            .ok()
            .flatten()
            .is_some_and(|record| Path::new(&record.path) == root)
    })
}

/// 登録を外したフォルダの索引を捨てて保存する。
pub fn forget_source(app: &AppHandle, source_id: i64) -> AppResult<()> {
    let search_index = app.state::<LibraryIndex>();
    search_index.retain(|id| id != source_id);
    search_index.save(&app_data_dir(app)?)
}
