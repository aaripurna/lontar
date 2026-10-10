use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::{BookRef, Ebook, Folder, SidecarFile, SidecarRef, EBOOK_EXTENSIONS, SIDECAR_EXTENSION};

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

    pub fn read_book(&self, book: &BookRef) -> Result<Vec<u8>, String> {
        fs::read(book_path(book)?).map_err(|e| e.to_string())
    }

    pub fn read_sidecar(&self, book: &SidecarRef) -> Result<Option<String>, String> {
        read_sidecar(book)
    }

    pub fn write_sidecar(&self, book: &SidecarRef, contents: &str) -> Result<(), String> {
        write_sidecar(book, contents)
    }

    pub fn read_sidecar_conflicts(&self, book: &SidecarRef) -> Result<Vec<SidecarFile>, String> {
        read_sidecar_conflicts(book)
    }

    /// Nothing to do: desktop windows draw their own title bar.
    pub fn set_bar_colors(&self, _color: &str, _dark: bool) -> Result<(), String> {
        Ok(())
    }

    /// `name` has already been checked by the caller.
    pub fn delete_sidecar_file(&self, book: &SidecarRef, name: &str) -> Result<(), String> {
        fs::remove_file(sidecar_dir(book)?.join(name)).map_err(|e| e.to_string())
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

/// Resolves the book path, refusing anything outside the library folder.
fn book_path(book: &BookRef) -> Result<PathBuf, String> {
    let root = fs::canonicalize(&book.folder_id).map_err(|e| e.to_string())?;
    let path = fs::canonicalize(&book.path).map_err(|e| e.to_string())?;
    if !path.starts_with(&root) {
        return Err(format!("{} is outside the library folder", book.path));
    }
    Ok(path)
}

fn read_sidecar_conflicts(book: &SidecarRef) -> Result<Vec<SidecarFile>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(sidecar_dir(book)?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if book.is_conflict_name(&name)? {
            let contents = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            files.push(SidecarFile { name, contents });
        }
    }
    Ok(files)
}

/// Resolves the book's directory, refusing anything outside the library folder.
fn sidecar_dir(book: &SidecarRef) -> Result<PathBuf, String> {
    let root = fs::canonicalize(&book.folder_id).map_err(|e| e.to_string())?;
    let dir = fs::canonicalize(&book.dir).map_err(|e| e.to_string())?;
    if !dir.starts_with(&root) {
        return Err(format!("{} is outside the library folder", book.dir));
    }
    Ok(dir)
}

fn sidecar_path(book: &SidecarRef) -> Result<PathBuf, String> {
    Ok(sidecar_dir(book)?.join(book.sidecar_name()?))
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
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let sidecar = path.with_file_name(format!("{file_name}.{SIDECAR_EXTENSION}"));
                books.push(Ebook {
                    name: path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    file_name,
                    path: path.to_string_lossy().into_owned(),
                    dir: dir.to_string_lossy().into_owned(),
                    folder_id: String::new(),
                    format,
                    size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                    sidecar: fs::read_to_string(sidecar).ok(),
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
    fn book_path_stays_inside_library_folder() {
        let tmp = std::env::temp_dir().join(format!("lontar-book-{}", std::process::id()));
        let library = tmp.join("library");
        fs::create_dir_all(&library).unwrap();
        fs::write(library.join("Dune.epub"), "x").unwrap();
        fs::write(tmp.join("secret.txt"), "x").unwrap();
        let book = |path: PathBuf| BookRef {
            folder_id: library.to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
        };

        assert!(book_path(&book(library.join("Dune.epub"))).is_ok());
        assert!(book_path(&book(library.join("../secret.txt"))).is_err());
        assert!(book_path(&book(tmp.join("secret.txt"))).is_err());

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn scan_includes_sidecars() {
        let library = std::env::temp_dir().join(format!("lontar-scan-{}", std::process::id()));
        fs::create_dir_all(library.join("Fiction")).unwrap();
        fs::write(library.join("Dune.epub"), "x").unwrap();
        fs::write(library.join("Dune.epub.lontar"), r#"{"version":1}"#).unwrap();
        fs::write(library.join("Fiction/Emma.epub"), "x").unwrap();

        let mut books = Vec::new();
        collect_ebooks(&library, &mut books);
        books.sort_by(|a, b| a.name.cmp(&b.name));
        let sidecars: Vec<_> = books.iter().map(|b| (b.name.as_str(), b.sidecar.as_deref())).collect();
        assert_eq!(sidecars, [("Dune", Some(r#"{"version":1}"#)), ("Emma", None)]);

        fs::remove_dir_all(&library).unwrap();
    }

    #[test]
    fn conflict_names() {
        let book = SidecarRef {
            folder_id: String::new(),
            dir: String::new(),
            file_name: "Dune.epub".into(),
        };
        let ok = |name| book.is_conflict_name(name).unwrap();
        assert!(ok("Dune.epub.sync-conflict-20261010-192000-ABC1234.lontar"));
        assert!(!ok("Dune.epub.lontar"));
        assert!(!ok("Dune.epub.sync-conflict-.lontar"));
        assert!(!ok("Dune.pdf.sync-conflict-20261010-192000-ABC1234.lontar"));
        assert!(!ok("Dune.epub.sync-conflict-x/../../etc.lontar"));
        assert!(!ok("Dune.epub"));
    }

    #[test]
    fn reads_and_deletes_conflicts() {
        let library = std::env::temp_dir().join(format!("lontar-cf-{}", std::process::id()));
        fs::create_dir_all(&library).unwrap();
        let conflict = "Dune.epub.sync-conflict-20261010-192000-ABC1234.lontar";
        fs::write(library.join("Dune.epub.lontar"), "main").unwrap();
        fs::write(library.join(conflict), "theirs").unwrap();
        fs::write(library.join("Other.epub.sync-conflict-20261010-192000-ABC1234.lontar"), "x").unwrap();
        let book = sidecar(&library, &library, "Dune.epub");

        let files = read_sidecar_conflicts(&book).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].name.as_str(), files[0].contents.as_str()), (conflict, "theirs"));

        fs::remove_file(sidecar_dir(&book).unwrap().join(conflict)).unwrap();
        assert!(read_sidecar_conflicts(&book).unwrap().is_empty());

        fs::remove_dir_all(&library).unwrap();
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
