# lontar

Tauri 2 + Svelte 5 (Vite) app for desktop and Android.

## Development

```sh
bun install
bun run tauri dev            # desktop
bun run tauri android dev    # Android emulator or device
```

## Release

Bump `version` in `src-tauri/tauri.conf.json`, then push a `v*` tag. CI builds a signed APK and attaches it to the GitHub release.

## License

GPL-3.0-or-later
