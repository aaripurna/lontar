import { describe, expect, test } from "bun:test";
import { mergeBookData, scannedProgress } from "./sidecar.js";

describe("mergeBookData", () => {
  test("keeps the newest progress", () => {
    const phone = { progress: { location: "a", updatedAt: "2026-10-10T10:00:00.000Z" } };
    const laptop = { progress: { location: "b", updatedAt: "2026-10-10T11:00:00.000Z" } };
    expect(mergeBookData(phone, laptop).progress.location).toBe("b");
    expect(mergeBookData(laptop, phone).progress.location).toBe("b");
  });

  test("combines bookmarks by id, keeping each one's newest version", () => {
    const a = {
      bookmarks: [
        { id: "1", createdAt: "2026-10-01T00:00:00.000Z", note: "old" },
        { id: "2", createdAt: "2026-10-02T00:00:00.000Z" },
      ],
    };
    const b = {
      bookmarks: [
        { id: "1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", note: "new" },
        { id: "3", createdAt: "2026-10-03T00:00:00.000Z" },
      ],
    };
    const merged = mergeBookData(a, b).bookmarks;
    expect(merged.map((m) => m.id).sort()).toEqual(["1", "2", "3"]);
    expect(merged.find((m) => m.id === "1").note).toBe("new");
  });

  test("a newer deletion wins over an older copy of the item", () => {
    const a = { annotations: [{ id: "x", createdAt: "2026-10-01T00:00:00.000Z", text: "hi" }] };
    const b = {
      annotations: [
        { id: "x", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", deleted: true },
      ],
    };
    expect(mergeBookData(a, b).annotations).toEqual(b.annotations);
  });

  test("keeps unknown fields, preferring earlier copies", () => {
    const merged = mergeBookData({ theme: "dark" }, { theme: "light", fontSize: 18 });
    expect(merged).toEqual({ theme: "dark", fontSize: 18 });
  });

  test("ignores missing or unreadable copies", () => {
    const data = { progress: { location: "a", updatedAt: "2026-10-10T10:00:00.000Z" } };
    expect(mergeBookData(null, data, null)).toEqual(data);
    expect(mergeBookData()).toEqual({});
  });

  test("doesn't add empty lists", () => {
    expect(mergeBookData({ progress: { location: "a" } })).not.toHaveProperty("bookmarks");
  });
});

describe("scannedProgress", () => {
  test("reads progress from the scanned sidecar text", () => {
    const progress = { location: "a", fraction: 0.5, updatedAt: "2026-10-10T10:00:00.000Z" };
    expect(scannedProgress({ fileName: "x.epub", sidecar: JSON.stringify({ progress }) })).toEqual(progress);
  });

  test("returns null without a sidecar, without progress, or for unreadable JSON", () => {
    expect(scannedProgress({ fileName: "x.epub" })).toBeNull();
    expect(scannedProgress({ fileName: "x.epub", sidecar: "{}" })).toBeNull();
    expect(scannedProgress({ fileName: "x.epub", sidecar: "{oops" })).toBeNull();
  });
});
