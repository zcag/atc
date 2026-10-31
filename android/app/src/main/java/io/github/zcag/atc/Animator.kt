package io.github.zcag.atc

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

/** One frame of a face: ARKit blend shape weights (0..1, by their standard names) plus head and eye rotation in
 *  radians. Any rig can take it: a glTF head maps the shapes onto its morph targets, a 2D rig onto its parameters. */
class Pose {
    val shapes = HashMap<String, Float>()
    var yaw = 0f
    var pitch = 0f
    var roll = 0f
    var eyeYaw = 0f
    var eyePitch = 0f

    operator fun get(name: String) = shapes[name] ?: 0f
    operator fun set(name: String, v: Float) {
        shapes[name] = v.coerceIn(0f, 1f)
    }
}

/** A critically damped spring: x follows its target smoothly at a speed set by hz, with no overshoot. */
class Spring(var x: Float = 0f, private val hz: Float) {
    private var v = 0f

    fun to(target: Float, dt: Float): Float {
        val w = 2f * PI.toFloat() * hz
        val f = 1f + 2f * dt * w
        val dtw2 = dt * w * w
        v = (v + dtw2 * (target - x)) / (f + dt * dtw2)
        x += v * dt
        return x
    }
}

/** The face's behaviour, procedural and live: what it does comes from the call (the state delta-talk reports,
 *  their voice's and the assistant's loudness on the phone), never from the assistant's words. It breathes, blinks
 *  at irregular intervals, makes small eye movements, sways a little; looks at them while listening and nods in
 *  their pauses; looks away while thinking; moves its jaw with the assistant's voice and lifts its brows and nods
 *  on emphasis. Deterministic for a seed, so tests can pin it down. */
class Animator(seed: Int = 1) {
    private val rnd = Random(seed)
    private var t = 0f
    private val pose = Pose()

    private var blinkAt = 1.5f
    private var blinkStart = -1f
    private var gazeAt = 0f
    private var gazeYaw = 0f
    private var gazePitch = 0f
    private val eyeYaw = Spring(hz = 9f)
    private val eyePitch = Spring(hz = 9f)
    private val headYaw = Spring(hz = 1.2f)
    private val headPitch = Spring(hz = 1.2f)
    private val headRoll = Spring(hz = .9f)
    private val jaw = Spring(hz = 11f)
    private val smile = Spring(hz = .8f)
    private val focus = Spring(hz = 1.5f)
    private val tilt = Spring(hz = .7f)
    private var slow = 0f
    private var nod = 0f
    private var brow = 0f
    private var youSince = -1f
    private var lastState = ""

    fun step(dt: Float, state: String, you: Float, it: Float): Pose {
        t += dt
        val speaking = state == "speaking"
        val thinking = state == "thinking" || state == "tool"
        val listening = state == "listening" || state == "hearing"
        if (state != lastState) {
            gazeAt = t
            lastState = state
        }

        blink(dt, if (thinking) 4.5f else if (speaking) 2.6f else 3.4f)
        gaze(thinking, speaking)
        listen(dt, you, listening)
        val voice = if (speaking) it else 0f
        emphasis(dt, voice)

        val sway = if (listening) .6f else 1f
        pose.eyeYaw = eyeYaw.to(gazeYaw, dt)
        pose.eyePitch = eyePitch.to(gazePitch, dt)
        pose.yaw = headYaw.to(gazeYaw * .35f + rad(2.2f) * sway * wave(.13f, .07f), dt)
        pose.pitch = headPitch.to(gazePitch * .3f + rad(1.2f) * sway * wave(.11f, .17f) + rad(.6f) * sin(2f * PI.toFloat() * .22f * t) + nod, dt)
        pose.roll = headRoll.to(rad(1.4f) * sway * wave(.09f, .05f) + tilt.to(if (state == "hearing") rad(3f) else if (thinking) rad(-2f) else 0f, dt), dt)

        val open = jaw.to(if (speaking) min(1f, voice.pow(.8f) * .85f) else 0f, dt)
        pose["jawOpen"] = open
        pose["mouthClose"] = if (speaking) 0f else .05f
        pose["mouthFunnel"] = open * (.15f + .15f * wave(1.7f, 2.9f))
        pose["mouthPucker"] = open * (.1f + .1f * wave(2.3f, 1.1f))
        pose["mouthStretch_L"] = open * .12f
        pose["mouthStretch_R"] = open * .12f
        val s = smile.to(if (listening) .22f else if (speaking) .12f else .02f, dt)
        pose["mouthSmile_L"] = s
        pose["mouthSmile_R"] = s
        pose["cheekSquint_L"] = s * .4f
        pose["cheekSquint_R"] = s * .4f

        val f = focus.to(if (thinking) 1f else 0f, dt)
        pose["browDown_L"] = .28f * f
        pose["browDown_R"] = .28f * f
        pose["eyeSquint_L"] = .25f * f + s * .3f
        pose["eyeSquint_R"] = .25f * f + s * .3f
        pose["browInnerUp"] = .06f + brow * .55f + (if (state == "hearing") .12f else 0f)
        pose["browOuterUp_L"] = brow * .4f
        pose["browOuterUp_R"] = brow * .4f

        val lookRight = max(0f, pose.eyeYaw) / rad(25f)
        val lookLeft = max(0f, -pose.eyeYaw) / rad(25f)
        val up = max(0f, pose.eyePitch) / rad(20f)
        val down = max(0f, -pose.eyePitch) / rad(20f)
        pose["eyeLookOut_R"] = lookRight
        pose["eyeLookIn_L"] = lookRight
        pose["eyeLookOut_L"] = lookLeft
        pose["eyeLookIn_R"] = lookLeft
        pose["eyeLookUp_L"] = up
        pose["eyeLookUp_R"] = up
        pose["eyeLookDown_L"] = down
        pose["eyeLookDown_R"] = down
        return pose
    }

