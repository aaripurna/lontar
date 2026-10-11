package com.nawa.lontar.library

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import androidx.core.view.WindowCompat
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
class BarColorsArgs {
  lateinit var color: String
  var dark: Boolean = false
}

@InvokeArg
class ConflictArgs {
  lateinit var folderId: String
  // Parent document id of the book.
  lateinit var dir: String
  lateinit var prefix: String
  lateinit var suffix: String
}

@InvokeArg
class SidecarArgs {
  lateinit var folderId: String
  // Parent document id of the book.
  lateinit var dir: String
  lateinit var sidecarName: String
  var contents: String? = null
}

private const val SIDECAR_SUFFIX = ".lontar"

private const val EXTERNAL_STORAGE = "com.android.externalstorage.documents"

// Stands in for the library folder of a book opened from another app that isn't in the
// library. Such a book can be read (see `openedUris`) but has nowhere to keep a sidecar.
private const val OPENED_FOLDER = "opened"

// For books opened from other apps without a usable file name. Matches the MIME types the
// manifest's "Open with" intent filter accepts.
private val MIME_FORMATS = mapOf(
  "application/epub+zip" to "epub",
  "application/pdf" to "pdf",
  "application/x-mobipocket-ebook" to "mobi",
  "application/vnd.amazon.ebook" to "azw",
  "application/vnd.amazon.mobi8-ebook" to "azw3",
  "application/x-mobi8-ebook" to "azw3",
  "application/x-fictionbook+xml" to "fb2",
  "application/x-fictionbook" to "fb2",
  "application/vnd.comicbook+zip" to "cbz",
  "application/x-cbz" to "cbz",
)

private const val READ_WRITE =
  Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

// Folders are picked with the Storage Access Framework. The returned tree URI is the folder id;
// its read/write permission (write is for the .lontar sidecars) is persisted so the library can
// be rescanned after the app restarts, and released when the folder is removed from the library.
@TauriPlugin
class LibraryPlugin(private val activity: Activity) : Plugin(activity) {

  // Books opened from other apps ("Open with"), waiting for the frontend to take them.
  private val openedBooks = mutableListOf<JSObject>()
  // Documents other apps have let us read by opening them here. The grant lasts as long as
  // the activity, so only these can be read outside the library folders.
  private val openedUris = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
  private var launchIntentHandled = false

  override fun onNewIntent(intent: Intent) {
    synchronized(openedBooks) {
      handleLaunchIntent() // keep the books in the order they were opened
      handleViewIntent(intent)
    }
  }

  // The frontend calls this at startup and whenever the app comes back to the foreground,
  // which it does after being sent a book.
  @Command
  fun takeOpenedBooks(invoke: Invoke) {
    val books = JSArray()
    synchronized(openedBooks) {
      handleLaunchIntent()
      openedBooks.forEach { books.put(it) }
      openedBooks.clear()
    }
    invoke.resolve(JSObject().put("books", books))
  }

  private fun handleLaunchIntent() {
    if (launchIntentHandled) return
    launchIntentHandled = true
    handleViewIntent(activity.intent)
  }

  private fun handleViewIntent(intent: Intent?) {
    if (intent?.action != Intent.ACTION_VIEW) return
    val uri = intent.data ?: return
    try {
      openedBook(uri, intent.type)?.let { openedBooks.add(it) }
    } catch (e: Exception) {
      android.util.Log.w("LibraryPlugin", "Couldn't open $uri", e)
    }
  }

