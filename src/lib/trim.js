// Margin trimming for PDF pages: find where a page's content is, so the reader can show just
// that part, larger. Pure functions, kept apart from pdf.js so they can be tested.

const INK_THRESHOLD = 230; // a pixel is content if any channel is darker than this
const PADDING = 0.02; // of the page size, kept around the content on each side
const MIN_SIZE = 0.6; // of the page size; stops a near-empty page from being blown up

/**
 * Bounding box of the non-white pixels in RGBA image data, in pixels, or null if the image is
 * blank. Transparent pixels count as paper.
 */
export function inkBounds(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      if (Math.min(data[i], data[i + 1], data[i + 2]) >= INK_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX + 1 - minX, height: maxY + 1 - minY };
}

/**
 * The part of a `pageWidth` x `pageHeight` page to show, given its content box `ink` (same
 * units): the content plus a little padding, at least MIN_SIZE of the page in each dimension,
 * and never outside the page. A blank page (no ink) is shown whole.
 */
export function trimBox(ink, pageWidth, pageHeight) {
  if (!ink) return { x: 0, y: 0, width: pageWidth, height: pageHeight };
  const axis = (start, size, total) => {
    const pad = PADDING * total;
    let lo = Math.max(0, start - pad);
    let hi = Math.min(total, start + size + pad);
    const grow = MIN_SIZE * total - (hi - lo);
    if (grow > 0) {
      lo -= grow / 2;
      hi += grow / 2;
      if (lo < 0) [lo, hi] = [0, hi - lo];
      if (hi > total) [lo, hi] = [lo - (hi - total), total];
    }
    return [lo, hi - lo];
  };
  const [x, width] = axis(ink.x, ink.width, pageWidth);
  const [y, height] = axis(ink.y, ink.height, pageHeight);
  return { x, y, width, height };
}
