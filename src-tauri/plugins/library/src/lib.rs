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

/// Reading progress, bookmarks and annotations live in a sidecar next to each book, named
/// `<file name>.lontar` (e.g. `Dune.epub.lontar`), so syncing the library folder (e.g. with
/// Syncthing) carries them across devices.
pub const SIDECAR_EXTENSION: &str = "lontar";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ebook {
    /// File name without the extension, for display.
    pub name: String,
    /// Full file name, e.g. `Dune.epub`.
    pub file_name: String,
    /// Path on desktop and iOS, document URI on Android.
    pub path: String,
    /// Where the book sits, to locate its sidecar: the parent directory path on desktop and
    /// iOS, the parent document id on Android.
    pub dir: String,
    /// The library folder this book was found in. Filled in by `scan`.
    #[serde(default)]
    pub folder_id: String,
    pub format: String,
    pub size: u64,
    /// Raw contents of the book's sidecar, if it has one, so the library can show progress
    /// without a read per book. Conflict copies aren't merged here; opening the book does that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidecar: Option<String>,
}

/// Identifies a book's sidecar. Mirrors the fields of [`Ebook`] that locate it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRef {
    pub folder_id: String,
    pub dir: String,
    pub file_name: String,
}

/// Identifies a book file to open. Mirrors the fields of [`Ebook`] that locate it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRef {
    pub folder_id: String,
    pub path: String,
}

impl SidecarRef {
    pub fn sidecar_name(&self) -> Result<String, String> {
        // Never let a crafted name escape the book's directory.
        if self.file_name.is_empty()
            || self.file_name.contains(['/', '\\'])
            || self.file_name == ".."
        {
            return Err(format!("Invalid book file name: {}", self.file_name));
        }
        Ok(format!("{}.{SIDECAR_EXTENSION}", self.file_name))
    }

    /// Syncthing keeps the losing side of a conflict as
    /// `<name>.sync-conflict-<date>-<time>-<device>.<ext>`, e.g.
    /// `Dune.epub.sync-conflict-20261010-192000-ABC1234.lontar`.
    pub fn conflict_affixes(&self) -> Result<(String, String), String> {
        self.sidecar_name()?;
        Ok((
            format!("{}.sync-conflict-", self.file_name),
            format!(".{SIDECAR_EXTENSION}"),
        ))
    }

    pub fn is_conflict_name(&self, name: &str) -> Result<bool, String> {
        let (prefix, suffix) = self.conflict_affixes()?;
        Ok(name.len() > prefix.len() + suffix.len()
            && name.starts_with(&prefix)
            && name.ends_with(&suffix)
            && !name.contains(['/', '\\']))
    }
}

/// A sidecar conflict copy left by a sync tool.
#[derive(Debug, Serialize, Deserialize)]
pub struct SidecarFile {
    pub name: String,
    pub contents: String,
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
                Ok(found) => books.extend(found.into_iter().map(|mut b| {
                    b.folder_id = id.clone();
                    b
                })),
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

/// Returns the book file's bytes, sent to the frontend as an `ArrayBuffer` rather than JSON.
#[tauri::command]
async fn read_book<R: Runtime>(
    app: tauri::AppHandle<R>,
    book: BookRef,
) -> Result<tauri::ipc::Response, String> {
    let library = app.state::<Library<R>>().inner().clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || library.read_book(&book))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Returns the book's sidecar contents, or `None` if it has none yet.
#[tauri::command]
async fn read_sidecar<R: Runtime>(
    app: tauri::AppHandle<R>,
    book: SidecarRef,
) -> Result<Option<String>, String> {
    let library = app.state::<Library<R>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.read_sidecar(&book))
        .await
        .map_err(|e| e.to_string())?
}

/// Creates or replaces the book's sidecar.
#[tauri::command]
async fn write_sidecar<R: Runtime>(
    app: tauri::AppHandle<R>,
    book: SidecarRef,
    contents: String,
) -> Result<(), String> {
    let library = app.state::<Library<R>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.write_sidecar(&book, &contents))
        .await
        .map_err(|e| e.to_string())?
}

/// Returns the book's sidecar conflict copies (see [`SidecarRef::conflict_affixes`]), so the
/// frontend can merge them into the sidecar.
#[tauri::command]
async fn read_sidecar_conflicts<R: Runtime>(
    app: tauri::AppHandle<R>,
    book: SidecarRef,
) -> Result<Vec<SidecarFile>, String> {
    let library = app.state::<Library<R>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let files = library.read_sidecar_conflicts(&book)?;
        // Don't trust the native side's filtering alone.
        let mut kept = Vec::new();
        for file in files {
            if book.is_conflict_name(&file.name)? {
                kept.push(file);
            }
        }
        Ok(kept)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a conflict copy once it has been merged. Refuses any other file.
#[tauri::command]
async fn delete_sidecar_conflict<R: Runtime>(
    app: tauri::AppHandle<R>,
    book: SidecarRef,
    name: String,
) -> Result<(), String> {
    if !book.is_conflict_name(&name)? {
        return Err(format!("{name} is not a sidecar conflict copy"));
    }
    let library = app.state::<Library<R>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.delete_sidecar_file(&book, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Colours the area behind the system status and navigation bars, and picks light or dark
/// icons for them. Only Android needs this; elsewhere the app draws behind the bars itself.
#[tauri::command]
fn set_bar_colors<R: Runtime>(
    app: tauri::AppHandle<R>,
    color: String,
    dark: bool,
) -> Result<(), String> {
    let valid = color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(format!("Expected a #rrggbb colour, got {color}"));
    }
    app.state::<Library<R>>().set_bar_colors(&color, dark)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library")
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            release_folder,
            scan,
            read_book,
            read_sidecar,
            write_sidecar,
            read_sidecar_conflicts,
            delete_sidecar_conflict,
            set_bar_colors
        ])
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
