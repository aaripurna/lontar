// PDF support for foliate-js: renders each page with pdf.js into foliate's fixed-layout view.
//
// Adapted from foliate-js's pdf.js (MIT, https://github.com/johnfactotum/foliate-js), which
// the npm release (1.0.1) doesn't include. Changes from upstream:
// - pdf.js comes from the pdfjs-dist package instead of a vendored copy, using its legacy
//   build: the modern one needs Chrome 126+ (URL.parse), and Android System WebView can lag
// - its runtime assets are served from /pdfjs/ (see pdfjsAssets in vite.config.js)
// - the text and annotation layer styles come from pdfjs-dist's pdf_viewer.css
// - optional margin trimming: each page can be shown cropped to its content (see trim.js)
// - each render builds fresh text and link layers (upstream appends to the old ones), and a
//   render overtaken by a newer one is discarded
// - pages have `createDocument`, so foliate-js can search them
// - the pages around the one shown are rendered ahead of time (see `makePrerenderer`)
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import viewerCSS from "pdfjs-dist/web/pdf_viewer.css?raw";
import { inkBounds, trimBox } from "./trim.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const assetUrl = (dir) => new URL(`/pdfjs/${dir}/`, location.href).href;

// Renders started for each page's document; only the latest one's result is shown, since
// zooming and resizing can start a new render before the last one finishes.
const latestRender = new WeakMap();

// Draws the whole page at `scale` (device pixels per PDF unit) on a new canvas.
const drawPage = async (page, scale) => {
  const viewport = page.getViewport({ scale });
  // the canvas must be in the `PDFDocument`'s `ownerDocument`
  // (`globalThis.document` by default); that's where the fonts are loaded
  const canvas = document.createElement("canvas");
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
};

const showCanvas = (doc, canvas, viewport, crop, scale) => {
  // A canvas rendered ahead at a slightly different zoom is stretched to fit until the sharp
  // one replaces it.
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  doc.documentElement.style.transform =
    `scale(${1 / devicePixelRatio}) translate(${-crop.x * scale}px, ${-crop.y * scale}px)`;
  doc.documentElement.style.transformOrigin = "top left";
  doc.documentElement.style.setProperty("--scale-factor", scale);
  doc.querySelector("#canvas").replaceChildren(doc.adoptNode(canvas));
};

// `crop` is the part of the page shown, in PDF units; the whole page is drawn, then shifted.
// `pages` is the book's prerenderer. Resolves once the page, its text layer and its links are
// in place.
const render = async (page, doc, zoom, crop, pages) => {
  const id = (latestRender.get(doc) ?? 0) + 1;
  latestRender.set(doc, id);
  const scale = zoom * devicePixelRatio;
  const viewport = page.getViewport({ scale });

  // A page just turned to shows its prerendered canvas, if there is one, straight away.
  const ahead = doc.querySelector("#canvas canvas") ? null : pages?.take(page.pageNumber);
  if (ahead) showCanvas(doc, ahead.canvas, viewport, crop, scale);
  const canvas = ahead?.scale === scale ? null : await drawPage(page, scale);

  // The text and link layers are built in new elements and swapped in at the end: pdf.js
  // appends to whatever is already there, and highlights point into the text layer, so it must
  // hold exactly one copy of the page's text, always in the same structure.
  const textDiv = doc.createElement("div");
  textDiv.className = "textLayer";
  await buildTextLayer(page, textDiv, viewport);

  // hide "offscreen" canvases appended to document when rendering text layer
  // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
  for (const canvas of document.querySelectorAll(".hiddenCanvasElement"))
    Object.assign(canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      display: "none",
    });

  // fix text selection
  // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
  textDiv.onpointerdown = () => textDiv.classList.add("selecting");
  textDiv.onpointerup = () => textDiv.classList.remove("selecting");

  const annotationDiv = doc.createElement("div");
  annotationDiv.className = "annotationLayer";
  const linkService = {
    goToDestination: () => {},
    getDestinationHash: (dest) => JSON.stringify(dest),
    addLinkAttributes: (link, url) => (link.href = url),
  };
  await new pdfjsLib.AnnotationLayer({ page, viewport, div: annotationDiv, linkService }).render({
    annotations: await page.getAnnotations(),
  });

  if (latestRender.get(doc) !== id) return;
  if (canvas) showCanvas(doc, canvas, viewport, crop, scale);
  doc.querySelector(".textLayer").replaceWith(textDiv);
  doc.querySelector(".annotationLayer").replaceWith(annotationDiv);
  pages?.shown(page.pageNumber, scale);
};