    private fun blink(dt: Float, every: Float) {
        if (blinkStart < 0 && t >= blinkAt) blinkStart = t
        var shut = 0f
        if (blinkStart >= 0) {
            val k = t - blinkStart
            shut = when {
                k < .07f -> k / .07f
                k < .1f -> 1f
                k < .22f -> 1f - (k - .1f) / .12f
                else -> {
                    blinkStart = -1f
                    blinkAt = t + if (rnd.nextFloat() < .12f) .18f else every * (.45f + rnd.nextFloat() * 1.1f)
                    0f
                }
            }
        }
        pose["eyeBlink_L"] = shut
        pose["eyeBlink_R"] = shut
    }

    private fun gaze(thinking: Boolean, speaking: Boolean) {
        if (t < gazeAt) return
        val away = thinking || (speaking && rnd.nextFloat() < .18f)
        if (away) {
            gazeYaw = rad(9f + rnd.nextFloat() * 8f) * if (rnd.nextBoolean()) 1f else -1f
            gazePitch = rad(if (thinking) 5f + rnd.nextFloat() * 6f else -2f + rnd.nextFloat() * 4f)
            gazeAt = t + if (thinking) 1.4f + rnd.nextFloat() * 1.6f else .5f + rnd.nextFloat() * .5f
        } else {
            gazeYaw = rad((rnd.nextFloat() - .5f) * 3f)
            gazePitch = rad((rnd.nextFloat() - .5f) * 2f)
            gazeAt = t + .6f + rnd.nextFloat() * 1.6f
        }
        if (abs(gazeYaw - eyeYaw.x) > rad(8f) && blinkStart < 0 && rnd.nextFloat() < .5f) blinkAt = t
    }

    /** A small nod when they stop after talking for a while, as a listener does. */
    private fun listen(dt: Float, you: Float, listening: Boolean) {
        if (you > .12f) {
            if (youSince < 0) youSince = t
        } else if (youSince >= 0) {
            if (listening && t - youSince > .9f && rnd.nextFloat() < .7f) nod += rad(4f)
            youSince = -1f
        }
        nod *= exp(-dt * 5f)
    }

    /** The assistant's voice: a rise well above its recent level is a stressed word, which lifts the brows and nods. */
    private fun emphasis(dt: Float, voice: Float) {
        slow += (voice - slow) * min(1f, dt * 2.5f)
        if (voice - slow > .22f && brow < .3f) {
            brow = 1f
            nod += rad(1.8f)
        }
        brow *= exp(-dt * 3.5f)
    }

    private fun wave(a: Float, b: Float) = (sin(t * a * 2f * PI.toFloat()) + sin(t * b * 2f * PI.toFloat() * 1.618f + 1.3f)) * .5f

    private fun rad(deg: Float) = deg * PI.toFloat() / 180f
}
