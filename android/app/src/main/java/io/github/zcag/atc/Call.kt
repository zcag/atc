package io.github.zcag.atc

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.telecom.DisconnectCause
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** A call with the assistant: a self-managed Telecom call whose audio runs over atc's call line. */
object Calls {
    enum class Phase { Idle, Calling, Ringing, Connecting, Active, Ended }

    data class State(
        val phase: Phase = Phase.Idle, val incoming: Boolean = false, val reason: String = "",
        val since: Long = 0, val muted: Boolean = false, val speaker: Boolean = false, val why: String = "",
    ) {
        val live get() = phase != Phase.Idle && phase != Phase.Ended
    }

    enum class Cmd { Answer, Hangup, Mute, Speaker, Hold, Unhold, Interrupt }

    /** What the assistant is doing, from delta-talk: listening, hearing (them), thinking, tool, speaking. */
    data class Face(val state: String = "listening", val hearing: String = "", val you: String = "", val said: String = "", val tool: String = "")

    sealed interface Wire {
        data object Active : Wire
        class Ended(val why: String) : Wire
    }

    val state = MutableStateFlow(State())
    val face = MutableStateFlow(Face())
    @Volatile var voice: Voice? = null

    /** Their voice's and the assistant's loudness right now, 0 to 1, measured on the phone. */
    fun levels() = voice?.let { it.you to it.it } ?: (0f to 0f)

    fun persona(o: JSONObject) {
        val f = face.value
        face.value = f.copy(
            state = o.optString("state").ifEmpty { f.state },
            hearing = if (o.has("hearing")) o.optString("hearing") else if (o.has("you")) "" else f.hearing,
            you = o.optString("you").ifEmpty { f.you },
            said = o.optString("said").ifEmpty { f.said },
            tool = o.optString("tool").ifEmpty { f.tool },
        )
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var cmds: Channel<Cmd>? = null

    fun dial(c: Context) = begin(c, false, "")

    fun ring(c: Context, reason: String) = begin(c, true, reason)

    fun send(cmd: Cmd) {
        cmds?.trySend(cmd)
    }

    fun canRecord(c: Context) = c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun update(f: State.() -> State) {
        state.value = state.value.f()
    }

    private fun begin(c: Context, incoming: Boolean, reason: String): Boolean {
        val app = c.applicationContext
        if (state.value.live) return false
        val server = Prefs(app).server ?: return false
        val inbox = Channel<Cmd>(Channel.UNLIMITED)
        cmds = inbox
        state.value = State(if (incoming) Phase.Ringing else Phase.Calling, incoming, reason)
        face.value = Face()
        CallNote.show(app, state.value)
        scope.launch {
            val why = runCatching { run(app, server, incoming, inbox) }.getOrElse { it.message ?: it.javaClass.simpleName }
            cmds = null
            update { copy(phase = Phase.Ended, why = why) }
            CallNote.cancel(app)
        }
        return true
    }

    private suspend fun run(app: Context, server: String, incoming: Boolean, inbox: Channel<Cmd>): String {
        val wire = Channel<Wire>(Channel.UNLIMITED)
        val voice = Voice()
        this.voice = voice
        val line = Line(app, "$server/api/call/line", voice, wire)
        line.open(if (incoming) "ringing" else "call")
        val calls = CallsManager(app)
        calls.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
        val attrs = CallAttributesCompat(
            "Assistant", Uri.fromParts("sip", "assistant@atc", null),
            if (incoming) CallAttributesCompat.DIRECTION_INCOMING else CallAttributesCompat.DIRECTION_OUTGOING,
        )
        var why = "ended"
        try {
            calls.addCall(attrs,
                onAnswer = { inbox.send(Cmd.Answer) },
                onDisconnect = { inbox.send(Cmd.Hangup) },
                onSetActive = { inbox.send(Cmd.Unhold) },
                onSetInactive = { inbox.send(Cmd.Hold) },
            ) {
                launch { why = session(app, line, voice, incoming, inbox, wire) }
            }
        } finally {
            voice.stop()
            line.close()
            this.voice = null
        }
        return why
    }

    private suspend fun CallControlScope.session(
        app: Context, line: Line, voice: Voice, incoming: Boolean, inbox: Channel<Cmd>, wire: Channel<Wire>,
    ): String {
        var endpoints = emptyList<CallEndpointCompat>()
        val watchers = listOf(
            launch { availableEndpoints.collect { endpoints = it } },
            launch {
            currentCallEndpoint.collect { e ->
                voice.route = when (e.type) {
                    CallEndpointCompat.TYPE_EARPIECE -> "earpiece"
                    CallEndpointCompat.TYPE_SPEAKER -> "speaker"
                    CallEndpointCompat.TYPE_BLUETOOTH -> "bluetooth"
                    CallEndpointCompat.TYPE_WIRED_HEADSET -> "wired"
                    else -> "other"
                }
                update { copy(speaker = e.type == CallEndpointCompat.TYPE_SPEAKER) }
            }
        },
            launch { isMuted.collect { m -> voice.systemMuted = m; update { copy(muted = voice.muted) } } },
        )
        val timeout = launch {
            delay(if (incoming) 60_000 else 20_000)
            wire.send(Wire.Ended("no answer"))
        }
        var answered = !incoming
        while (true) {
            val why: String? = select {
                inbox.onReceive { cmd ->
                    when (cmd) {
                        Cmd.Answer -> {
                            if (!answered) {
                                answered = true
                                answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL)
                                line.send("accept")
                                update { copy(phase = Phase.Connecting) }
                                CallService.start(app)
                            }
                            null
                        }
                        Cmd.Hangup -> {
                            line.send("hangup")
                            if (answered) "you hung up" else "declined"
                        }
                        Cmd.Mute -> {
                            voice.muted = !voice.muted
                            update { copy(muted = voice.muted) }
                            null
                        }
                        Cmd.Speaker -> {
                            val want = if (state.value.speaker) endpoints.filter { it.type != CallEndpointCompat.TYPE_SPEAKER }.maxByOrNull { it.type }
                            else endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER }
                            want?.let { requestEndpointChange(it) }
                            null
                        }
                        Cmd.Interrupt -> {
                            line.send("interrupt")
                            null
                        }
                        Cmd.Hold, Cmd.Unhold -> {
                            voice.held = cmd == Cmd.Hold
                            null
                        }
                    }
                }
                wire.onReceive { w ->
                    when (w) {
                        Wire.Active -> {
                            timeout.cancel()
                            if (state.value.phase != Phase.Active) {
                                if (!incoming) setActive()
                                voice.start(line)
                                update { copy(phase = Phase.Active, since = SystemClock.elapsedRealtime()) }
                                CallService.start(app)
                            }
                            null
                        }
                        is Wire.Ended -> w.why
                    }
                }
            }
            if (why != null) {
                val cause = when (why) {
                    "you hung up" -> DisconnectCause.LOCAL
                    "declined" -> DisconnectCause.REJECTED
                    "no answer" -> if (incoming) DisconnectCause.MISSED else DisconnectCause.REMOTE
                    else -> DisconnectCause.REMOTE
                }
                disconnect(DisconnectCause(cause))
                (watchers + timeout).forEach { it.cancel() }
                return why
            }
        }
    }
}