  // Describes a book sent by another app like a scanned one. A book inside a library folder
  // gets its library location, so it opens with its sidecar; any other is marked `readOnly`.
  private fun openedBook(uri: Uri, mimeType: String?): JSObject? {
    var displayName: String? = null
    var size = 0L
    try {
      activity.contentResolver.query(
        uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null
      )?.use {
        if (it.moveToFirst()) {
          displayName = it.getString(0)
          if (!it.isNull(1)) size = it.getLong(1)
        }
      }
    } catch (e: SecurityException) {
      // Not granted for this URI itself, e.g. a library book sent by its storage URI, which is
      // only reachable through the library folder's grant. The URI still names the file.
    }
    val fileName = displayName ?: uri.lastPathSegment?.substringAfterLast('/') ?: return null
    val dot = fileName.lastIndexOf('.')
    val format = fileName.substring(dot + 1).lowercase().takeIf { dot > 0 && it in EBOOK_EXTENSIONS }
      ?: MIME_FORMATS[mimeType ?: activity.contentResolver.getType(uri)]
      ?: return null

    val book = JSObject()
    book.put("name", if (dot > 0) fileName.substring(0, dot) else fileName)
    book.put("fileName", fileName)
    book.put("format", format)
    book.put("size", size)
    val inLibrary = libraryLocation(uri)
    if (inLibrary != null) {
      val (treeUri, docId) = inLibrary
      book.put("path", DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString())
      book.put("folderId", treeUri.toString())
      book.put("dir", parentDocumentId(docId))
    } else {
      openedUris.add(uri.toString())
      book.put("path", uri.toString())
      book.put("folderId", OPENED_FOLDER)
      book.put("dir", "")
      book.put("readOnly", true)
    }
    return book
  }

  // The library folder holding the document, if any, with the document's id. Only for the
  // device storage provider, whose document ids are paths ("primary:Books/Dune.epub"), so
  // containment can be told from the ids. File managers that send their own URIs are matched
  // to library books by the frontend instead.
  private fun libraryLocation(uri: Uri): Pair<Uri, String>? {
    if (uri.authority != EXTERNAL_STORAGE || !DocumentsContract.isDocumentUri(activity, uri)) {
      return null
    }
    val docId = DocumentsContract.getDocumentId(uri)
    for (perm in activity.contentResolver.persistedUriPermissions) {
      val tree = perm.uri
      if (tree.authority != EXTERNAL_STORAGE || !perm.isWritePermission) continue
      val treeId = try {
        DocumentsContract.getTreeDocumentId(tree)
      } catch (e: Exception) {
        continue
      }
      // A volume's root ("primary:") has children "primary:Books"; others "primary:Books/x".
      val prefix = if (treeId.endsWith(":")) treeId else "$treeId/"
      if (docId.startsWith(prefix)) return tree to docId
    }
    return null
  }

  private fun parentDocumentId(docId: String): String =
    if (docId.contains('/')) docId.substringBeforeLast('/') else docId.substringBefore(':') + ":"

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
        val orphans = JSArray()
        collectEbooks(treeUri, DocumentsContract.getTreeDocumentId(treeUri), books, orphans)
        invoke.resolve(JSObject().put("books", books).put("orphans", orphans))
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
        val allowed = if (args.folderId == OPENED_FOLDER) {
          args.path in openedUris
        } else {
          args.path.startsWith(args.folderId + "/document/")
        }
        if (!allowed) throw Exception("That book is outside the library folder.")
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

