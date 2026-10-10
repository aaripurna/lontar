<script>
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";

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
      books = result.books;
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

  onMount(refresh);
</script>

<main class="container">
  <header class="toolbar">
    <button onclick={addFolder} disabled={loading}>Add folder</button>
    {#if folders.length > 0}
      <button onclick={refresh} disabled={loading}>Rescan</button>
    {/if}
  </header>

  {#if folders.length > 0}
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
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {:else if loading}
    <p class="status">Scanning…</p>
  {:else if folders.length === 0}
    <p class="status">Add a folder to see the ebooks inside it.</p>
  {:else if books.length === 0}
    <p class="status">No ebooks found in these folders.</p>
  {:else}
    <p class="status">{books.length} {books.length === 1 ? "book" : "books"}</p>
    <ul class="books">
      {#each books as book (book.path)}
        <li title={book.path}>
          <span class="format">{book.format}</span>
          <span class="name">{book.name}</span>
          <span class="size">{formatSize(book.size)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</main>