/** atc's call line: commands and events as JSON text, audio as binary frames. A line that drops
 *  mid-call gets a few seconds to come back (the phone switched networks) before the call ends. */
class Line(private val c: Context, private val url: String, private val voice: Voice, private val wire: SendChannel<Calls.Wire>) {
    @Volatile private var ws: WebSocket? = null
    @Volatile private var live = false
    @Volatile private var closed = false
    private var lostAt = 0L
    private val ui = Handler(Looper.getMainLooper())

    fun open(hello: String) {
        val w = Net.webSocket(c, url, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("cmd", hello).put("out_rate", Voice.OUT_RATE).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val o = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (o.optString("event")) {
                    "active" -> {
                        live = true
                        lostAt = 0
                        wire.trySend(Calls.Wire.Active)
                    }
                    "ended" -> wire.trySend(Calls.Wire.Ended(ended(o.optString("why"))))
                    "persona" -> ui.post { Calls.persona(o) }
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = voice.play(bytes.toByteArray())

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                dropped(webSocket, response?.let { "atc answered ${it.code}" } ?: t.message ?: t.javaClass.simpleName)

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket, reason.ifEmpty { "line closed" })
        })
        ws = w
    }

    private fun ended(why: String) = when (why) {
        "busy" -> "the line is busy"
        "nobody" -> "nobody is there to answer"
        "gone" -> "the call is over"
        "lost" -> "connection lost"
        "hangup" -> "hung up"
        else -> why.ifEmpty { "ended" }
    }

    private fun dropped(w: WebSocket, why: String) {
        ui.post {
            if (closed || w !== ws) return@post
            if (!live) {
                wire.trySend(Calls.Wire.Ended(why))
                return@post
            }
            val now = SystemClock.elapsedRealtime()
            if (lostAt == 0L) lostAt = now
            if (now - lostAt > 8_000) wire.trySend(Calls.Wire.Ended("connection lost"))
            else ui.postDelayed({ if (!closed) open("resume") }, 1_000)
        }
    }

    fun send(name: String) {
        ws?.send(cmd(name))
    }

    fun audio(frame: ByteArray) {
        if (live) ws?.send(frame.toByteString())
    }

    fun stats(o: JSONObject) {
        if (live) ws?.send(o.put("cmd", "stats").toString())
    }

    fun close() {
        closed = true
        ws?.close(1000, null)
    }

    private fun cmd(name: String) = JSONObject().put("cmd", name).toString()
}

