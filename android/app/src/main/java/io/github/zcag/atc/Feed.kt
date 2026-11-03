package io.github.zcag.atc

import org.json.JSONObject
import java.time.OffsetDateTime

class Feed(val at: Long, val sessions: List<Row>, val said: Said? = null) {
    class Said(val text: String, val at: Long)

    class Row(
        val id: String?, val sid: String, val title: String, val state: String, val host: String?, val pinned: Boolean, val since: Long,
        val bay: String = "", val summary: String = "", val ask: Ask? = null,
    ) {
        val key get() = id ?: sid
    }

    fun count(state: String) = sessions.count { it.state == state }

    fun urgent() = count(NEEDS).takeIf { it > 0 }?.let { "$it ${if (it == 1) "needs" else "need"} you" }

    fun targets() = sessions.filter { it.id != null }.map { it.sid to it.title }

    companion object {
        const val NEEDS = "needs-you"
        const val TURN = "your-turn"
        const val WORK = "working"

        fun parse(json: String?): Feed? = runCatching {
            val o = JSONObject(json!!)
            if (o.optString("type") != "sessions") return null
            val arr = o.getJSONArray("sessions")
            val said = o.optJSONObject("assistant")?.let { a -> a.optString("text").takeIf { it.isNotBlank() }?.let { Said(it, time(a.optString("at"))) } }
            Feed(time(o.optString("at")), (0 until arr.length()).map { i ->
                arr.getJSONObject(i).run {
                    val sid = getString("sid")
                    Row(optString("id").ifEmpty { null }, sid, optString("title").ifBlank { sid.take(8) }, getString("state"),
                        optString("host").ifEmpty { null }, optBoolean("pinned"), time(optString("since")),
                        optString("bay"), optString("summary"), Ask.parse(optJSONObject("ask")))
                }
            }, said)
        }.getOrNull()

        private fun time(s: String) = runCatching { OffsetDateTime.parse(s).toInstant().toEpochMilli() }.getOrDefault(0L)
    }
}

fun elapsed(ms: Long): String {
    val m = ms / 60_000
    return when {
        m < 1 -> "now"
        m < 60 -> "${m}m"
        m < 48 * 60 -> "${m / 60}h"
        else -> "${m / 1440}d"
    }
}
