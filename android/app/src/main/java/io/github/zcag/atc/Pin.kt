package io.github.zcag.atc

import android.util.Base64
import java.io.ByteArrayInputStream
import java.security.cert.CertPathValidator
import java.security.cert.CertificateFactory
import java.security.cert.PKIXParameters
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.util.Date
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

object Pin {
    private const val PREFIX = "ca:"
    private val x509 get() = CertificateFactory.getInstance("X.509")

    fun encode(anchor: X509Certificate) = PREFIX + Base64.encodeToString(anchor.encoded, Base64.NO_WRAP)

    fun decode(pin: String?): X509Certificate? =
        pin?.removePrefix(PREFIX)?.takeIf { it != pin }?.let { runCatching { parse(Base64.decode(it, Base64.DEFAULT)) }.getOrNull() }

    fun parse(bytes: ByteArray) = x509.generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate

    fun parseAll(bytes: ByteArray) = x509.generateCertificates(ByteArrayInputStream(bytes)).map { it as X509Certificate }

    fun validates(chain: List<X509Certificate>, anchor: X509Certificate, at: Date = Date()): Boolean {
        val path = chain.takeWhile { !it.encoded.contentEquals(anchor.encoded) }
        if (path.isEmpty()) return chain.isNotEmpty() && runCatching { anchor.checkValidity(at) }.isSuccess
        return runCatching {
            val params = PKIXParameters(setOf(TrustAnchor(anchor, null))).apply { isRevocationEnabled = false; date = at }
            CertPathValidator.getInstance("PKIX").validate(x509.generateCertPath(path), params)
        }.isSuccess
    }

    fun trustManager(fallback: X509TrustManager?, accept: (List<X509Certificate>) -> Boolean) = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, type: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = fallback?.acceptedIssuers ?: emptyArray()
        override fun checkServerTrusted(chain: Array<X509Certificate>, type: String) {
            if (runCatching { fallback?.checkServerTrusted(chain, type) ?: error("no fallback") }.isSuccess) return
            if (!accept(chain.toList())) throw java.security.cert.CertificateException("certificate is not signed by the trusted authority")
        }
    }

    fun chainOf(host: String, port: Int): List<X509Certificate> {
        var seen = emptyList<X509Certificate>()
        val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager(null) { seen = it; true }), null) }
        (ctx.socketFactory.createSocket(host, port) as SSLSocket).use {
            it.soTimeout = 10_000
            it.startHandshake()
        }
        return seen
    }
}
