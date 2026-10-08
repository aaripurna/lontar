<script>
  import { invoke } from "@tauri-apps/api/core";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import tauriLogo from "./assets/tauri.svg";
  import svelteLogo from "./assets/svelte.svg";

  let name = $state("");
  let greetMsg = $state("");

  async function greet(event) {
    event.preventDefault();
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    greetMsg = await invoke("greet", { name });
  }

  function open(event, url) {
    event.preventDefault();
    openUrl(url);
  }
</script>

<main class="container">
  <h1>Welcome to Tauri + Svelte</h1>

  <div class="row">
    <a href="https://tauri.app" onclick={(e) => open(e, "https://tauri.app")}>
      <img src={tauriLogo} class="logo tauri" alt="Tauri logo" />
    </a>
    <a href="https://svelte.dev" onclick={(e) => open(e, "https://svelte.dev")}>
      <img src={svelteLogo} class="logo svelte" alt="Svelte logo" />
    </a>
  </div>
  <p>Click on the Tauri and Svelte logos to learn more.</p>

  <form class="row" onsubmit={greet}>
    <input id="greet-input" placeholder="Enter a name..." bind:value={name} />
    <button type="submit">Greet</button>
  </form>
  <p>{greetMsg}</p>
</main>