// Pages rendered ahead of time, relative to the one shown: foliate-js shows portrait PDFs as
// two-page spreads, so the page after next is often the next one to render from scratch.
const PRERENDER_AHEAD = [1, 2, -1];
// A canvas at high zoom can be tens of MB, so only a few are kept.
const PRERENDER_KEEP = 4;

/**
 * Renders the pages around the one on screen in the background, at its scale, so turning the
 * page doesn't wait for pdf.js. `sections` are the book's sections, loaded ahead as well.
 */
const makePrerenderer = (pdf, sections) => {
  const canvases = new Map(); // page number -> { canvas, scale }
  let queue = Promise.resolve();
  let generation = 0; // bumped by each page shown, so stale work is skipped

  const drop = (n) => {
    const entry = canvases.get(n);
    if (!entry) return;
    entry.canvas.width = 0; // frees its memory now rather than at garbage collection
    canvases.delete(n);
  };

  const renderAhead = async (n, scale, gen) => {
    if (gen !== generation || n < 1 || n > pdf.numPages) return;
    await sections[n - 1].load(); // its document, and its trimmed size if trimming
    if (canvases.get(n)?.scale === scale) return;
    const canvas = await drawPage(await pdf.getPage(n), scale);
    drop(n);
    canvases.set(n, { canvas, scale });
    while (canvases.size > PRERENDER_KEEP) drop(canvases.keys().next().value);
  };

  return {
    /** Hands over page `n`'s prerendered canvas, if any: { canvas, scale }. */
    take(n) {
      const entry = canvases.get(n);
      canvases.delete(n);
      return entry;
    },
    /** Called when page `n` has been shown at `scale`. */
    shown(n, scale) {
      const gen = ++generation;
      queue = queue.then(async () => {
        for (const offset of PRERENDER_AHEAD) {
          await renderAhead(n + offset, scale, gen).catch((e) => console.warn("Prerender failed", e));
        }
      });
    },
    clear() {
      generation++;
      for (const n of [...canvases.keys()]) drop(n);
    },
  };
};

const TRIM_SAMPLE_WIDTH = 300; // px; pages are rendered this small to find their content

// The part of the page to show when trimming margins, in PDF units.
const findCrop = async (page) => {
  const { width, height } = page.getViewport({ scale: 1 });
  const scale = TRIM_SAMPLE_WIDTH / width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext, viewport }).promise;
  const ink = inkBounds(canvasContext.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  const box = ink && { x: ink.x / scale, y: ink.y / scale, width: ink.width / scale, height: ink.height / scale };
  return trimBox(box, width, height);
};

// The body of each page's document. Search results and highlights are located by their path
// in it, so the documents made for search (see `pageText`) must have the same structure.
const PAGE_BODY = `<div id="canvas"></div><div class="textLayer"></div><div class="annotationLayer"></div>`;

// Builds a page's text layer into `div`, as `render` shows it.
const buildTextLayer = async (page, div, viewport) => {
  await new pdfjsLib.TextLayer({
    textContentSource: await page.streamTextContent(),
    container: div,
    viewport,
  }).render();
  const endOfContent = div.ownerDocument.createElement("div");
  endOfContent.className = "endOfContent";
  div.append(endOfContent);
};

