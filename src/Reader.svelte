<script>
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import "foliate-js/view.js";

  // `book` is an entry from the `plugin:library|scan` result.
  let { book, onclose } = $props();

  // Formats the bundled foliate-js can render. PDF needs pdf.js, which it doesn't ship.
  const SUPPORTED = new Set(["epub", "mobi", "azw", "azw3", "kf8", "fb2", "cbz"]);

  // Applied inside the book's own document, adapted from foliate-js's demo reader.
  const BOOK_CSS = `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: light dark; }
    @media (prefers-color-scheme: dark) { a:link { color: lightblue; } }
    p, li, blockquote, dd {
      line-height: 1.5;
      text-align: justify;
      hyphens: auto;
      -webkit-hyphens: auto;
      widows: 2;
      orphans: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    pre { white-space: pre-wrap !important; }
    aside[epub|type~="endnote"], aside[epub|type~="footnote"],
    aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
  `;

  let container;
  let view;
  let title = $state(book.name);
  let chapter = $state("");
  let fraction = $state(null);
  let loading = $state(true);
  let error = $state("");

  const percent = new Intl.NumberFormat(undefined, { style: "percent" });

  // Metadata values may be plain strings or { lang: string } maps.
  function text(value) {
    if (!value || typeof value === "string") return value ?? "";
    return Object.values(value)[0] ?? "";
  }

  function onKeydown(event) {
    if (event.key === "ArrowLeft") view?.goLeft();
    else if (event.key === "ArrowRight" || event.key === " ") view?.goRight();
    else if (event.key === "Escape") close();
  }

  // Tapping the outer thirds of the page turns it; the middle is left for future controls.
  // Returns the page-turn function for a tap, or null if the tap should be left alone.
  function tapAction(target, clientX) {
    const doc = target.ownerDocument;
    if (target.closest?.("a") || !doc.getSelection()?.isCollapsed) return null;
    // Map the tap into the reader's coordinates: paginated chapters live in a wide, scrolled
    // iframe, and fixed-layout pages (comics) are scaled with a CSS transform.
    const frame = doc.defaultView.frameElement;
    const rect = frame.getBoundingClientRect();
    const scale = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
    const x = rect.left + clientX * scale;
    const { left, width } = container.getBoundingClientRect();
    const position = (x - left) / width;
    if (position < 1 / 3) return () => view.goLeft();
    if (position > 2 / 3) return () => view.goRight();
    return null;
  }

  function onClick(event) {
    tapAction(event.target, event.clientX)?.();
  }

  // foliate-js snaps to the nearest page on every touchend. If a tap also turns the page, the
  // two navigations race, and when both cross into another section the paginator can lock up
  // for good. So a tap on a page-turn zone is handled here, before foliate's own listeners,
  // and kept from them. Swipes and long presses still go to foliate.
  let touchStart = null;

  function onTouchStart(event) {
    const t = event.changedTouches[0];
    touchStart = event.touches.length === 1 ? { x: t.screenX, y: t.screenY, time: event.timeStamp } : null;
  }

  function onTouchEnd(event) {
    const start = touchStart;
    touchStart = null;
    const t = event.changedTouches[0];
    if (!start || event.timeStamp - start.time > 500) return;
    if (Math.hypot(t.screenX - start.x, t.screenY - start.y) > 10) return;
    const action = tapAction(event.target, t.clientX);
    if (!action) return;
    event.stopPropagation();
    event.preventDefault(); // also suppresses the click, so the page isn't turned twice
    action();
  }

  function onLoad({ detail: { doc } }) {
    const win = doc.defaultView;
    doc.addEventListener("keydown", onKeydown);
    doc.addEventListener("click", onClick);
    win.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    win.addEventListener("touchend", onTouchEnd, { capture: true });
  }

  function onRelocate({ detail }) {
    fraction = detail.fraction;
    chapter = detail.tocItem?.label ?? "";
  }

  async function open() {
    if (!SUPPORTED.has(book.format)) {
      throw new Error(`Lontar can't open ${book.format.toUpperCase()} files yet.`);
    }
    const bytes = await invoke("plugin:library|read_book", {
      book: { folderId: book.folderId, path: book.path },
    });
    // foliate-js recognises some formats by extension, so give it the lowercase one.
    const file = new File([bytes], `${book.name}.${book.format}`);
    view = document.createElement("foliate-view");
    view.addEventListener("load", onLoad);
    view.addEventListener("relocate", onRelocate);
    container.append(view);
    await view.open(file);
    view.renderer.setStyles?.(BOOK_CSS);
    // Comics have no metadata, and foliate-js falls back to the file name.
    const metaTitle = text(view.book.metadata?.title);
    title = metaTitle && metaTitle !== file.name ? metaTitle : book.name;
    await view.init({});
  }

  // The system back button (Android) and the header's back button both pop this entry.
  function close() {
    history.back();
  }

  onMount(() => {
    history.pushState({ reader: true }, "");
    window.addEventListener("popstate", onclose);
    document.addEventListener("keydown", onKeydown);

    open()
      .catch((e) => (error = e?.message ?? String(e)))
      .finally(() => (loading = false));

    return () => {
      window.removeEventListener("popstate", onclose);
      document.removeEventListener("keydown", onKeydown);
      view?.close();
      view?.remove();
    };
  });
</script>

<div class="reader">
  <header class="reader-bar">
    <button class="back" onclick={close} aria-label="Back to library">‹</button>
    <div class="reader-title">
      <span class="title">{title}</span>
      {#if chapter}<span class="chapter">{chapter}</span>{/if}
    </div>
  </header>

  <div class="reader-page" bind:this={container}>
    {#if loading}
      <p class="status">Opening…</p>
    {:else if error}
      <p class="error">{error}</p>
    {/if}
  </div>

  <footer class="reader-bar reader-footer">
    {#if fraction != null}{percent.format(fraction)}{/if}
  </footer>
</div>
