package io.github.zcag.atc

import org.json.JSONObject
import java.time.OffsetDateTime

class Feed(val at: Long, val sessions: List<Row>) {
    class Row(val id: String?, val sid: String, val title: String, val state: String, val host: String?, val pinned: Boolean, val since: Long) {
        val key get() = id ?: sid
        val word get() = WORDS[state] ?: state
        fun detail(now: Long) = if (since > 0) "$word · ${elapsed(now - since)}" else word
    }

    val multiHost get() = sessions.mapNotNull { it.host }.distinct().size > 1

    fun count(state: String) = sessions.count { it.state == state }

    fun summary() = listOf(NEEDS, TURN, WORK).mapNotNull { s -> count(s).takeIf { it > 0 }?.let { tally(it, s) } }
        .joinToString(" · ").ifEmpty { "All quiet" }

    fun brief(): String {
        val first = listOf(NEEDS, TURN, WORK).firstOrNull { count(it) > 0 } ?: return "All quiet"
        val rest = sessions.size - count(first)
        return tally(count(first), first) + if (rest > 0) " · $rest more" else ""
    }

    fun urgent() = count(NEEDS).takeIf { it > 0 }?.let { tally(it, NEEDS) }

    fun targets() = sessions.filter { it.id != null }.map { it.sid to it.title }

    companion object {
        const val NEEDS = "needs-you"
        const val TURN = "your-turn"
        const val WORK = "working"
        private val WORDS = mapOf(NEEDS to "needs you", TURN to "your turn", WORK to "working")

        private fun tally(n: Int, state: String) = if (state == NEEDS) "$n ${if (n == 1) "needs" else "need"} you" else "$n ${WORDS[state]}"

        fun parse(json: String?): Feed? = runCatching {
            val o = JSONObject(json!!)
            if (o.optString("type") != "sessions") return null
            val arr = o.getJSONArray("sessions")
            Feed(time(o.optString("at")), (0 until arr.length()).map { i ->
                arr.getJSONObject(i).run {
                    val sid = getString("sid")
                    Row(optString("id").ifEmpty { null }, sid, optString("title").ifBlank { sid.take(8) }, getString("state"),
                        optString("host").ifEmpty { null }, optBoolean("pinned"), time(optString("since")))
                }
            })
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
