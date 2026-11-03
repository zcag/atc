package io.github.zcag.atc

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.service.quicksettings.TileService
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.view.View
import android.widget.RemoteViews
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

    private enum class Size { S22, S42, S44 }

    private fun size(c: Context, widget: Int): Size {
        val o = AppWidgetManager.getInstance(c).getAppWidgetOptions(widget)
        val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
        val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
        return when {
            w in 1..199 -> Size.S22
            h in 1..299 -> Size.S42
            else -> Size.S44
        }
    }

    /** The widget per widget.html: 2x2 counts and the first ask, 4x2 the first ask answered in one tap, 4x4 two asks,
     *  what is working, and the assistant with Talk. Painted from the palette the web hands over. */
    private fun views(c: Context, widget: Int) = RemoteViews(c.packageName, R.layout.widget).apply {
        val p = Prefs(c)
        val now = System.currentTimeMillis()
        val feed = Feed.parse(p.feed)
        val error = p.feedError
        val stale = error != null && now - (p.feedAt?.toLongOrNull() ?: 0) > STALE
        val home = PendingIntent.getActivity(c, 1, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val board = activity(c, "/")
        val talk = PendingIntent.getActivity(c, 2, assist(c), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val retry = PendingIntent.getBroadcast(c, 3, Intent(c, SessionsWidget::class.java).setAction(SessionsWidget.REFRESH),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val size = size(c, widget)
        val pal = Look.palette(c)
        setOnClickPendingIntent(R.id.head, home)
        setOnClickPendingIntent(R.id.more, board)
        setOnClickPendingIntent(R.id.talk, talk)
        if (themed) {
            tint(android.R.id.background, "setBackgroundTintList", pal.board)
            listOf(R.id.big_rule, R.id.big_rule2, R.id.wk_rule, R.id.as_rule).forEach { tint(it, "setImageTintList", pal.line) }
            listOf(R.id.h_work_bar, R.id.big_work_bar, R.id.wk_bar).forEach { tint(it, "setImageTintList", pal.work) }
            tint(R.id.talk, "setBackgroundTintList", pal.ink)
            listOf(R.id.name to pal.ink, R.id.h_work to pal.work, R.id.more to pal.dim, R.id.time to pal.faint, R.id.big_n to pal.ink,
                R.id.big_lbl to pal.dim, R.id.big_turn to pal.dim, R.id.big_work to pal.dim, R.id.big_first_t to pal.ink, R.id.big_first_d to pal.faint,
                R.id.clear to pal.dim, R.id.wk_text to pal.dim, R.id.said to pal.ink, R.id.talk to pal.board,
                R.id.message_title to pal.ink, R.id.message_body to pal.dim).forEach { (id, color) -> setTextColor(id, color) }
            block(R.id.h_needs, pal, needs = true)
            block(R.id.h_turn, pal, needs = false)
            block(R.id.big_sb, pal, needs = true)
            block(R.id.big_turn_n, pal, needs = false)
        }

        val message = when {
            p.server == null -> "Open atc to connect" to "Enter your server's address in the app."
            feed == null && error == "HTTP 401" -> "Sign in to atc" to "Open the app and log in."
            feed == null && error != null -> "Can't reach your server" to "Tap to try again."
            feed == null -> c.getString(R.string.widget_loading) to ""
            else -> null
        }
        val asks = feed?.sessions.orEmpty().filter { it.state == Feed.NEEDS }
            .filter { r -> r.ask?.let { Asked.get(it)?.status } != Asked.GONE }
        val waiting = asks.count { r -> r.ask?.let { Asked.get(it)?.status } != Asked.SENT }
        val turn = feed?.count(Feed.TURN) ?: 0
        val working = feed?.sessions.orEmpty().filter { it.state == Feed.WORK }
        val shown = when (size) { Size.S22 -> 0; Size.S42 -> 1; Size.S44 -> 2 }

        count(R.id.h_needs, waiting.takeIf { it > 0 })
        count(R.id.h_turn, turn.takeIf { it > 0 && size != Size.S22 })
        setViewVisibility(R.id.h_work_bar, if (working.isNotEmpty() && size != Size.S22) View.VISIBLE else View.GONE)
        count(R.id.h_work, working.size.takeIf { it > 0 && size != Size.S22 })
        val more = asks.size - shown
        count(R.id.more, more.takeIf { it > 0 && size != Size.S22 })
        setTextViewText(R.id.more, "+$more more")
        setTextViewText(R.id.time, when {
            feed == null -> ""
            stale -> "offline ${clock(p.feedAt?.toLongOrNull() ?: 0)}"
            else -> clock(feed.at.takeIf { it > 0 } ?: (p.feedAt?.toLongOrNull() ?: now))
        })

        listOf(R.id.big, R.id.asks, R.id.clear, R.id.wk, R.id.gap, R.id.said_row, R.id.message).forEach { setViewVisibility(it, View.GONE) }
        if (message != null) {
            setViewVisibility(R.id.message, View.VISIBLE)
            setTextViewText(R.id.message_title, message.first)
            setTextViewText(R.id.message_body, message.second)
            setOnClickPendingIntent(R.id.message, if (p.server == null || error == "HTTP 401") home else retry)
            return@apply
        }
        feed!!
        if (size == Size.S22) {
            setViewVisibility(R.id.big, View.VISIBLE)
            setViewVisibility(R.id.big_sb, if (waiting > 0) View.VISIBLE else View.GONE)
            setTextViewText(R.id.big_n, "$waiting")
            if (themed) setTextColor(R.id.big_n, if (waiting > 0) pal.ink else pal.faint)
            setTextViewText(R.id.big_lbl, if (waiting == 1) "needs you" else "need you")
            setTextViewText(R.id.big_turn_n, "$turn")
            setTextViewText(R.id.big_work, "${working.size} working")
            val first = asks.firstOrNull { r -> r.ask?.let { Asked.get(it)?.status } != Asked.SENT }
            setViewVisibility(R.id.big_first, if (first != null) View.VISIBLE else View.GONE)
            if (first != null) {
                setTextViewText(R.id.big_first_t, first.title)
                setTextViewText(R.id.big_first_d, listOf(first.bay, ago(now, first.since)).filter { it.isNotEmpty() }.joinToString(", "))
                setOnClickPendingIntent(R.id.big_first, activity(c, "/#/s/${first.key}"))
            }
            setOnClickPendingIntent(R.id.big, home)
            return@apply
        }

        removeAllViews(R.id.asks)
        if (asks.isEmpty()) setViewVisibility(R.id.clear, View.VISIBLE)
        else {
            setViewVisibility(R.id.asks, View.VISIBLE)
            asks.take(shown).forEachIndexed { i, r -> addView(R.id.asks, ask(c, r, i > 0, now, pal)) }
        }
        setViewVisibility(R.id.gap, View.VISIBLE)
        if (size != Size.S44) return@apply

        if (working.isNotEmpty()) {
            setViewVisibility(R.id.wk, View.VISIBLE)
            setTextViewText(R.id.wk_text, SpannableStringBuilder().bold("${working.size} working", pal.ink, themed).append("  ")
                .append(working.take(3).joinToString(", ") { it.title }))
            setOnClickPendingIntent(R.id.wk, home)
        }
        setViewVisibility(R.id.said_row, View.VISIBLE)
        val said = feed.said
        val who = "assistant" + if (said != null && said.at > 0) "  ${ago(now, said.at)}" else ""
        setTextViewText(R.id.said, SpannableStringBuilder()
            .append(who, TypefaceSpan("monospace"), 0).also { b -> b.setSpan(RelativeSizeSpan(.85f), 0, who.length, 0); if (themed) b.setSpan(ForegroundColorSpan(pal.dim), 0, who.length, 0) }
            .append("\n")
            .append(said?.text ?: "Talk to it from here.", TypefaceSpan("serif"), 0))
        setOnClickPendingIntent(R.id.said, activity(c, "/#/assist"))
    }

    private fun ask(c: Context, r: Feed.Row, rule: Boolean, now: Long, pal: Palette) = RemoteViews(c.packageName, R.layout.widget_ask).apply {
        val a = r.ask
        setViewVisibility(R.id.ask_rule, if (rule) View.VISIBLE else View.GONE)
        if (themed) {
            tint(R.id.ask_rule, "setImageTintList", pal.line)
            tint(R.id.ask_edge, "setImageTintList", pal.needs)
            block(R.id.ask_sb, pal, needs = true)
            listOf(R.id.ask_title to pal.ink, R.id.ask_where to pal.faint, R.id.ask_q to pal.ink, R.id.ask_st to pal.dim)
                .forEach { (id, color) -> setTextColor(id, color) }
        }
        setTextViewText(R.id.ask_title, r.title)
        setTextViewText(R.id.ask_where, listOf(r.bay, ago(now, r.since)).filter { it.isNotEmpty() }.joinToString("  "))
        setTextViewText(R.id.ask_q, when {
            a == null -> r.summary.ifEmpty { "Needs you" }
            a.tool == "Bash" -> SpannableStringBuilder("Run ").append(a.cmd, TypefaceSpan("monospace"), 0)
            else -> a.says()
        })
        val open = activity(c, "/#/s/${r.key}")
        setOnClickPendingIntent(R.id.ask, open)
        val st = a?.let { Asked.get(it) }
        val choices = a?.choices(Answer.MAX) ?: listOf(Choice("", "Open", "", open = true))
        setViewVisibility(R.id.ask_opts, if (st == null) View.VISIBLE else View.GONE)
        setViewVisibility(R.id.ask_st, if (st != null) View.VISIBLE else View.GONE)
        if (st != null && a != null) {
            setTextViewText(R.id.ask_st, when (st.status) {
                Asked.SENDING -> SpannableStringBuilder("Sending: ").bold(st.what, pal.ink, themed)
                Asked.FAILED -> SpannableStringBuilder("Not sent: ${st.what}. ${st.why} ").bold("Retry", pal.ink, themed)
                else -> SpannableStringBuilder("Sent: ").bold(st.what, pal.ink, themed).append(". It carries on.")
            })
            if (st.status == Asked.FAILED) setOnClickPendingIntent(R.id.ask_st, Answer.pending(c, a, choices.indexOfFirst { it.label == st.what }, null))
            return@apply
        }
        listOf(R.id.opt0, R.id.opt1, R.id.opt2).forEachIndexed { i, id ->
            val ch = choices.getOrNull(i)
            setViewVisibility(id, if (ch != null) View.VISIBLE else View.GONE)
            if (ch == null) return@forEachIndexed
            val first = i == 0
            val label = SpannableStringBuilder()
            if (ch.n.isNotEmpty()) label.append(ch.n, TypefaceSpan("monospace"), 0).also { it.setSpan(RelativeSizeSpan(.85f), 0, ch.n.length, 0) }.append(" ")
            label.append(ch.label)
            setTextViewText(id, label)
            if (themed) {
                tint(id, "setBackgroundTintList", if (first) pal.ink else pal.lineStrong)
                setTextColor(id, if (first) pal.board else pal.ink)
            }
            setOnClickPendingIntent(id, if (ch.open || a == null) open else Answer.pending(c, a, i, null))
        }
    }

    private fun RemoteViews.block(id: Int, pal: Palette, needs: Boolean) {
        tint(id, "setBackgroundTintList", if (needs) pal.needs else pal.ink)
        setTextColor(id, if (needs) pal.onNeeds else pal.ink)
    }

    private fun RemoteViews.count(id: Int, n: Int?) {
        setViewVisibility(id, if (n != null) View.VISIBLE else View.GONE)
        if (n != null) setTextViewText(id, "$n")
    }

    private fun SpannableStringBuilder.bold(text: String, color: Int, themed: Boolean): SpannableStringBuilder {
        val start = length
        append(text)
        setSpan(StyleSpan(Typeface.BOLD), start, length, 0)
        if (themed) setSpan(ForegroundColorSpan(color), start, length, 0)
        return this
    }

    private fun clock(ms: Long) = java.text.SimpleDateFormat("HH:mm", java.util.Locale.ROOT).format(java.util.Date(ms))

    private fun ago(now: Long, since: Long) = if (since > 0) elapsed(now - since) else ""

    private val themed get() = Build.VERSION.SDK_INT >= 31

    private fun RemoteViews.tint(id: Int, method: String, color: Int) {
        if (Build.VERSION.SDK_INT >= 31) setColorStateList(id, method, ColorStateList.valueOf(color))
    }

    private fun activity(c: Context, path: String) = Push.opener(c, path)
}
