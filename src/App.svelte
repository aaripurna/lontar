<script>
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";

  const LAST_DIR_KEY = "lontar.libraryDir";

  let dir = $state(null);
  let books = $state([]);
  let loading = $state(false);
  let error = $state("");

  async function scan(path) {
    loading = true;
    error = "";
    try {
      books = await invoke("scan_ebooks", { dir: path });
      dir = path;
      try {
        localStorage.setItem(LAST_DIR_KEY, path);
      } catch {}
    } catch (e) {
      error = String(e);
      books = [];
    } finally {
      loading = false;
    }
  }

  async function chooseDir() {
    const picked = await open({ directory: true, defaultPath: dir ?? undefined });
    if (typeof picked === "string") await scan(picked);
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

  $effect(() => {
    let last = null;
    try {
      last = localStorage.getItem(LAST_DIR_KEY);
    } catch {}
    if (last) scan(last);
  });
</script>

<main class="container">
  <header class="toolbar">
    <button onclick={chooseDir} disabled={loading}>
      {dir ? "Change folder" : "Choose folder"}
    </button>
    {#if dir}
      <button onclick={() => scan(dir)} disabled={loading}>Rescan</button>
      <span class="dir" title={dir}>{dir}</span>
    {/if}
  </header>

  {#if error}
    <p class="error">{error}</p>
  {:else if loading}
    <p class="status">Scanning…</p>
  {:else if !dir}
    <p class="status">Choose a folder to see the ebooks inside it.</p>
  {:else if books.length === 0}
    <p class="status">No ebooks found in this folder.</p>
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
