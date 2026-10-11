#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Opening a book from the OS while lontar runs hands it to this window instead of starting
    // a second one. macOS does this itself, sending the file to the running app. Must be the
    // first plugin.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        use tauri::Manager;
        let cwd = std::path::Path::new(&cwd);
        tauri_plugin_library::open_files(app, args.iter().skip(1).map(|a| cwd.join(a)));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    // The library plugin uses the dialog plugin's folder picker on desktop.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_library::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
