// Book metadata as foliate-js parses it, flattened for the library: values may be plain
// strings or { language: string } maps, and authors a string, an object or a list of either.

/** A metadata value as a string: the first translation of a language map. */
export function metaText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return Object.values(value).find((v) => typeof v === "string") ?? "";
}

function contributors(value) {
  return (Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .map((c) => (typeof c === "string" ? { name: c } : { name: metaText(c.name), sortAs: metaText(c.sortAs) }))
    .map((c) => ({ ...c, name: c.name.trim() }))
    .filter((c) => c.name);
}

/** "Mary Shelley" -> "Shelley, Mary", for sorting by surname. Names with a comma are kept. */
export function sortName(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || name.includes(",")) return name.trim();
  return `${parts.at(-1)}, ${parts.slice(0, -1).join(" ")}`;
}

/**
 * The library's view of a book's metadata: { title, author, authorSort }, each "" if unknown.
 * `fileName` is what the book was opened as: formats without metadata (comics) report it as
 * their title, which isn't one.
 */
export function bookMetadata(metadata, fileName) {
  const title = metaText(metadata?.title).trim();
  const authors = contributors(metadata?.author);
  return {
    title: title && title !== fileName ? title : "",
    author: authors.map((a) => a.name).join(", "),
    authorSort: authors.length ? authors[0].sortAs || sortName(authors[0].name) : "",
  };
}