  // Returns the sync tool's conflict copies of a sidecar; Rust re-checks the names.
  @Command
  fun readSidecarConflicts(invoke: Invoke) {
    val args = invoke.parseArgs(ConflictArgs::class.java)
    Thread {
      try {
        val treeUri = Uri.parse(args.folderId)
        val resolver = activity.contentResolver
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, args.dir)
        val columns = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME)
        val files = JSArray()
        resolver.query(childrenUri, columns, null, null, null)?.use { cursor ->
          while (cursor.moveToNext()) {
            val name = cursor.getString(1) ?: continue
            if (!name.startsWith(args.prefix) || !name.endsWith(args.suffix)) continue
            val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(0))
            val contents = resolver.openInputStream(uri)?.use {
              it.readBytes().toString(Charsets.UTF_8)
            } ?: continue
            files.put(JSObject().put("name", name).put("contents", contents))
          }
        }
        invoke.resolve(JSObject().put("files", files))
      } catch (e: SecurityException) {
        invoke.reject("Lost access to this folder. Please add it again.")
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Failed to read sidecar conflicts")
      }
    }.start()
  }

  // Rust has already checked that the name is a conflict copy.
  @Command
  fun deleteSidecarFile(invoke: Invoke) {
    val args = invoke.parseArgs(SidecarArgs::class.java)
    Thread {
      try {
        val treeUri = Uri.parse(args.folderId)
        findChild(treeUri, args.dir, args.sidecarName)?.let {
          DocumentsContract.deleteDocument(activity.contentResolver, it)
        }
        invoke.resolve()
      } catch (e: SecurityException) {
        invoke.reject("Lontar isn't allowed to change this folder. Try removing it and adding it again.")
      } catch (e: Exception) {
        invoke.reject(e.message ?: "Failed to delete ${args.sidecarName}")
      }
    }.start()
  }

  // What Back does at the app's root on Android 12+: the app goes to the background, still
  // running. The frontend handles Back itself (see App.svelte), so it asks for this.
  @Command
  fun moveToBackground(invoke: Invoke) {
    activity.runOnUiThread {
      activity.moveTaskToBack(true)
      invoke.resolve()
    }
  }

  // The app draws edge-to-edge, with MainActivity padding the content view clear of the system
  // bars, so that padding is what shows behind them.
  @Command
  fun setBarColors(invoke: Invoke) {
    val args = invoke.parseArgs(BarColorsArgs::class.java)
    val color = Color.parseColor(args.color)
    activity.runOnUiThread {
      val window = activity.window
      activity.findViewById<android.view.View>(android.R.id.content).setBackgroundColor(color)
      WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = !args.dark
        isAppearanceLightNavigationBars = !args.dark
      }
      invoke.resolve()
    }
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

  // Lists the ebooks under `parentId` into `books`, and into `orphans` the sidecars whose book
  // is gone (renamed or moved), which the frontend may reattach.
  private fun collectEbooks(treeUri: Uri, parentId: String, books: JSArray, orphans: JSArray) {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
    val columns = arrayOf(
      Document.COLUMN_DOCUMENT_ID,
      Document.COLUMN_DISPLAY_NAME,
      Document.COLUMN_MIME_TYPE,
      Document.COLUMN_SIZE,
    )
    val subdirs = mutableListOf<String>()
    val found = mutableListOf<JSObject>()
    val sidecars = mutableMapOf<String, String>() // file name -> document id
    activity.contentResolver.query(childrenUri, columns, null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        val docId = cursor.getString(0) ?: continue
        val name = cursor.getString(1) ?: continue
        if (name.startsWith(".")) continue

        if (cursor.getString(2) == Document.MIME_TYPE_DIR) {
          subdirs.add(docId)
          continue
        }
        if (name.endsWith(SIDECAR_SUFFIX)) {
          sidecars[name] = docId
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
        found.add(book)
      }
    }
    fun readText(docId: String): String? = try {
      val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
      activity.contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
    } catch (e: Exception) {
      null // leave it out; opening the book reports the problem
    }
    // Attach each book's sidecar, so the library can show progress without a read per book.
    for (book in found) {
      sidecars.remove(book.getString("fileName") + SIDECAR_SUFFIX)?.let { docId ->
        readText(docId)?.let { book.put("sidecar", it) }
      }
      books.put(book)
    }
    // What's left are sidecars without their book. Conflict copies aren't sidecars.
    for ((name, docId) in sidecars) {
      val bookName = name.removeSuffix(SIDECAR_SUFFIX)
      if (bookName.contains(".sync-conflict-")) continue
      val format = bookName.substringAfterLast('.', "").lowercase()
      if (format !in EBOOK_EXTENSIONS) continue
      val contents = readText(docId) ?: continue
      orphans.put(JSObject().put("dir", parentId).put("fileName", bookName).put("contents", contents))
    }
    for (dir in subdirs) {
      collectEbooks(treeUri, dir, books, orphans)
    }
  }
}
