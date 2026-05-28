mod app_error;
mod commands;
mod models;
mod services;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(state::RegistryLock::default())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
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
      commands::engines::get_engine_statuses,
      commands::engines::register_engine_directory,
      commands::engines::import_engine_archive,
      commands::engines::clear_engine_registration,
      commands::engines::enhance_image,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
