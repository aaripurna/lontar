// Per-book reading data (progress, bookmarks, annotations), stored as JSON in a sidecar next
// to the book: `Dune.epub` -> `Dune.epub.lontar`. Keeping it beside the book means syncing the
// library folder (e.g. with Syncthing) carries it to every device.
//
// Format (version 1):
//   {
//     "version": 1,
//     "progress": { "location": "epubcfi(...)", "fraction": 0.42, "updatedAt": "<ISO 8601>" },
//     "bookmarks":   [{ "id", "createdAt", "updatedAt"?, "deleted"?, ... }],
//     "annotations": [{ "id", "createdAt", "updatedAt"?, "deleted"?, ... }]
//   }
// Every field is optional. Unknown fields are kept when saving, so older builds don't strip
// data written by newer ones. Removed bookmarks/annotations stay as `deleted: true` tombstones
// so a merge can't resurrect them.
import { invoke } from "@tauri-apps/api/core";

export const SIDECAR_VERSION = 1;

// Lists of items that are merged by `id` rather than replaced wholesale.
const ITEM_LISTS = ["bookmarks", "annotations"];

// `book` is an entry from the `plugin:library|scan` result.
function sidecarRef(book) {
  return { folderId: book.folderId, dir: book.dir, fileName: book.fileName };
}

function stamp(item) {
  return item?.updatedAt ?? item?.createdAt ?? "";
}

// ISO 8601 UTC timestamps (as produced by `toISOString`) sort correctly as strings.
function newest(a, b) {
  return stamp(b) > stamp(a) ? b : a;
}

/**
 * Merges copies of a book's data, e.g. the sidecar and its sync-conflict copies. The newest
 * progress wins; bookmarks and annotations are combined by id, keeping each item's newest
 * version. For other fields, earlier arguments take precedence.
 */
export function mergeBookData(...copies) {
  copies = copies.filter(Boolean);
  const merged = Object.assign({}, ...copies.toReversed());

  const progress = copies.map((c) => c.progress).filter(Boolean);
  if (progress.length) merged.progress = progress.reduce(newest);

  for (const list of ITEM_LISTS) {
    const byId = new Map();
    for (const item of copies.flatMap((c) => c[list] ?? [])) {
      byId.set(item.id, byId.has(item.id) ? newest(byId.get(item.id), item) : item);
    }
    if (byId.size) merged[list] = [...byId.values()];
  }
  return merged;
}

function parse(contents, name) {
  try {
    const data = JSON.parse(contents);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {}
  console.warn(`Ignoring unreadable sidecar ${name}`);
  return null;
}

/**
 * Returns the reading progress from a scanned book's sidecar (`book.sidecar`, as returned by
 * `plugin:library|scan`), or null.
 */
export function scannedProgress(book) {
  if (!book.sidecar) return null;
  return parse(book.sidecar, book.fileName + ".lontar")?.progress ?? null;
}

async function write(book, data) {
  const { version, ...rest } = data;
  const contents = JSON.stringify({ version: SIDECAR_VERSION, ...rest }, null, 2) + "\n";
  await invoke("plugin:library|write_sidecar", { book: sidecarRef(book), contents });
}

/**
 * Returns the book's saved data, or null if it has none yet. Any sync-conflict copies are
 * merged into the sidecar and then deleted.
 */
export async function loadBookData(book) {
  const ref = sidecarRef(book);
  const [contents, conflicts] = await Promise.all([
    invoke("plugin:library|read_sidecar", { book: ref }),
    invoke("plugin:library|read_sidecar_conflicts", { book: ref }),
  ]);
  const main = contents == null ? null : parse(contents, book.fileName + ".lontar");
  if (!conflicts.length) return main;

  const data = mergeBookData(main, ...conflicts.map((c) => parse(c.contents, c.name)));
  await write(book, data);
  // Only delete the copies once the merged result is safely written.
  for (const { name } of conflicts) {
    await invoke("plugin:library|delete_sidecar_conflict", { book: ref, name });
  }
  return data;
}

/** Saves the book's data, replacing any existing sidecar. */
export async function saveBookData(book, data) {
  await write(book, data);
}