// A document with just the page's text, laid out like the rendered page's, for search.
const pageText = async (page) => {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${PAGE_BODY}</body></html>`,
    "text/html",
  );
  await buildTextLayer(page, doc.querySelector(".textLayer"), page.getViewport({ scale: 1 }));
  return doc;
};

const renderPage = async (page, getImageBlob, trim, pages) => {
  const viewport = page.getViewport({ scale: 1 });
  if (getImageBlob) {
    const canvas = document.createElement("canvas");
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    const canvasContext = canvas.getContext("2d");
    await page.render({ canvasContext, viewport }).promise;
    return new Promise((resolve) => canvas.toBlob(resolve));
  }
  const crop = trim ? await findCrop(page) : { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const src = URL.createObjectURL(
    new Blob(
      [
        `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${crop.width}, height=${crop.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        /*
        https://github.com/mozilla/pdf.js/commit/bd05b255fabfc313b194bfe9a17ccded4d90fb5a
        */
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${viewerCSS}
        </style>
        ${PAGE_BODY}
    `,
      ],
      { type: "text/html" },
    ),
  );
  const onZoom = ({ doc, scale }) => render(page, doc, scale, crop, pages);
  return { src, onZoom };
};

const makeTOCItem = (item) => ({
  label: item.title,
  href: JSON.stringify(item.dest),
  subitems: item.items.length ? item.items.map(makeTOCItem) : null,
});

export const makePDF = async (file, { trimMargins = false } = {}) => {
  const transport = new pdfjsLib.PDFDataRangeTransport(file.size, []);
  transport.requestDataRange = (begin, end) => {
    file
      .slice(begin, end)
      .arrayBuffer()
      .then((chunk) => {
        transport.onDataRange(begin, chunk);
      });
  };
  const pdf = await pdfjsLib.getDocument({
    range: transport,
    cMapUrl: assetUrl("cmaps"),
    standardFontDataUrl: assetUrl("standard_fonts"),
    wasmUrl: assetUrl("wasm"),
    iccUrl: assetUrl("iccs"),
    isEvalSupported: false,
  }).promise;

  const book = { rendition: { layout: "pre-paginated" }, trimMargins };

  const { metadata, info } = (await pdf.getMetadata()) ?? {};
  // TODO: for better results, parse `metadata.getRaw()`
  book.metadata = {
    title: metadata?.get("dc:title") ?? info?.Title,
    author: metadata?.get("dc:creator") ?? info?.Author,
    contributor: metadata?.get("dc:contributor"),
    description: metadata?.get("dc:description") ?? info?.Subject,
    language: metadata?.get("dc:language"),
    publisher: metadata?.get("dc:publisher"),
    subject: metadata?.get("dc:subject"),
    identifier: metadata?.get("dc:identifier"),
    source: metadata?.get("dc:source"),
    rights: metadata?.get("dc:rights"),
  };

  const outline = await pdf.getOutline();
  book.toc = outline?.map(makeTOCItem);

  const cache = new Map();
  book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
    id: i,
    load: async () => {
      // Changing `book.trimMargins` takes effect as pages are (re)loaded.
      const key = `${i}:${book.trimMargins}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const url = await renderPage(await pdf.getPage(i + 1), false, book.trimMargins, pages);
      cache.set(key, url);
      return url;
    },
    createDocument: async () => pageText(await pdf.getPage(i + 1)),
    size: 1000,
  }));
  const pages = makePrerenderer(pdf, book.sections);
  book.isExternal = (uri) => /^\w+:/i.test(uri);
  book.resolveHref = async (href) => {
    const parsed = JSON.parse(href);
    const dest = typeof parsed === "string" ? await pdf.getDestination(parsed) : parsed;
    const index = await pdf.getPageIndex(dest[0]);
    return { index };
  };
  book.splitTOCHref = async (href) => {
    const parsed = JSON.parse(href);
    const dest = typeof parsed === "string" ? await pdf.getDestination(parsed) : parsed;
    const index = await pdf.getPageIndex(dest[0]);
    return [index, null];
  };
  book.getTOCFragment = (doc) => doc.documentElement;
  book.getCover = async () => renderPage(await pdf.getPage(1), true);
  book.destroy = () => {
    pages.clear();
    pdf.destroy();
  };
  return book;
};
