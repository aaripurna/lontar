package com.nawa.lontar.library

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private val EBOOK_EXTENSIONS = setOf(
  "epub", "pdf", "mobi", "azw", "azw3", "kf8", "kfx", "fb2", "djvu", "cbz", "cbr", "cb7"
)

@InvokeArg
class FolderArgs {
  lateinit var id: String
}

@InvokeArg
class BookArgs {
  lateinit var folderId: String
  // Document URI of the book.
  lateinit var path: String
}

@InvokeArg
class SidecarArgs {
  lateinit var folderId: String
  // Parent document id of the book.
  lateinit var dir: String
  lateinit var sidecarName: String
  var contents: String? = null
}

private const val READ_WRITE =
  Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

// Folders are picked with the Storage Access Framework. The returned tree URI is the folder id;
// its read/write permission (write is for the .lontar sidecars) is persisted so the library can
// be rescanned after the app restarts, and released when the folder is removed from the library.
@TauriPlugin
class LibraryPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun pickFolder(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      .addFlags(READ_WRITE or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    startActivityForResult(invoke, intent, "pickFolderResult")
  }

  @ActivityCallback
  fun pickFolderResult(invoke: Invoke, result: ActivityResult) {
    val intent: Intent? = result.data
    val treeUri: Uri? = intent?.data
    if (result.resultCode != Activity.RESULT_OK || treeUri == null) {
      invoke.resolve(JSObject()) // cancelled: `folder` absent
      return
    }
    try {
      val resolver = activity.contentResolver
      resolver.takePersistableUriPermission(treeUri, READ_WRITE)

      val rootDocUri = DocumentsContract.buildDocumentUriUsingTree(
        treeUri, DocumentsContract.getTreeDocumentId(treeUri)
      )
      var name = treeUri.lastPathSegment ?: treeUri.toString()
      resolver.query(rootDocUri, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) name = it.getString(0) ?: name
      }

      val folder = JSObject()
      folder.put("id", treeUri.toString())
      folder.put("name", name)
      invoke.resolve(JSObject().put("folder", folder))
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Failed to open folder")
    }
  }

  @Command
  fun releaseFolder(invoke: Invoke) {
    val args = invoke.parseArgs(FolderArgs::class.java)
    val uri = Uri.parse(args.id)
    val resolver = activity.contentResolver
    // Release exactly what was granted: folders added by older builds only hold read access.
    for (perm in resolver.persistedUriPermissions) {
      if (perm.uri != uri) continue
      val flags = (if (perm.isReadPermission) Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or
        (if (perm.isWritePermission) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
      resolver.releasePersistableUriPermission(uri, flags)
    }
    invoke.resolve()
  }

  @Command
  fun scan(invoke: Invoke) {
    val args = invoke.parseArgs(FolderArgs::class.java)
    // A large library can take a while to walk; keep it off the caller's thread.
    Thread {
      try {
        val treeUri = Uri.parse(args.id)
        val books = JSArray()
        collectEbooks(treeUri, DocumentsContract.getTreeDocumentId(treeUri), books)
        invoke.resolve(JSObject().put("books", books))
      } catch (e: SecurityException) {
        invoke.reject("Lost access to this folder. Please choose it again.")
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Failed to scan folder")
      }
    }.start()
  }

  // Copies the book into the cache for Rust to read; Rust deletes the copy.
  @Command
  fun copyBook(invoke: Invoke) {
    val args = invoke.parseArgs(BookArgs::class.java)
    Thread {
      try {
        if (!args.path.startsWith(args.folderId + "/document/")) {
          throw Exception("That book is outside the library folder.")
        }
        val copy = java.io.File.createTempFile("book", null, activity.cacheDir)
        val input = activity.contentResolver.openInputStream(Uri.parse(args.path))
          ?: throw Exception("Couldn't open the book")
        input.use { src -> copy.outputStream().use { src.copyTo(it) } }
        invoke.resolve(JSObject().put("path", copy.absolutePath))
      } catch (e: SecurityException) {
        invoke.reject("Lost access to this folder. Please add it again.")
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Failed to open the book")
      }
    }.start()
  }

  @Command
  fun readSidecar(invoke: Invoke) {
    val args = invoke.parseArgs(SidecarArgs::class.java)
    Thread {
      try {
        val treeUri = Uri.parse(args.folderId)
        val result = JSObject()
        findChild(treeUri, args.dir, args.sidecarName)?.let { uri ->
          activity.contentResolver.openInputStream(uri)?.use {
            result.put("contents", it.readBytes().toString(Charsets.UTF_8))
          }
        }
        invoke.resolve(result) // no sidecar yet: `contents` absent
      } catch (e: SecurityException) {
        invoke.reject("Lost access to this folder. Please add it again.")
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Failed to read ${args.sidecarName}")
      }
    }.start()
  }

  // SAF can't rename over an existing document, so unlike desktop this isn't an atomic swap:
  // the existing sidecar is truncated and rewritten in place.
  @Command
  fun writeSidecar(invoke: Invoke) {
    val args = invoke.parseArgs(SidecarArgs::class.java)
    Thread {
      try {
        val treeUri = Uri.parse(args.folderId)
        val resolver = activity.contentResolver
        val uri = findChild(treeUri, args.dir, args.sidecarName)
          ?: DocumentsContract.createDocument(
            resolver,
            DocumentsContract.buildDocumentUriUsingTree(treeUri, args.dir),
            // A specific MIME type would make some providers append their own extension.
            "application/octet-stream",
            args.sidecarName
          )
          ?: throw Exception("Couldn't create ${args.sidecarName}")
        val stream = resolver.openOutputStream(uri, "wt")
          ?: throw Exception("Couldn't open ${args.sidecarName}")
        stream.use { it.write((args.contents ?: "").toByteArray(Charsets.UTF_8)) }
        invoke.resolve()
      } catch (e: SecurityException) {
        // Either the folder was added with read-only access (by an older build) or the book
        // isn't inside it.
        invoke.reject(
          "Lontar isn't allowed to save here. Try removing the folder and adding it again."
        )
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Failed to write ${args.sidecarName}")
      }
    }.start()
  }

  private fun findChild(treeUri: Uri, parentId: String, name: String): Uri? {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
    val columns = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME)
    activity.contentResolver.query(childrenUri, columns, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        if (cursor.getString(1) == name) {
          return DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(0))
        }
      }
    }
    return null
  }

  private fun collectEbooks(treeUri: Uri, parentId: String, books: JSArray) {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
    val columns = arrayOf(
      Document.COLUMN_DOCUMENT_ID,
      Document.COLUMN_DISPLAY_NAME,
      Document.COLUMN_MIME_TYPE,
      Document.COLUMN_SIZE,
    )
    val subdirs = mutableListOf<String>()
    activity.contentResolver.query(childrenUri, columns, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val docId = cursor.getString(0) ?: continue
        val name = cursor.getString(1) ?: continue
        if (name.startsWith(".")) continue

        if (cursor.getString(2) == Document.MIME_TYPE_DIR) {
          subdirs.add(docId)
          continue
        }
        val dot = name.lastIndexOf('.')
        if (dot <= 0) continue
        val format = name.substring(dot + 1).lowercase()
        if (format !in EBOOK_EXTENSIONS) continue

        val book = JSObject()
        book.put("name", name.substring(0, dot))
        book.put("fileName", name)
        book.put("path", DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString())
        book.put("dir", parentId)
        book.put("format", format)
        book.put("size", if (cursor.isNull(3)) 0L else cursor.getLong(3))
        books.put(book)
      }
    }
    for (dir in subdirs) {
      collectEbooks(treeUri, dir, books)
    }
  }
}
