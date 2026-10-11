// Book identity, for finding a book's sidecar again after the book is renamed or moved.
//
// Sidecars are named after their book (`Dune.epub.lontar`); renaming or moving the book leaves
// the sidecar behind as an orphan. Each sidecar records `bookId`, a fingerprint of the book's
// contents, so an orphan can be matched to the renamed book and renamed to suit it.
//
// The id is "v1:<size>:<sha-256 hex>", hashing the size and the first and last 64 KB: quick
// even for large PDFs, and since the size is in the clear, books of other sizes can be ruled
// out without reading them. Editing a book's contents changes its id; renaming never does.

const SAMPLE = 64 * 1024;
const ID_PATTERN = /^v1:(\d+):[0-9a-f]{64}$/;

/** The id of a book's contents (an ArrayBuffer or typed array), or null if it can't be made. */
export async function computeBookId(contents) {
  const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
  if (!globalThis.crypto?.subtle) return null; // only in secure contexts
  const size = bytes.byteLength;
  const header = new TextEncoder().encode(`${size}\n`);
  const head = bytes.subarray(0, SAMPLE);
  const tail = bytes.subarray(Math.max(SAMPLE, size - SAMPLE));
  const data = new Uint8Array(header.length + head.length + tail.length);
  data.set(header);
  data.set(head, header.length);
  data.set(tail, header.length + head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `v1:${size}:${hex}`;
}

/** The book size recorded in an id, or null if it isn't one. */
export function bookIdSize(id) {
  const match = typeof id === "string" && ID_PATTERN.exec(id);
  return match ? Number(match[1]) : null;
}

/** The `bookId` in an orphaned sidecar's contents, or null. */
export function orphanBookId(orphan) {
  try {
    const id = JSON.parse(orphan.contents)?.bookId;
    return bookIdSize(id) == null ? null : id;
  } catch {
    return null;
  }
}

/**
 * The books worth fingerprinting to place the orphans: those without a sidecar whose size
 * matches an orphan's book. `books` are scanned books, `hasSidecar(book)` says if one has.
 */
export function reattachCandidates(orphans, books, hasSidecar) {
  const sizes = new Set(orphans.map((o) => bookIdSize(orphanBookId(o))).filter((s) => s != null));
  return books.filter((b) => !hasSidecar(b) && sizes.has(b.size));
}

/**
 * Pairs orphans with the candidate book they belong to: [{ orphan, book }]. `idOf(book)` is a
 * candidate's id. Anything ambiguous (an orphan matching several books, or a book matched by
 * several orphans, e.g. a book kept in two folders) is left alone rather than guessed.
 */
export function matchOrphans(orphans, candidates, idOf) {
  const pairs = [];
  for (const orphan of orphans) {
    const id = orphanBookId(orphan);
    if (!id) continue;
    const matches = candidates.filter((b) => idOf(b) === id);
    if (matches.length === 1) pairs.push({ orphan, book: matches[0] });
  }
  return pairs.filter(({ book }) => pairs.filter((p) => p.book === book).length === 1);
}
