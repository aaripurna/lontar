<script>
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import "foliate-js/view.js";
  import { Overlayer } from "foliate-js/overlayer.js";
  import { loadBookData, mergeBookData, saveBookData } from "./lib/sidecar.js";
  import { computeBookId } from "./lib/bookid.js";
  import { activeItems, isOnPage, makeBookmark, removeItems } from "./lib/bookmarks.js";
  import { HIGHLIGHT_COLORS, highlightColor, makeHighlight, updateItem } from "./lib/annotations.js";
  import { setBarColors } from "./lib/bars.js";
  import { READABLE_FORMATS, openBookFile } from "./lib/formats.js";

  // `book` is an entry from the `plugin:library|scan` result.
  // `onprogress(book, progress)` is called whenever the reading progress changes.
  let props = $props();
  // A Reader shows a single book for its whole life (App keys it by path), so pin it: props are
  // read live, and the final save runs during teardown, when App has already cleared them.
  const book = props.book;
  const onprogress = props.onprogress;
  const onclose = props.onclose;

  // Page colours per theme; `chrome` is the reader's bars. Keep in sync with app.css.
  const THEMES = {
    light: { bg: "#ffffff", fg: "#1a1a1a", link: "#2a5db0", chrome: "#f3f3f3", scheme: "light" },
    sepia: { bg: "#f4ecd8", fg: "#5b4636", link: "#8a5a2b", chrome: "#ebe1c8", scheme: "light" },
    dark: { bg: "#1c1c1e", fg: "#d8d8d8", link: "#8ab4f8", chrome: "#2a2a2c", scheme: "dark" },
  };
  const FONT_SIZES = [80, 90, 100, 110, 120, 135, 150, 175, 200];
  const LINE_HEIGHTS = { Compact: 1.3, Normal: 1.5, Relaxed: 1.8 };
  // Fixed-layout pages (PDFs, comics) can't reflow, so they're zoomed instead: a percentage of
  // the fit-to-screen size. Drag to move around a zoomed page.
  const ZOOMS = [100, 125, 150, 175, 200, 250];

  // Reading settings are per device (a phone and a laptop want different sizes), so they live
  // in localStorage rather than the synced sidecar.
  const SETTINGS_KEY = "lontar.readerSettings";
  const DEFAULT_SETTINGS = { fontSize: 100, lineHeight: 1.5, theme: "auto", zoom: 100, trimMargins: false, tapToTurn: false };

  function loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  // Applied inside the book's own document, adapted from foliate-js's demo reader.
  function bookCSS({ fontSize, lineHeight }, { bg, fg, link, scheme }) {
    return `
      @namespace epub "http://www.idpf.org/2007/ops";
      /* foliate-js paints the page margins from this, not from the live background */
      html { --theme-bg-color: ${bg}; color-scheme: ${scheme}; font-size: ${fontSize}% !important; }
      html, body { background: ${bg} !important; color: ${fg} !important; }
      a:link, a:visited { color: ${link} !important; }
      p, li, blockquote, dd {
        line-height: ${lineHeight};
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
  }

  let container;
  let view;
  let title = $state(book.name);
  let chapter = $state("");
  let fraction = $state(null);
  let loading = $state(true);
  let error = $state("");
  let opened = $state(false); // the book is rendered and can take settings
  let reflowable = $state(true); // false for fixed-layout books such as comics

  // "controls" (the bottom sheet), "toc", or null.
  let panel = $state(null);
  let toc = $state([]); // flattened table of contents: { label, href, depth }
  let currentHref = $state(null);
  let sliderValue = $state(null); // set while the progress slider is being dragged

  let settings = $state(loadSettings());
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  let systemDark = $state(darkQuery.matches);
  let theme = $derived(settings.theme === "auto" ? (systemDark ? "dark" : "light") : settings.theme);

  $effect(() => {
    setBarColors(THEMES[theme].chrome, THEMES[theme].scheme === "dark");
  });

  $effect(() => {
    const css = bookCSS(settings, THEMES[theme]);
    if (opened) view.renderer.setStyles?.(css);
    if (opened && !reflowable) view.renderer.setAttribute("zoom-factor", settings.zoom / 100);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  });

  // PDF pages are re-rendered when margin trimming is switched.
  $effect(() => {
    const trim = settings.trimMargins;
    if (!opened || book.format !== "pdf" || view.book.trimMargins === trim) return;
    view.book.trimMargins = trim;
    view.renderer.reload();
  });

  // The book's sidecar data, or null if it couldn't be read, in which case nothing is saved
  // rather than risk overwriting it.
  let bookData = null;
  let ready = false; // ignore the relocations made while restoring the saved position
  let savedLocation = null;
  let pendingProgress = null;
  let saveTimer;
  let saving = Promise.resolve(); // sidecar writes, one at a time
  let saveError = $state("");

  let canBookmark = $state(false); // the sidecar was read, so bookmarks can be saved
  let bookmarks = $state([]); // active bookmarks, in reading order
  let pageCfi = $state(null); // location of the page on screen
  let bookmarked = $derived(bookmarks.some((b) => isOnPage(b, pageCfi)));

  // Highlights need selectable text: reflowable books, and PDFs through pdf.js's text layer
  // (not scanned ones, which are just images). Comics have none.
  let canAnnotate = $derived(canBookmark && (reflowable || book.format === "pdf"));
  let highlights = $state([]); // active highlights, in reading order
  let selection = $state.raw(null); // { doc, index, range, text } while text is selected
  let selectionTimer;
  let editingId = $state(null); // the highlight open in the "highlight" panel
  let editing = $derived(highlights.find((h) => h.id === editingId));
  let noteDraft = $state("");

  // Search, kept while the book is open so the results survive jumping to one.
  const MAX_SEARCH_RESULTS = 1000;
  let canSearch = $state(false); // the book has text to search (not comics)
  let searchQuery = $state("");
  let searchedFor = $state(""); // the query the results are for
  let searchResults = $state([]); // [{ label, items: [{ cfi, excerpt: { pre, match, post } }] }]
  let searchCount = $state(0);
  let searchProgress = $state(null); // 0-1 while searching
  let searchRun = 0;
  // Locations of the matches, marked on the page like a text selection. foliate-js marks them
  // itself with red outlines, which can't be restyled, so those are cleared and these drawn.
  let searchHits = new Set();

  const percent = new Intl.NumberFormat(undefined, { style: "percent" });

  // Metadata values may be plain strings or { lang: string } maps.
  function text(value) {
    if (!value || typeof value === "string") return value ?? "";
    return Object.values(value)[0] ?? "";
  }

  function onKeydown(event) {
    if (event.key === "Escape") return panel ? closePanel() : close();
    if (panel) return;
    if (event.key === "ArrowLeft") view?.goLeft();
    else if (event.key === "ArrowRight" || event.key === " ") view?.goRight();
  }

  function flattenToc(items, depth = 0) {
    return (items ?? []).flatMap((item) => [
      { label: item.label?.trim() || "Untitled", href: item.href, depth },
      ...flattenToc(item.subitems, depth + 1),
    ]);
  }

  // Each open panel is a history entry, so the system back button closes it first.
  function openPanel(name) {
    if (!panel) history.pushState({ readerPanel: true }, "");
    panel = name;
  }

  function closePanel() {
    if (panel) history.back(); // onPopState clears `panel`
  }

  function onPopState() {
    if (panel === "highlight") saveNote();
    if (panel) panel = null;
    else onclose();
  }

  async function goToTocItem(href) {
    closePanel();
    await view.goTo(href);
  }

  function seek(event) {
    sliderValue = null;
    view.goToFraction(Number(event.target.value));
  }

  function changeFontSize(step) {
    const i = FONT_SIZES.indexOf(settings.fontSize);
    const next = FONT_SIZES[(i === -1 ? FONT_SIZES.indexOf(100) : i) + step];
    if (next) settings.fontSize = next;
  }

  function changeZoom(step) {
    const i = ZOOMS.indexOf(settings.zoom);
    const next = ZOOMS[(i === -1 ? 0 : i) + step];
    if (next) settings.zoom = next;
  }

  // Keeps the current chapter visible when the contents open.
  function scrollIntoViewIf(node, active) {
    if (active) node.scrollIntoView({ block: "center" });
  }

  // Tapping the middle third of the page opens the controls. Clicking the outer thirds turns
  // the page; with touch they do nothing unless the "tap to turn" setting is on (it's too easy
  // to tap them by accident while holding a phone), and pages are turned by swiping.
  // Returns what a tap should do, or null if it should be left alone.
  function tapAction(target, clientX, clientY, turnsPages) {
    const doc = target.ownerDocument;
    if (target.closest?.("a") || !doc.getSelection()?.isCollapsed) return null;
    // A tap on a highlight opens it, wherever on the page it is.
    const overlayer = view.renderer.getContents?.().find((c) => c.doc === doc)?.overlayer;
    const [value] = overlayer?.hitTest({ x: clientX, y: clientY }) ?? [];
    const highlight = value && highlights.find((h) => h.location === value);
    if (highlight) return () => openHighlight(highlight.id);
    // Map the tap into the reader's coordinates: paginated chapters live in a wide, scrolled
    // iframe, and fixed-layout pages (comics) are scaled with a CSS transform.
    const frame = doc.defaultView.frameElement;
    const rect = frame.getBoundingClientRect();
    const scale = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
    const x = rect.left + clientX * scale;
    const { left, width } = container.getBoundingClientRect();
    const position = (x - left) / width;
    if (position < 1 / 3) return turnsPages ? () => view.goLeft() : () => {};
    if (position > 2 / 3) return turnsPages ? () => view.goRight() : () => {};
    return () => openPanel("controls");
  }

  function onClick(event) {
    tapAction(event.target, event.clientX, event.clientY, true)?.();
  }

  // Touch is handled here, before foliate-js's own listeners. Reflowable books turn pages with
  // foliate-js's swipe; fixed-layout ones (PDFs, comics) have none, so swipes are turned into
  // page turns here. Taps are kept from foliate-js: it snaps to the nearest page on every
  // touchend, and a snap racing another navigation can lock the paginator up for good.
  const SWIPE_MIN = 40; // px of horizontal travel
  let touchStart = null;

  function onTouchStart(event) {
    const t = event.changedTouches[0];
    if (event.touches.length !== 1) {
      touchStart = null;
      return;
    }
    // Where a zoomed page was scrolled to: a swipe only turns the page from its edge, so that
    // dragging around the page doesn't.
    const r = view.renderer;
    const scroll = reflowable ? null : { left: r.scrollLeft, max: r.scrollWidth - r.clientWidth };
    touchStart = { x: t.screenX, y: t.screenY, time: event.timeStamp, scroll };
  }

  function onTouchEnd(event) {
    const start = touchStart;
    touchStart = null;
    const t = event.changedTouches[0];
    if (!start) return;
    const dx = t.screenX - start.x;
    const dy = t.screenY - start.y;
    if (Math.hypot(dx, dy) > 10) {
      const swipe = start.scroll && event.timeStamp - start.time < 800 && Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > 1.5 * Math.abs(dy);
      if (swipe && dx < 0 && start.scroll.left >= start.scroll.max - 1) view.goRight();
      else if (swipe && dx > 0 && start.scroll.left <= 1) view.goLeft();
      return;
    }
    if (event.timeStamp - start.time > 500) return;
    const action = tapAction(event.target, t.clientX, t.clientY, settings.tapToTurn);
    if (!action) return;
    event.stopPropagation();
    event.preventDefault(); // also suppresses the click, which would turn the page
    action();
  }

  function onLoad({ detail: { doc, index } }) {
    const win = doc.defaultView;
    doc.addEventListener("selectionchange", () => onSelectionChange(doc, index));
    doc.addEventListener("keydown", onKeydown);
    doc.addEventListener("click", onClick);
    win.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    win.addEventListener("touchend", onTouchEnd, { capture: true });
  }

  function onRelocate({ detail }) {
    fraction = detail.fraction;
    chapter = detail.tocItem?.label ?? "";
    currentHref = detail.tocItem?.href ?? null;
    pageCfi = detail.cfi ?? null;
    if (!ready || !bookData || !detail.cfi || detail.cfi === savedLocation) return;
    pendingProgress = { location: detail.cfi, fraction: detail.fraction };
    // Page turns come in bursts; write once the reader settles.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 1000);
  }

  function saveProgress() {
    clearTimeout(saveTimer);
    if (!pendingProgress) return;
    const progress = { ...pendingProgress, updatedAt: new Date().toISOString() };
    pendingProgress = null;
    savedLocation = progress.location;
    bookData = { ...bookData, progress };
    onprogress?.(book, progress);
    persist();
  }

  // Writes `bookData` to the sidecar, picking up whatever sync brought in meanwhile.
  function persist() {
    const data = bookData;
    saving = saving
      .then(() => saveBookData(book, data))
      .then(
        (saved) => {
          // Keep changes made while the write was in flight.
          bookData = mergeBookData(bookData, saved);
          bookmarks = activeItems(bookData.bookmarks);
          setHighlights(bookData.annotations ?? []);
          saveError = "";
        },
        (e) => (saveError = String(e)),
      );
  }

  function toggleBookmark() {
    const location = view?.lastLocation;
    if (!ready || !bookData || !location?.cfi) return;
    const onPage = bookmarks.filter((b) => isOnPage(b, location.cfi));
    if (onPage.length) {
      bookData.bookmarks = removeItems(bookData.bookmarks, onPage.map((b) => b.id));
    } else {
      const page = reflowable ? null : (location.section?.current ?? 0) + 1;
      bookData.bookmarks = [...(bookData.bookmarks ?? []), makeBookmark(location, page)];
    }
    bookmarks = activeItems(bookData.bookmarks);
    persist();
  }

  function removeBookmark(id) {
    bookData.bookmarks = removeItems(bookData.bookmarks, [id]);
    bookmarks = activeItems(bookData.bookmarks);
    persist();
  }

  async function runSearch(event) {
    event?.preventDefault();
    const query = searchQuery.trim();
    const run = ++searchRun;
    searchedFor = query;
    searchResults = [];
    searchCount = 0;
    clearSearchHits();
    if (!query) {
      searchProgress = null;
      return;
    }
    searchProgress = 0;
    try {
      for await (const result of view.search({ query })) {
        view.clearSearch(); // foliate-js's outlines; see searchHits
        if (run !== searchRun) return; // a newer search took over
        if (result === "done") break;
        if (result.progress != null) searchProgress = result.progress;
        if (!result.subitems) continue;
        for (const { cfi } of result.subitems) {
          searchHits.add(cfi);
          view.addAnnotation({ value: cfi }).catch(() => {});
        }
        // Fixed-layout pages (PDFs) are better known by number than by chapter.
        const page = reflowable ? null : view.resolveNavigation(result.subitems[0].cfi).index + 1;
        const label = [page && `Page ${page}`, result.label].filter(Boolean).join(" · ");
        searchResults = [...searchResults, { label, items: result.subitems }];
        searchCount += result.subitems.length;
        if (searchCount >= MAX_SEARCH_RESULTS) break;
      }
    } catch (e) {
      console.warn("Search failed", e);
    }
    if (run === searchRun) searchProgress = null;
  }

  function clearSearchHits() {
    view.clearSearch();
    for (const cfi of searchHits) view.deleteAnnotation({ value: cfi }).catch(() => {});
    searchHits = new Set();
  }

  async function goToSearchResult(cfi) {
    closePanel();
    await view.goTo(cfi);
  }

  function focusOnMount(node) {
    node.focus();
  }

  async function goToBookmark(bookmark) {
    closePanel();
    await view.goTo(bookmark.location);
  }

  // Selecting text shows the highlight toolbar; it waits for the selection to settle, since
  // dragging the selection handles fires a stream of changes.
  function onSelectionChange(doc, index) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const sel = doc.getSelection();
      const range = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      if (canAnnotate && range?.toString().trim()) {
        selection = { doc, index, range: range.cloneRange(), text: range.toString() };
      } else if (selection?.doc === doc) {
        selection = null;
      }
    }, 250);
  }

  function setHighlights(annotations) {
    bookData.annotations = annotations;
    highlights = activeItems(annotations).filter((a) => a.text != null);
  }

  function createHighlight(color, withNote = false) {
    const { doc, index, range, text } = selection;
    const location = view.getCFI(index, range);
    // Fixed-layout pages are labelled by number, which also helps find a PDF highlight again
    // should a newer pdf.js lay out the page's text differently.
    const page = reflowable ? null : index + 1;
    const highlight = makeHighlight(location, text, color, {
      fraction: view.lastLocation?.fraction,
      label: [page && `Page ${page}`, view.lastLocation?.tocItem?.label].filter(Boolean).join(" · "),
    });
    setHighlights([...(bookData.annotations ?? []), highlight]);
    doc.getSelection()?.removeAllRanges();
    selection = null;
    view.addAnnotation({ value: location });
    persist();
    if (withNote) openHighlight(highlight.id);
  }

  function openHighlight(id) {
    editingId = id;
    noteDraft = highlights.find((h) => h.id === id)?.note ?? "";
    openPanel("highlight");
  }

  function setHighlightColor(color) {
    if (!editing || editing.color === color) return;
    setHighlights(updateItem(bookData.annotations, editing.id, { color }));
    view.addAnnotation({ value: editing.location }); // redraws it
    persist();
  }

  function saveNote() {
    const note = noteDraft.trim();
    if (!editing || note === (editing.note ?? "")) return;
    setHighlights(updateItem(bookData.annotations, editing.id, { note: note || undefined }));
    persist();
  }

  function removeHighlight(id) {
    const highlight = highlights.find((h) => h.id === id);
    if (!highlight) return;
    if (editingId === id) editingId = null;
    setHighlights(removeItems(bookData.annotations, [id]));
    view.deleteAnnotation({ value: highlight.location });
    persist();
  }

  async function goToHighlight(highlight) {
    closePanel();
    await view.goTo(highlight.location);
  }

  // foliate-js asks for highlights to be drawn whenever a chapter is laid out.
  function onCreateOverlay() {
    for (const h of highlights) view.addAnnotation({ value: h.location }).catch(() => {});
    for (const cfi of searchHits) view.addAnnotation({ value: cfi }).catch(() => {});
  }

  function onDrawAnnotation({ detail: { draw, annotation } }) {
    if (searchHits.has(annotation.value)) {
      draw(Overlayer.highlight, { color: THEMES[theme].link });
      return;
    }
    const highlight = highlights.find((h) => h.location === annotation.value);
    draw(Overlayer.highlight, { color: highlightColor(highlight ?? {}) });
  }

  // Android may kill a backgrounded app without warning, so save as soon as it's hidden.
  function onVisibilityChange() {
    if (document.visibilityState === "hidden") saveProgress();
  }

  async function open() {
    if (!READABLE_FORMATS.has(book.format)) {
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
    view.addEventListener("create-overlay", onCreateOverlay);
    view.addEventListener("draw-annotation", onDrawAnnotation);
    container.append(view);
    await view.open(await openBookFile(file, book.format, { trimMargins: settings.trimMargins }));
    reflowable = view.book.rendition?.layout !== "pre-paginated";
    canSearch = view.book.sections.some((section) => section.createDocument);
    toc = flattenToc(view.book.toc);
    opened = true; // applies the reading settings
    // Comics have no metadata, and foliate-js falls back to the file name.
    const metaTitle = text(view.book.metadata?.title);
    title = metaTitle && metaTitle !== file.name ? metaTitle : book.name;

    try {
      // A book opened from another app, outside the library, has nowhere to save to.
      if (!book.readOnly) bookData = (await loadBookData(book)) ?? {};
      // Merging sync-conflict copies may have changed it since the scan.
      if (bookData.progress) onprogress?.(book, bookData.progress);
      bookmarks = activeItems(bookData.bookmarks);
      setHighlights(bookData.annotations ?? []);
    } catch (e) {
      saveError = `Couldn't read saved progress: ${e}`;
    }
    const lastLocation = bookData?.progress?.location;
    try {
      await view.init({ lastLocation });
    } catch (e) {
      // e.g. a location from a different edition of the book
      console.warn("Couldn't restore reading position", e);
      await view.init({});
    }
    // Only moving away from where the book opened counts as progress.
    savedLocation = view.lastLocation?.cfi ?? lastLocation ?? null;
    ready = true;
    canBookmark = !!bookData;

    // Record what the book is, so its sidecar can find it again if it's renamed or moved.
    const bookId = await computeBookId(bytes).catch(() => null);
    if (bookData && bookId && bookData.bookId !== bookId) {
      bookData.bookId = bookId;
      persist();
    }
  }

  // The system back button (Android) and the header's back button both pop this entry.
  function close() {
    history.back();
  }

  onMount(() => {
    // A book opened from the OS replaces the one being read; it reuses that reader's entry.
    if (!history.state?.reader) history.pushState({ reader: true }, "");
    window.addEventListener("popstate", onPopState);
    document.addEventListener("keydown", onKeydown);
    const onSchemeChange = (e) => (systemDark = e.matches);
    darkQuery.addEventListener("change", onSchemeChange);
    document.addEventListener("visibilitychange", onVisibilityChange);

    open()
      .catch((e) => (error = e?.message ?? String(e)))
      .finally(() => (loading = false));

    return () => {
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("keydown", onKeydown);
      darkQuery.removeEventListener("change", onSchemeChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      saveProgress();
      view?.close();
      view?.book?.destroy?.();
      view?.remove();
    };
  });
</script>

<div class="reader" data-theme={theme} data-format={book.format}>
  <header class="reader-bar">
    <button class="back" onclick={close} aria-label="Back to library">‹</button>
    <div class="reader-title">
      <span class="title">{title}</span>
      {#if chapter}<span class="chapter">{chapter}</span>{/if}
    </div>
    {#if canSearch}
      <button class="bar-icon" aria-label="Search this book" onclick={() => openPanel("search")}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></svg>
      </button>
    {/if}
    {#if canBookmark}
      <button
        class="bar-icon bookmark-toggle"
        class:on={bookmarked}
        aria-pressed={bookmarked}
        aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"}
        onclick={toggleBookmark}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21z" /></svg>
      </button>
    {/if}
    <button class="bar-icon" aria-label="Reading settings" title="Reading settings" onclick={() => openPanel("controls")}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>
    </button>
  </header>

  <div class="reader-page" bind:this={container}>
    {#if loading}
      <p class="status">Opening…</p>
    {:else if error}
      <p class="error">{error}</p>
    {:else}
      <!-- shown only with a mouse; see .page-turn in app.css. They don't take focus, so Space
           keeps turning forward after one is clicked. -->
      <button class="page-turn left" aria-label="Previous page" onmousedown={(e) => e.preventDefault()} onclick={() => view?.goLeft()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      <button class="page-turn right" aria-label="Next page" onmousedown={(e) => e.preventDefault()} onclick={() => view?.goRight()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
      </button>
    {/if}
  </div>

  <footer class="reader-bar reader-footer">
    {#if fraction != null}{percent.format(fraction)}{/if}
    {#if saveError}<span class="save-error" title={saveError}>· progress not saved</span>{/if}
    {#if book.readOnly}<span title="Opened from another app. Add its folder to your library to save progress, bookmarks and highlights.">· not in your library</span>{/if}
  </footer>

  {#if selection && !panel}
    <div class="highlight-toolbar" role="toolbar" aria-label="Highlight selection">
      {#each Object.entries(HIGHLIGHT_COLORS) as [name, color]}
        <button class="swatch" style:background={color} aria-label="Highlight in {name}" onclick={() => createHighlight(name)}></button>
      {/each}
      <button class="toolbar-note" onclick={() => createHighlight("yellow", true)}>Note</button>
    </div>
  {/if}

  {#if panel}
    <button class="reader-backdrop" aria-label="Close" onclick={closePanel}></button>
  {/if}

  {#if panel === "controls"}
    <div class="reader-sheet" role="dialog" aria-label="Reading controls">
      <div class="sheet-row">
        <input
          class="progress"
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={fraction ?? 0}
          oninput={(e) => (sliderValue = Number(e.target.value))}
          onchange={seek}
          aria-label="Position in book"
        />
        <span class="sheet-value">{percent.format(sliderValue ?? fraction ?? 0)}</span>
      </div>

      <div class="sheet-buttons">
        <button class="sheet-button" onclick={() => (panel = "toc")} disabled={!toc.length}>
          Contents
        </button>
        <button class="sheet-button" onclick={() => (panel = "bookmarks")} disabled={!bookmarks.length}>
          Bookmarks{bookmarks.length ? ` (${bookmarks.length})` : ""}
        </button>
        {#if canAnnotate}
          <button class="sheet-button" onclick={() => (panel = "highlights")} disabled={!highlights.length}>
            Highlights{highlights.length ? ` (${highlights.length})` : ""}
          </button>
        {/if}
      </div>

      {#if reflowable}
        <div class="sheet-row">
          <span class="sheet-label">Text size</span>
          <div class="segmented">
            <button onclick={() => changeFontSize(-1)} disabled={settings.fontSize <= FONT_SIZES[0]} aria-label="Smaller text">A−</button>
            <span class="sheet-value">{settings.fontSize}%</span>
            <button onclick={() => changeFontSize(1)} disabled={settings.fontSize >= FONT_SIZES.at(-1)} aria-label="Larger text">A+</button>
          </div>
        </div>
        <div class="sheet-row">
          <span class="sheet-label">Spacing</span>
          <div class="segmented">
            {#each Object.entries(LINE_HEIGHTS) as [label, value]}
              <button aria-pressed={settings.lineHeight === value} onclick={() => (settings.lineHeight = value)}>
                {label}
              </button>
            {/each}
          </div>
        </div>
      {:else}
        <div class="sheet-row">
          <span class="sheet-label">Zoom</span>
          <div class="segmented">
            <button onclick={() => changeZoom(-1)} disabled={settings.zoom <= ZOOMS[0]} aria-label="Zoom out">−</button>
            <span class="sheet-value">{settings.zoom}%</span>
            <button onclick={() => changeZoom(1)} disabled={settings.zoom >= ZOOMS.at(-1)} aria-label="Zoom in">+</button>
          </div>
        </div>
        {#if book.format === "pdf"}
          <div class="sheet-row">
            <span class="sheet-label">Margins</span>
            <div class="segmented">
              <button aria-pressed={!settings.trimMargins} onclick={() => (settings.trimMargins = false)}>Keep</button>
              <button aria-pressed={settings.trimMargins} onclick={() => (settings.trimMargins = true)}>Trim</button>
            </div>
          </div>
        {/if}
      {/if}

      <div class="sheet-row">
        <span class="sheet-label">Turn pages</span>
        <div class="segmented">
          <button aria-pressed={!settings.tapToTurn} onclick={() => (settings.tapToTurn = false)}>Swipe</button>
          <button aria-pressed={settings.tapToTurn} onclick={() => (settings.tapToTurn = true)}>Swipe or tap</button>
        </div>
      </div>

      <div class="sheet-row">
        <span class="sheet-label">Theme</span>
        <div class="segmented">
          {#each ["auto", "light", "sepia", "dark"] as name}
            <button aria-pressed={settings.theme === name} onclick={() => (settings.theme = name)}>
              {name[0].toUpperCase() + name.slice(1)}
            </button>
          {/each}
        </div>
      </div>
    </div>
  {:else if panel === "toc"}
    <div class="reader-sheet reader-toc" role="dialog" aria-label="Contents">
      <h2>Contents</h2>
      <ul>
        {#each toc as item, i (i)}
          <li>
            <button
              class:current={item.href === currentHref}
              style:padding-left="{0.75 + item.depth}em"
              use:scrollIntoViewIf={item.href === currentHref}
              onclick={() => goToTocItem(item.href)}
            >
              {item.label}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {:else if panel === "bookmarks"}
    <div class="reader-sheet reader-toc" role="dialog" aria-label="Bookmarks">
      <h2>Bookmarks</h2>
      {#if bookmarks.length}
        <ul>
          {#each bookmarks as bookmark (bookmark.id)}
            <li class="list-item">
              <button class:current={isOnPage(bookmark, pageCfi)} onclick={() => goToBookmark(bookmark)}>
                <span class="bookmark-label">
                  {bookmark.label || "Bookmark"}
                  {#if bookmark.fraction != null}<span class="bookmark-percent">{percent.format(bookmark.fraction)}</span>{/if}
                </span>
                {#if bookmark.excerpt}<span class="bookmark-excerpt">{bookmark.excerpt}</span>{/if}
              </button>
              <button class="bookmark-remove" onclick={() => removeBookmark(bookmark.id)} aria-label="Remove bookmark">×</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">No bookmarks left.</p>
      {/if}
    </div>
  {:else if panel === "highlights"}
    <div class="reader-sheet reader-toc" role="dialog" aria-label="Highlights">
      <h2>Highlights</h2>
      {#if highlights.length}
        <ul>
          {#each highlights as highlight (highlight.id)}
            <li class="list-item">
              <button onclick={() => goToHighlight(highlight)}>
                <span class="bookmark-label">
                  {highlight.label || "Highlight"}
                  {#if highlight.fraction != null}<span class="bookmark-percent">{percent.format(highlight.fraction)}</span>{/if}
                </span>
                <span class="highlight-text" style:border-color={highlightColor(highlight)}>{highlight.text}</span>
                {#if highlight.note}<span class="highlight-note">{highlight.note}</span>{/if}
              </button>
              <button class="bookmark-remove" onclick={() => removeHighlight(highlight.id)} aria-label="Remove highlight">×</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">No highlights left.</p>
      {/if}
    </div>
  {:else if panel === "search"}
    <div class="reader-sheet reader-toc reader-search" role="dialog" aria-label="Search">
      <form onsubmit={runSearch}>
        <input
          type="search"
          enterkeyhint="search"
          placeholder="Search this book"
          aria-label="Search this book"
          bind:value={searchQuery}
          use:focusOnMount
        />
      </form>
      {#if searchProgress != null}
        <p class="search-status">Searching… {percent.format(searchProgress)}</p>
      {:else if searchedFor}
        <p class="search-status">
          {#if !searchCount}
            No results for “{searchedFor}”.
          {:else}
            {searchCount}{searchCount >= MAX_SEARCH_RESULTS ? "+" : ""} result{searchCount === 1 ? "" : "s"}
          {/if}
        </p>
      {/if}
      {#each searchResults as group, g (g)}
        <h3>{group.label}</h3>
        <ul>
          {#each group.items as item (item.cfi)}
            <li>
              <button class="search-result" onclick={() => goToSearchResult(item.cfi)}>
                {item.excerpt.pre}<mark>{item.excerpt.match}</mark>{item.excerpt.post}
              </button>
            </li>
          {/each}
        </ul>
      {/each}
    </div>
  {:else if panel === "highlight" && editing}
    <div class="reader-sheet" role="dialog" aria-label="Highlight">
      <p class="highlight-text highlight-quote" style:border-color={highlightColor(editing)}>{editing.text}</p>
      <div class="sheet-row">
        <span class="sheet-label">Colour</span>
        <div class="swatches">
          {#each Object.entries(HIGHLIGHT_COLORS) as [name, color]}
            <button
              class="swatch"
              style:background={color}
              aria-pressed={editing.color === name}
              aria-label={name}
              onclick={() => setHighlightColor(name)}
            ></button>
          {/each}
        </div>
      </div>
      <textarea class="highlight-note-input" rows="3" placeholder="Add a note" bind:value={noteDraft} onblur={saveNote}></textarea>
      <div class="sheet-buttons">
        <button class="sheet-button" onclick={() => { removeHighlight(editing.id); closePanel(); }}>Delete</button>
        <button class="sheet-button" onclick={closePanel}>Done</button>
      </div>
    </div>
  {/if}
</div>
