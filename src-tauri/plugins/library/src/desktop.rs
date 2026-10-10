use std::fs;
use std::path::Path;

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::{Ebook, Folder, EBOOK_EXTENSIONS};

pub fn init<R: Runtime, C: DeserializeOwned>(app: &AppHandle<R>, _api: PluginApi<R, C>) -> Library<R> {
    Library(app.clone())
}

pub struct Library<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Clone for Library<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> Library<R> {
    pub fn pick_folder(&self) -> Result<Option<Folder>, String> {
        let Some(picked) = self.0.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let path = path.to_string_lossy().into_owned();
        Ok(Some(Folder {
            name: path.clone(),
            id: path,
        }))
    }

    /// Nothing to release: desktop reads folders by path without any grant.
    pub fn release_folder(&self, _id: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn scan(&self, id: &str) -> Result<Vec<Ebook>, String> {
        let root = Path::new(id);
        if !root.is_dir() {
            return Err(format!("Not a directory: {id}"));
        }
        let mut books = Vec::new();
        collect_ebooks(root, &mut books);
        Ok(books)
    }
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
