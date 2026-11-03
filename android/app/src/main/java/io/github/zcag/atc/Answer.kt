package io.github.zcag.atc

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/** Answers an ask from a push's action or a widget's button, through the same API the web uses, saying where from. */
class Answer : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        val ask = Ask.parse(intent.getStringExtra(ASK)) ?: return
        val choice = ask.choices(MAX).getOrNull(intent.getIntExtra(PICK, -1))?.takeIf { !it.open } ?: return
        val note = intent.getStringExtra(NOTE)?.let { Note.parse(it.toByteArray()) }
        val server = Prefs(c).server ?: return
        val done = goAsync()
        if (note != null) Push.notify(c, note, quiet = true, body = "Sending: ${choice.label}", actions = emptyList(), waiting = false)
        else Asked.set(c, ask, Asked.State(choice.label, Asked.SENDING))
        thread {
            val r = runCatching { Net.send(c, ask.url(server, if (note != null) "push" else "widget"), JSONObject(choice.body)) }
            val ok = r.getOrNull()?.first in 200..299
            val why = if (ok) "" else why(server, r)
            if (note != null) {
                if (ok) Push.sent(c, note, choice.label)
                else Push.notify(c, note, quiet = true, body = "Not sent: ${choice.label}. $why", actions = listOfNotNull(
                    Push.action(c, "Retry", PendingIntent.getBroadcast(c, note.id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT), choice.unlock),
                    Push.action(c, "Open", Push.opener(c, note.url), false),
                ), waiting = false)
            } else {
                Asked.set(c, ask, Asked.State(choice.label, if (ok) Asked.SENT else Asked.FAILED, why))
                if (ok) {
                    Thread.sleep(1_800)
                    Asked.set(c, ask, Asked.State(choice.label, Asked.GONE))
                    Live.refresh(c, force = true)
                }
            }
            done.finish()
        }
    }

    companion object {
        const val MAX = 3
        private const val ASK = "ask"
        private const val PICK = "pick"
        private const val NOTE = "note"

        fun intent(c: Context, ask: Ask, pick: Int, note: Note?): Intent = Intent(c, Answer::class.java).setPackage(c.packageName)
            .setData(Uri.parse("atc://answer/${Uri.encode(ask.sid)}/${ask.key}/$pick/${if (note == null) "widget" else "push"}"))
            .putExtra(ASK, ask.json()).putExtra(PICK, pick).apply { if (note != null) putExtra(NOTE, note.raw) }

        fun pending(c: Context, ask: Ask, pick: Int, note: Note?): PendingIntent =
            PendingIntent.getBroadcast(c, pick, intent(c, ask, pick, note), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        fun why(server: String, r: Result<Pair<Int, String>>): String {
            val (code, said) = r.getOrNull() ?: return "${runCatching { URL(server).host }.getOrDefault("atc")} is unreachable."
            return when {
                code == 401 -> "Sign in to atc again."
                said.isNotEmpty() -> said.replaceFirstChar { it.uppercase() }.let { if (it.endsWith(".")) it else "$it." }
                else -> "atc answered HTTP $code."
            }
        }
    }
}

/** What the widget shows in place of an ask's buttons while its answer goes out, keyed by the ask. */
object Asked {
    const val SENDING = "sending"
    const val SENT = "sent"
    const val FAILED = "failed"
    const val GONE = "gone"

    class State(val what: String, val status: String, val why: String = "", val at: Long = System.currentTimeMillis())

    private val states = ConcurrentHashMap<String, State>()

    private fun key(a: Ask) = "${a.sid} ${a.key}"

    fun get(a: Ask): State? = states[key(a)]?.takeIf { it.status != GONE || System.currentTimeMillis() - it.at < 120_000 }

    fun set(c: Context, a: Ask, s: State) {
        states[key(a)] = s
        Live.render(c)
    }
}
