// Sets the app version in tauri.conf.json from a release tag ("v1.2.0" -> "1.2.0"), so the
// tag is the only place a release's version is written. Used by .github/workflows/release.yml.
// Usage: node scripts/set-version.mjs v1.2.0
import { readFileSync, writeFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const version = tag.replace(/^v/, "");
// Tauri needs semver: three numbers, optionally with a pre-release such as "-beta.1".
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`"${tag}" isn't a version tag like v1.2.0`);
  process.exit(1);
}

const path = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(readFileSync(path, "utf8"));
config.version = version;
writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
console.log(`App version set to ${version}`);
