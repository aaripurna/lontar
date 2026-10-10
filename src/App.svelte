<script>
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import Reader from "./Reader.svelte";
  import Cover from "./Cover.svelte";
  import { pruneCovers } from "./lib/covers.js";
  import { scannedProgress } from "./lib/sidecar.js";
  import { setBarColors } from "./lib/bars.js";

  const FOLDERS_KEY = "lontar.libraryFolders";
  // Older builds saved a single folder under this key.
  const LEGACY_FOLDER_KEY = "lontar.libraryFolder";

  // [{ id, name }]: id is a path on desktop and an opaque access token on Android/iOS.
  // Device-local on purpose: these ids mean nothing on another device.
  let folders = $state(loadFolders());
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

  const SORT_KEY = "lontar.librarySort";
  let sortBy = $state(loadSort()); // "title" or "recent"
  // Books arrive sorted by title. Recent puts the most recently read first; the sort is
  // stable, so unread books keep their title order at the end.
  let sortedBooks = $derived(
    sortBy === "recent"
      ? [...books].sort((a, b) =>
          (progress[b.path]?.updatedAt ?? "").localeCompare(progress[a.path]?.updatedAt ?? ""),
        )
      : books,
  );

  const percent = new Intl.NumberFormat(undefined, { style: "percent" });

  // Colours match app.css's background for the library.
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  let systemDark = $state(darkQuery.matches);
  $effect(() => {
    if (!reading) setBarColors(systemDark ? "#2f2f2f" : "#f6f6f6", systemDark);
  });

  function loadSort() {
    try {
      return localStorage.getItem(SORT_KEY) === "recent" ? "recent" : "title";
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
      const saved = JSON.parse(localStorage.getItem(FOLDERS_KEY));
      if (saved) return saved;
      const legacy = JSON.parse(localStorage.getItem(LEGACY_FOLDER_KEY));
      return legacy ? [legacy] : [];
    } catch {
      return [];
    }
  }

  function saveFolders() {
    try {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
      localStorage.removeItem(LEGACY_FOLDER_KEY);
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
      folderErrors = Object.fromEntries(result.errors.map((e) => [e.folderId, e.message]));
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
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

  // The reader keeps its own history entries and can only be opened from home, so a popstate
  // while on the folders page is always this page's back.
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
    refresh();
    const onSchemeChange = (e) => (systemDark = e.matches);
    darkQuery.addEventListener("change", onSchemeChange);
    window.addEventListener("popstate", onPopState);
    return () => {
      darkQuery.removeEventListener("change", onSchemeChange);
      window.removeEventListener("popstate", onPopState);
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
      <div class="list-header">
        <p class="status">{books.length} {books.length === 1 ? "book" : "books"}</p>
        <div class="sort" role="group" aria-label="Sort books">
          <button aria-pressed={sortBy === "title"} onclick={() => setSort("title")}>Title</button>
          <button aria-pressed={sortBy === "recent"} onclick={() => setSort("recent")}>Recent</button>
        </div>
      </div>
      <ul class="books">
        {#each sortedBooks as book (book.path)}
          {@const read = progress[book.path]}
          <li style:--progress={read?.fraction ?? 0}>
            <button class="book" title={book.path} onclick={() => (reading = book)}>
              <Cover {book} />
              <span class="book-text">
                <span class="name">{book.name}</span>
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