/** Call audio: their voice at 16 kHz (what delta-call's speech recognition takes) and the assistant's at 24 kHz (Higgs' own
 *  rate), mono s16le in 20 ms frames. Playback holds a few frames before it starts and after it runs dry, so network
 *  jitter does not cut words; every time it runs dry mid-call it holds two more (up to 300 ms), and gives one back
 *  after each 10 s that played clean. The counters go to delta-call every 10 s, into the call's log line. */
class Voice {
    companion object {
        const val RATE = 16_000
        const val FRAME = 640
        const val OUT_RATE = 24_000
        const val OUT_FRAME = 960
        private const val MIN_HOLD = 3
        private const val MAX_HOLD = 15
        private const val SLACK = 10
    }

    @Volatile var muted = false
    @Volatile var systemMuted = false
    @Volatile var held = false
    @Volatile var you = 0f
    @Volatile var it = 0f
    @Volatile var route = ""
    @Volatile private var aec = "off"
    @Volatile private var running = false
    private val queue = LinkedBlockingDeque<ByteArray>()
    private var hold = MIN_HOLD + 1
    private var underruns = 0
    private var dropped = 0
    private var played = 0
    private var deepest = 0
    private var holdMax = hold

    fun start(line: Line) {
        if (running) return
        running = true
        thread(name = "call-mic") { record(line) }
        thread(name = "call-speaker") { play(line) }
    }

    fun play(frame: ByteArray) {
        if (running) queue.offer(frame)
    }

    fun stop() {
        running = false
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun record(line: Line) {
        val size = maxOf(AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), FRAME * 4)
        val rec = runCatching {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
        }.getOrNull()?.takeIf { it.state == AudioRecord.STATE_INITIALIZED } ?: return
        aec = if (!AcousticEchoCanceler.isAvailable()) "unavailable"
        else AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.enabled = true; if (it.enabled) "on" else "refused" } ?: "failed"
        if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.enabled = true
        val silence = ByteArray(FRAME)
        try {
            rec.startRecording()
            val buf = ByteArray(FRAME)
            while (running) {
                var n = 0
                while (n < FRAME && running) {
                    val r = rec.read(buf, n, FRAME - n)
                    if (r < 0) return
                    n += r
                }
                val quiet = muted || systemMuted || held
                you = if (quiet) 0f else loudness(buf)
                line.audio(if (quiet) silence else buf.copyOf())
            }
        } finally {
            rec.release()
        }
    }

    private fun play(line: Line) {
        val size = maxOf(AudioTrack.getMinBufferSize(OUT_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), OUT_FRAME * 4)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(OUT_RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(size)
            .build()
        val silence = ByteArray(OUT_FRAME)
        var buffering = true
        var started = false
        var clean = SystemClock.elapsedRealtime()
        var report = clean
        try {
            track.play()
            while (running) {
                val now = SystemClock.elapsedRealtime()
                if (now - report >= 10_000) {
                    report = now
                    line.stats(stats())
                }
                if (buffering) {
                    if (queue.size < hold) {
                        Thread.sleep(5)
                        continue
                    }
                    buffering = false
                    started = true
                }
                val f = queue.poll(60, TimeUnit.MILLISECONDS)
                if (f == null) {
                    it = 0f
                    buffering = true
                    if (started) {
                        underruns++
                        hold = minOf(hold + 2, MAX_HOLD)
                        holdMax = maxOf(holdMax, hold)
                        clean = now
                    }
                    continue
                }
                if (now - clean >= 10_000 && hold > MIN_HOLD) {
                    hold--
                    clean = now
                }
                deepest = maxOf(deepest, queue.size)
                while (queue.size > hold + SLACK) {
                    queue.poll()
                    dropped++
                }
                played++
                it = if (held) 0f else loudness(f)
                track.write(if (held) silence else f, 0, f.size)
            }
        } finally {
            line.stats(stats())
            queue.clear()
            track.release()
        }
    }

    /** RMS of a frame, scaled so normal speech sits around 0.5. */
    private fun loudness(frame: ByteArray): Float {
        var sum = 0.0
        for (i in 0 until frame.size / 2) {
            val v = ((frame[2 * i + 1].toInt() shl 8) or (frame[2 * i].toInt() and 0xff)).toDouble()
            sum += v * v
        }
        return minOf(1f, (Math.sqrt(sum / (frame.size / 2)) / 32768 * 6).toFloat())
    }

    private fun stats() = JSONObject()
        .put("played", played).put("underruns", underruns).put("dropped", dropped)
        .put("hold_ms", hold * 20).put("hold_max_ms", holdMax * 20).put("deepest_ms", deepest * 20)
        .put("route", route).put("aec", aec)
}
