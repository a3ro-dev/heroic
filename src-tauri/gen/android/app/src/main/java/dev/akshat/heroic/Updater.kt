package dev.akshat.heroic

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Self-update from the repo's `android-nightly` release. The repo is private, so CI bakes a
 * read-only token into the build (HEROIC_UPDATE_TOKEN). Android asks the user to confirm each
 * install, and only accepts APKs signed with the same key as the installed one.
 * The page reaches this as `window.HeroicUpdater`; progress comes back through `window.onHeroicUpdate`.
 */
class Updater(private val activity: Activity, private val webView: WebView) {
  private val busy = AtomicBoolean(false)

  @JavascriptInterface
  fun available() = BuildConfig.UPDATE_TOKEN.isNotEmpty()

  @JavascriptInterface
  fun build() = BuildConfig.VERSION_CODE

  /** quiet: only speak up when there is an update (used for the check on launch). */
  @JavascriptInterface
  fun check(quiet: Boolean) {
    if (!available()) return report("error", "This build can't update itself")
    if (!busy.compareAndSet(false, true)) return
    thread {
      try {
        val rel = JSONObject(open(RELEASE, "application/vnd.github+json").bufferedReader().use { it.readText() })
        val latest = Regex("""build (\d+)""").find(rel.optString("name"))?.groupValues?.get(1)?.toInt() ?: 0
        if (latest <= BuildConfig.VERSION_CODE) {
          if (!quiet) report("latest", "You're on the newest build (${BuildConfig.VERSION_CODE})")
          return@thread
        }
        val assets = rel.getJSONArray("assets")
        val apk = (0 until assets.length()).map { assets.getJSONObject(it) }.first { it.getString("name").endsWith(".apk") }
        report("downloading", "Downloading build $latest")
        install(open(apk.getString("url"), "application/octet-stream"))
        report("ready", "Confirm the install to finish updating")
      } catch (e: Exception) {
        if (!quiet) report("error", "Couldn't update: ${e.message}")
      } finally {
        busy.set(false)
      }
    }
  }

  private fun open(url: String, accept: String): InputStream {
    val c = URL(url).openConnection() as HttpURLConnection
    c.instanceFollowRedirects = false
    c.setRequestProperty("Authorization", "Bearer ${BuildConfig.UPDATE_TOKEN}")
    c.setRequestProperty("Accept", accept)
    c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
    val code = c.responseCode
    // assets redirect to a signed storage URL, which must not receive our token
    if (code in 300..399) return URL(c.getHeaderField("Location")).openStream()
    if (code != 200) throw IOException("GitHub answered $code")
    return c.inputStream
  }

  private fun install(apk: InputStream) {
    val installer = activity.packageManager.packageInstaller
    val id = installer.createSession(PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL))
    installer.openSession(id).use { s ->
      s.openWrite("heroic.apk", 0, -1).use { out ->
        apk.use { it.copyTo(out) }
        s.fsync(out)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
      val done = PendingIntent.getBroadcast(activity, id, Intent(activity, InstallResult::class.java), flags)
      s.commit(done.intentSender)
    }
  }

  private fun report(state: String, message: String) = activity.runOnUiThread {
    webView.evaluateJavascript("window.onHeroicUpdate?.(${JSONObject.quote(state)}, ${JSONObject.quote(message)})", null)
  }

  companion object {
    private const val RELEASE = "https://api.github.com/repos/a3ro-dev/heroic/releases/tags/android-nightly"
  }
}

/** Shows Android's install confirmation when the installer asks for it. */
class InstallResult : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1) != PackageInstaller.STATUS_PENDING_USER_ACTION) return
    @Suppress("DEPRECATION")
    val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
