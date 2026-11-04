package io.github.zcag.atc

import android.webkit.JavascriptInterface

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
    @JavascriptInterface fun copyImage(url: String) { a.copyImage(url) }
    @JavascriptInterface fun call() = a.runOnUiThread {
        a.startActivity(android.content.Intent(a, CallActivity::class.java).setAction(CallActivity.DIAL))
    }
    @JavascriptInterface fun checklist() = a.runOnUiThread { a.startActivity(android.content.Intent(a, ChecklistActivity::class.java)) }
    @JavascriptInterface fun checkUpdate() = a.runOnUiThread { a.updater.check(manual = true) }
}
