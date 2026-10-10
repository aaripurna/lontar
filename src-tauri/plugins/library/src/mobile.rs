use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{BookRef, Ebook, Folder, SidecarRef};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_library);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<Library<R>, Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.nawa.lontar.library", "LibraryPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_library)?;
    Ok(Library(handle))
}

pub struct Library<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Clone for Library<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

#[derive(Deserialize)]
struct PickFolderResponse {
    folder: Option<Folder>,
}

#[derive(Serialize)]
struct FolderArgs<'a> {
    id: &'a str,
}

#[derive(Deserialize)]
struct ScanResponse {
    books: Vec<Ebook>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarArgs<'a> {
    #[serde(flatten)]
    book: &'a SidecarRef,
    sidecar_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteSidecarArgs<'a> {
    #[serde(flatten)]
    sidecar: SidecarArgs<'a>,
    contents: &'a str,
}

#[derive(Deserialize)]
struct CopyBookResponse {
    path: String,
}

#[derive(Deserialize)]
struct ReadSidecarResponse {
    contents: Option<String>,
}

impl<R: Runtime> Library<R> {
    pub fn pick_folder(&self) -> Result<Option<Folder>, String> {
        self.0
            .run_mobile_plugin::<PickFolderResponse>("pickFolder", ())
            .map(|r| r.folder)
            .map_err(|e| e.to_string())
    }

    pub fn release_folder(&self, id: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<()>("releaseFolder", FolderArgs { id })
            .map_err(|e| e.to_string())
    }

    pub fn scan(&self, id: &str) -> Result<Vec<Ebook>, String> {
        self.0
            .run_mobile_plugin::<ScanResponse>("scan", FolderArgs { id })
            .map(|r| r.books)
            .map_err(|e| e.to_string())
    }

    // Books can be tens of MB, too big to pass through the plugin bridge's JSON. The native side
    // copies the book into the app's cache instead, and it's read and deleted from here.
    pub fn read_book(&self, book: &BookRef) -> Result<Vec<u8>, String> {
        let copy = self
            .0
            .run_mobile_plugin::<CopyBookResponse>("copyBook", book)
            .map_err(|e| e.to_string())?;
        let bytes = std::fs::read(&copy.path).map_err(|e| e.to_string());
        let _ = std::fs::remove_file(&copy.path);
        bytes
    }

    pub fn read_sidecar(&self, book: &SidecarRef) -> Result<Option<String>, String> {
        let args = SidecarArgs {
            book,
            sidecar_name: book.sidecar_name()?,
        };
        self.0
            .run_mobile_plugin::<ReadSidecarResponse>("readSidecar", args)
            .map(|r| r.contents)
            .map_err(|e| e.to_string())
    }

    pub fn write_sidecar(&self, book: &SidecarRef, contents: &str) -> Result<(), String> {
        let args = WriteSidecarArgs {
            sidecar: SidecarArgs {
                book,
                sidecar_name: book.sidecar_name()?,
            },
            contents,
        };
        self.0
            .run_mobile_plugin::<()>("writeSidecar", args)
            .map_err(|e| e.to_string())
    }
}
