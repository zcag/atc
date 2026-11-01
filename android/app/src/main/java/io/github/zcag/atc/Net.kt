package io.github.zcag.atc

import android.content.Context
import android.webkit.CookieManager
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

object Net {
    fun get(c: Context, url: String) = call(c, url) { it.inputStream.bufferedReader().readText() }

    fun bytes(c: Context, url: String) = call(c, url) { it.inputStream.readBytes() }

    fun download(c: Context, url: String, to: File) =
        call(c, url) { conn -> conn.inputStream.use { i -> to.outputStream().use { i.copyTo(it) } } }

    fun post(c: Context, url: String, body: JSONObject): Int {
        val conn = open(c, url)
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    fun webSocket(c: Context, url: String, listener: WebSocketListener): WebSocket {
        val client = OkHttpClient.Builder().pingInterval(5, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS).apply {
            Pin.decode(Prefs(c).pinFor(URL(url).host))?.let { anchor ->
                val tm = trustManager { Pin.validates(it, anchor) }
                sslSocketFactory(factory(tm), tm)
            }
        }.build()
        val req = Request.Builder().url(url)
        cookie(url)?.let { req.header("Cookie", it) }
        return client.newWebSocket(req.build(), listener)
    }

    private fun cookie(url: String) = runCatching { CookieManager.getInstance().getCookie(url) }.getOrNull()

    private fun <T> call(c: Context, url: String, read: (HttpURLConnection) -> T): T {
        val conn = open(c, url)
        try {
            if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode}")
            return read(conn)
        } finally {
            conn.disconnect()
        }
    }

    private fun open(c: Context, url: String) = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 10_000
        readTimeout = 30_000
        val anchor = Pin.decode(Prefs(c).pinFor(URL(url).host))
        if (this is HttpsURLConnection && anchor != null) sslSocketFactory = trusting { Pin.validates(it, anchor) }
        cookie(url)?.let { setRequestProperty("Cookie", it) }
    }

    fun caFor(server: String, chain: List<X509Certificate>): X509Certificate? = runCatching {
        val conn = URL("$server/app/ca.crt").openConnection() as HttpsURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        conn.sslSocketFactory = trusting { it.firstOrNull()?.encoded?.contentEquals(chain[0].encoded) == true }
        try {
            if (conn.responseCode != 200) return null
            Pin.parseAll(conn.inputStream.readBytes()).firstOrNull { Pin.validates(chain, it) }
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    private fun trusting(accept: (List<X509Certificate>) -> Boolean) = factory(trustManager(accept))

    private fun trustManager(accept: (List<X509Certificate>) -> Boolean): X509TrustManager {
        val system = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            .apply { init(null as KeyStore?) }.trustManagers.filterIsInstance<X509TrustManager>().first()
        return Pin.trustManager(system, accept)
    }

    private fun factory(tm: X509TrustManager): SSLSocketFactory =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }.socketFactory
}
