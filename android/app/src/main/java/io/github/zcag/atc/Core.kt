package io.github.zcag.atc

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

fun randomHex() = ByteArray(32).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }

/** Which shared file this path names, given the unguessable [base] of the current share. */
fun sharedIndex(path: String, base: String?) = base?.let { path.removePrefix(it).takeIf { rest -> rest != path }?.toIntOrNull() }

fun pretty(hex: String) = hex.uppercase().chunked(2).joinToString(":")

fun serverUrl(input: String): String? =
    input.trim().trimEnd('/').takeIf { Regex("^https?://[^/\\s?#]+(/\\S*)?$").matches(it) }

class Release(val versionCode: Int, val versionName: String, val apk: String, val sha256: String) {
    fun newerThan(own: Int) = versionCode > own
    val localApk get() = apk.takeIf(Pairing::isLocalPath)

    companion object {
        fun parse(json: String) = JSONObject(json).run {
            val code = getInt("versionCode")
            Release(code, optString("versionName", "$code"), optString("apk", "/app/atc.apk"), getString("sha256").lowercase())
        }
    }
}

/** Why an update must not be offered for install, or null when it is this app from the same signer. */
fun apkProblem(ownPackage: String, ownSigners: Set<String>, apkPackage: String?, apkSigners: Set<String>) = when {
    apkPackage != ownPackage -> "It is a different app (${apkPackage ?: "unreadable"}), not $ownPackage."
    apkSigners.isEmpty() || apkSigners != ownSigners -> "It is not signed by the key this app was installed with."
    else -> null
}

class Ring(val reason: String, val at: Long) {
    fun fresh(now: Long) = now - at < 60

    companion object {
        fun parse(text: String) = runCatching { JSONObject(text).optJSONObject("ring") }.getOrNull()
            ?.let { Ring(it.optString("reason"), it.optLong("at")) }
    }
}

class Note(
    val title: String, val body: String, val tag: String, val url: String,
    val session: String = "", val replies: List<String> = emptyList(), val open: Boolean = false,
    val bay: String = "", val ask: Ask? = null, val raw: String = "",
) {
    val id get() = tag.hashCode()

    companion object {
        fun parse(bytes: ByteArray) = runCatching {
            val raw = String(bytes)
            JSONObject(raw).run {
                val url = optString("url").takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/"
                val session = optString("session").takeIf { Regex("^[A-Za-z0-9_-]{1,64}$").matches(it) } ?: ""
                val replies = optJSONArray("replies")?.let { a -> List(a.length()) { a.optString(it).trim() } }.orEmpty().filter { it.isNotEmpty() }
                Note(optString("title", "atc"), optString("body"), optString("tag"), url, session, if (session.isEmpty()) emptyList() else replies,
                    optBoolean("open"), optString("bay"), Ask.parse(optJSONObject("ask")), raw)
            }
        }.getOrNull()
    }
}

/** One tap's answer to an ask: what the button says, its number, and the body the answer API takes. */
class Choice(val n: String, val label: String, val body: String, val unlock: Boolean = false, val open: Boolean = false) {
    val button get() = if (n.isEmpty()) label else "$n $label"
}

class Ask(
    val sid: String, val id: String, val key: String, val host: String,
    val text: String, val tool: String, val cmd: String, val options: List<String>,
) {
    val perm get() = tool.isNotEmpty()

    fun says() = when {
        tool == "Bash" -> "Wants to run $cmd"
        perm -> if (cmd.isEmpty()) "Wants to use $tool" else "Wants to use $tool: $cmd"
        else -> text
    }

    /** A permission is 1 Allow once (behind the unlock), 3 Deny and Open, never Always; a question its options in
     *  order, at most [max] buttons in all, with Open last when some are left out. */
    fun choices(max: Int = 3): List<Choice> {
        val open = Choice("", "Open", "", open = true)
        if (perm) return listOf(Choice("1", "Allow once", """{"reply":"once"}""", unlock = true), Choice("3", "Deny", """{"reject":true}"""), open).take(max)
        val all = options.mapIndexed { i, o -> Choice("${i + 1}", o, JSONObject().put("answers", JSONArray().put(JSONArray().put(o))).toString()) }
        return if (all.isNotEmpty() && all.size <= max) all else all.take(max - 1) + open
    }

    fun url(server: String, via: String) = "$server/api/sessions/${enc(sid)}/asks/${enc(id)}?via=$via&key=${enc(key)}" +
        (if (host.isEmpty()) "" else "&host=${enc(host)}")

    fun json(): String = JSONObject().put("sid", sid).put("id", id).put("key", key).put("host", host).put("text", text)
        .put("tool", tool).put("cmd", cmd).put("options", JSONArray(options)).toString()

    companion object {
        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

        fun parse(o: JSONObject?): Ask? = o?.run {
            val sid = optString("sid")
            val id = optString("id")
            if (sid.isEmpty() || id.isEmpty()) return null
            val opts = optJSONArray("options")?.let { a -> List(a.length()) { a.optString(it) } }.orEmpty().filter { it.isNotBlank() }
            Ask(sid, id, optString("key"), optString("host"), optString("text"), optString("tool"), optString("cmd"), opts)
        }

        fun parse(json: String?): Ask? = runCatching { parse(JSONObject(json!!)) }.getOrNull()
    }
}

private val outwardWords = Regex("\\b(merge|publish|send|push|deploy)", RegexOption.IGNORE_CASE)

/** A reply that acts outside the session's own work: from a lock screen it asks for the unlock first. */
fun outward(text: String) = outwardWords.containsMatchIn(text)
