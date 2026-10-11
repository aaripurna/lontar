import { describe, expect, test } from "bun:test";
import { activeItems, isOnPage, makeBookmark, removeItems } from "./bookmarks.js";

// A page spanning offsets 0-30 of the text node at /4/2/1 in the second spine item.
const PAGE = "epubcfi(/6/4!/4/2,/1:0,/1:30)";

describe("isOnPage", () => {
  test("is true for a position within the page", () => {
    expect(isOnPage({ location: "epubcfi(/6/4!/4/2/1:12)" }, PAGE)).toBe(true);
  });

  test("is false for positions before or after the page", () => {
    expect(isOnPage({ location: "epubcfi(/6/2!/4/2/1:12)" }, PAGE)).toBe(false);
    expect(isOnPage({ location: "epubcfi(/6/4!/4/2/1:31)" }, PAGE)).toBe(false);
  });

  test("ignores removed bookmarks", () => {
    expect(isOnPage({ location: "epubcfi(/6/4!/4/2/1:12)", deleted: true }, PAGE)).toBe(false);
  });
});

describe("makeBookmark", () => {
  test("starts at the page's first position and quotes its text", () => {
    const range = { toString: () => "  It was a bright\n cold day in April " };
    const b = makeBookmark({ cfi: PAGE, fraction: 0.25, range, tocItem: { label: "Chapter 1" } });
    expect(b).toMatchObject({ location: "epubcfi(/6/4!/4/2/1:0)", fraction: 0.25, label: "Chapter 1" });
    expect(b.excerpt).toBe("It was a bright cold day in April");
    expect(b.id).toBeTruthy();
  });

  test("labels fixed-layout pages by number", () => {
    expect(makeBookmark({ cfi: PAGE, fraction: 0.5 }, 7).label).toBe("Page 7");
  });
});

describe("removeItems", () => {
  test("leaves a tombstone that activeItems hides", () => {
    const list = [
      { id: "a", location: "epubcfi(/6/4!/4/2/1:5)", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", location: "epubcfi(/6/2!/4/2/1:5)", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const removed = removeItems(list, ["a"]);
    expect(removed.find((b) => b.id === "a")).toMatchObject({ deleted: true });
    expect(removed.find((b) => b.id === "a").updatedAt > list[0].createdAt).toBe(true);
    expect(activeItems(removed).map((b) => b.id)).toEqual(["b"]);
  });

  test("activeItems skips items without a location", () => {
    const list = [
      { id: "a", location: "epubcfi(/6/4!/4/2/1:5)" },
      { id: "odd", range: "epubcfi(/6/10)" },
      { id: "b", location: "epubcfi(/6/2!/4/2/1:5)" },
    ];
    expect(activeItems(list).map((b) => b.id)).toEqual(["b", "a"]);
  });

  test("activeItems sorts by position in the book", () => {
    const list = [
      { id: "late", location: "epubcfi(/6/4!/4/2/1:5)" },
      { id: "early", location: "epubcfi(/6/2!/4/2/1:5)" },
    ];
    expect(activeItems(list).map((b) => b.id)).toEqual(["early", "late"]);
  });
});
