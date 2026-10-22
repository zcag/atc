package io.github.zcag.atc

import org.json.JSONObject
import java.security.MessageDigest

enum class Trust { YES, ASK, NO }

fun trust(pinned: String?, presented: String) = when (pinned) {
    null -> Trust.ASK
    presented -> Trust.YES
    else -> Trust.NO
}

fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

fun pretty(hex: String) = hex.uppercase().chunked(2).joinToString(":")

fun serverUrl(input: String): String? =
    input.trim().trimEnd('/').takeIf { Regex("^https?://[^/\\s?#]+(/\\S*)?$").matches(it) }

fun sentences(text: String) =
    text.split(Regex("(?<=[.!?…])\\s+|\\n+")).map { it.trim() }.filter { it.isNotEmpty() }

class Release(val versionCode: Int, val versionName: String, val apk: String, val sha256: String) {
    fun newerThan(own: Int) = versionCode > own

    companion object {
        fun parse(json: String) = JSONObject(json).run {
            val code = getInt("versionCode")
            Release(code, optString("versionName", "$code"), optString("apk", "/app/atc.apk"), getString("sha256").lowercase())
        }
    }
}

class Note(val title: String, val body: String, val tag: String, val url: String) {
    val id get() = tag.hashCode()

    companion object {
        fun parse(bytes: ByteArray) = runCatching {
            JSONObject(String(bytes)).run {
                val url = optString("url").takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/"
                Note(optString("title", "atc"), optString("body"), optString("tag"), url)
            }
        }.getOrNull()
    }
}
