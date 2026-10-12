<script>
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion, onBackButtonPress } from "@tauri-apps/api/app";
  import Reader from "./Reader.svelte";
  import Cover from "./Cover.svelte";
  import { getBookMeta, pauseBackground, pruneCovers } from "./lib/covers.js";
  import { displayTitle, filterBooks, sortBooks } from "./lib/library.js";
  import { reattachSidecar, saveBookData, scannedProgress } from "./lib/sidecar.js";
  import { computeBookId, matchOrphans, reattachCandidates } from "./lib/bookid.js";
  import { setBarColors } from "./lib/bars.js";

  const FOLDERS_KEY = "lontar.libraryFolders";

  // [{ id, name }]: id is a path on desktop and an opaque access token on Android/iOS.
  // Device-local on purpose: these ids mean nothing on another device.
  let folders = $state(loadFolders());
  let version = $state("");
  let books = $state([]);
  // folder id -> why it couldn't be scanned
  let folderErrors = $state({});
  let loading = $state(false);
  let error = $state("");
  // The book being read, or null while browsing the library.
  let reading = $state(null);
  // "books" (home) or "folders" (managing the library folders).
  let page = $state("books");
  let failedFolders = $derived(folders.filter((f) => folderErrors[f.id]).length);
  // book path -> reading progress ({ fraction, updatedAt, ... }) from its sidecar
  let progress = $state({});

  // book path -> { title, author, authorSort } from the book's metadata, filled in as books
  // are read in the background (see covers.js); until then a book goes by its file name.
  let bookInfo = $state({});
  let query = $state("");

  const SORT_KEY = "lontar.librarySort";
  const SORTS = { title: "Title", author: "Author", recent: "Recent" };
  let sortBy = $state(loadSort());
  let shownBooks = $derived(filterBooks(sortBooks(books, sortBy, bookInfo, progress), query, bookInfo));

  // Reading books in the background would compete with the one being read.
  $effect(() => pauseBackground(!!reading));

  const percent = new Intl.NumberFormat(undefined, { style: "percent" });

  // Colours match app.css's background for the library.
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  let systemDark = $state(darkQuery.matches);
  $effect(() => {
    if (!reading) setBarColors(systemDark ? "#2f2f2f" : "#f6f6f6", systemDark);
  });

  function loadSort() {
    try {
      const saved = localStorage.getItem(SORT_KEY);
      return saved in SORTS ? saved : "title";
    } catch {
      return "title";
    }
  }

  function setSort(value) {
    sortBy = value;
    try {
      localStorage.setItem(SORT_KEY, value);
    } catch {}
  }

  function loadFolders() {
    try {
      return JSON.parse(localStorage.getItem(FOLDERS_KEY)) ?? [];
    } catch {
      return [];
    }
  }

  function saveFolders() {
    try {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
    } catch {}
  }

  async function refresh() {
    if (folders.length === 0) {
      books = [];
      folderErrors = {};
      return;
    }
    loading = true;
    error = "";
    try {
      const result = await invoke("plugin:library|scan", { ids: folders.map((f) => f.id) });
      progress = Object.fromEntries(
        result.books.map((b) => [b.path, scannedProgress(b)]).filter(([, p]) => p),
      );
      // The sidecar text was only needed for the progress.
      books = result.books.map(({ sidecar, ...book }) => book);
      // With a folder missing, its covers would be dropped and remade later, so wait.
      if (!result.errors.length) pruneCovers(books).catch((e) => console.warn(e));
      loadBookInfo(books);
      reattachOrphans(result.orphans, result.books).then(() => stampBookIds(result.books));
      folderErrors = Object.fromEntries(result.errors.map((e) => [e.folderId, e.message]));
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  // Gives renamed or moved books back their sidecar: an orphaned sidecar whose bookId matches
  // a book without one is renamed to suit it. Only books of the right size are read.
  async function reattachOrphans(orphans, scanned) {
    const candidates = reattachCandidates(orphans, scanned, (book) => book.sidecar != null);
    if (!candidates.length) return;
    const ids = new Map();
    for (const book of candidates) {
      try {
        const bytes = await invoke("plugin:library|read_book", {
          book: { folderId: book.folderId, path: book.path },
        });
        ids.set(book.path, await computeBookId(bytes));
      } catch (e) {
        console.warn(`Couldn't read ${book.fileName}`, e);
      }
    }
    for (const { orphan, book } of matchOrphans(orphans, candidates, (b) => ids.get(b.path))) {
      try {
        await reattachSidecar(orphan, book);
        const restored = scannedProgress({ ...book, sidecar: orphan.contents });
        if (restored) progress[book.path] = restored;
      } catch (e) {
        console.warn(`Couldn't move ${orphan.fileName}.lontar to ${book.fileName}`, e);
      }
    }
  }

  // Sidecars from before bookId (or for books never opened since) get one in the background,
  // so a rename can't orphan them. Paused while reading; each book is done once.
  const stamping = new Set();
  async function stampBookIds(scanned) {
    for (const book of scanned) {
      if (!book.sidecar || stamping.has(book.path)) continue;
      try {
        if (JSON.parse(book.sidecar)?.bookId) continue;
      } catch {
        continue; // unreadable; opening the book deals with it
      }
      stamping.add(book.path);
      while (reading) await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const bytes = await invoke("plugin:library|read_book", {
          book: { folderId: book.folderId, path: book.path },
        });
        const bookId = await computeBookId(bytes);
        // Merged with the sidecar on disk, so nothing else in it changes.
        if (bookId) await saveBookData(book, { bookId });
      } catch (e) {
        console.warn(`Couldn't record the id of ${book.fileName}`, e);
      }
    }
  }

  // Titles and authors for sorting and search, in the background, one book at a time.
  function loadBookInfo(list) {
    for (const book of list) {
      if (bookInfo[book.path]) continue;
      getBookMeta(book).then(
        (meta) => (bookInfo[book.path] = meta),
        (e) => console.warn(`No metadata for ${book.fileName}`, e),
      );
    }
  }

  async function addFolder() {
    try {
      const picked = await invoke("plugin:library|pick_folder");
      if (!picked || folders.some((f) => f.id === picked.id)) return;
      folders.push(picked);
      saveFolders();
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }

  async function removeFolder(folder) {
    try {
      folders = folders.filter((f) => f.id !== folder.id);
      saveFolders();
      await invoke("plugin:library|release_folder", { id: folder.id });
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }

  // The folders page is a history entry, so the system back button returns home.
  function openFolders() {
    history.pushState({ libraryPage: "folders" }, "");
    page = "folders";
  }

  function closeFolders() {
    history.back(); // onPopState switches the page
  }

  // The first scan, which books opened from the OS may need to find their library entry.
  let firstScan = Promise.resolve();

  // Books opened from the OS ("Open With", double-clicking a file) go straight to the reader.
  // One that's in the library opens as its library entry, so the list shows its progress and
  // (on Android) it gets its sidecar.
  async function takeOpenedBooks() {
    const opened = await invoke("plugin:library|take_opened_books");
    let book = opened.at(-1);
    if (!book) return;
    if (book.readOnly) {
      // Android file managers send their own URI for a file, which can't be traced back to a
      // library folder; a single library book with the same name and size is taken to be it.
      await firstScan;
      const same = books.filter((b) => b.fileName === book.fileName && b.size === book.size);
      if (same.length === 1) book = same[0];
    }
    if (reading?.path === book.path) return;
    reading = books.find((b) => b.path === book.path) ?? book;
  }

  // The reader keeps its own history entries, and closing it pops one while `reading` is still
  // set, so otherwise a popstate on the folders page is always this page's back.
  function onPopState() {
    if (page === "folders" && !reading) page = "books";
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let i = -1;
    do {
      bytes /= 1024;
      i++;
    } while (bytes >= 1024 && i < units.length - 1);
    return `${bytes.toFixed(1)} ${units[i]}`;
  }

  onMount(() => {
    // The library is on screen after the next frame; Android's launch screen can go.
    requestAnimationFrame(() =>
      invoke("plugin:library|hide_splash").catch((e) => console.warn("Couldn't hide the launch screen", e)),
    );
    firstScan = refresh();
    getVersion().then((v) => (version = v), (e) => console.warn("Couldn't read the app version", e));
    // Listen first, then take what arrived before, so no opened book is missed. Android has no
    // event; a book sent from another app brings lontar back to the foreground instead.
    const openedBook = () => takeOpenedBooks().catch((e) => console.warn("Couldn't open the book", e));
    const unlisten = listen("library://opened", openedBook).then((unlisten) => {
      openedBook();
      return unlisten;
    });
    const onVisible = () => document.visibilityState === "visible" && openedBook();
    document.addEventListener("visibilitychange", onVisible);
    // Android's Back would otherwise go through the web view's own history, which skips the
    // entries added without a tap (a book sent from another app opens that way) and so can close
    // the book or leave the app from inside a panel. Every page and panel here has its own
    // history entry with a state, so Back steps through those, and only leaves from the library.
    const backButton = onBackButtonPress(() => {
      if (history.state) history.back();
      else invoke("plugin:library|move_to_background").catch((e) => console.warn(e));
    }).catch(() => null); // desktop has no Back button
    const onSchemeChange = (e) => (systemDark = e.matches);
    darkQuery.addEventListener("change", onSchemeChange);
    window.addEventListener("popstate", onPopState);
    return () => {
      darkQuery.removeEventListener("change", onSchemeChange);
      window.removeEventListener("popstate", onPopState);
      unlisten.then((unlisten) => unlisten());
      document.removeEventListener("visibilitychange", onVisible);
      backButton.then((listener) => listener?.unregister());
    };
  });
</script>

{#if page === "folders"}
  <main class="container">
    <header class="page-header">
      <button class="back" onclick={closeFolders} aria-label="Back to books">‹</button>
      <h1>Folders</h1>
    </header>

    <div class="toolbar">
      <button onclick={addFolder} disabled={loading}>Add folder</button>
      {#if folders.length > 0}
        <button onclick={refresh} disabled={loading}>Rescan</button>
      {/if}
    </div>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    {#if folders.length === 0}
      <p class="status">No folders yet. Add one to see the ebooks inside it.</p>
    {:else}
      <ul class="folders">
        {#each folders as folder (folder.id)}
          <li>
            <div class="folder-info">
              <span class="folder-name" title={folder.name}>{folder.name}</span>
              {#if folderErrors[folder.id]}
                <span class="error">{folderErrors[folder.id]}</span>
              {/if}
            </div>
            <button
              class="remove"
              onclick={() => removeFolder(folder)}
              disabled={loading}
              aria-label="Remove {folder.name}"
              title="Remove folder">×</button
            >
          </li>
        {/each}
      </ul>
      <p class="status">{loading ? "Scanning…" : `${books.length} ${books.length === 1 ? "book" : "books"} found`}</p>
    {/if}

    {#if version}
      <p class="app-version">Lontar {version}</p>
    {/if}
  </main>
{:else}
  <main class="container">
    <header class="page-header">
      <h1>Books</h1>
      {#if folders.length > 0}
        <button class="header-button" onclick={openFolders}>Folders</button>
      {/if}
    </header>

    {#if failedFolders}
      <button class="notice" onclick={openFolders}>
        {failedFolders === 1 ? "A folder" : `${failedFolders} folders`} couldn't be read. Manage folders ›
      </button>
    {/if}

    {#if error}
      <p class="error">{error}</p>
    {:else if loading && books.length === 0}
      <p class="status">Scanning…</p>
    {:else if folders.length === 0}
      <div class="empty">
        <p>Add a folder to see the ebooks inside it.</p>
        <button onclick={addFolder}>Add folder</button>
      </div>
    {:else if books.length === 0}
      <div class="empty">
        <p>No ebooks found in your folders.</p>
        <button onclick={openFolders}>Manage folders</button>
      </div>
    {:else}
      <input
        class="library-search"
        type="search"
        enterkeyhint="search"
        placeholder="Search title or author"
        aria-label="Search books"
        bind:value={query}
      />
      <div class="list-header">
        <p class="status">
          {#if query.trim()}
            {shownBooks.length} of {books.length}
          {:else}
            {books.length} {books.length === 1 ? "book" : "books"}
          {/if}
        </p>
        <div class="sort" role="group" aria-label="Sort books">
          {#each Object.entries(SORTS) as [value, label]}
            <button aria-pressed={sortBy === value} onclick={() => setSort(value)}>{label}</button>
          {/each}
        </div>
      </div>
      {#if !shownBooks.length}
        <p class="status">No books match “{query.trim()}”.</p>
      {/if}
      <ul class="books">
        {#each shownBooks as book (book.path)}
          {@const read = progress[book.path]}
          {@const info = bookInfo[book.path]}
          <li style:--progress={read?.fraction ?? 0}>
            <button class="book" title={book.path} onclick={() => (reading = book)}>
              <Cover {book} />
              <span class="book-text">
                <span class="name">{displayTitle(book, info)}</span>
                {#if info?.author}<span class="author">{info.author}</span>{/if}
                <span class="meta">
                  {book.format.toUpperCase()} ·
                  {#if read}
                    <span class="read">{percent.format(read.fraction ?? 0)}</span>
                  {:else}
                    {formatSize(book.size)}
                  {/if}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </main>
{/if}

{#if reading}
  {#key reading.path}
    <Reader
      book={reading}
      onclose={() => (reading = null)}
      onprogress={(book, p) => (progress[book.path] = p)}
    />
  {/key}
{/if}
