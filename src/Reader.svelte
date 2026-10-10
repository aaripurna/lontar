<script>
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import "foliate-js/view.js";
  import { loadBookData, saveBookData } from "./lib/sidecar.js";
  import { setBarColors } from "./lib/bars.js";

  // `book` is an entry from the `plugin:library|scan` result.
  // `onprogress(book, progress)` is called whenever the reading progress changes.
  let props = $props();
  // A Reader shows a single book for its whole life (App keys it by path), so pin it: props are
  // read live, and the final save runs during teardown, when App has already cleared them.
  const book = props.book;
  const onprogress = props.onprogress;
  const onclose = props.onclose;

  // Formats the bundled foliate-js can render. PDF needs pdf.js, which it doesn't ship.
  const SUPPORTED = new Set(["epub", "mobi", "azw", "azw3", "kf8", "fb2", "cbz"]);

  // Page colours per theme; `chrome` is the reader's bars. Keep in sync with app.css.
  const THEMES = {
    light: { bg: "#ffffff", fg: "#1a1a1a", link: "#2a5db0", chrome: "#f3f3f3", scheme: "light" },
    sepia: { bg: "#f4ecd8", fg: "#5b4636", link: "#8a5a2b", chrome: "#ebe1c8", scheme: "light" },
    dark: { bg: "#1c1c1e", fg: "#d8d8d8", link: "#8ab4f8", chrome: "#2a2a2c", scheme: "dark" },
  };
  const FONT_SIZES = [80, 90, 100, 110, 120, 135, 150, 175, 200];
  const LINE_HEIGHTS = { Compact: 1.3, Normal: 1.5, Relaxed: 1.8 };

  // Reading settings are per device (a phone and a laptop want different sizes), so they live
  // in localStorage rather than the synced sidecar.
  const SETTINGS_KEY = "lontar.readerSettings";
  const DEFAULT_SETTINGS = { fontSize: 100, lineHeight: 1.5, theme: "auto" };

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
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  });

  // The book's sidecar data, or null if it couldn't be read, in which case nothing is saved
  // rather than risk overwriting it.
  let bookData = null;
  let ready = false; // ignore the relocations made while restoring the saved position
  let savedLocation = null;
  let pendingProgress = null;
  let saveTimer;
  let saveError = $state("");

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

  // Keeps the current chapter visible when the contents open.
  function scrollIntoViewIf(node, active) {
    if (active) node.scrollIntoView({ block: "center" });
  }

  // Tapping the outer thirds of the page turns it; the middle third opens the controls.
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
    return () => openPanel("controls");
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
    currentHref = detail.tocItem?.href ?? null;
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
    saveBookData(book, bookData).then(
      () => (saveError = ""),
      (e) => (saveError = String(e)),
    );
  }

  // Android may kill a backgrounded app without warning, so save as soon as it's hidden.
  function onVisibilityChange() {
    if (document.visibilityState === "hidden") saveProgress();
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
    reflowable = view.book.rendition?.layout !== "pre-paginated";
    toc = flattenToc(view.book.toc);
    opened = true; // applies the reading settings
    // Comics have no metadata, and foliate-js falls back to the file name.
    const metaTitle = text(view.book.metadata?.title);
    title = metaTitle && metaTitle !== file.name ? metaTitle : book.name;

    try {
      bookData = (await loadBookData(book)) ?? {};
      // Merging sync-conflict copies may have changed it since the scan.
      if (bookData.progress) onprogress?.(book, bookData.progress);
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
  }

  // The system back button (Android) and the header's back button both pop this entry.
  function close() {
    history.back();
  }

  onMount(() => {
    history.pushState({ reader: true }, "");
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
      view?.remove();
    };
  });
</script>

<div class="reader" data-theme={theme}>
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
    {#if saveError}<span class="save-error" title={saveError}>· progress not saved</span>{/if}
  </footer>

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

      <button class="sheet-button" onclick={() => (panel = "toc")} disabled={!toc.length}>
        Contents
      </button>

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
      {/if}

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
  {/if}
</div>
