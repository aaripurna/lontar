use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::{Ebook, Folder, SidecarRef, EBOOK_EXTENSIONS};

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

    pub fn read_sidecar(&self, book: &SidecarRef) -> Result<Option<String>, String> {
        read_sidecar(book)
    }

    pub fn write_sidecar(&self, book: &SidecarRef, contents: &str) -> Result<(), String> {
        write_sidecar(book, contents)
    }
}

fn read_sidecar(book: &SidecarRef) -> Result<Option<String>, String> {
    match fs::read_to_string(sidecar_path(book)?) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// Write a temp file and rename it over the sidecar, so Syncthing never picks up a
// half-written file. The temp name is hidden, which also keeps it out of scans.
fn write_sidecar(book: &SidecarRef, contents: &str) -> Result<(), String> {
    let path = sidecar_path(book)?;
    let tmp = path.with_file_name(format!(".{}.tmp", book.sidecar_name()?));
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Resolves the sidecar path, refusing anything outside the library folder.
fn sidecar_path(book: &SidecarRef) -> Result<PathBuf, String> {
    let root = fs::canonicalize(&book.folder_id).map_err(|e| e.to_string())?;
    let dir = fs::canonicalize(&book.dir).map_err(|e| e.to_string())?;
    if !dir.starts_with(&root) {
        return Err(format!("{} is outside the library folder", book.dir));
    }
    Ok(dir.join(book.sidecar_name()?))
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
                    file_name: entry.file_name().to_string_lossy().into_owned(),
                    path: path.to_string_lossy().into_owned(),
                    dir: dir.to_string_lossy().into_owned(),
                    folder_id: String::new(),
                    format,
                    size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar(folder: &Path, dir: &Path, file_name: &str) -> SidecarRef {
        SidecarRef {
            folder_id: folder.to_string_lossy().into_owned(),
            dir: dir.to_string_lossy().into_owned(),
            file_name: file_name.into(),
        }
    }

    #[test]
    fn sidecar_path_stays_inside_library_folder() {
        let tmp = std::env::temp_dir().join(format!("lontar-test-{}", std::process::id()));
        let library = tmp.join("library");
        let nested = library.join("Fiction");
        let outside = tmp.join("outside");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let path = sidecar_path(&sidecar(&library, &nested, "Dune.epub")).unwrap();
        assert_eq!(path, fs::canonicalize(&nested).unwrap().join("Dune.epub.lontar"));

        assert!(sidecar_path(&sidecar(&library, &outside, "Dune.epub")).is_err());
        assert!(sidecar_path(&sidecar(&library, &nested.join(".."), "x.epub")).is_ok());
        assert!(sidecar_path(&sidecar(&library, &library.join(".."), "x.epub")).is_err());
        assert!(sidecar_path(&sidecar(&library, &nested, "../../x.epub")).is_err());
        assert!(sidecar_path(&sidecar(&library, &nested, "")).is_err());

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn sidecar_round_trip() {
        let library = std::env::temp_dir().join(format!("lontar-rt-{}", std::process::id()));
        fs::create_dir_all(&library).unwrap();
        let book = sidecar(&library, &library, "Dune.epub");

        assert_eq!(read_sidecar(&book).unwrap(), None);
        write_sidecar(&book, r#"{"progress":{"percent":0.42},"long":"xxxxxxxx"}"#).unwrap();
        write_sidecar(&book, "{}").unwrap(); // shorter rewrite must not leave old bytes
        assert_eq!(read_sidecar(&book).unwrap().as_deref(), Some("{}"));

        let mut names: Vec<_> = fs::read_dir(&library)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["Dune.epub.lontar"]); // no temp file left behind

        fs::remove_dir_all(&library).unwrap();
    }
}
