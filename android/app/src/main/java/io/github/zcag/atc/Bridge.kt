package io.github.zcag.atc

import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest

class Bridge(private val a: MainActivity) {
    @JavascriptInterface fun version() = BuildConfig.VERSION_CODE
    @JavascriptInterface fun versionName() = BuildConfig.VERSION_NAME
    @JavascriptInterface fun pushStatus() = Push.status(a)
    @JavascriptInterface fun shared() = Shared.json()
    @JavascriptInterface fun clearShared() = Shared.clear(a)
    @JavascriptInterface fun setTargets(json: String) { Targets.update(a, Targets.parse(json)) }
    @JavascriptInterface fun setSessions(json: String) {
        val feed = Feed.parse(json) ?: return
        Live.save(a, json)
        Targets.update(a, feed.targets().take(8))
    }
    @JavascriptInterface fun setLook(json: String) {
        Look.save(a, json)
        a.runOnUiThread { a.paint() }
        Live.render(a)
    }
    @JavascriptInterface fun openExternal(url: String) { a.openOutside(url) }
    @JavascriptInterface fun openInBrowser(url: String) { a.openInBrowser(url) }
    @JavascriptInterface fun copyImage(url: String) { a.copyImage(url) }
    @JavascriptInterface fun call() = a.runOnUiThread {
        a.startActivity(android.content.Intent(a, CallActivity::class.java).setAction(CallActivity.DIAL))
    }
    @JavascriptInterface fun checklist() = a.runOnUiThread { a.startActivity(android.content.Intent(a, ChecklistActivity::class.java)) }
    @JavascriptInterface fun checkUpdate() = a.runOnUiThread { a.updater.check(manual = true) }
}

/**
 * The one object native code puts in a WebView, and addJavascriptInterface puts it in every frame. It does nothing
 * without [secret], which only [startScript] holds and only frames of the server's origin run.
 */
class Gate(private val target: Any, private val secret: String = randomHex()) {
    private val methods = target.javaClass.methods.filter { it.isAnnotationPresent(JavascriptInterface::class.java) }.associateBy { it.name }

    @JavascriptInterface fun invoke(secret: String, name: String, args: String): String? {
        if (!MessageDigest.isEqual(secret.toByteArray(), this.secret.toByteArray())) return null
        val m = methods[name] ?: return null
        return runCatching {
            val given = JSONArray(args)
            JSONArray().put(m.invoke(target, *Array(m.parameterCount) { given.get(it).toString() })).toString()
        }.onFailure { Log.w("atc", "bridge $name failed", it) }.getOrNull()
    }

    /** Defines window.AtcApp, synchronous like the plain interface it replaces. The origin check repeats the WebView's own
     *  rule, so a WebView that gets that rule wrong still doesn't hand out the secret. */
    fun startScript(origins: Set<String>) = """(() => {
        if (!${JSONArray(origins)}.includes(self.origin)) return;
        const gate = self.$NAME, key = ${JSONObject.quote(secret)}, app = {};
        for (const name of ${JSONArray(methods.keys)})
            app[name] = (...args) => { const r = gate.invoke(key, name, JSON.stringify(args)); return r == null ? undefined : JSON.parse(r)[0]; };
        Object.defineProperty(self, "AtcApp", { value: Object.freeze(app) });
    })();"""

    companion object {
        const val NAME = "AtcGate"
    }
}

/** Who may hold the bridge: the server's origin, and on a plain http address the https one it may redirect to. */
fun bridgeOrigins(server: String): Set<String> {
    val u = runCatching { URI(server) }.getOrNull() ?: return emptySet()
    val host = u.host?.lowercase() ?: return emptySet()
    val scheme = u.scheme.lowercase()
    val port = u.port.takeIf { it > 0 && it != (if (scheme == "https") 443 else 80) }?.let { ":$it" }.orEmpty()
    return setOfNotNull("$scheme://$host$port", "https://$host".takeIf { scheme == "http" })
}
