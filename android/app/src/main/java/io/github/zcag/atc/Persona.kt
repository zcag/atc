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

/** The assistant as a living orb filling the call screen: a liquid blob, raymarched, with iridescent skin, light and
 *  glowing filaments swirling inside, a halo, drifting dust and an aurora behind it. It breathes and turns, its surface
 *  ripples with their voice while they talk and with its own while it speaks (sound rings spread out from it then), sparks
 *  orbit it while it thinks, and each state has its own colours. A shader on Android 13+, a soft disc before. The same
 *  shader as the web's ORB_SRC in web/app.js, in AGSL. */
class Orb(c: Context) : View(c), Persona {
    override val view get() = this

    private class Look(val a: FloatArray, val b: FloatArray, val c: FloatArray)

    private val looks = mapOf(
        "listening" to Look(floatArrayOf(.08f, .25f, .9f), floatArrayOf(.2f, .75f, 1f), floatArrayOf(.75f, .5f, 1f)),
        "hearing" to Look(floatArrayOf(.02f, .42f, .4f), floatArrayOf(.2f, .95f, .7f), floatArrayOf(.85f, 1f, .5f)),
        "thinking" to Look(floatArrayOf(.3f, .1f, .85f), floatArrayOf(.85f, .3f, .95f), floatArrayOf(.3f, .75f, 1f)),
        "tool" to Look(floatArrayOf(.8f, .25f, .05f), floatArrayOf(1f, .65f, .2f), floatArrayOf(1f, .3f, .5f)),
        "speaking" to Look(floatArrayOf(.12f, .18f, .95f), floatArrayOf(.35f, .65f, 1f), floatArrayOf(1f, .45f, .85f)),
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
            shader.setFloatUniform("bg", 1f)
            shader.setFloatUniform("rad", if (h > w * 1.3f) .27f else .19f)
            shader.setFloatUniform("lift", if (h > w * 1.3f) .1f else .07f)
            shader.setFloatUniform("c1", col[0][0], col[0][1], col[0][2])
            shader.setFloatUniform("c2", col[1][0], col[1][1], col[1][2])
            shader.setFloatUniform("c3", col[2][0], col[2][1], col[2][2])
            paint.shader = shader
            canvas.drawPaint(paint)
        } else {
            canvas.drawColor(BACKDROP)
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
        const val BACKDROP = 0xff05070d.toInt()
        private const val SRC = """
            uniform float2 size;
            uniform float t;
            uniform float level;
            uniform float think;
            uniform float hear;
            uniform float speak;
            uniform float bg;
            uniform float rad;
            uniform float lift;
            uniform float3 c1;
            uniform float3 c2;
            uniform float3 c3;
            float hash(float3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
            float hash2(float2 p) { p = fract(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
            float noise(float3 x) { float3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
              return mix(mix(mix(hash(i), hash(i + float3(1,0,0)), f.x), mix(hash(i + float3(0,1,0)), hash(i + float3(1,1,0)), f.x), f.y),
                         mix(mix(hash(i + float3(0,0,1)), hash(i + float3(1,0,1)), f.x), mix(hash(i + float3(0,1,1)), hash(i + float3(1,1,1)), f.x), f.y), f.z); }
            float fbm(float3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.03 + 3.1; a *= 0.5; } return s; }
            float blob(float3 p, float lv) {
              float amp = 0.025 + 0.015 * think + lv * (0.045 * speak + 0.035 * hear + 0.015);
              float d = sin(p.x * 2.1 + t * 1.3) * sin(p.y * 2.4 - t * 1.1) * sin(p.z * 1.9 + t * 0.9);
              d += 0.5 * sin(p.x * 4.3 - t * 2.1 + p.y * 1.7) * sin(p.z * 3.9 + t * 1.7);
              d += (0.2 + 0.5 * think + 0.6 * speak * lv) * sin(dot(p, float3(5.1, 6.7, 4.3)) + t * (3.0 + 4.0 * lv));
              return length(p) - (1.0 + 0.025 * sin(t * 1.2) + 0.07 * lv) - d * amp;
            }
            float3 normalAt(float3 p, float lv) {
              float2 e = float2(0.003, -0.003);
              return normalize(e.xyy * blob(p + e.xyy, lv) + e.yyx * blob(p + e.yyx, lv) + e.yxy * blob(p + e.yxy, lv) + e.xxx * blob(p + e.xxx, lv));
            }
            half4 main(float2 px) {
              float2 uv = (px - 0.5 * size) / min(size.x, size.y);
              uv.y = -uv.y;
              float lv = min(level, 1.0);
              float2 ctr = float2(0.0, lift + 0.012 * sin(t * 0.8));
              float2 q = (uv - ctr) / rad;
              float dq = length(q);
              float3 tint = mix(c1, c2, 0.55);
              float3 col = float3(0.0);
              float a = 0.0;
              if (bg > 0.0) {
                float n1 = fbm(float3(uv * 1.3, t * 0.04));
                float n2 = fbm(float3(uv * 1.1 + n1 * 1.8 + float2(t * 0.03, -t * 0.02), t * 0.05 + 5.0));
                col = (float3(0.01, 0.013, 0.025) + c1 * 0.03) * (1.25 - 0.45 * length(uv * float2(0.8, 0.55)));
                col += mix(c1, c2, n1) * smoothstep(0.38, 0.9, n2) * (0.12 + 0.2 * lv) * smoothstep(2.2, 0.3, length(uv - ctr * 0.5));
                float ring = pow(0.5 + 0.5 * sin(dq * 8.0 - t * 3.5 * (speak >= hear ? 1.0 : -1.0)), 8.0);
                col += tint * ring * smoothstep(1.0, 1.3, dq) * exp(-(dq - 1.0) * 0.8) * lv * (0.25 * speak + 0.2 * hear);
                for (int i = 0; i < 2; i++) {
                  float fi = float(i);
                  float2 g = uv * (11.0 + 9.0 * fi) + float2(fi * 3.7, t * (0.04 + 0.03 * fi));
                  float2 id = floor(g), f = fract(g) - 0.5;
                  float h = hash2(id + fi * 7.1);
                  float2 off = float2(hash2(id + 3.3), hash2(id + 9.7)) - 0.5;
                  float s = smoothstep(0.07, 0.0, length(f - off * 0.7)) * step(0.82, h) * (0.55 + 0.45 * sin(t * (0.7 + 2.0 * h) + h * 40.0));
                  col += mix(c3, float3(1.0), 0.5) * s * (0.25 + 0.35 * smoothstep(3.0, 0.8, dq) + 0.3 * lv);
                }
                a = 1.0;
              }
              float glow = exp(-max(dq - 1.0, 0.0) * (7.0 - 3.0 * lv)) * (0.35 + 0.5 * lv) + exp(-max(dq - 1.0, 0.0) * 1.6) * (0.07 + 0.12 * lv);
              if (bg <= 0.0) glow *= smoothstep(2.8, 1.2, dq);
              col += tint * glow;
              a += glow * 0.9;
              float3 back = float3(0.0), front = float3(0.0);
              for (int i = 0; i < 9; i++) {
                float fi = float(i);
                float an = t * (0.5 + 0.07 * fi) + fi * 0.698;
                float orbit = 1.32 + 0.12 * sin(t * 1.1 + fi * 2.3);
                float2 pos = float2(cos(an), sin(an) * 0.3) * orbit;
                pos = float2(pos.x * 0.96 - pos.y * 0.28, pos.x * 0.28 + pos.y * 0.96);
                float sp = (exp(-length(q - pos) * 40.0) * 2.5 + exp(-length(q - pos) * 12.0) * 0.35) * think;
                if (sin(an) > 0.0) back += c3 * sp; else front += c3 * sp;
              }
              col += back;
              a += length(back);
              if (dq < 1.45) {
                float cs = cos(t * (0.15 + 0.5 * think)), sn = sin(t * (0.15 + 0.5 * think)), tx = 0.25 * sin(t * 0.2);
                float3x3 m = float3x3(cs, 0.0, -sn, 0.0, 1.0, 0.0, sn, 0.0, cs) * float3x3(1.0, 0.0, 0.0, 0.0, cos(tx), sin(tx), 0.0, -sin(tx), cos(tx));
                float3 ro = float3(0.0, 0.0, 4.0), rd = normalize(float3(q, -4.0));
                float3 rdo = m * rd;
                float3 p = m * ro;
                float b = dot(p, rdo), c = dot(p, p) - 2.1, h = b * b - c;
                float dist = -b - sqrt(max(h, 0.0)), best = 9.0;
                float3 near = p + rdo * dist;
                if (h > 0.0) {
                  for (int i = 0; i < 26; i++) {
                    float3 x = p + rdo * dist;
                    float d = blob(x, lv);
                    if (d < best) { best = d; near = x; }
                    if (d < 0.001) break;
                    dist += d * 0.6;
                    if (dist > 7.0) break;
                  }
                }
                float cov = 1.0 - smoothstep(0.0, 2.0 / (min(size.x, size.y) * rad), best);
                if (cov > 0.0) {
                  float3 no = normalAt(near, lv);
                  float3 n = no * m;
                  float3 v = -rd;
                  float z = max(dot(n, v), 0.0);
                  float fres = pow(1.0 - z, 3.0);
                  float ph = dot(n, float3(sin(t * 0.3), cos(t * 0.23), 0.5)) * 2.2 + fbm(no * 1.6 + t * 0.08) * 4.0 + t * 0.3;
                  float3 iri = mix(c1, c2, 0.5 + 0.5 * sin(ph * 2.2));
                  iri = mix(iri, c3, smoothstep(0.55, 1.0, sin(ph * 1.3 + 1.7)) * 0.6);
                  float3 ip = near + refract(rdo, no, 0.72) * 0.7;
                  float sw = fbm(ip * 1.7 + float3(0.0, t * (0.12 + 0.35 * lv), t * 0.07));
                  float3 inner = mix(c1 * 0.12, c1, smoothstep(0.25, 0.55, sw));
                  inner = mix(inner, c2, smoothstep(0.5, 0.75, sw)) + c3 * pow(smoothstep(0.45, 0.85, sw), 2.0) * (0.4 + 0.9 * lv);
                  inner += mix(c3, float3(1.0), 0.3) * pow(max(1.0 - abs(sw - 0.52) * 7.0, 0.0), 3.0) * (0.35 + 0.7 * lv);
                  float3 sc = mix(inner, iri, 0.25 + 0.55 * fres);
                  sc += mix(c2, c3, 0.4) * pow(z, 3.0) * (0.22 + 0.35 * lv);
                  sc += fres * mix(c2, c3, 0.5 + 0.5 * sin(ph)) * 0.8;
                  float3 rf = reflect(rd, n);
                  sc += pow(max(dot(rf, normalize(float3(-0.5, 0.7, 0.6))), 0.0), 48.0) * 0.7;
                  sc += c2 * pow(max(dot(rf, normalize(float3(0.6, -0.5, 0.4))), 0.0), 6.0) * 0.25;
                  sc = 1.0 - exp(-sc * 1.5);
                  col = mix(col, sc, cov);
                  a = mix(a, 1.0, cov);
                }
              }
              col += front;
              a += length(front);
              if (bg <= 0.0) {
                float2 e = 0.5 * size / min(size.x, size.y);
                float keep = smoothstep(e.x, e.x - 0.12, abs(uv.x)) * smoothstep(e.y, e.y - 0.12, abs(uv.y));
                col *= keep; a *= keep;
              }
              a = clamp(a, 0.0, 1.0);
              return half4(half3(min(col, float3(a))), half(a));
            }
        """
    }
}
