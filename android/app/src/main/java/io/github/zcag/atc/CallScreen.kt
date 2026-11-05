package io.github.zcag.atc

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.TypefaceSpan
import android.view.Gravity
import android.view.View
import android.window.OnBackInvokedDispatcher
import android.widget.Chronometer
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.Job
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread
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
        val screen = PendingIntent.getActivity(c, 0, CallActivity.open(c), PendingIntent.FLAG_IMMUTABLE)
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

    /** Telecom logs a missed call from a self-managed app but leaves the notification to it. */
    fun missed(c: Context, reason: String) {
        channels(c)
        val back = PendingIntent.getActivity(c, 3, Intent(c, CallActivity::class.java).setAction(CallActivity.DIAL)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        c.getSystemService(NotificationManager::class.java).notify(ID + 1, Notification.Builder(c, ONGOING)
            .setSmallIcon(R.drawable.ic_call)
            .setContentTitle("Missed call from the assistant")
            .setContentText(reason.ifEmpty { "Tap to call back" })
            .setCategory(Notification.CATEGORY_MISSED_CALL)
            .setContentIntent(back)
            .setAutoCancel(true)
            .build())
    }
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

/** The call so far, growing up from the controls to [limit], then scrolling. It follows the end unless scrolled back, until you next speak. */
private class Transcript(c: Context, private val limit: Int, onTap: () -> Unit) : ScrollView(c) {
    private val dp = c.resources.displayMetrics.density
    private val body = TextView(c).apply {
        textSize = 16f
        setLineSpacing(0f, 1.15f)
        setTextColor(INK)
        setShadowLayer(8f, 0f, 1f, 0x99000000.toInt())
        setPadding((20 * dp).toInt(), (40 * dp).toInt(), (20 * dp).toInt(), (16 * dp).toInt())
        setOnClickListener { onTap() }
    }
    private var following = true
    private var yours = 0

    init {
        visibility = GONE
        isVerticalScrollBarEnabled = false
        overScrollMode = OVER_SCROLL_NEVER
        isVerticalFadingEdgeEnabled = true
        setFadingEdgeLength((36 * dp).toInt())
        background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0, SHADE, SHADE, SHADE, SHADE, 0))
        addView(body)
        setOnScrollChangeListener { _, _, y, _, _ -> following = body.height - y - height < 32 * dp }
        body.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> if (following) scrollTo(0, body.height) }
    }

    override fun onMeasure(w: Int, h: Int) = super.onMeasure(w, MeasureSpec.makeMeasureSpec(minOf(limit, MeasureSpec.getSize(h)), MeasureSpec.AT_MOST))

    fun show(f: Calls.Face) {
        val mine = f.log.count { it.yours }
        if (mine != yours) following = true
        yours = mine
        val turns = if (f.hearing.isEmpty()) f.log else Calls.extended(f.log, true, Calls.YOU, f.hearing)
        visibility = if (turns.isEmpty()) GONE else VISIBLE
        body.text = SpannableStringBuilder().apply {
            turns.forEachIndexed { i, t ->
                val end = i == turns.lastIndex
                if (i > 0) inSpans(RelativeSizeSpan(.6f)) { append("\n\n") }
                inSpans(RelativeSizeSpan(.8f), ForegroundColorSpan(LABEL)) { append(t.who) }
                append("\n")
                val start = length
                t.parts.forEachIndexed { j, part ->
                    val newest = end && j == t.parts.lastIndex
                    val quiet = !end || t.yours || (f.state == "speaking" && !newest)
                    inSpans(ForegroundColorSpan(if (quiet) PAST else INK)) { append(part) }
                    if (j < t.parts.lastIndex) append(" ")
                }
                if (!t.yours) setSpan(TypefaceSpan("serif"), start, length, 0)
            }
        }
    }

    private inline fun SpannableStringBuilder.inSpans(vararg spans: Any, add: SpannableStringBuilder.() -> Unit) {
        val start = length
        add()
        spans.forEach { setSpan(it, start, length, 0) }
    }

    private companion object {
        const val INK = 0xfff7f8fa.toInt()
        const val PAST = 0xffb4b9c1.toInt()
        const val LABEL = 0xffa8adb5.toInt()
        const val SHADE = 0xc405070c.toInt()
    }
}

