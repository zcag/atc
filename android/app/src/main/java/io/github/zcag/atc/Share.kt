package io.github.zcag.atc

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.WebResourceResponse
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream

class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = intent
        Thread {
            val failed = runCatching { Shared.take(this, intent) }.exceptionOrNull()
            runOnUiThread {
                if (failed == null) startActivity(
                    Intent(this, MainActivity::class.java)
                        .putExtra(MainActivity.EXTRA_PATH, "/#/share?n=${System.currentTimeMillis()}" + (Targets.sessionOf(intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID))?.let { "&to=$it" } ?: ""))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                )
                else Toast.makeText(this, "atc could not read what was shared: ${failed.message}", Toast.LENGTH_LONG).show()
                finish()
            }
        }.start()
    }
}

object Shared {
    private const val MAX = 64L shl 20
    private const val PREFIX = "/__shared/"
    @Volatile private var payload: JSONObject? = null
    @Volatile private var files: List<Pair<File, String>> = emptyList()

    private fun dir(c: Context) = File(c.cacheDir, "shared")

    fun take(c: Context, intent: Intent) {
        val d = dir(c)
        d.deleteRecursively()
        d.mkdirs()
        @Suppress("DEPRECATION")
        val uris = when (intent.action) {
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            else -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        }
        val kept = mutableListOf<Pair<File, String>>()
        val list = JSONArray()
        var skipped = 0
        uris.forEachIndexed { i, uri ->
            val (name, size) = describe(c, uri, i)
            if (size > MAX) return@forEachIndexed run { skipped++ }
            val type = c.contentResolver.getType(uri) ?: intent.type ?: "application/octet-stream"
            val f = File(d, "$i")
            val copied = c.contentResolver.openInputStream(uri)?.use { input -> f.outputStream().use { input.copyTo(it) } } ?: return@forEachIndexed
            if (copied > MAX) return@forEachIndexed run { f.delete(); skipped++ }
            list.put(JSONObject().put("name", name).put("type", type).put("size", copied).put("url", "$PREFIX${kept.size}"))
            kept += f to type
        }
        var text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        if (skipped > 0) text = "$text\n($skipped file(s) over 64 MB were left out)".trim()
        files = kept
        payload = JSONObject()
            .put("text", text)
            .put("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty())
            .put("files", list)
    }

    private fun describe(c: Context, uri: Uri, i: Int): Pair<String, Long> {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "shared-$i"
        var size = -1L
        runCatching {
            c.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
                if (it.moveToFirst()) {
                    it.getString(0)?.let { n -> name = n }
                    if (!it.isNull(1)) size = it.getLong(1)
                }
            }
        }
        return name to size
    }

    fun json() = payload?.toString() ?: "null"

    fun clear(c: Context) {
        payload = null
        files = emptyList()
        dir(c).deleteRecursively()
    }

    fun serve(path: String?): WebResourceResponse? {
        val i = path?.removePrefix(PREFIX)?.takeIf { it != path }?.toIntOrNull() ?: return null
        val (f, type) = files.getOrNull(i) ?: return WebResourceResponse("text/plain", null, 404, "Not Found", null, null)
        return WebResourceResponse(type, null, FileInputStream(f))
    }
}
