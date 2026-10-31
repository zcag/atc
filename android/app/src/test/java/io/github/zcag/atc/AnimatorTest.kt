package io.github.zcag.atc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class AnimatorTest {
    private val dt = 1f / 60

    private fun run(seconds: Float, state: String, you: (Float) -> Float = { 0f }, it: (Float) -> Float = { 0f }, each: (Float, Pose) -> Unit) {
        val a = Animator(7)
        var t = 0f
        while (t < seconds) {
            each(t, a.step(dt, state, you(t), it(t)))
            t += dt
        }
    }

    @Test fun blinksNaturallyAndOpensAgain() {
        var blinks = 0
        var shut = false
        var last = 0f
        run(60f, "listening") { _, p ->
            if (p["eyeBlink_L"] > .9f && !shut) blinks++
            shut = p["eyeBlink_L"] > .9f
            last = p["eyeBlink_L"]
        }
        assertTrue("blinks a minute: $blinks", blinks in 10..30)
        assertTrue(last < 1f)
    }

    @Test fun jawFollowsTheAssistantsVoiceOnlyWhileSpeaking() {
        var loud = 0f
        var quiet = 1f
        run(4f, "speaking", it = { t -> if (t % 1f < .5f) .8f else 0f }) { t, p ->
            if (t > 1f && t % 1f in .3f..0.5f) loud = maxOf(loud, p["jawOpen"])
            if (t > 1f && t % 1f in .85f..0.99f) quiet = minOf(quiet, p["jawOpen"])
        }
        assertTrue("open while loud: $loud", loud > .35f)
        assertTrue("closed in the gaps: $quiet", quiet < .1f)
        var listening = 0f
        run(2f, "listening", it = { .8f }) { _, p -> listening = maxOf(listening, p["jawOpen"]) }
        assertEquals(0f, listening, .01f)
    }

    @Test fun looksAwayWhileThinkingAndAtHimWhileListening() {
        fun meanGaze(state: String): Float {
            var sum = 0f
            var n = 0
            run(30f, state) { t, p -> if (t > 2f) { sum += abs(p.eyeYaw); n++ } }
            return sum / n
        }
        assertTrue(meanGaze("thinking") > 3 * meanGaze("listening"))
    }

    @Test fun staysInRange() {
        run(20f, "speaking", it = { t -> abs(kotlin.math.sin(t * 7f)) }) { _, p ->
            p.shapes.values.forEach { assertTrue(it in 0f..1f) }
            assertTrue(abs(p.yaw) < .5f && abs(p.pitch) < .5f && abs(p.roll) < .5f)
        }
    }
}
