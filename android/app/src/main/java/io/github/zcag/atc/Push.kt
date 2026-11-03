package io.github.zcag.atc

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class Push : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        Prefs(this).endpoint = endpoint.url
        sync(this)
    }

    override fun onMessage(message: PushMessage, instance: String) = handle(this, message.content)

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Prefs(this).pushError = reason.name.lowercase()
    }

    override fun onUnregistered(instance: String) {
        val p = Prefs(this)
        val server = p.server
        val endpoint = p.endpoint ?: return
        p.endpoint = null
        p.registered = null
        if (server != null) unregister(this, server, endpoint)
    }

    companion object {
        private val syncing = AtomicBoolean()

        private fun key(server: String?, endpoint: String?) = "$server $endpoint widget"

        fun handle(c: Context, content: ByteArray) {
            val text = String(content)
            val ring = Ring.parse(text)
            if (ring != null) {
                if (ring.fresh(System.currentTimeMillis() / 1000)) Calls.ring(c, ring.reason)
            } else if (Feed.parse(text) != null) Live.save(c, text)
            else Note.parse(content)?.let { if (!(it.open && AssistService.open(it.url))) notify(c, it) }
        }

        fun start(a: Activity) {
            if (Build.VERSION.SDK_INT >= 33 && a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                a.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
            UnifiedPush.tryUseCurrentOrDefaultDistributor(a) { ok ->
                if (ok) UnifiedPush.register(a, messageForDistributor = "atc")
                else if (UnifiedPush.getDistributors(a).isEmpty()) hint(a)
            }
        }

        fun sync(c: Context) {
            val p = Prefs(c)
            val server = p.server ?: return
            val endpoint = p.endpoint ?: return
            if (p.registered == key(server, endpoint) || !syncing.compareAndSet(false, true)) return
            thread {
                try {
                    val code = Net.post(c, "$server/api/push/register", JSONObject().put("endpoint", endpoint).put("name", Build.MODEL).put("widget", true))
                    when (code) {
                        in 200..299 -> { p.registered = key(server, endpoint); p.pushError = null }
                        401 -> p.pushError = null
                        else -> p.pushError = "HTTP $code"
                    }
                } catch (e: Exception) {
                    p.pushError = e.message ?: e.javaClass.simpleName
                } finally {
                    syncing.set(false)
                }
            }
        }

        fun unregister(c: Context, server: String, endpoint: String) = thread {
            runCatching { Net.post(c, "$server/api/push/unregister", JSONObject().put("endpoint", endpoint)) }
        }

        fun status(c: Context): String {
            val p = Prefs(c)
            return when {
                p.endpoint != null && p.registered == key(p.server, p.endpoint) -> "ok"
                p.pushError != null -> "error: ${p.pushError}"
                UnifiedPush.getAckDistributor(c) == null && UnifiedPush.getDistributors(c).isEmpty() -> "no-distributor"
                else -> "registering"
            }
        }

        private fun hint(a: Activity) {
            val p = Prefs(a)
            if (p.hinted != null) return
            p.hinted = "1"
            AlertDialog.Builder(a)
                .setTitle("Notifications")
                .setMessage("atc delivers notifications through UnifiedPush. To get them, install a distributor such as ntfy, then open atc again.")
                .setPositiveButton("Get ntfy") { _, _ ->
                    a.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/io.heckel.ntfy/")))
                }
                .setNegativeButton("Not now", null)
                .show()
        }

        private const val LINE = "atc.line"
        private const val WAITS = "atc.waits"

        fun opener(c: Context, path: String): PendingIntent = PendingIntent.getActivity(c, path.hashCode(),
            Intent(c, MainActivity::class.java).putExtra(MainActivity.EXTRA_PATH, path).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        fun action(c: Context, label: CharSequence, pi: PendingIntent, unlock: Boolean): Notification.Action =
            Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_notification), label, pi).apply {
                if (unlock && Build.VERSION.SDK_INT >= 31) setAuthenticationRequired(true)
            }.build()

        private fun askActions(c: Context, note: Note, ask: Ask) = ask.choices(Answer.MAX).mapIndexed { i, ch ->
            action(c, ch.button, if (ch.open) opener(c, note.url) else Answer.pending(c, ask, i, note), ch.unlock)
        }

        /** A push as Android draws it: the session as the title, its bay beside the app's name, the ask whole; its
         *  answers as actions. Several from one bay group under one line per bay. */
        fun notify(
            c: Context, note: Note, quiet: Boolean = false, timeout: Long = 0,
            body: String = note.body, actions: List<Notification.Action>? = null, waiting: Boolean = note.ask != null,
        ) {
            val nm = c.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel("atc", "Sessions", NotificationManager.IMPORTANCE_HIGH))
            val b = Notification.Builder(c, "atc")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(note.title)
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setContentIntent(opener(c, note.url))
                .setAutoCancel(true)
                .setOnlyAlertOnce(quiet)
            b.extras.putCharSequence(LINE, "${note.title}  $body")
            b.extras.putBoolean(WAITS, waiting)
            if (note.bay.isNotEmpty()) b.setSubText(note.bay).setGroup(group(note.bay))
            if (timeout > 0) b.setTimeoutAfter(timeout)
            (actions ?: when {
                note.ask != null -> askActions(c, note, note.ask)
                note.session.isNotEmpty() -> Reply.actions(c, note)
                else -> emptyList()
            }).forEach { b.addAction(it) }
            val n = b.build()
            nm.notify(note.id, n)
            regroup(c, note.bay, note.id to n)
        }

        fun sent(c: Context, note: Note, what: String) {
            val at = java.text.SimpleDateFormat("HH:mm", java.util.Locale.ROOT).format(java.util.Date())
            notify(c, note, quiet = true, timeout = CLEAR, body = "Sent $at: $what. It carries on; this clears in a few seconds.", actions = emptyList(), waiting = false)
            Thread.sleep(CLEAR + 300)
            regroup(c, note.bay)
        }

        private const val CLEAR = 4_000L

        private fun group(bay: String) = "bay:$bay"

        private fun regroup(c: Context, bay: String, posted: Pair<Int, Notification>? = null) {
            if (bay.isEmpty()) return
            val nm = c.getSystemService(NotificationManager::class.java)
            val g = group(bay)
            val id = g.hashCode()
            val kids = nm.activeNotifications.filter { it.id != posted?.first && it.notification.group == g && it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 }
                .map { it.notification } + listOfNotNull(posted?.second)
            val shown = nm.activeNotifications.any { it.id == id }
            if (kids.isEmpty()) return nm.cancel(id)
            if (kids.size < 2 && !shown) return
            val waits = kids.count { it.extras.getBoolean(WAITS) }
            val title = when {
                waits > 0 -> "$bay, $waits ${if (waits == 1) "needs" else "need"} you"
                else -> "$bay, ${kids.size} done"
            }
            val inbox = Notification.InboxStyle().setBigContentTitle(title)
            kids.take(5).forEach { inbox.addLine(it.extras.getCharSequence(LINE)) }
            nm.notify(id, Notification.Builder(c, "atc")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(kids.joinToString("; ") { it.extras.getCharSequence(Notification.EXTRA_TITLE) ?: "" })
                .setStyle(inbox)
                .setSubText(bay)
                .setGroup(g)
                .setGroupSummary(true)
                .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
                .setOnlyAlertOnce(true)
                .setContentIntent(opener(c, "/"))
                .build())
        }
    }
}
