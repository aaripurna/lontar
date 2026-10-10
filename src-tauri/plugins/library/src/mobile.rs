use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{Ebook, Folder};

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
}
