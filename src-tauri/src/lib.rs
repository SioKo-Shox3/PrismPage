mod app_error;
mod commands;
mod launch;
mod models;
mod protocol;
mod services;
mod state;

use std::path::PathBuf;

use tauri::{DragDropEvent, Manager, WindowEvent};

/// 開いたままにしておく本の数。超えたら最も長く使われていない本から閉じる。
const OPEN_BOOK_CACHE_CAPACITY: usize = 8;
/// 表紙サムネイルを同時に作る数。ビューアのページ配信と取り合わないよう少なくする。
const THUMB_PARALLELISM: usize = 2;

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(launch::PendingOpenPath::default())
        .manage(state::RegistryLock::default())
        .manage(state::BookItems::default())
        .manage(state::BookRoots::default())
        .manage(services::store::SharedStore::default())
        .manage(services::source::BookCache::new(OPEN_BOOK_CACHE_CAPACITY))
        .manage(services::thumbs::Thumbs::new(THUMB_PARALLELISM))
        .manage(services::library::index::LibraryIndex::default())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // 引数の先頭は 2 つ目の起動の実行ファイル名なので除く。
            let cwd = PathBuf::from(cwd);
            focus_main_window(app);
            launch::request_open(
                app,
                launch::open_path_from_args(args.iter().skip(1), Some(&cwd)),
            );
        }))
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                launch::request_open(window.app_handle(), launch::open_path_from_dropped(paths));
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let cwd = std::env::current_dir().ok();
            launch::request_open(
                app.handle(),
                launch::open_path_from_args(std::env::args().skip(1), cwd.as_deref()),
            );
            // RAR/CBR の展開先。前回の実行が残した一時フォルダはここで消す。
            match app.path().app_cache_dir() {
                Ok(dir) => {
                    services::source::rar_archive::init_extract_root(dir.join("rar-extract"))
                }
                Err(error) => log::warn!(
                    "キャッシュの場所を得られないため、RAR はシステムの一時フォルダへ展開します: {error}"
                ),
            }
            // 同梱の PDFium(`bundle.resources` でリソースフォルダの `pdfium/` に置く)。読み込みは最初に PDF を開くとき。
            match app.path().resource_dir() {
                Ok(dir) => services::source::pdf::set_library_dir(
                    dir.join(services::source::pdf::LIBRARY_DIR_NAME),
                ),
                Err(error) => log::warn!(
                    "リソースの場所を得られないため、PDFium は実行ファイルの隣から探します: {error}"
                ),
            }
            // 超解像のキュー。ジョブの状態はイベントでフロントへ流す。
            app.manage(services::engines::start_queue(app.handle()));
            // 検索索引を保存から読み、登録フォルダの変わった所だけを裏で読み直す。
            commands::search::spawn_index_refresh(app.handle().clone(), None);

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::books::open_book,
            commands::books::save_reading_position,
            commands::books::save_view_settings,
            commands::books::get_adjacent_books,
            commands::books::close_books,
            commands::history::list_continue_reading,
            commands::history::list_history,
            commands::history::remove_history_entry,
            commands::history::clear_history,
            commands::collections::list_shelves,
            commands::collections::create_shelf,
            commands::collections::rename_shelf,
            commands::collections::delete_shelf,
            commands::collections::list_shelf_books,
            commands::collections::list_favorites,
            commands::collections::get_book_collections,
            commands::collections::add_to_shelf,
            commands::collections::remove_from_shelf,
            commands::collections::set_favorite,
            commands::legacy::get_legacy_library_dir,
            commands::legacy::delete_legacy_library_dir,
            commands::library::take_pending_open_path,
            commands::sources::list_sources,
            commands::sources::add_source,
            commands::sources::remove_source,
            commands::sources::list_directory,
            commands::search::search_library,
            commands::engines::get_engine_statuses,
            commands::engines::detect_engine_candidates,
            commands::engines::get_engine_install_options,
            commands::engines::register_engine_directory,
            commands::engines::import_engine_archive,
            commands::engines::install_engine_from_release,
            commands::engines::clear_engine_registration,
            commands::engines::request_enhancement,
            commands::engines::cancel_enhancement,
            commands::engines::start_batch_enhancement,
            commands::engines::cancel_batch_enhancement,
            commands::engines::get_enhance_cache_info,
            commands::engines::set_enhance_cache_limit,
            commands::engines::clear_enhance_cache,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // 終わるときは実行中のエンジンを残さない。
            if let tauri::RunEvent::Exit = event {
                if let Some(queue) = app.try_state::<services::engines::queue::EnhanceQueue>() {
                    queue.shutdown();
                }
            }
        });
}
