package io.github.zcag.atc

import android.app.KeyguardManager
import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import org.json.JSONObject
import kotlin.concurrent.thread

class Reply : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        val note = intent.getStringExtra(NOTE)?.let { Note.parse(it.toByteArray()) } ?: return
        val picked = intent.getStringExtra(TEXT)
        val text = (picked ?: RemoteInput.getResultsFromIntent(intent)?.getCharSequence(TEXT)?.toString())?.trim()
        val server = Prefs(c).server
        if (text.isNullOrEmpty() || server == null) return
        if (picked == null && outward(text) && c.getSystemService(KeyguardManager::class.java).isDeviceLocked) {
            Push.notify(c, note, quiet = true, body = "Not sent: “$text” acts outward, so it waits for the unlock.",
                actions = listOf(Push.action(c, "Unlock and send", pending(c, note, 2, text), true)), waiting = false)
            return
        }
        val done = goAsync()
        Push.notify(c, note, quiet = true, body = "Sending: $text", actions = emptyList(), waiting = false)
        thread {
            val r = runCatching { Net.send(c, "$server/api/sessions/${note.session}/send", JSONObject().put("text", text).put("suggested", picked != null)) }
            if (r.getOrNull()?.first in 200..299) Push.sent(c, note, text)
            else Push.notify(c, note, quiet = true, body = "Not sent: $text. ${Answer.why(server, r)}", waiting = false,
                actions = listOf(Push.action(c, "Retry", pending(c, note, 2, text), outward(text)), Push.action(c, "Open", Push.opener(c, note.url), false)))
            done.finish()
        }
    }

    companion object {
        private const val NOTE = "note"
        private const val TEXT = "text"

        private fun pending(c: Context, note: Note, slot: Int, text: String?): PendingIntent {
            val i = Intent(c, Reply::class.java).setPackage(c.packageName)
                .setData(Uri.parse("atc://reply/${Uri.encode(note.tag)}/$slot"))
                .putExtra(NOTE, note.raw)
            if (text != null) i.putExtra(TEXT, text)
            val mode = if (text == null) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
            return PendingIntent.getBroadcast(c, slot, i, mode or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        /** The summary's suggested replies, labelled with the message they send, and Reply to type one. */
        fun actions(c: Context, note: Note): List<Notification.Action> {
            val picks = note.replies.take(2).mapIndexed { n, text -> Push.action(c, "Reply: $text", pending(c, note, n, text), outward(text)) }
            val typed = Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_notification), "Reply", pending(c, note, 3, null))
                .addRemoteInput(RemoteInput.Builder(TEXT).setLabel("Reply to ${note.title}").build())
                .build()
            return picks + typed
        }
    }
}
