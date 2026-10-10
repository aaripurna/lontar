<script>
  import { onMount } from "svelte";
  import { getCover } from "./lib/covers.js";

  // `book` is an entry from the `plugin:library|scan` result.
  let { book } = $props();

  let node;
  let src = $state(null);

  // Only fetch covers for rows on (or near) screen; making one may mean parsing the book.
  onMount(() => {
    let url = null;
    let cancelled = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        getCover(book)
          .then((blob) => {
            if (blob && !cancelled) src = url = URL.createObjectURL(blob);
          })
          .catch((e) => console.warn(`No cover for ${book.fileName}`, e));
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  });
</script>

<span class="cover" bind:this={node} aria-hidden="true">
  {#if src}
    <img {src} alt="" />
  {:else}
    <span class="cover-placeholder">{book.format}</span>
  {/if}
</span>
