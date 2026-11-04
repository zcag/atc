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
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.telecom.DisconnectCause
import android.os.Build
import android.telecom.CallEndpoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
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
        val held: Boolean = false,
    ) {
        val live get() = phase != Phase.Idle && phase != Phase.Ended
    }

    enum class Cmd { Answer, Hangup, Mute, Speaker, Hold, Unhold, Resume, Interrupt }

    /** What the assistant is doing, from the talker: listening, hearing (the user), thinking, tool, speaking. */
    data class Face(val state: String = "listening", val hearing: String = "", val you: String = "", val said: String = "", val tool: String = "")

    sealed interface Wire {
        data object Active : Wire
        class Ended(val why: String) : Wire
    }

    val state = MutableStateFlow(State())
    val face = MutableStateFlow(Face())
    @Volatile var voice: Voice? = null

    /** The user's voice's and the assistant's loudness right now, 0 to 1, measured on the phone. */
    fun levels() = voice?.let { it.you to it.heard()[0] } ?: (0f to 0f)

    /** The assistant's voice as it is heard now: [loudness, below 700 Hz, above 3 kHz], each 0..1. */
    fun speech() = voice?.heard() ?: FloatArray(3)

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
        if (state.value.live || Build.VERSION.SDK_INT < 34) return false
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
            Diag.send(app)
        }
        return true
    }

    private suspend fun run(app: Context, server: String, incoming: Boolean, inbox: Channel<Cmd>): String {
        val wire = Channel<Wire>(Channel.UNLIMITED)
        val voice = Voice()
        this.voice = voice
        val line = Line(app, "$server/api/call/line", voice, wire)
        line.open(if (incoming) "ringing" else "call")
        val tele = Telecom(app, inbox)
        try {
            tele.add(incoming, address(app, server))
            return session(app, tele, line, voice, incoming, inbox, wire)
        } finally {
            voice.stop()
            line.close()
            this.voice = null
        }
    }

    /** What the phone's call log shows for these calls: the assistant's own phone line (its number, from atc's
     *  /api/me), so calling back from recents reaches the assistant over the SIM line; sip:assistant@atc without it. */
    private suspend fun address(app: Context, server: String): Uri {
        val number = withContext(Dispatchers.IO) {
            runCatching { JSONObject(Net.get(app, "$server/api/me")).optString("callNumber") }.getOrNull()
        }.orEmpty()
        if (number.isEmpty()) return Uri.fromParts("sip", "assistant@atc", null)
        Prefs(app).callNumber = number
        Contact.ensure(app, number)
        return Uri.fromParts("tel", number, null)
    }

    private suspend fun session(
        app: Context, tele: Telecom, line: Line, voice: Voice, incoming: Boolean, inbox: Channel<Cmd>, wire: Channel<Wire>,
    ): String = coroutineScope {
        val watchers = listOf(
            launch {
                tele.endpoint.collect { e ->
                    if (e == null) return@collect
                    voice.route = when (e.endpointType) {
                        CallEndpoint.TYPE_EARPIECE -> "earpiece"
                        CallEndpoint.TYPE_SPEAKER -> "speaker"
                        CallEndpoint.TYPE_BLUETOOTH -> "bluetooth"
                        CallEndpoint.TYPE_WIRED_HEADSET -> "wired"
                        else -> "other"
                    }
                    update { copy(speaker = e.endpointType == CallEndpoint.TYPE_SPEAKER) }
                }
            },
            launch { tele.muted.collect { m -> voice.systemMuted = m; update { copy(muted = voice.muted) } } },
            launch { Cellular.idle(app).collect { if (state.value.held) inbox.send(Cmd.Resume) } },
        )
        fun hold(on: Boolean) {
            voice.held = on
            line.send(if (on) "hold" else "unhold")
            update { copy(held = on) }
        }
        val timeout = launch {
            delay(if (incoming) 60_000 else 20_000)
            wire.send(Wire.Ended("no answer"))
        }
        var answered = !incoming
        var ended: String? = null
        while (ended == null) {
            val why: String? = select {
                inbox.onReceive { cmd ->
                    when (cmd) {
                        Cmd.Answer -> {
                            if (!answered) {
                                answered = true
                                tele.answer()
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
                            val all = tele.endpoints.value
                            val want = if (state.value.speaker) all.filter { it.endpointType != CallEndpoint.TYPE_SPEAKER }.maxByOrNull { it.endpointType }
                            else all.firstOrNull { it.endpointType == CallEndpoint.TYPE_SPEAKER }
                            want?.let { tele.route(it) }
                            null
                        }
                        Cmd.Interrupt -> {
                            voice.flush()
                            line.send("interrupt")
                            null
                        }
                        Cmd.Hold, Cmd.Unhold -> {
                            hold(cmd == Cmd.Hold)
                            null
                        }
                        Cmd.Resume -> {
                            if (state.value.held && tele.setActive()) hold(false)
                            null
                        }
                    }
                }
                wire.onReceive { w ->
                    when (w) {
                        Wire.Active -> {
                            timeout.cancel()
                            if (state.value.phase != Phase.Active) {
                                if (!incoming) tele.setActive()
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
                    else -> if (incoming && !answered) DisconnectCause.MISSED else DisconnectCause.REMOTE
                }
                tele.disconnect(cause)
                (watchers + timeout).forEach { it.cancel() }
                if (incoming && !answered && why != "declined") CallNote.missed(app, state.value.reason)
                ended = why
            }
        }
        ended!!
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
                    "flush" -> voice.flush()
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

    fun report(o: JSONObject) {
        if (live) ws?.send(o.toString())
    }

    fun close() {
        closed = true
        ws?.close(1000, null)
    }

    private fun cmd(name: String) = JSONObject().put("cmd", name).toString()
}

/** Call audio: the user's voice at 16 kHz (what the speech recognition takes) and the assistant's at 24 kHz (Higgs' own
 *  rate), mono s16le in 20 ms frames. Playback holds a few frames before it starts and after it runs dry, so network
 *  jitter does not cut words. Each time it runs dry mid-call it holds enough to cover the longest wait between frames of
 *  the last 30 s (at least two more, up to 1 s: on a phone's mobile data a frame came up to 0.37 s late on one call,
 *  and bursts reached 1.7 s), and gives one back after each 10 s that played clean. A burst is shed through silent frames,
 *  never speech (the old cap of hold + 200 ms dropped words). The counters go to the call line every 10 s, into the call's log
 *  line, with each frame's arrival time (android/bench/where.py, replay.py). */
class Voice {
    companion object {
        const val RATE = 16_000
        const val FRAME = 640
        const val OUT_RATE = 24_000
        const val OUT_FRAME = 960
        private const val MIN_HOLD = 3
        private const val MAX_HOLD = 50
        private const val SLACK = 10
        private const val MAX_QUEUE = 150
        private const val SPIKE_MS = 30_000
        private val GAP_STEPS = intArrayOf(100, 250, 500, 1000)
    }

    @Volatile var muted = false
    @Volatile var systemMuted = false
    @Volatile var held = false
    @Volatile var you = 0f
    @Volatile var route = ""
    @Volatile private var aec = "off"
    @Volatile private var micFrames = 0
    @Volatile private var micZero = 0
    @Volatile private var withheld = 0
    @Volatile private var running = false
    private val queue = LinkedBlockingDeque<ByteArray>()
    private var hold = MIN_HOLD + 1
    private var underruns = 0
    private var dropped = 0
    private var played = 0
    private var deepest = 0
    private var holdMax = hold
    private class Arrival(val gap: Int, val speech: Boolean, val wall: Long)
    private val arrivals = java.util.concurrent.ConcurrentLinkedQueue<Arrival>()
    @Volatile private var lastArrival = 0L
    @Volatile private var spike = 0
    @Volatile private var spikeAt = 0L
    private var gapMax = 0
    private val gapsOver = IntArray(4)
    private var speechDropped = 0
    private var breaks = 0
    private var breakMs = 0L
    private class Heard(val at: Long, val v: FloatArray)
    private val heard = java.util.concurrent.ConcurrentLinkedDeque<Heard>()
    @Volatile private var now = Heard(0, FloatArray(3))
    private var low = 0f
    private var high = 0f

    /** What the speaker is playing now, from the frames written to it: [loudness, low band, high band]. Silence
     *  once nothing has played for a little while (an underrun, the end of a reply). */
    fun heard(): FloatArray {
        val t = SystemClock.elapsedRealtime()
        while (true) {
            val h = heard.peekFirst() ?: break
            if (h.at > t) break
            now = heard.pollFirst() ?: break
        }
        return if (t - now.at > 120) FloatArray(3) else now.v
    }

    /** Loudness overall and in a low and a high band of one frame, as one-pole filters see them, stamped with when
     *  the speaker plays it: a written frame waits behind the track's buffer. */
    private fun measure(frame: ByteArray, delay: Long) {
        val a = .167f
        val b = .545f
        var all = 0.0
        var lo = 0.0
        var hi = 0.0
        for (i in 0 until frame.size / 2) {
            val v = ((frame[2 * i + 1].toInt() shl 8) or (frame[2 * i].toInt() and 0xff)) / 32768f
            low += a * (v - low)
            high += b * (v - high)
            all += v * v
            lo += low * low
            hi += (v - high) * (v - high)
        }
        val n = frame.size / 2
        val k = { e: Double -> minOf(1f, (Math.sqrt(e / n) * 6).toFloat()) }
        heard.offerLast(Heard(SystemClock.elapsedRealtime() + delay, floatArrayOf(k(all), k(lo), k(hi))))
        while (heard.size > 64) heard.pollFirst()
    }

    fun start(line: Line) {
        if (running) return
        running = true
        thread(name = "call-mic") { record(line) }
        thread(name = "call-speaker") { play(line) }
    }

    fun play(frame: ByteArray) {
        if (!running) return
        val now = SystemClock.elapsedRealtime()
        val gap = if (lastArrival == 0L) 0 else (now - lastArrival).toInt()
        arrivals.offer(Arrival(gap, !silent(frame), System.currentTimeMillis()))
        lastArrival = now
        if (gap >= spike || now - spikeAt > SPIKE_MS) {
            spike = gap
            spikeAt = now
        }
        queue.offer(frame)
    }

    private fun silent(f: ByteArray) = f.all { it == 0.toByte() }

    /** Drop what is queued: the user cut the assistant off (a tap, or the talker heard them talk over it), so nothing already sent plays. */
    fun flush() = queue.clear()

    /** Frames to hold so the longest recent wait between frames does not run the speaker dry. */
    private fun spikeHold(now: Long) = if (now - spikeAt > SPIKE_MS) 0 else spike / 20 + 1

    /** When each of the assistant's frames reached the phone since the last trace: the gap after the previous one in ms and
     *  whether it was speech, so the call line can line it up with what atc's relay sent and replay it in tests. */
    private fun trace(line: Line) {
        val gaps = org.json.JSONArray()
        val speech = StringBuilder()
        var at = 0L
        while (true) {
            val a = arrivals.poll() ?: break
            if (at == 0L) at = a.wall
            gaps.put(a.gap)
            speech.append(if (a.speech) '1' else '0')
            gapMax = maxOf(gapMax, a.gap)
            GAP_STEPS.forEachIndexed { i, step -> if (a.gap >= step) gapsOver[i]++ }
        }
        if (at != 0L) line.report(JSONObject().put("cmd", "trace").put("at", at).put("gaps", gaps).put("speech", speech))
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
                if (quiet) withheld++ else if (buf.all { it == 0.toByte() }) micZero++
                micFrames++
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
        var lastPlayed = clean
        var lastSpeech = false
        var dry = false
        try {
            track.play()
            while (running) {
                val now = SystemClock.elapsedRealtime()
                if (now - report >= 10_000) {
                    report = now
                    trace(line)
                    line.report(stats())
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
                    buffering = true
                    if (started) {
                        dry = true
                        underruns++
                        hold = minOf(maxOf(hold + 2, spikeHold(now)), MAX_HOLD)
                        holdMax = maxOf(holdMax, hold)
                        clean = now
                    }
                    continue
                }
                if (now - clean >= 10_000 && hold > maxOf(MIN_HOLD, spikeHold(now))) {
                    hold--
                    clean = now
                }
                deepest = maxOf(deepest, queue.size)
                trim()
                val speech = !silent(f)
                if (dry && speech && lastSpeech) {
                    breaks++
                    breakMs += now - lastPlayed - 20
                }
                dry = false
                lastSpeech = speech
                lastPlayed = now
                played++
                track.write(if (held) silence else f, 0, f.size)
                measure(if (held) silence else f, 1000L * track.bufferSizeInFrames / OUT_RATE)
            }
        } finally {
            trace(line)
            line.report(stats())
            queue.clear()
            track.release()
        }
    }

    /** A burst left more queued than the hold needs: shed silent frames (the talker sends digital zero between and around
     *  sentences) so the delay comes back down without cutting a word; speech goes only past MAX_QUEUE (3 s). */
    private fun trim() {
        val extra = queue.size - (hold + SLACK)
        if (extra <= 0) return
        var shed = 0
        val it = queue.iterator()
        while (shed < extra && it.hasNext()) {
            if (silent(it.next())) {
                it.remove()
                shed++
            }
        }
        dropped += shed
        while (queue.size > MAX_QUEUE) {
            if (!silent(queue.poll() ?: break)) speechDropped++
            dropped++
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

    private fun stats() = JSONObject().put("cmd", "stats")
        .put("speech_dropped", speechDropped).put("breaks", breaks).put("break_ms", breakMs)
        .put("gap_max_ms", gapMax).put("gaps_over", org.json.JSONObject().apply { GAP_STEPS.forEachIndexed { i, s -> put("$s", gapsOver[i]) } })
        .put("played", played).put("underruns", underruns).put("dropped", dropped)
        .put("hold_ms", hold * 20).put("hold_max_ms", holdMax * 20).put("deepest_ms", deepest * 20)
        .put("route", route).put("aec", aec)
        .put("mic_frames", micFrames).put("mic_zero", micZero).put("withheld", withheld)
        .put("muted", muted).put("system_muted", systemMuted).put("held", held)
}
