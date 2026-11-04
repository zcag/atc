package io.github.zcag.atc

import android.content.Context
import org.json.JSONObject
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.security.cert.X509Certificate

/** What a QR code or an atc://pair link carries: where the server is, a one-time code, and the
 *  SHA-256 of the certificate to pin when the server's is one the phone can't check by itself. */
data class Pairing(val url: String, val code: String, val ca: String?) {
    val host: String get() = URI(url).host

    companion object {
        private val CODE = Regex("^[A-Za-z0-9_-]{8,128}$")
        private val CA = Regex("^[0-9a-f]{64}$")

        fun parse(text: String): Pairing? {
            val q = query(text, "pair") ?: return null
            val url = q["url"]?.let(::serverUrl)?.takeIf(::plainAddress) ?: return null
            val code = q["code"]?.takeIf { CODE.matches(it) } ?: return null
            val ca = q["ca"]?.lowercase()?.ifEmpty { null }
            if (ca != null && !CA.matches(ca)) return null
            return Pairing(url, code, ca)
        }

        /** The page an atc://open link names on the server this phone uses; "/" when it names none. */
        fun openPath(text: String): String? {
            val path = (query(text, "open") ?: return null)["path"] ?: return "/"
            return path.takeIf(::isLocalPath)
        }

        /** A path on the server, so joining it to the server's address can't land on another host. */
        fun isLocalPath(path: String) = path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")

        private fun plainAddress(url: String) = runCatching {
            val u = URI(url)
            u.host != null && u.userInfo == null && u.rawQuery == null && u.rawFragment == null
        }.getOrDefault(false)

        private fun query(text: String, host: String): Map<String, String>? = runCatching {
            val u = URI(text.trim())
            if (u.scheme != "atc" || u.host != host) return null
            val pairs = u.rawQuery.orEmpty().split("&").filter { "=" in it }.map {
                it.substringBefore("=") to URLDecoder.decode(it.substringAfter("="), "UTF-8")
            }
            pairs.toMap().takeIf { it.size == pairs.size }
        }.getOrNull()
    }
}

class CertificateMismatch(val host: String, val want: String, val got: String?) : Exception("$host: certificate mismatch")

class Claimed(val token: String, val pin: String?)

object Pairer {
    /** Pins first, so the code never reaches a server that fails the fingerprint. Saves nothing: the caller adopts the result. */
    fun claim(c: Context, p: Pairing, name: String): Claimed {
        val anchor = if (p.ca != null && p.url.startsWith("https://")) anchorFor(c, p, p.ca) else null
        val (code, said) = Net.send(c, "${p.url}/api/pair/claim", JSONObject().put("code", p.code).put("name", name), anchor)
        if (code !in 200..299) error(said.ifEmpty { "HTTP $code" })
        return Claimed(JSONObject(said).getString("token"), anchor?.let { "${p.host} ${Pin.encode(it)}" })
    }

    private fun anchorFor(c: Context, p: Pairing, ca: String): X509Certificate {
        val u = URL(p.url)
        val chain = Pin.chainOf(u.host, if (u.port > 0) u.port else 443)
        return (chain + Net.casAt(p.url, chain)).firstOrNull { sha256(it.encoded) == ca && Pin.validates(chain, it) }
            ?: throw CertificateMismatch(u.host, ca, chain.lastOrNull()?.let { sha256(it.encoded) })
    }
}
