package io.github.zcag.atc

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread
import kotlin.math.sin

/** What the call screen shows of the assistant. A persona gets the call's state as it changes and reads both
 *  voices' loudness itself on every frame it draws (Calls.levels), so its movement follows the sound with no
 *  network delay. New looks plug in here: a character drawn on the phone, or video frames streamed for a face. */
interface Persona {
    val view: View
    fun face(f: Calls.Face)

    /** A persona that needs a while before its first frame (a character uploading its textures) returns true and
     *  calls [go] on the UI thread once that frame is up; the host keeps the old one on screen until then and fades
     *  the new one in over it. One that draws at once returns false and is swapped in directly. */
    fun drawn(go: () -> Unit) = false

    companion object {
        fun make(c: Context): Persona = PersonaHost(c)
    }
}

/** The call screen's persona slot: the orb at once, then the chosen character once its files are on the phone.
 *  Characters are folders on the server under /app/personas/<name>/ (persona.json with "kind" and "files", plus
 *  those files), listed in /app/personas/index.json ({"default": name, "personas": [{"name", "rev"}]}), and
 *  cached on the phone until their rev changes. A long press switches to the next one, and the choice is kept. */
class PersonaHost(c: Context) : FrameLayout(c), Persona {
    override val view get() = this
    private var current: Persona = Orb(c)
    private var face = Calls.Face()
    private var names = listOf("orb")
    private val ui = Handler(Looper.getMainLooper())