class CallActivity : Activity() {
    companion object {
        private const val FACE_LIFT = .09f
        const val DIAL = "io.github.zcag.atc.DIAL"
        const val ANSWER = "io.github.zcag.atc.ANSWER"
        private const val REQ_MIC = 1

        fun open(c: Context): Intent = Intent(c, CallActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        fun status(st: Calls.State) = when (st.phase) {
            Calls.Phase.Calling -> "Calling…"
            Calls.Phase.Ringing -> st.reason.ifEmpty { "Calling you" }
            Calls.Phase.Connecting -> "Connecting…"
            Calls.Phase.Active -> if (st.held) "On hold, tap to resume" else if (st.muted) "Muted" else "On the call"
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
    private lateinit var persona: PersonaHost
    private lateinit var transcript: Transcript
    private lateinit var floor: View
    private lateinit var whoView: TextView
    private var personName: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        window.setDecorFitsSystemWindows(false)
        setContentView(layout())
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { back() }
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
        transcript.show(f)
        val talked = transcript.visibility == View.VISIBLE
        persona.view.animate().translationY(if (talked) resources.displayMetrics.heightPixels * -FACE_LIFT else 0f).setDuration(500)
        floor.animate().alpha(if (talked) 1f else 0f).setDuration(500)
        showWho(Calls.state.value, f)
        if (Calls.state.value.phase == Calls.Phase.Active && !Calls.state.value.held) statusView.text = activity(f)
    }

    /** Who the call is with; tapping the name moves it. An agent's call shows the assistant's knock under the status. */
    private fun showWho(st: Calls.State, f: Calls.Face) {
        whoView.text = f.who + personName?.let { " · $it" }.orEmpty() + if (st.phase == Calls.Phase.Active) " \u25BE" else ""
        val knock = f.knock.takeIf { it.isNotEmpty() && f.line != "assistant" }?.let { "Assistant: $it" }
        reasonView.text = knock ?: st.reason
        val talking = f.log.isNotEmpty() || f.hearing.isNotEmpty()
        reasonView.visibility = if (reasonView.text.isNotEmpty() && st.phase != Calls.Phase.Ringing && (knock != null || !talking)) View.VISIBLE else View.GONE
    }

    private fun activity(f: Calls.Face) = if (f.moving) "Connecting to ${f.who}…" else when (f.state) {
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
        if (Build.VERSION.SDK_INT < 34) {
            statusView.text = "Calls in atc need Android 14 or newer"
            finishSoon()
            return
        }
        val prefs = Prefs(this)
        val ask = (if (Calls.canRecord(this)) emptyList() else listOf(Manifest.permission.RECORD_AUDIO)) +
            (if (prefs.askedContacts == null) Contact.permissions.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED } else emptyList()) +
            (if (prefs.askedCallLog == null && checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED)
                listOf(Manifest.permission.READ_CALL_LOG) else emptyList()) +
            if (prefs.askedPhoneState == null && !Cellular.allowed(this)) listOf(Manifest.permission.READ_PHONE_STATE) else emptyList()
        if (ask.isNotEmpty()) {
            prefs.askedContacts = "1"
            prefs.askedCallLog = "1"
            prefs.askedPhoneState = "1"
            pending = action
            requestPermissions(ask.toTypedArray(), REQ_MIC)
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
        statusView.text = if (st.phase == Calls.Phase.Active && !st.muted && !st.held) activity(Calls.face.value) else status(st)
        persona.view.visibility = if (st.phase == Calls.Phase.Active || st.phase == Calls.Phase.Connecting) View.VISIBLE else View.INVISIBLE
        showWho(st, Calls.face.value)
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

    /** atc's sessions over the call, which goes on in its service; the green bar there (or the notification) brings
     *  this screen back as it was. */
    private fun toSessions() = startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

    private fun back() = if (Calls.state.value.live) toSessions() else finish()

    @Deprecated("Below Android 13 only; newer ones use the callback registered in onCreate")
    override fun onBackPressed() = back()

    /** The ⋯ button: options that don't need a button of their own. */
    private fun menu(anchor: View) = PopupMenu(this, anchor).apply {
        menu.add("Sessions (the call keeps going)").setOnMenuItemClickListener { toSessions(); true }
        menu.add("Talk to…").setOnMenuItemClickListener { pickLine(); true }
        menu.add("View…").setOnMenuItemClickListener { pickView(); true }
        if (persona.choices().isNotEmpty()) menu.add("Person…").setOnMenuItemClickListener { pickPerson(); true }
        menu.add("Edit persons…").setOnMenuItemClickListener {
            startActivity(Intent(this@CallActivity, MainActivity::class.java).putExtra(MainActivity.EXTRA_PATH, "/#/settings#persons")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            true
        }
        show()
    }

    /** The assistant and the agents that can talk; a pick moves the line. Saying so on the call does the same. */
    private fun pickLine() {
        val server = Prefs(this).server?.trimEnd('/') ?: return
        thread {
            val got = runCatching { JSONArray(Net.get(this, "$server/api/agents")) }
            runOnUiThread {
                val all = got.getOrNull() ?: return@runOnUiThread Toast.makeText(this, "Agents not reachable", Toast.LENGTH_SHORT).show()
                val on = Calls.face.value.line
                val items = listOf("assistant" to "Assistant") + List(all.length()) { all.getJSONObject(it) }
                    .filter { it.optBoolean("talk") && it.optString("error").isEmpty() }
                    .map { it.getString("name") to it.optString("title").ifEmpty { it.getString("name") } + if (it.optString("state") == "working") " · busy" else "" }
                if (items.size == 1) return@runOnUiThread Toast.makeText(this, "No agent can take the line", Toast.LENGTH_SHORT).show()
                AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setTitle("Talk to")
                    .setItems(items.map { (n, label) -> if (n == on) "$label  ✓" else label }.toTypedArray()) { _, i ->
                        val to = items[i].first
                        if (to != on) thread {
                            val ok = runCatching { Net.post(this, "$server/api/call/to", JSONObject().put("agent", to)) }.getOrNull() == 200
                            if (!ok) runOnUiThread { Toast.makeText(this, "Couldn't move the call", Toast.LENGTH_SHORT).show() }
                        }
                    }
                    .show()
            }
        }
    }

    /** How this phone shows the call; the person on the line stays who they are. */
    private fun pickView() {
        val views = PersonaHost.VIEWS
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("View")
            .setSingleChoiceItems(views.map { v -> v.replaceFirstChar { it.uppercase() } }.toTypedArray(), views.indexOf(persona.mode)) { d, i ->
                persona.pickMode(views[i])
                d.dismiss()
            }
            .show()
    }

    /** Who the assistant is in each language, the current ones ticked; a pick shows at once if that language is being
     *  spoken, and its voice speaks from the next reply. */
    private fun pickPerson() {
        val items = persona.choices()
        fun language(l: String) = mapOf("tr" to "Turkish", "en" to "English")[l] ?: l
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Person")
            .setItems(items.map { (l, p, on) -> "${language(l)} · ${p.optString("name")}" + if (on) "  ✓" else "" }.toTypedArray()) { _, i ->
                val (l, p, _) = items[i]
                persona.choose(l, p.optString("id")) { ok ->
                    Toast.makeText(this, if (ok) "${p.optString("name")} in ${language(l)}" else "Couldn't switch", Toast.LENGTH_SHORT).show()
                }
            }
            .show()
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
        setShadowLayer(14f, 0f, 1f, 0x99000000.toInt())
    }

    /** The name and the captions stay readable over a character, whose face keeps the middle of the screen to itself. */
    private fun scrim(from: GradientDrawable.Orientation) = View(this).apply {
        background = GradientDrawable(from, intArrayOf(0xcc05070c.toInt(), 0x9905070c.toInt(), 0x0005070c))
    }

    private fun layout(): View {
        statusView = text(15f, 0.85f).apply { setPadding(dp(4), 0, dp(4), 0) }
        reasonView = text(15f, 0.8f).apply { maxLines = 3 }
        timer = Chronometer(this).apply { textSize = 15f; setTextColor(Color.WHITE); alpha = 0.85f; gravity = Gravity.CENTER; setShadowLayer(14f, 0f, 1f, 0x99000000.toInt()); setPadding(dp(4), 0, dp(4), 0) }
        incomingRow = row(
            round(R.drawable.ic_call_end, 0xffe5484d.toInt()) { Calls.send(Calls.Cmd.Hangup) },
            round(R.drawable.ic_call, 0xff30a46c.toInt()) { handle(Intent(ANSWER)) },
        )
        mute = round(R.drawable.ic_mic_off, 0x33ffffff) { Calls.send(Calls.Cmd.Mute) }
        speaker = round(R.drawable.ic_speaker, 0x33ffffff) { Calls.send(Calls.Cmd.Speaker) }
        persona = PersonaHost(this)
        val more = round(R.drawable.ic_more, 0x33ffffff) {}
        more.setOnClickListener { menu(more) }
        callRow = row(mute, round(R.drawable.ic_call_end, 0xffe5484d.toInt()) { Calls.send(Calls.Cmd.Hangup) }, speaker, more)
        for (i in 0 until callRow.childCount) (callRow.getChildAt(i).layoutParams as LinearLayout.LayoutParams).setMargins(dp(9), 0, dp(9), 0)
        persona.view.setOnClickListener {
            if (Calls.state.value.held) Calls.send(Calls.Cmd.Resume)
            else if (Calls.face.value.state in setOf("speaking", "thinking", "tool")) Calls.send(Calls.Cmd.Interrupt)
        }
        statusView.setOnClickListener { if (Calls.state.value.held) Calls.send(Calls.Cmd.Resume) }
        transcript = Transcript(this, (resources.displayMetrics.heightPixels * .42f).toInt()) { persona.view.performClick() }
        val front = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, dp(36), 0, dp(56))
            whoView = text(24f, 1f).apply {
                setPadding(dp(24), dp(4), dp(24), 0)
                text = "Assistant"
                setOnClickListener { if (Calls.state.value.phase == Calls.Phase.Active) pickLine() }
            }
            addView(whoView)
            addView(row(statusView, timer).apply { setPadding(dp(24), 0, dp(24), 0) })
            persona.onPerson = { personName = it?.ifEmpty { null }; showWho(Calls.state.value, Calls.face.value) }
            addView(Space(context), LinearLayout.LayoutParams(0, 0, 1f))
            addView(reasonView)
            addView(transcript, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(incomingRow)
            addView(callRow)
        }
        floor = View(this).apply {
            alpha = 0f
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(Orb.BACKDROP, Orb.BACKDROP, Orb.BACKDROP and 0xffffff))
        }
        return FrameLayout(this).apply {
            setBackgroundColor(Orb.BACKDROP)
            addView(persona.view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(scrim(GradientDrawable.Orientation.TOP_BOTTOM), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(150), Gravity.TOP))
            addView(scrim(GradientDrawable.Orientation.BOTTOM_TOP), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(340), Gravity.BOTTOM))
            addView(floor, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, (resources.displayMetrics.heightPixels * FACE_LIFT * 2.4f).toInt(), Gravity.BOTTOM))
            addView(front, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
    }
}
