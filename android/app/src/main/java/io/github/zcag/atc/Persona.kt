package io.github.zcag.atc

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import android.view.View
import kotlin.math.sin

/** What the call screen shows of the assistant. A persona gets the call's state as it changes and reads both
 *  voices' loudness itself on every frame it draws (Calls.levels), so its movement follows the sound with no
 *  network delay. New looks plug in here: a character drawn on the phone, or video frames streamed for a face. */
interface Persona {
    val view: View
    fun face(f: Calls.Face)

    companion object {
        fun make(c: Context, name: String = "orb"): Persona = when (name) {
            else -> Orb(c)
        }
    }
}

/** A living orb: it swells with their voice while they talk, with the assistant's while it speaks, turns slowly
 *  while it thinks and warms to amber while a tool runs. Drawn by a shader on Android 13+, a soft disc before. */
class Orb(c: Context) : View(c), Persona {
    override val view get() = this

    private class Look(val a: FloatArray, val b: FloatArray, val spin: Float)

    private val looks = mapOf(
        "listening" to Look(floatArrayOf(.25f, .55f, 1f), floatArrayOf(.45f, .9f, .95f), .6f),
        "hearing" to Look(floatArrayOf(.2f, .85f, .55f), floatArrayOf(.6f, 1f, .7f), .8f),
        "thinking" to Look(floatArrayOf(.55f, .35f, 1f), floatArrayOf(.95f, .5f, .9f), 2.2f),
        "tool" to Look(floatArrayOf(1f, .6f, .2f), floatArrayOf(1f, .85f, .45f), 2.6f),
        "speaking" to Look(floatArrayOf(.35f, .6f, 1f), floatArrayOf(.95f, .95f, 1f), 1f),
    )
    private var state = "listening"
    private val a = looks.getValue(state).a.copyOf()
    private val b = looks.getValue(state).b.copyOf()
    private var spin = 1f
    private var level = 0f
    private var phase = 0f
    private var last = System.nanoTime()
    private val shader = if (Build.VERSION.SDK_INT >= 33) RuntimeShader(SRC) else null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun face(f: Calls.Face) {
        state = f.state.takeIf { it in looks } ?: "listening"
    }

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = ((now - last) / 1e9f).coerceIn(0f, .1f)
        last = now
        val t = now / 1e9f
        val (you, it) = Calls.levels()
        val target = when (state) {
            "speaking" -> .15f + it
            "hearing" -> .1f + you
            "thinking", "tool" -> .22f + .1f * sin(t * 3f)
            else -> .06f + .03f * sin(t * 1.4f) + you * .5f
        }
        level += (target - level) * if (target > level) .35f else .12f
        val look = looks.getValue(state)
        for (i in 0..2) {
            a[i] += (look.a[i] - a[i]) * .06f
            b[i] += (look.b[i] - b[i]) * .06f
        }
        spin += (look.spin - spin) * .05f
        phase += dt * spin
        val w = width.toFloat()
        val h = height.toFloat()
        if (shader != null) {
            shader.setFloatUniform("size", w, h)
            shader.setFloatUniform("t", phase)
            shader.setFloatUniform("level", level.coerceIn(0f, 1.2f))
            shader.setFloatUniform("c1", a[0], a[1], a[2])
            shader.setFloatUniform("c2", b[0], b[1], b[2])
            paint.shader = shader
            canvas.drawPaint(paint)
        } else {
            val r = minOf(w, h) * (.28f + .12f * level)
            paint.shader = RadialGradient(w / 2, h / 2, r * 1.4f, rgb(b), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            canvas.drawCircle(w / 2, h / 2, r * 1.4f, paint)
            paint.shader = RadialGradient(w / 2, h / 2, r, rgb(b), rgb(a), Shader.TileMode.CLAMP)
            canvas.drawCircle(w / 2, h / 2, r, paint)
        }
        postInvalidateOnAnimation()
    }

    private fun rgb(c: FloatArray) = Color.rgb(c[0], c[1], c[2])

    companion object {
        private const val SRC = """
            uniform float2 size;
            uniform float t;
            uniform float level;
            uniform float3 c1;
            uniform float3 c2;

            half4 main(float2 p) {
                float2 uv = (p - size * 0.5) / min(size.x, size.y);
                float r = length(uv);
                float a = atan(uv.y, uv.x);
                float wob = 0.030 * sin(a * 3.0 + t * 1.3) + 0.022 * sin(a * 5.0 - t * 1.7) + 0.016 * sin(a * 7.0 + t * 2.3);
                float radius = 0.26 + 0.11 * level + wob * (0.5 + 1.6 * level);
                float d = r - radius;
                float body = smoothstep(0.008, -0.008, d);
                float glow = exp(-max(d, 0.0) * (10.0 - 4.0 * min(level, 1.0))) * (0.25 + 0.6 * min(level, 1.0));
                float swirl = 0.5 + 0.5 * sin(a * 2.0 + t * 0.9 + r * 9.0 - level * 3.0);
                float3 col = mix(c1, c2, swirl);
                float core = 0.75 + 0.35 * (1.0 - clamp(r / radius, 0.0, 1.0));
                float alpha = clamp(body + glow * 0.85, 0.0, 1.0);
                float3 rgb = col * (body * core + glow * (1.0 - body));
                return half4(half3(rgb), half(alpha));
            }
        """
    }
}
