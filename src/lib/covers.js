// Book cover thumbnails for the library.
//
// Getting a cover means reading and parsing the whole book, so thumbnails are made once and
// cached in IndexedDB. They're derived data and device-local, so they don't belong in the
// synced sidecar. Requests are queued and handled one at a time to keep memory in check: a
// single book can be tens of MB.
import { invoke } from "@tauri-apps/api/core";
import { READABLE_FORMATS, openBookFile } from "./formats.js";

const DB_NAME = "lontar-covers";
const STORE = "covers";
const THUMB_HEIGHT = 240; // px; rows show covers ~64 CSS px tall on ~3x screens
const THUMB_TYPE = "image/webp";

/** Cache key: a replaced book (different size) gets a fresh cover. */
export function coverKey(book) {
  return `${book.path}|${book.size}`;
}

/** Scales (width, height) to fit `maxHeight`, never enlarging. */
export function thumbnailSize(width, height, maxHeight = THUMB_HEIGHT) {
  const scale = Math.min(1, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// --- IndexedDB (records: { blob: Blob | null }, null meaning "this book has no cover") ---

let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((e) => {
    console.warn("Cover cache unavailable", e);
    return null;
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}

const cacheGet = (key) => withStore("readonly", (store) => store.get(key));
const cachePut = (key, record) => withStore("readwrite", (store) => store.put(record, key));

/** Drops cached covers of books that are no longer in the library. */
export async function pruneCovers(books) {
  const keep = new Set(books.map(coverKey));
  const keys = (await withStore("readonly", (store) => store.getAllKeys())) ?? [];
  const stale = keys.filter((key) => !keep.has(key));
  if (stale.length) await withStore("readwrite", (store) => stale.forEach((key) => store.delete(key)));
}

// --- Extraction ---

async function downscale(blob) {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = thumbnailSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, THUMB_TYPE, 0.8));
}

async function extractCover(book) {
  const bytes = await invoke("plugin:library|read_book", {
    book: { folderId: book.folderId, path: book.path },
  });
  // foliate-js recognises some formats by extension, so give it the lowercase one.
  const parsed = await openBookFile(new File([bytes], `${book.name}.${book.format}`), book.format);
  try {
    const cover = await parsed.getCover?.();
    return cover ? await downscale(cover) : null;
  } finally {
    parsed.destroy?.();
  }
}

// One extraction at a time; covers already cached skip the queue.
let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// Within a session, each book's cover is looked up once: key -> Promise<Blob | null>.
const pending = new Map();

/**
 * Returns the book's cover thumbnail as a Blob, or null if it has none (or its format can't
 * be opened). Failures aren't cached, so a book that couldn't be read is retried next time.
 */
export function getCover(book) {
  if (!READABLE_FORMATS.has(book.format)) return Promise.resolve(null);
  const key = coverKey(book);
  if (!pending.has(key)) {
    const promise = (async () => {
      const cached = await cacheGet(key).catch(() => undefined);
      if (cached !== undefined) return cached.blob;
      const blob = await enqueue(() => extractCover(book));
      await cachePut(key, { blob }).catch((e) => console.warn("Couldn't cache cover", e));
      return blob;
    })();
    promise.catch(() => pending.delete(key));
    pending.set(key, promise);
  }
  return pending.get(key);
}
