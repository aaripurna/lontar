import { invoke } from "@tauri-apps/api/core";

// Colours the area behind Android's status and navigation bars to match the app. `dark` picks
// light icons. A no-op on other platforms.
export function setBarColors(color, dark) {
  invoke("plugin:library|set_bar_colors", { color, dark }).catch((e) =>
    console.warn("Couldn't colour the system bars", e),
  );
}
