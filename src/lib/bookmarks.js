// Bookmarks, stored in the sidecar's `bookmarks` list (see sidecar.js):
//   { id, location (CFI of the page's start), fraction, label, excerpt?, createdAt,
//     updatedAt?, deleted? }
// A bookmark marks a position, not a page: pages reflow with the text size, so a page counts
// as bookmarked if any bookmark's position falls on it.
import { collapse, compare } from "foliate-js/epubcfi.js";

const EXCERPT_LENGTH = 120;

export function newId() {
  return globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Bookmarks or annotations that haven't been removed, in reading order. Items without a
 * location (e.g. written by another app or a future version) are left out.
 */
export function activeItems(items = []) {
  return items.filter((b) => !b.deleted && b.location).sort((a, b) => compare(a.location, b.location));
}

/** Whether `bookmark` falls on the page whose location (a range CFI) is `pageCfi`. */
export function isOnPage(bookmark, pageCfi) {
  if (bookmark.deleted || !pageCfi) return false;
  return compare(bookmark.location, collapse(pageCfi)) >= 0 && compare(bookmark.location, collapse(pageCfi, true)) <= 0;
}

/**
 * A new bookmark for the page at `location` (foliate-js's `relocate` detail). `page` is the
 * page number for fixed-layout books, which have no text to quote.
 */
export function makeBookmark(location, page) {
  const excerpt = location.range?.toString().replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH);
  return {
    id: newId(),
    location: collapse(location.cfi),
    fraction: location.fraction,
    label: [page && `Page ${page}`, location.tocItem?.label].filter(Boolean).join(" · "),
    ...(excerpt ? { excerpt } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** Marks the given bookmarks or annotations as removed, so a sync merge can't bring them back. */
export function removeItems(items = [], ids) {
  const now = new Date().toISOString();
  return items.map((b) => (ids.includes(b.id) ? { id: b.id, createdAt: b.createdAt, updatedAt: now, deleted: true } : b));
}
