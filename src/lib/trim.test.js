import { describe, expect, test } from "bun:test";
import { inkBounds, trimBox } from "./trim.js";

// A white RGBA image with the given pixels painted black.
function image(width, height, inked = []) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y] of inked) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  return data;
}

describe("inkBounds", () => {
  test("finds the box around the dark pixels", () => {
    expect(inkBounds(image(10, 10, [[2, 3], [7, 5]]), 10, 10)).toEqual({ x: 2, y: 3, width: 6, height: 3 });
  });

  test("returns null for a blank page", () => {
    expect(inkBounds(image(10, 10), 10, 10)).toBeNull();
  });

  test("treats transparent pixels as paper", () => {
    const data = image(4, 4);
    data.fill(0, 0, 4); // pixel (0, 0): black but fully transparent
    expect(inkBounds(data, 4, 4)).toBeNull();
  });
});

describe("trimBox", () => {
  test("crops to the content plus padding", () => {
    expect(trimBox({ x: 100, y: 100, width: 800, height: 800 }, 1000, 1000)).toEqual({
      x: 80,
      y: 80,
      width: 840,
      height: 840,
    });
  });

  test("keeps at least 60% of the page, around the content", () => {
    const box = trimBox({ x: 450, y: 100, width: 100, height: 20 }, 1000, 1000);
    expect(box.width).toBeCloseTo(600);
    expect(box.x).toBeCloseTo(200);
    expect(box.height).toBeCloseTo(600);
    expect(box.y).toBeCloseTo(0); // shifted down rather than past the top edge
  });

  test("shows a blank page whole", () => {
    expect(trimBox(null, 600, 800)).toEqual({ x: 0, y: 0, width: 600, height: 800 });
  });
});
