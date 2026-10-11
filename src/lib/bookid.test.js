import { describe, expect, test } from "bun:test";
import { bookIdSize, computeBookId, matchOrphans, orphanBookId, reattachCandidates } from "./bookid.js";

const bytes = (size, fill = 7) => new Uint8Array(size).fill(fill);

describe("computeBookId", () => {
  test("records the size and is stable", async () => {
    const id = await computeBookId(bytes(1000));
    expect(id).toMatch(/^v1:1000:[0-9a-f]{64}$/);
    expect(await computeBookId(bytes(1000).buffer)).toBe(id);
    expect(bookIdSize(id)).toBe(1000);
  });

  test("differs when the contents do", async () => {
    expect(await computeBookId(bytes(1000, 1))).not.toBe(await computeBookId(bytes(1000, 2)));
  });

  test("covers the end of large books, not just the start", async () => {
    const a = bytes(500_000);
    const b = bytes(500_000);
    b[499_999] = 1;
    expect(await computeBookId(a)).not.toBe(await computeBookId(b));
  });
});

const ID = `v1:100:${"a".repeat(64)}`;
const OTHER = `v1:100:${"b".repeat(64)}`;
const orphan = (bookId, name = "Old.epub") => ({ fileName: name, contents: JSON.stringify({ bookId }) });

describe("reattachCandidates", () => {
  test("picks books without a sidecar whose size matches an orphan", () => {
    const books = [
      { path: "a", size: 100 },
      { path: "b", size: 100, hasSidecar: true },
      { path: "c", size: 200 },
    ];
    const found = reattachCandidates([orphan(ID), { contents: "not json" }], books, (b) => b.hasSidecar);
    expect(found.map((b) => b.path)).toEqual(["a"]);
  });

  test("ignores orphans without a valid id", () => {
    expect(orphanBookId({ contents: JSON.stringify({ bookId: "nope" }) })).toBeNull();
    expect(orphanBookId({ contents: "{" })).toBeNull();
  });
});

describe("matchOrphans", () => {
  const a = { path: "a" };
  const b = { path: "b" };

  test("pairs an orphan with the one book that has its id", () => {
    const ids = { a: OTHER, b: ID };
    const pairs = matchOrphans([orphan(ID)], [a, b], (book) => ids[book.path]);
    expect(pairs.map((p) => p.book)).toEqual([b]);
  });

  test("leaves an orphan matching two books alone", () => {
    expect(matchOrphans([orphan(ID)], [a, b], () => ID)).toEqual([]);
  });

  test("leaves a book claimed by two orphans alone", () => {
    expect(matchOrphans([orphan(ID, "x.epub"), orphan(ID, "y.epub")], [a], () => ID)).toEqual([]);
  });
});
