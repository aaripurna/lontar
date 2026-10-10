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
  let fileName: String
  let path: String
  let dir: String
  let format: String
  let size: Int
}

struct BookArgs: Decodable {
  let folderId: String
  let path: String
}

struct CopyBookResponse: Encodable {
  let path: String
}

struct SidecarArgs: Decodable {
  let folderId: String
  let dir: String
  let sidecarName: String
  var contents: String?
}

struct ReadSidecarResponse: Encodable {
  let contents: String?
}

enum LibraryError: LocalizedError {
  case lostAccess
  case outsideFolder

  var errorDescription: String? {
    switch self {
    case .lostAccess: return "Lost access to this folder. Please add it again."
    case .outsideFolder: return "That book is outside the library folder."
    }
  }
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
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let books = try self.withFolder(args.id) { root in self.collectEbooks(root) }
        invoke.resolve(ScanResponse(books: books))
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  // Copies the book into the temp dir for Rust to read; Rust deletes the copy.
  @objc public func copyBook(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BookArgs.self)
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let copy = try self.withFolder(args.folderId) { root -> URL in
          let book = URL(fileURLWithPath: args.path).standardizedFileURL
          guard self.isInside(book, root) else { throw LibraryError.outsideFolder }
          let copy = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
          try FileManager.default.copyItem(at: book, to: copy)
          return copy
        }
        invoke.resolve(CopyBookResponse(path: copy.path))
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  @objc public func readSidecar(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SidecarArgs.self)
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let contents = try self.withFolder(args.folderId) { root -> String? in
          let url = try self.sidecarURL(root, args)
          guard FileManager.default.fileExists(atPath: url.path) else { return nil }
          return try String(contentsOf: url, encoding: .utf8)
        }
        invoke.resolve(ReadSidecarResponse(contents: contents))
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  // `.atomic` writes a temp file and swaps it in, so sync tools never see a partial file.
  @objc public func writeSidecar(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SidecarArgs.self)
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        try self.withFolder(args.folderId) { root in
          let url = try self.sidecarURL(root, args)
          try Data((args.contents ?? "").utf8).write(to: url, options: .atomic)
        }
        invoke.resolve()
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  /// Resolves a folder bookmark and runs `body` inside its security scope.
  private func withFolder<T>(_ id: String, _ body: (URL) throws -> T) throws -> T {
    var stale = false
    guard let bookmark = Data(base64Encoded: id),
      let root = try? URL(resolvingBookmarkData: bookmark, bookmarkDataIsStale: &stale)
    else { throw LibraryError.lostAccess }

    let accessing = root.startAccessingSecurityScopedResource()
    defer { if accessing { root.stopAccessingSecurityScopedResource() } }
    return try body(root)
  }

  private func isInside(_ url: URL, _ root: URL) -> Bool {
    let rootPath = root.standardizedFileURL.path
    let path = url.standardizedFileURL.path
    return path == rootPath || path.hasPrefix(rootPath + "/")
  }

  private func sidecarURL(_ root: URL, _ args: SidecarArgs) throws -> URL {
    let dir = URL(fileURLWithPath: args.dir).standardizedFileURL
    guard isInside(dir, root) else { throw LibraryError.outsideFolder }
    return dir.appendingPathComponent(args.sidecarName)
  }

  private func collectEbooks(_ root: URL) -> [Ebook] {
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
          fileName: url.lastPathComponent,
          path: url.path,
          dir: url.deletingLastPathComponent().path,
          format: format,
          size: values.fileSize ?? 0))
    }
    return books
  }
}

@_cdecl("init_plugin_library")
func initPlugin() -> Plugin {
  return LibraryPlugin()
}
