# Lontar

Lontar is a simple, free ebook reader for your phone and computer. Point it at the folder where you keep your books, and it shows them as a library you can read from. It remembers where you stopped in every book, and it can carry your place across all your devices.

## What it can do

- **Read most ebook files:** EPUB, PDF, Kindle files (MOBI, AZW, AZW3), FB2, and comic books (CBZ). Books with copy protection (DRM), such as those bought in the Kindle or Apple Books stores, can't be opened.
- **Remember your place** in every book, and show how far you've read in the library.
- **Bookmarks, highlights and notes**, so you can find your favourite parts again.
- **Search** inside a book, or search your library by title or author.
- **Make reading comfortable:** change the text size and line spacing, and choose a light, sepia or dark page.
- **Open books from anywhere:** tap an ebook in your file manager or downloads and choose Lontar.

## Install Lontar

Go to the [download page](https://github.com/aaripurna/lontar/releases/latest) and, under **Assets**, download the file for your device:

| Your device | File to download |
|---|---|
| Android phone or tablet | the file ending in `.apk` |
| Windows | the file ending in `-setup.exe` |
| Mac | the file ending in `.dmg` |
| Linux | the file ending in `.flatpak` or `.deb` |
| iPhone or iPad | the file ending in `.ipa` (see the note below) |

### Android

1. Download the `.apk` file on your phone.
2. Open it from your notifications or your **Downloads**.
3. Your phone may say it isn't allowed to install apps from this source. Tap **Settings**, turn on **Allow from this source**, then go back and tap **Install**.
4. If Google Play Protect warns you about an unknown app, tap **More details**, then **Install anyway**. This shows up because Lontar doesn't come from the Play Store.

### Windows

1. Open the downloaded `-setup.exe` file.
2. Windows may show **Windows protected your PC**. Click **More info**, then **Run anyway**. This shows up because Lontar isn't registered with Microsoft, which costs a yearly fee, not because anything is wrong with it.
3. Follow the installer. You don't need an administrator password. If your computer is missing a part Lontar needs (Microsoft WebView2), the installer downloads it, so stay connected to the internet.
4. Open Lontar from the **Start** menu.

To open an ebook with Lontar from File Explorer, right-click it, choose **Open with**, then **Lontar**.

### Mac

1. Open the downloaded `.dmg` file.
2. Drag **Lontar** into the **Applications** folder.
3. Open Lontar from Applications. The first time, your Mac shows **"Lontar" Not Opened**, saying Apple could not verify it is free of malware. Click **Done**, not Move to Trash.
4. Open **System Settings** and go to **Privacy & Security**.
5. Scroll down to **Security**. Next to the message that Lontar was blocked, click **Open Anyway**.
6. Enter your password or use Touch ID, then click **Open Anyway** once more.

From then on, Lontar opens normally. The Mac asks because Lontar isn't registered with Apple, which costs a yearly fee, not because anything is wrong with it. You'll need to do this again each time you download a new version.

If you don't see **Open Anyway**, try opening Lontar again first: the button only appears for about an hour after the Mac blocks the app.

<details>
<summary>Comfortable with Terminal? There's a shortcut.</summary>

After dragging Lontar into Applications, open the **Terminal** app, paste this line and press Return:

```
xattr -dr com.apple.quarantine /Applications/Lontar.app
```

Lontar then opens without the warning.

</details>

### Linux

- **Flatpak** (works on most Linux systems): double-click the `.flatpak` file to install it with your Software app.
- **`.deb`** (Ubuntu, Debian, Linux Mint and similar): double-click the file and choose **Install**.

### iPhone and iPad

Lontar isn't in the App Store. To install the `.ipa` file you need a sideloading tool such as AltStore, SideStore or Sideloadly. This takes some setup, so ask a tech-savvy friend if you're unsure.

## Getting started

1. Open Lontar and tap **Add folder**.
2. Choose the folder where your ebooks are, and allow Lontar to use it. Books in folders inside it are found too.
3. Your books appear in the library. Tap one to start reading.

While reading:

- **Turn pages** by swiping left or right. On a computer, use the arrow keys, or click the arrows at the sides of the page.
- **Tap the middle of the page**, or the settings icon at the top, for the reading settings, the table of contents, and your bookmarks and highlights.
- **Highlight text** by selecting it and choosing a colour. Tap a highlight to add a note.

You can add more than one folder. Tap **Folders** at the top of the library to add or remove them.

## Keep your place on all your devices

Lontar keeps your reading place, bookmarks and highlights in a small file next to each book. For `Dune.epub` it's called `Dune.epub.lontar`. Please don't delete these files, or you'll lose your place in that book.

Because the files sit next to your books, you can keep your library the same on every device with **[Syncthing](https://syncthing.net)**. Syncthing is a free app that keeps a folder identical on your phone and computer, sending files straight between them without any cloud account. Lontar doesn't need anything else to work with it.

1. Install Syncthing on each device. On Android, use **Syncthing-Fork**.
2. Share your books folder between your devices in Syncthing.
3. Add that folder in Lontar on each device.

Now when you stop reading on your phone, your computer opens the book at the same page, and the other way round. If two devices change the same book at the same time, Lontar combines the changes, so nothing is lost.

## For developers

Lontar is built with Tauri 2 and Svelte 5 (Vite).

```sh
bun install
bun run tauri dev            # desktop
bun run tauri android dev    # Android emulator or device
bun test src                 # tests
```

To release, bump `version` in `src-tauri/tauri.conf.json` and push a `v*` tag. CI builds a signed Android APK, an unsigned Windows installer, a universal macOS DMG, an unsigned iOS IPA, a Linux `.deb` and a Flatpak bundle, and attaches them to the GitHub release. The DMG is only Developer ID signed and notarized when the `APPLE_*` secrets are set (see `.github/workflows/release.yml`).

## License

GPL-3.0-or-later
