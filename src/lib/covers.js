// Book cover thumbnails and metadata (title, author) for the library.
//
// Getting them means reading and parsing the whole book, so they're read once and cached in
// IndexedDB. They're derived data and device-local, so they don't belong in the synced
// sidecar. Books are parsed one at a time to keep memory in check (a single book can be tens
// of MB): rows on screen first, then the rest of the library in the background.
import { invoke } from "@tauri-apps/api/core";
import { READABLE_FORMATS, openBookFile } from "./formats.js";
import { bookMetadata } from "./metadata.js";

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

// --- IndexedDB ---
// Records: { blob: Blob | null, meta: { title, author, authorSort } }, a null blob meaning
// "this book has no cover". Records from before metadata was kept have no `meta`, and are
// read again.

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

async function extractInfo(book) {
  const bytes = await invoke("plugin:library|read_book", {
    book: { folderId: book.folderId, path: book.path },
  });
  // foliate-js recognises some formats by extension, so give it the lowercase one.
  const fileName = `${book.name}.${book.format}`;
  const parsed = await openBookFile(new File([bytes], fileName), book.format);
  try {
    const cover = await parsed.getCover?.();
    return { blob: cover ? await downscale(cover) : null, meta: bookMetadata(parsed.metadata, fileName) };
  } finally {
    parsed.destroy?.();
  }
}

// --- The queue: one book at a time ---
// Jobs for rows on screen go first. Background jobs wait while paused, e.g. while reading, so
// they don't compete with the book being read.

const waiting = []; // [{ key, task, resolve, reject, urgent }]
let running = false;
let paused = false;

function schedule(key, task, urgent) {
  return new Promise((resolve, reject) => {
    const job = { key, task, resolve, reject, urgent };
    if (urgent) waiting.unshift(job);
    else waiting.push(job);
    pump();
  });
}

// Moves a waiting background job to the front, when its row comes on screen.
function hurry(key) {
  const i = waiting.findIndex((job) => job.key === key && !job.urgent);
  if (i === -1) return;
  const [job] = waiting.splice(i, 1);
  job.urgent = true;
  waiting.unshift(job);
}

async function pump() {
  if (running) return;
  running = true;
  for (;;) {
    const i = waiting.findIndex((job) => job.urgent || !paused);
    if (i === -1) break;
    const [job] = waiting.splice(i, 1);
    try {
      job.resolve(await job.task());
    } catch (e) {
      job.reject(e);
    }
  }
  running = false;
}

/** Pauses (or resumes) reading books in the background; rows on screen still get theirs. */
export function pauseBackground(value) {
  paused = value;
  if (!paused) pump();
}

// Within a session, each book is looked up once: key -> Promise<record>.
const pending = new Map();
// Books wanted for rows on screen, also while their lookup is still checking the cache.
const onScreen = new Set();

function getInfo(book, urgent) {
  const key = coverKey(book);
  if (urgent) onScreen.add(key);
  if (pending.has(key)) {
    if (urgent) hurry(key);
    return pending.get(key);
  }
  const promise = (async () => {
    const cached = await cacheGet(key).catch(() => undefined);
    if (cached?.meta) return cached;
    const record = await schedule(key, () => extractInfo(book), onScreen.has(key));
    await cachePut(key, record).catch((e) => console.warn("Couldn't cache book info", e));
    return record;
  })();
  // Failures aren't kept, so a book that couldn't be read is retried next time.
  promise.catch(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

/**
 * Returns the book's cover thumbnail as a Blob, or null if it has none (or its format can't
 * be opened). For rows on screen, so it jumps the queue.
 */
export async function getCover(book) {
  if (!READABLE_FORMATS.has(book.format)) return null;
  return (await getInfo(book, true)).blob;
}

/**
 * Returns the book's { title, author, authorSort } ("" where unknown), reading it in the
 * background if it isn't cached.
 */
export async function getBookMeta(book) {
  if (!READABLE_FORMATS.has(book.format)) return { title: "", author: "", authorSort: "" };
  return (await getInfo(book, false)).meta;
}
