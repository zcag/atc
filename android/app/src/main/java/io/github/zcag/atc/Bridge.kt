package io.github.zcag.atc

import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.view.WindowManager
import android.webkit.JavascriptInterface
import java.util.Locale

class Bridge(private val a: MainActivity) : TextToSpeech.OnInitListener {
    private val tts = TextToSpeech(a, this)
    private var ready: Boolean? = null
    private var pending: Pair<String, String>? = null
    @Volatile private var gen = 0
    @Volatile private var speaking = false

    @Synchronized
    override fun onInit(status: Int) {
        ready = status == TextToSpeech.SUCCESS
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String) {}
            override fun onDone(id: String) { if (id == "$gen-end") done() }
            @Suppress("OVERRIDE_DEPRECATION")
            override fun onError(id: String) { if (id.startsWith("$gen-")) done() }
        })
        pending?.let { (text, lang) -> pending = null; speak(text, lang) }
    }

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
    @JavascriptInterface fun openExternal(url: String) { a.openOutside(url) }
    @JavascriptInterface fun copyImage(url: String) { a.copyImage(url) }
    @JavascriptInterface fun checkUpdate() = a.runOnUiThread { a.updater.check(manual = true) }

    @JavascriptInterface
    fun keepScreenOn(on: Boolean) = a.runOnUiThread {
        if (on) a.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else a.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    @JavascriptInterface
    @Synchronized
    fun speak(text: String, lang: String) {
        speaking = true
        when (ready) {
            null -> pending = text to lang
            false -> done()
            true -> {
                val id = ++gen
                val parts = sentences(text).ifEmpty { return done() }
                pickVoice(Locale.forLanguageTag(lang))
                parts.forEachIndexed { i, s ->
                    val mode = if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                    tts.speak(s, mode, null, if (i == parts.lastIndex) "$id-end" else "$id-$i")
                }
            }
        }
    }

    @JavascriptInterface
    @Synchronized
    fun stopSpeaking() {
        gen++
        pending = null
        tts.stop()
        done()
    }

    fun shutdown() = tts.shutdown()

    private fun pickVoice(locale: Locale) {
        tts.language = locale
        val default = tts.defaultVoice
        if (default != null && default.locale.language == locale.language) {
            tts.voice = default
            return
        }
        tts.voices.orEmpty()
            .filter { it.locale.language == locale.language && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
            .maxWithOrNull(compareBy<Voice>({ it.quality }, { it.locale.country == locale.country }))
            ?.let { tts.voice = it }
    }


    private fun done() {
        if (!speaking) return
        speaking = false
        a.runOnUiThread { a.js("window.atcSpeechDone && window.atcSpeechDone()") }
    }
}
