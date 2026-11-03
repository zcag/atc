package io.github.zcag.atc

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.TypedValue
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.net.URL
import kotlin.concurrent.thread

/** Debug builds only: fake data for testing push and the widget on a device without a real server or push. Each
 *  of look, feed and push is JSON or a URL to fetch it from.
 *  adb shell am broadcast -n io.github.zcag.atc/.Fake --es server http://host:port --es look URL --es feed URL --es push URL */
class Fake : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        intent.getStringExtra("server")?.let { Prefs(c).server = it }
        val done = goAsync()
        thread {
            fun get(k: String) = intent.getStringExtra(k)?.let { if (it.startsWith("http")) URL(it).readText() else it }
            runCatching {
                get("look")?.let { Look.save(c, it); Live.render(c) }
                get("feed")?.let { Live.save(c, it) }
                get("push")?.let { Push.handle(c, it.toByteArray()) }
            }.onFailure { android.util.Log.e("atc-fake", "fake", it) }
            done.finish()
        }
    }
}

/** Debug builds only: hosts the widget at 2x2, 4x2 and 4x4 (Android's portrait cell sizes), the way a launcher would.
 *  adb shell appwidget grantbind --package io.github.zcag.atc --user 0, then start this activity (--es sizes 22,44 to pick). */
class Widgets : Activity() {
    private lateinit var host: AppWidgetHost

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        host = AppWidgetHost(this, 7)
        host.deleteHost()
        val m = AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, SessionsWidget::class.java)
        val dark = intent.getBooleanExtra("dark", Look.dark(this))
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
            setBackgroundColor(if (dark) 0xFF0E1116.toInt() else 0xFFE4E7EC.toInt())
        }
        val row = LinearLayout(this)
        col.addView(row)
        val sizes = mapOf("22" to (130 to 220), "42" to (276 to 220), "44" to (276 to 456))
        for ((w, h) in (intent.getStringExtra("sizes") ?: "22,42,44").split(",").mapNotNull { sizes[it] }) {
            val id = host.allocateAppWidgetId()
            if (!m.bindAppWidgetIdIfAllowed(id, provider)) {
                col.addView(TextView(this).apply { text = "grantbind first" })
                break
            }
            m.updateAppWidgetOptions(id, Bundle().apply {
                putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, w)
                putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, w)
                putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, h)
                putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, h)
            })
            val v = host.createView(this, id, m.getAppWidgetInfo(id))
            val lp = LinearLayout.LayoutParams(dp(w), dp(h)).apply { setMargins(0, 0, dp(16), dp(16)) }
            if (w < 200) row.addView(v, lp) else col.addView(v, lp)
        }
        setContentView(ScrollView(this).apply { addView(col) })
        Live.render(this)
    }

    override fun onStart() { super.onStart(); host.startListening() }
    override fun onStop() { super.onStop(); host.stopListening() }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
}