    init {
        addView(current.view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        setOnLongClickListener {
            val next = names[(names.indexOf(Prefs(context).persona ?: "orb") + 1) % names.size]
            Prefs(context).persona = next
            Toast.makeText(context, next, Toast.LENGTH_SHORT).show()
            load(next)
            true
        }
        load(Prefs(c).persona)
    }

    override fun face(f: Calls.Face) {
        face = f
        current.face(f)
    }

    private fun load(chosen: String?) = thread {
        val made = runCatching {
            val server = Prefs(context).server ?: return@thread
            val index = JSONObject(Net.get(context, "$server/app/personas/index.json"))
            val list = index.optJSONArray("personas") ?: JSONArray()
            names = listOf("orb") + List(list.length()) { list.getJSONObject(it).getString("name") }
            val name = chosen ?: index.optString("default", "orb")
            if (name == "orb" || name !in names) return@runCatching null
            val rev = List(list.length()) { list.getJSONObject(it) }.first { it.getString("name") == name }.optString("rev")
            val dir = File(context.filesDir, "personas/$name")
            val spec = File(dir, "persona.json")
            if (File(dir, ".rev").takeIf { it.exists() }?.readText() != rev || !spec.exists()) {
                dir.deleteRecursively()
                dir.mkdirs()
                Net.download(context, "$server/app/personas/$name/persona.json", spec)
                val files = JSONObject(spec.readText()).optJSONArray("files") ?: JSONArray()
                for (i in 0 until files.length()) {
                    val file = File(dir, files.getString(i)).apply { parentFile?.mkdirs() }
                    Net.download(context, "$server/app/personas/$name/${files.getString(i)}", file)
                }
                File(dir, ".rev").writeText(rev)
            }
            dir to JSONObject(spec.readText())
        }.onFailure { Log.w("atc", "persona: ${it.message}") }.getOrNull()
        ui.post { show(made) }
    }

    private fun show(made: Pair<File, JSONObject>?) {
        if (!isAttachedToWindow) return
        val next = runCatching {
            when (made?.second?.optString("kind")) {
                "head3d" -> Head3D(context, made.first, made.second)
                "live2d" -> Live2D(context, made.first, made.second)
                "illustration" -> Illustration(context, made.first)
                else -> Orb(context)
            }
        }.onFailure { Log.w("atc", "persona: ${it.message}") }.getOrElse { Orb(context) }
        current = next
        next.face(face)
        val fades = next.drawn {
            if (current === next) next.view.animate().alpha(1f).setDuration(400).withEndAction { keepOnly(next.view) }
        }
        if (fades) next.view.alpha = UNSEEN else removeAllViews()
        addView(next.view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    private fun keepOnly(v: View) {
        for (i in childCount - 1 downTo 0) if (getChildAt(i) !== v) removeViewAt(i)
    }

    companion object {
        /** Faint enough not to show, yet still drawn: a view at alpha 0 is skipped, and a TextureView only gets its
         *  surface once it is drawn. */
        private const val UNSEEN = .01f
    }
}

/** The assistant as a living orb: a glassy sphere with light flowing inside, a soft glow and haze behind it, a floor
 *  line and its reflection, all drawn with transparency over the call screen. It breathes and drifts, swells and
 *  ripples with their voice while they talk and with its own while it speaks, swirls faster and turns violet while it
 *  thinks, warms to amber while a tool runs. A shader on Android 13+, a soft disc before. */
class Orb(c: Context) : View(c), Persona {
    override val view get() = this

    private class Look(val a: FloatArray, val b: FloatArray, val c: FloatArray)

    private val looks = mapOf(
        "listening" to Look(floatArrayOf(.18f, .42f, 1f), floatArrayOf(.35f, .85f, .95f), floatArrayOf(.85f, .95f, 1f)),
        "hearing" to Look(floatArrayOf(.12f, .7f, .55f), floatArrayOf(.45f, .95f, .75f), floatArrayOf(.9f, 1f, .85f)),
        "thinking" to Look(floatArrayOf(.45f, .25f, .95f), floatArrayOf(.9f, .45f, .85f), floatArrayOf(1f, .8f, .95f)),
        "tool" to Look(floatArrayOf(.95f, .5f, .15f), floatArrayOf(1f, .8f, .4f), floatArrayOf(1f, .95f, .8f)),
        "speaking" to Look(floatArrayOf(.3f, .42f, 1f), floatArrayOf(.62f, .7f, 1f), floatArrayOf(.95f, .85f, 1f)),
    )
    private var state = "listening"
    private val col = Array(3) { looks.getValue(state).let { l -> listOf(l.a, l.b, l.c)[it].copyOf() } }
    private var level = 0f
    private var think = 0f
    private var hear = 0f
    private var speak = 0f
    private var start = System.nanoTime()
    private val shader = if (Build.VERSION.SDK_INT >= 33) runCatching { RuntimeShader(SRC) }.onFailure { Log.w("atc", "orb: $it") }.getOrNull() else null
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun face(f: Calls.Face) {
        state = f.state.takeIf { it in looks } ?: "listening"
    }

    override fun onDraw(canvas: Canvas) {
        val t = (System.nanoTime() - start) / 1e9f
        val (you, it) = Calls.levels()
        val target = when (state) {
            "speaking" -> .1f + it
            "hearing" -> .08f + you
            "thinking", "tool" -> .22f + .1f * sin(t * 3f)
            else -> .05f + you * .4f
        }
        level += (target - level) * if (target > level) .35f else .1f
        think += ((if (state == "thinking" || state == "tool") 1f else 0f) - think) * .04f
        hear += ((if (state == "hearing") 1f else 0f) - hear) * .06f
        speak += ((if (state == "speaking") 1f else 0f) - speak) * .06f
        val look = looks.getValue(state)
        listOf(look.a, look.b, look.c).forEachIndexed { i, want -> for (j in 0..2) col[i][j] += (want[j] - col[i][j]) * .04f }
        val w = width.toFloat()
        val h = height.toFloat()
        if (shader != null) {
            shader.setFloatUniform("size", w, h)
            shader.setFloatUniform("t", t)
            shader.setFloatUniform("level", level.coerceIn(0f, 1.2f))
            shader.setFloatUniform("think", think)
            shader.setFloatUniform("hear", hear)
            shader.setFloatUniform("speak", speak)
            shader.setFloatUniform("c1", col[0][0], col[0][1], col[0][2])
            shader.setFloatUniform("c2", col[1][0], col[1][1], col[1][2])
            shader.setFloatUniform("c3", col[2][0], col[2][1], col[2][2])
            paint.shader = shader
            canvas.drawPaint(paint)
        } else {
            val r = minOf(w, h) * (.22f + .08f * level)
            paint.shader = RadialGradient(w / 2, h / 2, r * 1.6f, rgb(col[1]), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            canvas.drawCircle(w / 2, h / 2, r * 1.6f, paint)
            paint.shader = RadialGradient(w / 2, h / 2, r, rgb(col[2]), rgb(col[0]), Shader.TileMode.CLAMP)
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
            uniform float think;
            uniform float hear;
            uniform float speak;
            uniform float3 c1;
            uniform float3 c2;
            uniform float3 c3;

            float hash(float3 p) {
                p = fract(p * 0.3183099 + 0.1);
                p *= 17.0;
                return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
            }

            float noise(float3 x) {
                float3 i = floor(x);
                float3 f = fract(x);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(mix(hash(i), hash(i + float3(1, 0, 0)), f.x), mix(hash(i + float3(0, 1, 0)), hash(i + float3(1, 1, 0)), f.x), f.y),
                           mix(mix(hash(i + float3(0, 0, 1)), hash(i + float3(1, 0, 1)), f.x), mix(hash(i + float3(0, 1, 1)), hash(i + float3(1, 1, 1)), f.x), f.y), f.z);
            }

            float fbm(float3 p) {
                float a = 0.5;
                float s = 0.0;
                for (int i = 0; i < 4; i++) {
                    s += a * noise(p);
                    p = p * 2.03 + 3.1;
                    a *= 0.5;
                }
                return s;
            }

            half4 main(float2 px) {
                float2 uv = (px - 0.5 * size) / min(size.x, size.y);
                uv.y = -uv.y;
                float floorY = -0.3;
                float3 tint = mix(c1, c2, 0.55);
                float lv = min(level, 1.0);
                float haze = fbm(float3(uv * 1.4 + float2(t * 0.015, t * 0.008), t * 0.025));
                float vig = smoothstep(0.75, 0.1, length(uv * float2(0.8, 1.0)));
                float a = 0.1 * smoothstep(0.35, 0.85, haze) * vig;
                float3 col = tint * a;
                float line = 0.08 * exp(-abs(uv.y - floorY) * 30.0) * smoothstep(0.5, 0.0, abs(uv.x));
                col += tint * line;
                a += line;
                float2 o = float2(0.0, 0.05 + 0.012 * sin(t * 0.8));
                float r = 0.2 + 0.01 * sin(t * 1.25) + 0.03 * lv;
                float2 q = uv - o;
                float ang = atan(q.y, q.x);
                r += (0.002 + 0.01 * speak * lv) * sin(ang * 3.0 + t * 2.2) + (0.002 + 0.008 * hear * lv) * sin(ang * 4.0 - t * 2.9);
                float d = length(q);
                float glow = exp(-max(d - r, 0.0) * (7.0 - 3.0 * lv)) * (0.22 + 0.45 * lv) * smoothstep(0.62, 0.22, d);
                col += tint * glow;
                a += glow * 0.9;
                float below = smoothstep(floorY + 0.01, floorY - 0.02, uv.y);
                float2 m = float2(uv.x, 2.0 * floorY - uv.y) - o;
                float md = length(m);
                float refl = (smoothstep(r, r - 0.08, md) * 0.3 + exp(-max(md - r, 0.0) * 7.0) * 0.1) * below * exp(-(floorY - uv.y) * 6.0);
                col += tint * refl;
                a += refl;
                float2 edge2 = 0.5 * size / min(size.x, size.y);
                float keep = smoothstep(edge2.x, edge2.x - 0.12, abs(uv.x)) * smoothstep(edge2.y, edge2.y - 0.12, abs(uv.y));
                col *= keep;
                a *= keep;
                if (d < r) {
                    float z = sqrt(max(r * r - d * d, 0.0)) / r;
                    float3 nrm = normalize(float3(q / r, z));
                    float spin = t * (0.12 + 0.45 * think);
                    float3 pp = nrm * 1.3;
                    pp = float3(cos(spin) * pp.x - sin(spin) * pp.z, pp.y, sin(spin) * pp.x + cos(spin) * pp.z);
                    float3 w = float3(fbm(pp * 1.7 + t * 0.06), fbm(pp * 1.7 + 4.3 - t * 0.05), fbm(pp * 1.7 + 8.1));
                    float bands = fbm(pp * 0.9 + w * (0.9 + 0.8 * lv) + float3(0.0, 0.0, t * (0.12 + 0.4 * lv)));
                    float stripe = smoothstep(0.42, 0.62, bands) - smoothstep(0.62, 0.8, bands);
                    float3 inner = mix(mix(c1, c2, 0.25) * 0.7, c1, smoothstep(0.2, 0.55, bands));
                    inner = mix(inner, c2, smoothstep(0.5, 0.78, bands));
                    inner += c3 * stripe * (0.1 + 0.22 * lv);
                    inner *= 0.75 + 0.45 * z;
                    inner += mix(c2, float3(1.0), 0.3) * pow(z, 3.0) * 0.35;
                    float fres = pow(1.0 - z, 3.0);
                    float rim = smoothstep(0.0, 0.12, 1.0 - z) * smoothstep(0.35, 0.05, 1.0 - z);
                    float spec = pow(max(dot(nrm, normalize(float3(-0.45, 0.6, 0.75))), 0.0), 22.0);
                    float3 orb = inner + fres * mix(c2, float3(1.0), 0.5) * 0.55 + rim * tint * 0.25 + spec * 0.35;
                    orb = orb / (1.0 + orb * 0.35);
                    float edge = smoothstep(r, r - 0.004, d);
                    col = col * (1.0 - edge) + orb * edge;
                    a = a * (1.0 - edge) + edge;
                }
                a = clamp(a, 0.0, 1.0);
                return half4(half3(min(col, float3(a))), half(a));
            }
        """
    }
}
