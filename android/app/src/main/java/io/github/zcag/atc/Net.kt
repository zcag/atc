package io.github.zcag.atc

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

object Net {
    fun get(c: Context, url: String) = call(c, url) { it.inputStream.bufferedReader().readText() }

    fun download(c: Context, url: String, to: File) =
        call(c, url) { conn -> conn.inputStream.use { i -> to.outputStream().use { i.copyTo(it) } } }

    fun post(c: Context, url: String, body: JSONObject): Int {
        val conn = open(c, url)
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            CookieManager.getInstance().getCookie(url)?.let { conn.setRequestProperty("Cookie", it) }
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

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
        val fp = Prefs(c).pinFor(URL(url).host)
        if (this is HttpsURLConnection && fp != null) {
            sslSocketFactory = pinned(fp)
            hostnameVerifier = javax.net.ssl.HostnameVerifier { host, session ->
                HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session) ||
                    session.peerCertificates.firstOrNull()?.let { sha256(it.encoded) } == fp
            }
        }
    }

    private fun pinned(fp: String): SSLSocketFactory {
        val system = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            .apply { init(null as KeyStore?) }.trustManagers.filterIsInstance<X509TrustManager>().first()
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, type: String) = system.checkClientTrusted(chain, type)
            override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
            override fun checkServerTrusted(chain: Array<X509Certificate>, type: String) {
                try {
                    system.checkServerTrusted(chain, type)
                } catch (e: CertificateException) {
                    if (sha256(chain[0].encoded) != fp) throw e
                }
            }
        }
        return SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }.socketFactory
    }
}
