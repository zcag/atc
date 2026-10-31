package io.github.zcag.atc

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.Chronometer
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

object CallNote {
    const val ID = 7001
    private const val RING = "call-ring"
    private const val ONGOING = "call"

    private fun channels(c: Context) = c.getSystemService(NotificationManager::class.java).apply {
        createNotificationChannel(NotificationChannel(RING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 800)
        })
        createNotificationChannel(NotificationChannel(ONGOING, "Calls", NotificationManager.IMPORTANCE_DEFAULT).apply { setSound(null, null) })
    }

    fun build(c: Context, st: Calls.State): Notification {
        channels(c)
        val screen = PendingIntent.getActivity(c, 0, Intent(c, CallActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        val hangup = PendingIntent.getBroadcast(c, 1, Intent(c, CallAction::class.java), PendingIntent.FLAG_IMMUTABLE)
        val person = Person.Builder().setName("Assistant").setImportant(true).build()
        val ringing = st.phase == Calls.Phase.Ringing
        val b = Notification.Builder(c, if (ringing) RING else ONGOING)
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle("Assistant")
            .setContentText(CallActivity.status(st))
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(screen)
        if (st.phase == Calls.Phase.Active) b.setUsesChronometer(true).setWhen(System.currentTimeMillis() - (SystemClock.elapsedRealtime() - st.since))
        if (ringing) {
            val answer = PendingIntent.getActivity(c, 2, Intent(c, CallActivity::class.java).setAction(CallActivity.ANSWER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
            b.setFullScreenIntent(screen, true)
            if (Build.VERSION.SDK_INT >= 31) b.setStyle(Notification.CallStyle.forIncomingCall(person, hangup, answer))
            else b.addAction(Notification.Action.Builder(null, "Decline", hangup).build()).addAction(Notification.Action.Builder(null, "Answer", answer).build())
        } else if (Build.VERSION.SDK_INT >= 31) b.setStyle(Notification.CallStyle.forOngoingCall(person, hangup))
        else b.addAction(Notification.Action.Builder(null, "Hang up", hangup).build())
        return b.build().apply { if (ringing) flags = flags or Notification.FLAG_INSISTENT }
    }

    /** A ringing call's notice goes up at once; the ongoing one belongs to CallService. */
    fun show(c: Context, st: Calls.State) {
        if (st.phase == Calls.Phase.Ringing) c.getSystemService(NotificationManager::class.java).notify(ID, build(c, st))
        else CallService.start(c)
    }

    fun cancel(c: Context) = c.getSystemService(NotificationManager::class.java).cancel(ID)
}

class CallAction : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) = Calls.send(Calls.Cmd.Hangup)
}

/** Keeps the process and the microphone while a call is on; its notification is the call's. */
class CallService : Service() {
    private val scope = MainScope()
    private var watching: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val st = Calls.state.value
        if (!st.live) {
            stopSelf()
            return START_NOT_STICKY
        }
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        if (Build.VERSION.SDK_INT >= 30 && Calls.canRecord(this)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (runCatching { startForeground(CallNote.ID, CallNote.build(this, st), type) }.isFailure) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (watching == null) watching = scope.launch {
            Calls.state.collect { s ->
                if (s.live) getSystemService(NotificationManager::class.java).notify(CallNote.ID, CallNote.build(this@CallService, s))
                else {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        fun start(c: Context) {
            runCatching { c.startForegroundService(Intent(c, CallService::class.java)) }
        }
    }
}

class CallActivity : Activity() {
    companion object {
        const val DIAL = "io.github.zcag.atc.DIAL"
        const val ANSWER = "io.github.zcag.atc.ANSWER"
        private const val REQ_MIC = 1

        fun status(st: Calls.State) = when (st.phase) {
            Calls.Phase.Calling -> "Calling…"
            Calls.Phase.Ringing -> st.reason.ifEmpty { "Calling you" }
            Calls.Phase.Connecting -> "Connecting…"
            Calls.Phase.Active -> if (st.muted) "Muted" else "On the call"
            Calls.Phase.Ended -> "Call ended" + if (st.why.isNotEmpty()) ": ${st.why}" else ""
            Calls.Phase.Idle -> ""
        }
    }

    private val scope = MainScope()
    private var pending: String? = null
    private var proximity: PowerManager.WakeLock? = null
    private lateinit var statusView: TextView
    private lateinit var reasonView: TextView
    private lateinit var timer: Chronometer
    private lateinit var incomingRow: LinearLayout
    private lateinit var callRow: LinearLayout
    private lateinit var mute: ImageButton
    private lateinit var speaker: ImageButton
    private lateinit var persona: Persona
    private lateinit var youView: TextView
    private lateinit var saidView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.statusBarColor = Color.TRANSPARENT
        setContentView(layout())
        proximity = getSystemService(PowerManager::class.java)
            .takeIf { it.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) }
            ?.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "atc:call")
        handle(intent)
        scope.launch {
            Calls.state.collect { show(it) }
        }
        scope.launch {
            Calls.face.collect { show(it) }
        }
    }

    private fun show(f: Calls.Face) {
        persona.face(f)
        youView.text = f.hearing.ifEmpty { f.you }
        youView.alpha = if (f.hearing.isNotEmpty()) .5f else .7f
        saidView.text = f.said
        if (Calls.state.value.phase == Calls.Phase.Active) statusView.text = activity(f)
    }

    private fun activity(f: Calls.Face) = when (f.state) {
        "hearing" -> "Hearing you"
        "thinking" -> "Thinking…"
        "tool" -> "Using " + f.tool.substringAfterLast("__").replace('_', ' ').ifEmpty { "a tool" } + "…"
        "speaking" -> "Speaking · tap to stop"
        else -> "Listening"
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        scope.cancel()
        proximity?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    private fun handle(intent: Intent) {
        val action = intent.action?.takeIf { it == DIAL || it == ANSWER } ?: return
        if (!Calls.canRecord(this)) {
            pending = action
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            return
        }
        act(action)
    }

    private fun act(action: String) {
        if (action == ANSWER) Calls.send(Calls.Cmd.Answer)
        else if (!Calls.dial(this) && !Calls.state.value.live) {
            statusView.text = "Set up atc's server first"
            finishSoon()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        val action = pending ?: return
        pending = null
        act(action)
    }

    private fun show(st: Calls.State) {
        statusView.text = if (st.phase == Calls.Phase.Active && !st.muted) activity(Calls.face.value) else status(st)
        persona.view.visibility = if (st.phase == Calls.Phase.Active || st.phase == Calls.Phase.Connecting) View.VISIBLE else View.INVISIBLE
        reasonView.text = st.reason
        reasonView.visibility = if (st.reason.isNotEmpty() && st.phase != Calls.Phase.Ringing) View.VISIBLE else View.GONE
        incomingRow.visibility = if (st.phase == Calls.Phase.Ringing) View.VISIBLE else View.GONE
        callRow.visibility = if (st.live && st.phase != Calls.Phase.Ringing) View.VISIBLE else View.GONE
        if (st.phase == Calls.Phase.Active) {
            timer.base = st.since
            timer.visibility = View.VISIBLE
            timer.start()
        } else {
            timer.stop()
            timer.visibility = View.GONE
        }
        tint(mute, st.muted)
        tint(speaker, st.speaker)
        val near = st.phase == Calls.Phase.Active && !st.speaker
        proximity?.let { if (near && !it.isHeld) it.acquire(3 * 60 * 60 * 1000L) else if (!near && it.isHeld) it.release() }
        if (st.phase == Calls.Phase.Ended || st.phase == Calls.Phase.Idle && pending == null && intent.action == null) finishSoon()
    }

    private fun finishSoon() = scope.launch {
        delay(1500)
        if (!Calls.state.value.live) finish()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun round(icon: Int, color: Int, cmd: () -> Unit) = ImageButton(this).apply {
        setImageResource(icon)
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
        setColorFilter(Color.WHITE)
        setOnClickListener { cmd() }
        layoutParams = LinearLayout.LayoutParams(dp(68), dp(68)).apply { setMargins(dp(18), 0, dp(18), 0) }
    }

    private fun tint(b: ImageButton, on: Boolean) {
        (b.background as GradientDrawable).setColor(if (on) Color.WHITE else 0x33ffffff)
        b.setColorFilter(if (on) 0xff151c27.toInt() else Color.WHITE)
    }

    private fun row(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
        views.forEach { addView(it) }
    }

    private fun text(size: Float, alpha: Float) = TextView(this).apply {
        textSize = size
        setTextColor(Color.WHITE)
        this.alpha = alpha
        gravity = Gravity.CENTER
        setPadding(dp(24), dp(6), dp(24), dp(6))
    }

    private fun layout(): View {
        statusView = text(18f, 0.8f)
        reasonView = text(16f, 0.7f)
        timer = Chronometer(this).apply { textSize = 18f; setTextColor(Color.WHITE); alpha = 0.8f; gravity = Gravity.CENTER }
        incomingRow = row(
            round(R.drawable.ic_call_end, 0xffe5484d.toInt()) { Calls.send(Calls.Cmd.Hangup) },
            round(R.drawable.ic_call, 0xff30a46c.toInt()) { handle(Intent(ANSWER)) },
        )
        mute = round(R.drawable.ic_mic_off, 0x33ffffff) { Calls.send(Calls.Cmd.Mute) }
        speaker = round(R.drawable.ic_speaker, 0x33ffffff) { Calls.send(Calls.Cmd.Speaker) }
        callRow = row(mute, round(R.drawable.ic_call_end, 0xffe5484d.toInt()) { Calls.send(Calls.Cmd.Hangup) }, speaker)
        persona = Persona.make(this)
        persona.view.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        persona.view.setOnClickListener { if (Calls.face.value.state in setOf("speaking", "thinking", "tool")) Calls.send(Calls.Cmd.Interrupt) }
        youView = text(15f, .7f).apply { maxLines = 3 }
        saidView = text(19f, 1f).apply { maxLines = 4; setPadding(dp(24), dp(4), dp(24), dp(20)) }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(0xff151c27.toInt())
            setPadding(0, dp(96), 0, dp(72))
            addView(text(34f, 1f).apply { text = "Assistant" })
            addView(statusView)
            addView(timer)
            addView(reasonView)
            addView(persona.view)
            addView(youView)
            addView(saidView)
            addView(incomingRow)
            addView(callRow)
        }
    }
}
