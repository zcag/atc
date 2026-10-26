package io.github.zcag.atc

import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import org.json.JSONObject
import kotlin.concurrent.thread

class Reply : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        val session = intent.getStringExtra(SESSION) ?: return
        val picked = intent.getStringExtra(TEXT)
        val text = (picked ?: RemoteInput.getResultsFromIntent(intent)?.getCharSequence(TEXT)?.toString())?.trim()
        val server = Prefs(c).server
        if (text.isNullOrEmpty() || server == null) return
        val note = { body: String -> Note(intent.getStringExtra(TITLE) ?: "atc", body, intent.getStringExtra(TAG) ?: session, intent.getStringExtra(PATH) ?: "/") }
        val done = goAsync()
        thread {
            val code = runCatching { Net.post(c, "$server/api/sessions/$session/send", JSONObject().put("text", text).put("suggested", picked != null)) }
            if (code.getOrNull() in 200..299) Push.notify(c, note("Sent: $text"), quiet = true, timeout = 5_000)
            else Push.notify(c, note("Could not send “$text”: ${code.exceptionOrNull()?.message ?: "HTTP ${code.getOrNull()}"}. Tap to open the session."), quiet = true)
            done.finish()
        }
    }

    companion object {
        private const val SESSION = "session"
        private const val TEXT = "text"
        private const val TITLE = "title"
        private const val TAG = "tag"
        private const val PATH = "path"

        fun actions(c: Context, note: Note): List<Notification.Action> {
            val icon = Icon.createWithResource(c, R.drawable.ic_notification)
            fun intent(slot: Int, text: String?, mutable: Boolean): PendingIntent {
                val i = Intent(c, Reply::class.java).setPackage(c.packageName)
                    .putExtra(SESSION, note.session).putExtra(TITLE, note.title).putExtra(TAG, note.tag).putExtra(PATH, note.url)
                if (text != null) i.putExtra(TEXT, text)
                val mode = if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
                return PendingIntent.getBroadcast(c, note.id * 4 + slot, i, mode or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            val picks = note.replies.take(2).mapIndexed { n, text -> Notification.Action.Builder(icon, text, intent(n, text, false)).build() }
            val typed = Notification.Action.Builder(icon, "Reply", intent(3, null, true))
                .addRemoteInput(RemoteInput.Builder(TEXT).setLabel("Reply to ${note.title}").build())
                .build()
            return picks + typed
        }
    }
}
