import { describe, expect, test } from "bun:test";
import { apkAsset, downloadUrl, isNewer } from "./updates.js";

describe("isNewer", () => {
  test("compares versions number by number", () => {
    expect(isNewer("v1.10.0", "1.9.2")).toBe(true);
    expect(isNewer("1.2.0", "1.10.0")).toBe(false);
    expect(isNewer("v2.0.0", "1.99.99")).toBe(true);
  });

  test("the same version isn't newer", () => {
    expect(isNewer("v1.1.0", "1.1.0")).toBe(false);
    expect(isNewer("1.1", "1.1.0")).toBe(false);
  });

  test("ignores pre-release parts", () => {
    expect(isNewer("v1.2.0-beta.1", "1.1.0")).toBe(true);
    expect(isNewer("v1.1.0-beta.1", "1.1.0")).toBe(false);
  });
});

describe("downloadUrl", () => {
  const release = {
    html_url: "https://github.com/aaripurna/lontar/releases/tag/v1.2.0",
    assets: [
      { name: "lontar-v1.2.0-amd64.deb", browser_download_url: "https://example.com/lontar.deb" },
      { name: "lontar-v1.2.0.apk", browser_download_url: "https://example.com/lontar.apk" },
    ],
  };

  test("links Android straight to the APK", () => {
    expect(downloadUrl(release, true)).toBe("https://example.com/lontar.apk");
  });

  test("links everything else to the release page", () => {
    expect(downloadUrl(release, false)).toBe(release.html_url);
  });

  test("falls back to the release page without an APK", () => {
    expect(downloadUrl({ ...release, assets: [] }, true)).toBe(release.html_url);
  });
});

describe("apkAsset", () => {
  const sha256 = "a".repeat(64);
  const apk = {
    name: "lontar-v1.2.0.apk",
    browser_download_url: "https://example.com/lontar.apk",
    digest: `sha256:${sha256}`,
  };

  test("finds the APK and its SHA-256", () => {
    const release = { assets: [{ name: "lontar.deb", digest: "sha256:" + "b".repeat(64) }, apk] };
    expect(apkAsset(release)).toEqual({ url: apk.browser_download_url, sha256 });
  });

  test("needs a SHA-256 to check the download against", () => {
    expect(apkAsset({ assets: [{ ...apk, digest: null }] })).toBe(null);
    expect(apkAsset({ assets: [{ ...apk, digest: "sha512:abc" }] })).toBe(null);
  });

  test("is null without an APK", () => {
    expect(apkAsset({ assets: [] })).toBe(null);
    expect(apkAsset({})).toBe(null);
  });
});
