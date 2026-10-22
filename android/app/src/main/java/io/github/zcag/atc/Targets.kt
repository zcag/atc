package io.github.zcag.atc

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray

object Targets {
    const val CATEGORY = "io.github.zcag.atc.SESSION"
    private const val PREFIX = "s:"
    private val colors = intArrayOf(0xFF2F6FDB.toInt(), 0xFFB7791F.toInt(), 0xFF2E8B57.toInt(), 0xFF8E44AD.toInt(), 0xFFC0392B.toInt(), 0xFF16808A.toInt())

    fun sessionOf(shortcutId: String?) = shortcutId?.removePrefix(PREFIX)?.takeIf { it != shortcutId }

    fun parse(json: String) = runCatching {
        val arr = JSONArray(json)
        (0 until arr.length()).map { i -> arr.getJSONObject(i).run { getString("id").let { it to optString("title").ifBlank { it.take(8) } } } }
    }.getOrDefault(emptyList())

    fun update(c: Context, sessions: List<Pair<String, String>>) = runCatching {
        val list = sessions.take(ShortcutManagerCompat.getMaxShortcutCountPerActivity(c)).mapIndexed { i, (id, title) ->
            ShortcutInfoCompat.Builder(c, PREFIX + id)
                .setShortLabel(title.take(24))
                .setLongLabel(title.take(60))
                .setIcon(IconCompat.createWithAdaptiveBitmap(avatar(title)))
                .setIntent(Intent(c, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_PATH, "/#/s/$id"))
                .setCategories(setOf(CATEGORY))
                .setLongLived(true)
                .setRank(i)
                .build()
        }
        ShortcutManagerCompat.setDynamicShortcuts(c, list)
    }

    private fun avatar(title: String): Bitmap {
        val size = 216
        val b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(b)
        canvas.drawColor(colors[Math.floorMod(title.hashCode(), colors.size)])
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textSize = 84f; textAlign = Paint.Align.CENTER; isFakeBoldText = true }
        val letters = title.split(Regex("[\\s_-]+")).filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1).uppercase() }
        canvas.drawText(letters.ifEmpty { "?" }, size / 2f, size / 2f - (p.descent() + p.ascent()) / 2, p)
        return b
    }
}
