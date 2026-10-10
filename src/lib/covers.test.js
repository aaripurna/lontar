import { describe, expect, test } from "bun:test";
import { coverKey, thumbnailSize } from "./covers.js";

describe("thumbnailSize", () => {
  test("scales tall images down to the target height, keeping the aspect ratio", () => {
    expect(thumbnailSize(1200, 1800, 240)).toEqual({ width: 160, height: 240 });
  });

  test("never enlarges small images", () => {
    expect(thumbnailSize(100, 150, 240)).toEqual({ width: 100, height: 150 });
  });

  test("never produces a zero dimension", () => {
    expect(thumbnailSize(10, 100000, 240).width).toBe(1);
  });
});

describe("coverKey", () => {
  test("changes when the book file is replaced with a different size", () => {
    const book = { path: "/books/Dune.epub", size: 1000 };
    expect(coverKey(book)).not.toBe(coverKey({ ...book, size: 2000 }));
  });
});
