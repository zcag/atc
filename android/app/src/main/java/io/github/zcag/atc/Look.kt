package io.github.zcag.atc

import android.content.Context
import android.graphics.Color
import androidx.core.graphics.ColorUtils
import org.json.JSONObject

class Palette(
    val dark: Boolean, val board: Int, val strip: Int, val line: Int,
    val ink: Int, val dim: Int, val faint: Int, val needs: Int, val turn: Int, val work: Int,
) {
    val widgetBg get() = if (dark) board else ColorUtils.blendARGB(board, strip, .45f)
    val rowLine get() = if (dark) line else ColorUtils.blendARGB(line, strip, .4f)
    val onWork get() = if (ColorUtils.calculateLuminance(work) > .4) 0xFF0B1220.toInt() else Color.WHITE
}

object Look {
    fun save(c: Context, json: String) {
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return
        val p = Prefs(c)
        o.optJSONObject("look")?.let { p.look = it.toString() }
        o.optJSONObject("palettes")?.let { p.palettes = it.toString() }
    }

    fun fromFeed(c: Context, json: String) {
        runCatching { JSONObject(json).optJSONObject("look") }.getOrNull()?.let { Prefs(c).look = it.toString() }
    }

    private fun look(c: Context) = runCatching { JSONObject(Prefs(c).look!!) }.getOrDefault(JSONObject())

    fun dark(c: Context) = when (look(c).optString("scheme")) {
        "dark" -> true
        "light" -> false
        else -> c.resources.configuration.isNightModeActive
    }

    fun palette(c: Context): Palette {
        val dark = dark(c)
        val theme = look(c).optString("theme").ifEmpty { "atc" }
        val o = runCatching { JSONObject(Prefs(c).palettes!!).getJSONObject(theme).getJSONObject(if (dark) "dark" else "light") }.getOrNull()
        fun color(k: String, fallback: Int) = o?.optString(k)?.let { runCatching { Color.parseColor(it) }.getOrNull() } ?: c.getColor(fallback)
        return Palette(
            dark, color("board", R.color.board), color("strip", R.color.w_row), color("line", R.color.w_row_line),
            color("ink", R.color.w_ink), color("dim", R.color.w_dim), color("faint", R.color.w_faint),
            color("needs", R.color.needs), color("turn", R.color.turn), color("work", R.color.work),
        )
    }
}
