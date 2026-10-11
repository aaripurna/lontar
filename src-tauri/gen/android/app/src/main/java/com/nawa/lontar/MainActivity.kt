package com.nawa.lontar

import android.os.Bundle
import android.os.SystemClock
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.nawa.lontar.library.LibraryPlugin

// Longest the launch screen waits for the page, in case it never reports in.
private const val SPLASH_MAX_MS = 5000L

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Keep the launch screen up until the frontend has drawn the library (it calls the library
    // plugin's hideSplash). A recreated activity loads the page again, so it waits again.
    LibraryPlugin.pageReady = false
    val shownAt = SystemClock.uptimeMillis()
    installSplashScreen().setKeepOnScreenCondition {
      !LibraryPlugin.pageReady && SystemClock.uptimeMillis() - shownAt < SPLASH_MAX_MS
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // The WebView doesn't report safe-area insets to CSS, so keep it clear of the
    // status bar, navigation bar and display cutout here instead. The keyboard too: drawing
    // edge to edge, the window isn't resized for it, so it would cover the bottom of the page
    // (e.g. the search box in the reader).
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
