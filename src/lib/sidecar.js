// Per-book reading data (progress, bookmarks, annotations), stored as JSON in a sidecar next
// to the book: `Dune.epub` -> `Dune.epub.lontar`. Keeping it beside the book means syncing the
// library folder (e.g. with Syncthing) carries it to every device.
import { invoke } from "@tauri-apps/api/core";

export const SIDECAR_VERSION = 1;

// `book` is an entry from the `plugin:library|scan` result.
function sidecarRef(book) {
  return { folderId: book.folderId, dir: book.dir, fileName: book.fileName };
}

/** Returns the book's saved data, or null if it has none yet. */
export async function readBookData(book) {
  const contents = await invoke("plugin:library|read_sidecar", { book: sidecarRef(book) });
  return contents == null ? null : JSON.parse(contents);
}

/** Saves the book's data, replacing any existing sidecar. */
export async function writeBookData(book, data) {
  const contents = JSON.stringify({ ...data, version: SIDECAR_VERSION }, null, 2) + "\n";
  await invoke("plugin:library|write_sidecar", { book: sidecarRef(book), contents });
}
