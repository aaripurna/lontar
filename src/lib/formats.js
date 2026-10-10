// Formats the bundled foliate-js can render, plus PDF through ./foliate-pdf.js.
export const READABLE_FORMATS = new Set(["epub", "mobi", "azw", "azw3", "kf8", "fb2", "cbz", "pdf"]);

// Opens a book file with foliate-js (or the PDF adapter), without displaying it.
export async function openBookFile(file, format) {
  if (format === "pdf") {
    // pdf.js is large, so only load it for PDFs.
    const { makePDF } = await import("./foliate-pdf.js");
    return makePDF(file);
  }
  const { makeBook } = await import("foliate-js/view.js");
  return makeBook(file);
}
