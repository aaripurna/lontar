import Foundation
import Tauri
import UIKit
import UniformTypeIdentifiers

private let ebookExtensions: Set<String> = [
  "epub", "pdf", "mobi", "azw", "azw3", "kf8", "kfx", "fb2", "djvu", "cbz", "cbr", "cb7",
]

struct FolderArgs: Decodable {
  let id: String
}

struct Folder: Encodable {
  let id: String
  let name: String
}

struct PickFolderResponse: Encodable {
  let folder: Folder?
}

struct Ebook: Encodable {
  let name: String
  let path: String
  let format: String
  let size: Int
}

struct ScanResponse: Encodable {
  let books: [Ebook]
}

// Folders come from the document picker and are only readable inside a security scope, and
// their paths don't survive app restarts. So the folder id is a base64 bookmark, resolved and
// opened on every scan.
class LibraryPlugin: Plugin, UIDocumentPickerDelegate {
  private var pendingPick: Invoke?

  @objc public func pickFolder(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.pendingPick?.resolve(PickFolderResponse(folder: nil))
      self.pendingPick = invoke
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
      picker.delegate = self
      picker.allowsMultipleSelection = false
      self.manager.viewController?.present(picker, animated: true)
    }
  }

  public func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    guard let invoke = pendingPick else { return }
    pendingPick = nil
    guard let url = urls.first else {
      invoke.resolve(PickFolderResponse(folder: nil))
      return
    }

    let accessing = url.startAccessingSecurityScopedResource()
    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
    do {
      let bookmark = try url.bookmarkData()
      invoke.resolve(
        PickFolderResponse(
          folder: Folder(id: bookmark.base64EncodedString(), name: url.lastPathComponent)))
    } catch {
      invoke.reject("Failed to open folder: \(error.localizedDescription)")
    }
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pendingPick?.resolve(PickFolderResponse(folder: nil))
    pendingPick = nil
  }

  // Bookmarks hold no system-side grant, so dropping the id is all removal needs.
  @objc public func releaseFolder(_ invoke: Invoke) {
    invoke.resolve()
  }

  @objc public func scan(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FolderArgs.self)
    guard let bookmark = Data(base64Encoded: args.id) else {
      invoke.reject("Invalid folder id")
      return
    }

    DispatchQueue.global(qos: .userInitiated).async {
      var stale = false
      guard
        let root = try? URL(resolvingBookmarkData: bookmark, bookmarkDataIsStale: &stale)
      else {
        invoke.reject("Lost access to this folder. Please choose it again.")
        return
      }

      let accessing = root.startAccessingSecurityScopedResource()
      defer { if accessing { root.stopAccessingSecurityScopedResource() } }

      var books: [Ebook] = []
      let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
      // Unreadable subfolders are skipped rather than failing the whole scan.
      let enumerator = FileManager.default.enumerator(
        at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles],
        errorHandler: { _, _ in true })
      while let url = enumerator?.nextObject() as? URL {
        let format = url.pathExtension.lowercased()
        guard ebookExtensions.contains(format),
          let values = try? url.resourceValues(forKeys: Set(keys)),
          values.isRegularFile == true
        else { continue }
        books.append(
          Ebook(
            name: url.deletingPathExtension().lastPathComponent,
            path: url.path,
            format: format,
            size: values.fileSize ?? 0))
      }
      invoke.resolve(ScanResponse(books: books))
    }
  }
}

@_cdecl("init_plugin_library")
func initPlugin() -> Plugin {
  return LibraryPlugin()
}
