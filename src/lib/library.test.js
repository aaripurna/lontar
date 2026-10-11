import { describe, expect, test } from "bun:test";
import { filterBooks, normalize, sortBooks } from "./library.js";
import { bookMetadata, sortName } from "./metadata.js";

const books = [
  { path: "/b/frank.epub", name: "frank" },
  { path: "/b/dune.epub", name: "dune" },
  { path: "/b/comic.cbz", name: "Comic 10" },
  { path: "/b/comic2.cbz", name: "Comic 9" },
];
const info = {
  "/b/frank.epub": { title: "Frankenstein", author: "Mary Shelley", authorSort: "Shelley, Mary" },
  "/b/dune.epub": { title: "Dune", author: "Frank Herbert", authorSort: "Herbert, Frank" },
};
const names = (list) => list.map((b) => b.name);

describe("filterBooks", () => {
  test("matches title, author and file name, ignoring case and accents", () => {
    expect(names(filterBooks(books, "SHELLEY", info))).toEqual(["frank"]);
    expect(names(filterBooks(books, "frank", info))).toEqual(["frank", "dune"]); // file name, author
    expect(names(filterBooks(books, "dúne", info))).toEqual(["dune"]);
  });

  test("needs every word to match", () => {
    expect(names(filterBooks(books, "frank herbert", info))).toEqual(["dune"]);
  });

  test("keeps everything for an empty query", () => {
    expect(filterBooks(books, "  ", info)).toBe(books);
  });
});

describe("sortBooks", () => {
  test("sorts titles naturally, falling back to file names", () => {
    expect(names(sortBooks(books, "title", info, {}))).toEqual(["Comic 9", "Comic 10", "dune", "frank"]);
  });

  test("sorts by author surname, with unknown authors last", () => {
    expect(names(sortBooks(books, "author", info, {}))).toEqual(["dune", "frank", "Comic 9", "Comic 10"]);
  });

  test("puts the most recently read first", () => {
    const progress = { "/b/dune.epub": { updatedAt: "2026-01-01" }, "/b/frank.epub": { updatedAt: "2026-02-01" } };
    expect(names(sortBooks(books, "recent", info, progress))).toEqual(["frank", "dune", "Comic 9", "Comic 10"]);
  });
});

describe("bookMetadata", () => {
  test("flattens language maps and author lists", () => {
    const meta = {
      title: { en: "Good Omens" },
      author: [{ name: "Terry Pratchett" }, { name: { en: "Neil Gaiman" }, sortAs: "Gaiman, Neil" }],
    };
    expect(bookMetadata(meta, "omens.epub")).toEqual({
      title: "Good Omens",
      author: "Terry Pratchett, Neil Gaiman",
      authorSort: "Pratchett, Terry",
    });
  });

  test("uses the author's file-as name when there is one", () => {
    expect(bookMetadata({ author: { name: "Mary Shelley", sortAs: "Shelley, Mary W." } }, "x").authorSort).toBe(
      "Shelley, Mary W.",
    );
  });

  test("ignores a title that is just the file name", () => {
    expect(bookMetadata({ title: "comic.cbz" }, "comic.cbz").title).toBe("");
  });
});

test("sortName puts the surname first", () => {
  expect(sortName("Robert A. Heinlein")).toBe("Heinlein, Robert A.");
  expect(sortName("Plato")).toBe("Plato");
  expect(sortName("Shelley, Mary")).toBe("Shelley, Mary");
});

test("normalize strips accents", () => {
  expect(normalize("Émile Zola")).toBe("emile zola");
});
