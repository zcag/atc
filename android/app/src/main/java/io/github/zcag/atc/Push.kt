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

    override fun onMessage(message: PushMessage, instance: String) {
        val text = String(message.content)
        val ring = Ring.parse(text)
        if (ring != null) {
            if (ring.fresh(System.currentTimeMillis() / 1000)) Calls.ring(this, ring.reason)
        } else if (Feed.parse(text) != null) Live.save(this, text)
        else Note.parse(message.content)?.let { if (!(it.open && AssistService.open(it.url))) notify(this, it) }
    }

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

        fun notify(c: Context, note: Note, quiet: Boolean = false, timeout: Long = 0) {
            val nm = c.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel("atc", "Sessions", NotificationManager.IMPORTANCE_HIGH))
            val open = Intent(c, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_PATH, note.url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val pi = PendingIntent.getActivity(c, note.id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val b = Notification.Builder(c, "atc")
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(note.title)
                .setContentText(note.body)
                .setStyle(Notification.BigTextStyle().bigText(note.body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setOnlyAlertOnce(quiet)
            if (timeout > 0) b.setTimeoutAfter(timeout)
            if (note.session.isNotEmpty()) Reply.actions(c, note).forEach { b.addAction(it) }
            nm.notify(note.id, b.build())
        }
    }
}
