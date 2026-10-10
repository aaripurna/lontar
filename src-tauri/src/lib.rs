use std::fs;
use std::path::Path;

use serde::Serialize;

const EBOOK_EXTENSIONS: &[&str] = &[
    "epub", "pdf", "mobi", "azw", "azw3", "kf8", "kfx", "fb2", "djvu", "cbz", "cbr", "cb7",
];

#[derive(Serialize)]
struct Ebook {
    name: String,
    path: String,
    format: String,
    size: u64,
}

fn ebook_format(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    EBOOK_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

// Recurses into subdirectories, skipping hidden entries and symlinks (which could loop).
// Unreadable subdirectories are skipped so one bad folder doesn't fail the whole scan.
fn collect_ebooks(dir: &Path, books: &mut Vec<Ebook>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_ebooks(&path, books);
        } else if file_type.is_file() {
            if let Some(format) = ebook_format(&path) {
                books.push(Ebook {
                    name: path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    path: path.to_string_lossy().into_owned(),
                    format,
                    size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
}

#[tauri::command]
async fn scan_ebooks(dir: String) -> Result<Vec<Ebook>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&dir);
        if !root.is_dir() {
            return Err(format!("Not a directory: {dir}"));
        }
        let mut books = Vec::new();
        collect_ebooks(root, &mut books);
        books.sort_by_key(|b| b.name.to_lowercase());
        Ok(books)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_ebooks])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
