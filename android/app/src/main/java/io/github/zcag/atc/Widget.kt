package io.github.zcag.atc

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.service.quicksettings.TileService
import android.view.View
import android.widget.RemoteViews
import androidx.core.widget.RemoteViewsCompat
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class SessionsWidget : AppWidgetProvider() {
    override fun onUpdate(c: Context, m: AppWidgetManager, ids: IntArray) {
        Live.render(c)
        Live.refresh(c)
    }

    override fun onAppWidgetOptionsChanged(c: Context, m: AppWidgetManager, id: Int, options: Bundle) = Live.render(c)

    override fun onReceive(c: Context, intent: Intent) = when (intent.action) {
        REFRESH -> goAsync().let { done -> Live.refresh(c, force = true) { done.finish() } }
        TICK -> Live.render(c)
        else -> super.onReceive(c, intent)
    }

    override fun onDisabled(c: Context) = Live.render(c)

    companion object {
        const val REFRESH = "io.github.zcag.atc.REFRESH"
        const val TICK = "io.github.zcag.atc.TICK"
    }
}

object Live {
    private const val STALE = 10 * 60_000L
    private val fetching = AtomicBoolean()

    fun save(c: Context, json: String) {
        if (store(c, json)) changed(c)
    }

    private fun store(c: Context, json: String): Boolean {
        Feed.parse(json) ?: return false
        Look.fromFeed(c, json)
        val p = Prefs(c)
        p.feed = json
        p.feedAt = "${System.currentTimeMillis()}"
        p.feedError = null
        return true
    }

    fun refresh(c: Context, force: Boolean = false, done: () -> Unit = {}) {
        val p = Prefs(c)
        val server = p.server ?: return changed(c).also { done() }
        val age = System.currentTimeMillis() - (p.feedAt?.toLongOrNull() ?: 0)
        if ((!force && age < 60_000) || !fetching.compareAndSet(false, true)) return done()
        render(c)
        thread {
            try {
                if (!store(c, Net.get(c, "$server/api/widget"))) error("unexpected reply")
            } catch (e: Exception) {
                p.feedError = e.message ?: e.javaClass.simpleName
            } finally {
                fetching.set(false)
                changed(c)
                done()
            }
        }
    }

    fun changed(c: Context) {
        render(c)
        runCatching { TileService.requestListeningState(c, ComponentName(c, TalkTile::class.java)) }
    }

    fun assist(c: Context): Intent = Intent(c, MainActivity::class.java)
        .putExtra(MainActivity.EXTRA_ASSIST, true)
        .putExtra(MainActivity.EXTRA_PATH, "/#/assist")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    fun render(c: Context) {
        val m = AppWidgetManager.getInstance(c) ?: return
        val ids = m.getAppWidgetIds(ComponentName(c, SessionsWidget::class.java))
        ids.forEach { id -> m.updateAppWidget(id, views(c, id)) }
        tick(c, Feed.parse(Prefs(c).feed)?.takeIf { ids.isNotEmpty() })
    }

