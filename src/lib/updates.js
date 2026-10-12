// Looks for a newer release of Lontar. The Windows installer and the macOS app install it with
// Tauri's updater (from latest.json on the latest GitHub release, signed by CI); other builds
// can't replace themselves, so they get a link to download it instead.
import { invoke } from "@tauri-apps/api/core";

const RELEASES_API = "https://api.github.com/repos/aaripurna/lontar/releases/latest";

/** "1.10.0" > "1.9.2": compares the numbers of two versions, ignoring any "-beta" part. */
export function isNewer(version, than) {
  const parts = (v) => v.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Picks where to send someone for the new version: the APK itself on Android, which the system
 * offers to install, and the release page elsewhere.
 */
export function downloadUrl(release, android) {
  const apk = android && release.assets?.find((a) => a.name.endsWith(".apk"));
  return apk ? apk.browser_download_url : release.html_url;
}

/**
 * Returns the newer release as { version, install } (install downloads it, installs it and
 * restarts) or { version, url } (a page to download it from), or null if this is the latest.
 */
export async function findUpdate(currentVersion) {
  const method = await invoke("update_method");
  if (method === "install") {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      install: async () => {
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  }
  const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = await res.json();
  if (!isNewer(release.tag_name, currentVersion)) return null;
  const android = /Android/i.test(navigator.userAgent);
  return { version: release.tag_name.replace(/^v/, ""), url: downloadUrl(release, android) };
}
