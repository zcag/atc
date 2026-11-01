package io.github.zcag.atc

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.File

/** A character the web page draws (web/persona.js, the same code browser calls run), in a transparent WebView.
 *  The page never goes to the network itself: it is loaded from a made-up origin and every request is answered
 *  here, the character's files from its folder on the phone and the page and script from atc through Net, so the
 *  server's pinned certificate applies. The page reads both voices' loudness from the bridge on every frame and
 *  gets the call's state when it changes. */
@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
class WebPersona(c: Context, private val dir: File, private val server: String) : WebView(c), Persona {
    override val view get() = this
    private var go: (() -> Unit)? = null
    private var ready = false
    private var state = "listening"

    init {
        setBackgroundColor(Color.TRANSPARENT)
        settings.javaScriptEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        addJavascriptInterface(Bridge(), "AtcPersona")
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val path = request.url.path.orEmpty()
                return runCatching {
                    require(".." !in path)
                    val data = if (path.startsWith("/p/")) File(dir, path.removePrefix("/p/")).readBytes() else Net.bytes(context, server + path)
                    WebResourceResponse(type(path), null, data.inputStream())
                }.getOrElse { WebResourceResponse("text/plain", null, 404, "Not found", null, null) }
            }

            override fun onPageFinished(view: WebView, url: String) = face(Calls.Face(state))
        }
        loadUrl("https://persona.atc/persona.html")
    }

    override fun face(f: Calls.Face) {
        state = f.state
        evaluateJavascript("window.persona?.state(${JSONObject.quote(state)})", null)
    }

    override fun drawn(go: () -> Unit): Boolean {
        if (ready) go() else this.go = go
        return true
    }

    private inner class Bridge {
        @JavascriptInterface
        fun levels(): String = Calls.speech().let { "${Calls.levels().first},${it[0]},${it[1]},${it[2]}" }

        @JavascriptInterface
        fun drawn() = post {
            ready = true
            go?.invoke()
            go = null
        }
    }

    private fun type(path: String) = when (path.substringAfterLast('.')) {
        "html" -> "text/html"
        "js" -> "text/javascript"
        "json" -> "application/json"
        "png" -> "image/png"
        "jpg" -> "image/jpeg"
        "mp4" -> "video/mp4"
        else -> "application/octet-stream"
    }
}
