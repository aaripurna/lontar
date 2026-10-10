//! Picks ebook library folders and lists the ebooks inside them.
//!
//! Desktop works on plain filesystem paths. Android and iOS can't read arbitrary folders that
//! way, so there a folder is identified by an opaque token: an Android Storage Access Framework
//! tree URI, or a base64 iOS bookmark. The frontend saves the folder list itself and passes the
//! ids back to `scan`.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop::Library;
#[cfg(mobile)]
use mobile::Library;

/// Lowercase extensions recognised as ebooks. The mobile scanners keep their own copy.
pub const EBOOK_EXTENSIONS: &[&str] = &[
    "epub", "pdf", "mobi", "azw", "azw3", "kf8", "kfx", "fb2", "djvu", "cbz", "cbr", "cb7",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    /// Path on desktop, tree URI on Android, base64 bookmark on iOS.
    pub id: String,
    /// Human-readable name for display.
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Ebook {
    pub name: String,
    /// Path on desktop and iOS, document URI on Android.
    pub path: String,
    pub format: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanError {
    folder_id: String,
    message: String,
}

#[derive(Serialize)]
struct ScanResult {
    books: Vec<Ebook>,
    /// Folders that couldn't be read, e.g. because access was revoked. The rest still scan.
    errors: Vec<ScanError>,
}

/// Shows the folder picker and grants lasting read access to the chosen folder.
/// Returns `None` if cancelled.
#[tauri::command]
async fn pick_folder<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Option<Folder>, String> {
    app.state::<Library<R>>().pick_folder()
}

/// Gives up the access granted by `pick_folder`, once the folder leaves the library.
#[tauri::command]
fn release_folder<R: Runtime>(app: tauri::AppHandle<R>, id: String) -> Result<(), String> {
    app.state::<Library<R>>().release_folder(&id)
}

#[tauri::command]
async fn scan<R: Runtime>(app: tauri::AppHandle<R>, ids: Vec<String>) -> Result<ScanResult, String> {
    let library = app.state::<Library<R>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut books = Vec::new();
        let mut errors = Vec::new();
        for id in ids {
            match library.scan(&id) {
                Ok(found) => books.extend(found),
                Err(message) => errors.push(ScanError {
                    folder_id: id,
                    message,
                }),
            }
        }
        // Folders may overlap (one inside another); list each book once.
        let mut seen = HashSet::new();
        books.retain(|b| seen.insert(b.path.clone()));
        books.sort_by_key(|b| b.name.to_lowercase());
        ScanResult { books, errors }
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library")
        .invoke_handler(tauri::generate_handler![pick_folder, release_folder, scan])
        .setup(|app, api| {
            #[cfg(desktop)]
            let library = desktop::init(app, api);
            #[cfg(mobile)]
            let library = mobile::init(app, api)?;
            app.manage(library);
            Ok(())
        })
        .build()
}
