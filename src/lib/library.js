// Searching and sorting the library. `info` maps book path -> { title, author, authorSort }
// (see metadata.js), for the books whose metadata has been read so far.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Lowercase, without accents, for matching typed queries. */
export function normalize(text) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

/** The book's title, or its file name until (or unless) it has one. */
export function displayTitle(book, info) {
  return info?.title || book.name;
}

/** Books matching every word of `query` in their title, author or file name. */
export function filterBooks(books, query, info) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return books;
  return books.filter((book) => {
    const meta = info[book.path];
    const text = normalize([displayTitle(book, meta), meta?.author ?? "", book.name].join(" "));
    return words.every((word) => text.includes(word));
  });
}

/**
 * Books sorted by "title", "author" (by surname; books without one last) or "recent" (most
 * recently read first, unread last). Ties go by title.
 */
export function sortBooks(books, by, info, progress) {
  const byTitle = (a, b) => collator.compare(displayTitle(a, info[a.path]), displayTitle(b, info[b.path]));
  const compare = {
    recent: (a, b) =>
      (progress[b.path]?.updatedAt ?? "").localeCompare(progress[a.path]?.updatedAt ?? "") || byTitle(a, b),
    author: (a, b) => {
      const x = info[a.path]?.authorSort ?? "";
      const y = info[b.path]?.authorSort ?? "";
      if (!x !== !y) return x ? -1 : 1;
      return collator.compare(x, y) || byTitle(a, b);
    },
  }[by] ?? byTitle;
  return [...books].sort(compare);
}
