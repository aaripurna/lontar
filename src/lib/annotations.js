// Highlights (with optional notes), stored in the sidecar's `annotations` list (see sidecar.js):
//   { id, location (CFI range of the text), text, color, note?, fraction?, label?, createdAt,
//     updatedAt?, deleted? }
// Removal and ordering work as for bookmarks: see activeItems and removeItems in bookmarks.js.
import { newId } from "./bookmarks.js";

// Highlight colours, by name; the name is what's stored, so it can be restyled later.
export const HIGHLIGHT_COLORS = {
  yellow: "#f2c94c",
  green: "#6fcf97",
  blue: "#56a4f0",
  pink: "#f28cb1",
};
export const DEFAULT_COLOR = "yellow";

const MAX_TEXT = 1000; // characters of the highlighted text kept in the sidecar

/**
 * A new highlight of `text` at `location` (a range CFI). `context` is where it is in the book:
 * { fraction, label }.
 */
export function makeHighlight(location, text, color = DEFAULT_COLOR, context = {}) {
  const { fraction, label } = context;
  return {
    id: newId(),
    location,
    text: text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT),
    color,
    ...(fraction != null ? { fraction } : {}),
    ...(label ? { label } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** Applies `changes` to the item with `id`, stamping it so it wins a sync merge. */
export function updateItem(items = [], id, changes) {
  const now = new Date().toISOString();
  return items.map((item) => (item.id === id ? { ...item, ...changes, updatedAt: now } : item));
}

/** The colour to draw a highlight in, falling back to the default for unknown names. */
export function highlightColor(annotation) {
  return HIGHLIGHT_COLORS[annotation.color] ?? HIGHLIGHT_COLORS[DEFAULT_COLOR];
}
