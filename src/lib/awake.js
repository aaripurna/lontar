import { invoke } from "@tauri-apps/api/core";

// Keeps the screen on while a book is open. Android sets a flag on its window, since its web
// view has no Screen Wake Lock API; elsewhere that API is used where the web view has it. The
// system drops a wake lock whenever the page is hidden, so it's taken again when it's back.
let holders = 0;
let wanted = false;
let lock = null;
let requesting = false;

// Keeps the screen on until the returned function is called. Counted, so a reader closing
// after the next one opened (a book opened from another app replacing it) leaves it on.
export function keepScreenOn() {
  holders++;
  update();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    update();
  };
}

function update() {
  const on = holders > 0;
  if (on === wanted) return;
  wanted = on;
  invoke("plugin:library|set_keep_screen_on", { on }).catch((e) =>
    console.warn("Couldn't keep the screen on", e),
  );
  if (on) requestLock();
  else lock?.release().catch(() => {});
}

async function requestLock() {
  if (!wanted || lock || requesting || !navigator.wakeLock) return;
  if (document.visibilityState !== "visible") return;
  requesting = true;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      if (lock === sentinel) lock = null;
    });
    lock = sentinel;
    if (!wanted) await sentinel.release(); // the book was closed meanwhile
  } catch (e) {
    console.warn("No screen wake lock", e); // e.g. low battery, or not allowed
  } finally {
    requesting = false;
  }
}

document.addEventListener("visibilitychange", requestLock);
