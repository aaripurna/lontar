import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_COLORS, highlightColor, makeHighlight, updateItem } from "./annotations.js";

describe("makeHighlight", () => {
  test("keeps the location, tidied text, colour and context", () => {
    const h = makeHighlight("epubcfi(/6/4!/4/2,/1:0,/1:9)", " It was\n a dark ", "green", {
      fraction: 0.1,
      label: "Chapter 1",
    });
    expect(h).toMatchObject({
      location: "epubcfi(/6/4!/4/2,/1:0,/1:9)",
      text: "It was a dark",
      color: "green",
      fraction: 0.1,
      label: "Chapter 1",
    });
    expect(h.id).toBeTruthy();
    expect(h).not.toHaveProperty("note");
  });

  test("caps very long selections", () => {
    expect(makeHighlight("epubcfi(/6/4)", "x".repeat(5000)).text.length).toBe(1000);
  });
});

describe("updateItem", () => {
  test("changes only the matching item and stamps it", () => {
    const list = [
      { id: "a", note: "old", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const updated = updateItem(list, "a", { note: "new" });
    expect(updated[0]).toMatchObject({ id: "a", note: "new" });
    expect(updated[0].updatedAt > list[0].createdAt).toBe(true);
    expect(updated[1]).toBe(list[1]);
  });
});

describe("highlightColor", () => {
  test("falls back to the default colour for unknown names", () => {
    expect(highlightColor({ color: "green" })).toBe(HIGHLIGHT_COLORS.green);
    expect(highlightColor({ color: "ultraviolet" })).toBe(HIGHLIGHT_COLORS.yellow);
  });
});
