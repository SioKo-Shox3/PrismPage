mod app_error;
mod commands;
mod models;
mod services;
mod state;

use std::path::{Path, PathBuf};

use tauri::{Emitter, Manager};

const OPENED_EPUB_EVENT: &str = "epub-files-opened";

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn normalize_epub_path(path: PathBuf) -> Option<String> {
    let path = std::fs::canonicalize(path).ok()?;

    if !path.is_file()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
    {
        return None;
    }

    Some(path.to_string_lossy().to_string())
}

fn normalize_epub_arg(raw_arg: &str, cwd: Option<&Path>) -> Option<String> {
    let trimmed = raw_arg.trim().trim_matches('"');
    if trimmed.starts_with('-') || trimmed.is_empty() {
        return None;
    }

    let path = PathBuf::from(trimmed);
    let candidate = if path.is_absolute() {
        path
    } else {
        cwd.unwrap_or_else(|| Path::new(".")).join(path)
    };

    normalize_epub_path(candidate)
}

fn store_and_emit_opened_epubs(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    let pending_paths = app.state::<state::OpenedEpubPaths>();
    let Ok(mut guard) = pending_paths.0.lock() else {
        return;
    };

    let mut added_paths = Vec::new();
    for path in paths {
        if !guard
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&path))
        {
            guard.push(path.clone());
            added_paths.push(path);
        }
    }
    drop(guard);

    if !added_paths.is_empty() {
        let _ = app.emit(OPENED_EPUB_EVENT, added_paths);
    }
}

fn collect_epub_args<I>(args: I, cwd: Option<&Path>) -> Vec<String>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    args.into_iter()
        .filter_map(|arg| normalize_epub_arg(arg.as_ref(), cwd))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::OpenedEpubPaths::default())
        .manage(state::RegistryLock::default())
        .manage(state::EnhancementLock::default())
        .manage(state::EnhancementJobs::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let cwd = PathBuf::from(cwd);
            focus_main_window(app);
            store_and_emit_opened_epubs(app, collect_epub_args(args, Some(&cwd)));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let cwd = std::env::current_dir().ok();
            store_and_emit_opened_epubs(
                app.handle(),
                collect_epub_args(std::env::args().skip(1), cwd.as_deref()),
            );

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
            commands::library::import_epub_from_path,
            commands::library::read_book_base64,
            commands::library::take_pending_opened_epubs,
            commands::engines::get_engine_statuses,
            commands::engines::detect_engine_candidates,
            commands::engines::get_engine_install_options,
            commands::engines::register_engine_directory,
            commands::engines::import_engine_archive,
            commands::engines::install_engine_from_release,
            commands::engines::clear_engine_registration,
            commands::engines::enhance_image,
            commands::engines::enhance_book_image,
            commands::engines::scan_book_images,
            commands::engines::enhance_book_asset_image,
            commands::engines::read_enhanced_book_image,
            commands::engines::cancel_enhancement_jobs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
