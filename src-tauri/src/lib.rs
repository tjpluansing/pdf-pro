mod convert;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![convert::convert])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Release builds get the updater's public key and download address from
      // the workflow (see docs/RELEASING.md). Builds without them, such as
      // local and PR builds, simply have no updater; the app hides the check.
      if app.config().plugins.0.contains_key("updater") {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