    private fun tick(c: Context, feed: Feed?) {
        val alarms = c.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(c, 6, Intent(c, SessionsWidget::class.java).setAction(SessionsWidget.TICK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val now = System.currentTimeMillis()
        val young = feed?.sessions?.any { it.since > 0 && now - it.since < 3_600_000 } ?: return alarms.cancel(pi)
        if (feed.sessions.isEmpty()) return alarms.cancel(pi)
        alarms.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + if (young) 60_000 else 600_000, pi)
    }

    private fun views(c: Context, widget: Int) = RemoteViews(c.packageName, R.layout.widget).apply {
        val p = Prefs(c)
        val now = System.currentTimeMillis()
        val feed = Feed.parse(p.feed)
        val error = p.feedError
        val stale = error != null && now - (p.feedAt?.toLongOrNull() ?: 0) > STALE
        val busy = fetching.get()
        val open = Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val home = activity(c, 1, open)
        val talk = activity(c, 2, assist(c))
        val retry = PendingIntent.getBroadcast(c, 3, Intent(c, SessionsWidget::class.java).setAction(SessionsWidget.REFRESH),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        setOnClickPendingIntent(R.id.head, home)
        setOnClickPendingIntent(R.id.mic, talk)
        setOnClickPendingIntent(R.id.refresh, retry)
        val size = AppWidgetManager.getInstance(c).getAppWidgetOptions(widget)
        val compact = size.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT) in 1..120
        val narrow = size.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH) in 1..279
        setViewVisibility(R.id.refresh, if (busy || p.server == null) View.INVISIBLE else View.VISIBLE)
        setViewVisibility(R.id.busy, if (busy) View.VISIBLE else View.GONE)
        setViewVisibility(R.id.refresh_box, if (narrow && !busy) View.GONE else View.VISIBLE)
        setViewVisibility(R.id.body, if (compact) View.GONE else View.VISIBLE)
        val pal = Look.palette(c)
        if (themed) {
            tint(android.R.id.background, "setBackgroundTintList", pal.widgetBg)
            tint(R.id.mic, "setBackgroundTintList", pal.work)
            tint(R.id.mic, "setImageTintList", pal.onWork)
            tint(R.id.refresh, "setImageTintList", pal.faint)
            tint(R.id.busy, "setIndeterminateTintList", pal.faint)
            listOf(R.id.name to pal.ink, R.id.summary to pal.dim, R.id.message_title to pal.ink, R.id.message_body to pal.dim)
                .forEach { (id, color) -> setTextColor(id, color) }
        }

        val message = when {
            p.server == null -> "Open atc to connect" to "Enter your server's address in the app."
            feed == null && error == "HTTP 401" -> "Sign in to atc" to "Open the app and log in."
            feed == null && error != null -> "Can't reach your server" to "Tap refresh to try again."
            feed != null && feed.sessions.isEmpty() -> "No active sessions" to "Tap the mic to start one."
            else -> null
        }
        setTextViewText(R.id.summary, when {
            p.server == null -> "Not connected"
            feed == null -> if (error != null && !busy) "Offline" else c.getString(R.string.widget_loading)
            stale -> "Offline · updated ${elapsed(now - (p.feedAt?.toLongOrNull() ?: 0))} ago"
            narrow -> feed.brief()
            else -> feed.summary()
        })
        setViewVisibility(R.id.message, if (message != null) View.VISIBLE else View.GONE)
        setViewVisibility(R.id.list, if (message == null && feed != null) View.VISIBLE else View.GONE)
        if (message != null) {
            setTextViewText(R.id.message_title, message.first)
            setTextViewText(R.id.message_body, message.second)
            setOnClickPendingIntent(R.id.message, when {
                p.server == null || feed == null && error == "HTTP 401" -> home
                feed == null -> retry
                else -> talk
            })
        }
        if (feed == null || message != null || compact) return@apply

        setPendingIntentTemplate(R.id.list, PendingIntent.getActivity(c, 4, open, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        val items = RemoteViewsCompat.RemoteCollectionItems.Builder().setHasStableIds(true).setViewTypeCount(1)
        feed.sessions.forEach { items.addItem(it.sid.hashCode().toLong(), row(c, it, now, feed.multiHost, live = !stale, pal)) }
        RemoteViewsCompat.setRemoteAdapter(c, this, widget, R.id.list, items.build())
    }

    private fun row(c: Context, r: Feed.Row, now: Long, multiHost: Boolean, live: Boolean, pal: Palette) = RemoteViews(c.packageName, R.layout.widget_row).apply {
        setTextViewText(R.id.title, r.title)
        if (themed) {
            setImageViewResource(R.id.edge, R.drawable.widget_edge)
            tint(R.id.edge, "setImageTintList", when (r.state) { Feed.NEEDS -> pal.needs; Feed.TURN -> pal.turn; else -> pal.work })
            tint(R.id.card, "setBackgroundTintList", pal.rowLine)
            tint(R.id.fill, "setBackgroundTintList", pal.strip)
            listOf(R.id.title to pal.ink, R.id.clock to pal.dim, R.id.detail to pal.dim, R.id.host to pal.faint)
                .forEach { (id, color) -> setTextColor(id, color) }
        } else setImageViewResource(R.id.edge, when (r.state) {
            Feed.NEEDS -> R.drawable.widget_edge_needs
            Feed.TURN -> R.drawable.widget_edge_turn
            else -> R.drawable.widget_edge_work
        })
        val ticking = live && r.state == Feed.WORK && r.since > 0
        setViewVisibility(R.id.clock, if (ticking) View.VISIBLE else View.GONE)
        setViewVisibility(R.id.detail, if (ticking) View.GONE else View.VISIBLE)
        if (ticking) setChronometer(R.id.clock, SystemClock.elapsedRealtime() - (now - r.since).coerceAtLeast(0), "${r.word} · %s", true)
        else setTextViewText(R.id.detail, r.detail(now))
        val host = r.host.takeIf { multiHost }
        setViewVisibility(R.id.host, if (host != null) View.VISIBLE else View.GONE)
        if (host != null) setTextViewText(R.id.host, " · $host")
        setOnClickFillInIntent(R.id.card, Intent().putExtra(MainActivity.EXTRA_PATH, "/#/s/${r.key}"))
    }

    private val themed get() = Build.VERSION.SDK_INT >= 31

    private fun RemoteViews.tint(id: Int, method: String, color: Int) {
        if (Build.VERSION.SDK_INT >= 31) setColorStateList(id, method, ColorStateList.valueOf(color))
    }

    private fun activity(c: Context, code: Int, i: Intent) =
        PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
}
