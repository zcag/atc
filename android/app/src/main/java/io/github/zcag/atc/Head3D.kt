package io.github.zcag.atc

import android.content.Context
import android.opengl.Matrix
import android.view.Choreographer
import android.graphics.BitmapFactory
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.view.TextureView
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import com.google.android.filament.Colors
import com.google.android.filament.Engine
import com.google.android.filament.android.UiHelper
import com.google.android.filament.utils.Manipulator
import com.google.android.filament.EntityManager
import com.google.android.filament.IndirectLight
import com.google.android.filament.LightManager
import com.google.android.filament.Renderer
import com.google.android.filament.utils.ModelViewer
import com.google.android.filament.utils.Utils
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer

/** A glTF head drawn by Filament, its ARKit morph targets, head and eyes driven by the Animator every frame.
 *  The persona's folder holds persona.json: {"model": "head.glb", "nodes": {"head", "eyeL", "eyeR"},
 *  "axes": {"head": {"yaw": "-x", "pitch": "-z", "roll": "+y"}, "eye": {...}} (which local axis of each bone
 *  turns which way; rigs differ), "rest": {node: [x, y, z] degrees} (a pose to start from, such as arms down
 *  from a T-pose), "camera": {"target": [x, y, z], "eye": [x, y, z]} in model units (without it the model is
 *  scaled into a unit cube and "lift" raises the view), "focal": mm, "light": key light lux, "ambient",
 *  "backdrop": a picture behind them, or {"day", "evening", "night"} by the hour, "blur": its blur in px,
 *  "clips": {state: [animation names]} (listening, hearing, thinking, tool, speaking; a clip is picked at random
 *  from its state's list and cross-faded in, the face controller's head and eye turns go on top)}. */
class Head3D(c: Context, dir: File, private val spec: JSONObject) : FrameLayout(c), Persona, Choreographer.FrameCallback {
    override val view get() = this

    private val surface = TextureView(c).apply { isOpaque = false }
    private val backdrop = ImageView(c).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
    private val clips = HashMap<String, IntArray>()
    private var clip = -1
    private var clipAt = 0f
    private var clipEnd = 0f
    private var fromClip = -1
    private var fromAt = 0f
    private var fade = 1f
    private var clipState = ""
    private var clock = 0f
    private val viewer: ModelViewer
    private val animator = Animator((System.nanoTime() % 100_000).toInt())
    private var state = "listening"
    private var last = 0L
    private class Target(val entity: Int, val names: Array<String>, val weights: FloatArray)
    private class Node(val entity: Int, val rest: FloatArray) {
        val now: FloatArray = rest.copyOf()
    }
    private var targets = emptyList<Target>()
    private val nodes = HashMap<String, Node>()
    private val m = FloatArray(16)
    private class Axis(val index: Int, val axis: Int, val sign: Float)
    private val headAxes = axes("head", "+y", "-x", "+z")
    private val eyeAxes = axes("eye", "+y", "-x", "+z")
    private val turn = FloatArray(3)
    private var light = 0
    private var gone = false
    private var ambient: IndirectLight? = null

    init {
        ensureFilament()
        picture(dir)?.let { backdrop.setImageBitmap(it) }
        val blur = spec.optDouble("blur", 0.0).toFloat()
        if (blur > 0 && Build.VERSION.SDK_INT >= 31) backdrop.setRenderEffect(RenderEffect.createBlurEffect(blur, blur, Shader.TileMode.CLAMP))
        addView(backdrop, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        surface.addOnAttachStateChangeListener(object : OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) {}
            override fun onViewDetachedFromWindow(v: View) = releaseOwn()
        })
        val lift = spec.optDouble("lift", 0.0).toFloat()
        val cam = spec.optJSONObject("camera")
        val target = cam?.optJSONArray("target")?.let { a -> FloatArray(3) { a.getDouble(it).toFloat() } } ?: floatArrayOf(0f, lift, -4f)
        val eye = cam?.optJSONArray("eye")?.let { a -> FloatArray(3) { a.getDouble(it).toFloat() } } ?: floatArrayOf(0f, lift, 0f)
        val ui = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK).apply { isOpaque = false }
        viewer = ModelViewer(surface, Engine.create(), ui,
            Manipulator.Builder().targetPosition(target[0], target[1], target[2]).orbitHomePosition(eye[0], eye[1], eye[2])
                .build(Manipulator.Mode.ORBIT))
        viewer.autoPlayAnimations = false
        viewer.cameraFocalLength = spec.optDouble("focal", 50.0).toFloat()
        viewer.view.blendMode = com.google.android.filament.View.BlendMode.TRANSLUCENT
        viewer.renderer.clearOptions = Renderer.ClearOptions().apply {
            clear = true
            clearColor = if (backdrop.drawable != null) doubleArrayOf(0.0, 0.0, 0.0, 0.0) else doubleArrayOf(.0074, .0119, .0203, 1.0)
        }
        viewer.loadModelGlb(ByteBuffer.wrap(File(dir, spec.optString("model", "head.glb")).readBytes()).let {
            ByteBuffer.allocateDirect(it.capacity()).put(it).flip() as ByteBuffer
        })
        if (cam == null) viewer.transformToUnitCube()
        setUp()
    }

    private fun setUp() {
        val asset = viewer.asset ?: return
        val engine = viewer.engine
        val rm = engine.renderableManager
        targets = asset.renderableEntities.toList().mapNotNull { e ->
            val names = asset.getMorphTargetNames(e)
            if (names.isEmpty()) null else Target(e, names, FloatArray(names.size))
        }
        val tm = engine.transformManager
        spec.optJSONObject("rest")?.let { rest ->
            for (name in rest.keys()) {
                val e = asset.getFirstEntityByName(name).takeIf { it != 0 } ?: continue
                val a = rest.getJSONArray(name)
                tm.getTransform(tm.getInstance(e), m)
                for (i in 0..2) Matrix.rotateM(m, 0, a.getDouble(i).toFloat(), if (i == 0) 1f else 0f, if (i == 1) 1f else 0f, if (i == 2) 1f else 0f)
                tm.setTransform(tm.getInstance(e), m)
            }
        }
        val n = spec.optJSONObject("nodes") ?: JSONObject()
        for (key in listOf("head", "eyeL", "eyeR")) {
            val name = n.optString(key).ifEmpty { continue }
            val e = asset.getFirstEntityByName(name)
            if (e == 0) continue
            val rest = FloatArray(16)
            tm.getTransform(tm.getInstance(e), rest)
            nodes[key] = Node(e, rest)
        }
        targets.forEach { rm.setMorphWeights(rm.getInstance(it.entity), it.weights, 0) }
        viewer.animator?.let { a ->
            val byName = (0 until a.animationCount).associateBy { a.getAnimationName(it) }
            spec.optJSONObject("clips")?.let { cs ->
                for (st in cs.keys()) {
                    val names = cs.optJSONArray(st) ?: continue
                    val found = (0 until names.length()).mapNotNull { byName[names.getString(it)] }
                    if (found.isNotEmpty()) clips[st] = found.toIntArray()
                }
            }
        }
        val (cr, cg, cb) = Colors.cct(5600f)
        light = EntityManager.get().create()
        LightManager.Builder(LightManager.Type.DIRECTIONAL)
            .color(cr, cg, cb)
            .intensity(spec.optDouble("light", 70_000.0).toFloat())
            .direction(-.45f, -.35f, -1f)
            .castShadows(false)
            .build(engine, light)
        viewer.scene.addEntity(light)
        ambient = IndirectLight.Builder()
            .irradiance(1, floatArrayOf(.85f, .8f, .78f))
            .intensity(spec.optDouble("ambient", 28_000.0).toFloat())
            .build(engine)
        viewer.scene.indirectLight = ambient
    }

    override fun face(f: Calls.Face) {
        state = f.state
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!gone) Choreographer.getInstance().postFrameCallback(this)
    }

    override fun onDetachedFromWindow() {
        gone = true
        Choreographer.getInstance().removeFrameCallback(this)
        super.onDetachedFromWindow()
    }

    /** ModelViewer destroys itself and its engine when the surface leaves the window, which is before this view's
     *  own onDetachedFromWindow; what Head3D added to the engine goes first, from a listener registered ahead of it. */
    private fun releaseOwn() {
        gone = true
        Choreographer.getInstance().removeFrameCallback(this)
        val engine = viewer.engine
        viewer.scene.indirectLight = null
        ambient?.let { engine.destroyIndirectLight(it) }
        if (light != 0) {
            viewer.scene.removeEntity(light)
            engine.lightManager.destroy(light)
            EntityManager.get().destroy(light)
        }
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (gone) return
        Choreographer.getInstance().postFrameCallback(this)
        val dt = if (last == 0L) 1f / 60 else ((frameTimeNanos - last) / 1e9f).coerceIn(0f, .1f)
        last = frameTimeNanos
        val (you, it) = Calls.levels()
        val p = animator.step(dt, state, you, it)
        clock += dt
        body(dt)
        apply(p)
        viewer.animator?.updateBoneMatrices()
        viewer.render(frameTimeNanos)
    }

    /** The body: the state's clip, a new one from its list when it ends or the state changes, cross-faded in. */
    private fun body(dt: Float) {
        val a = viewer.animator ?: return
        val tm = viewer.engine.transformManager
        for (n in nodes.values) tm.setTransform(tm.getInstance(n.entity), n.rest)
        val list = clips[state] ?: clips["listening"] ?: return
        if (clip < 0 || state != clipState || clock >= clipEnd) {
            val next = list[(Math.random() * list.size).toInt()]
            if (clip >= 0) {
                fromClip = clip
                fromAt = clipAt
                fade = 0f
            }
            clip = next
            clipAt = 0f
            clipState = state
            clipEnd = clock + a.getAnimationDuration(next).coerceAtLeast(1f) * if (list.size == 1) 2 else 1
        }
        clipAt += dt
        val len = a.getAnimationDuration(clip).coerceAtLeast(.01f)
        a.applyAnimation(clip, clipAt % len)
        if (fade < 1f && fromClip >= 0) {
            fromAt += dt
            fade = (fade + dt / .6f).coerceAtMost(1f)
            a.applyCrossFade(fromClip, fromAt % a.getAnimationDuration(fromClip).coerceAtLeast(.01f), fade)
        }
        for (n in nodes.values) tm.getTransform(tm.getInstance(n.entity), n.now)
    }

    private fun picture(dir: File): android.graphics.Bitmap? {
        val b = spec.opt("backdrop") ?: return null
        val name = if (b is JSONObject) {
            val h = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
            b.optString(if (h in 7..16) "day" else if (h in 17..20) "evening" else "night").ifEmpty { b.optString("day") }
        } else b.toString()
        return runCatching { BitmapFactory.decodeFile(File(dir, name).path) }.getOrNull()
    }

    private fun apply(p: Pose) {
        val engine = viewer.engine
        val rm = engine.renderableManager
        val eyes = nodes.containsKey("eyeL")
        for (tg in targets) {
            for (i in tg.names.indices) tg.weights[i] = p[tg.names[i]] * if (eyes && tg.names[i].startsWith("eyeLook")) .35f else 1f
            rm.setMorphWeights(rm.getInstance(tg.entity), tg.weights, 0)
        }
        rotate("head", headAxes, p.yaw, p.pitch, p.roll)
        rotate("eyeL", eyeAxes, p.eyeYaw, p.eyePitch, 0f)
        rotate("eyeR", eyeAxes, p.eyeYaw, p.eyePitch, 0f)
    }

    private fun rotate(key: String, axes: List<Axis>, yaw: Float, pitch: Float, roll: Float) {
        val n = nodes[key] ?: return
        turn[0] = yaw
        turn[1] = pitch
        turn[2] = roll
        System.arraycopy(if (clips.isEmpty()) n.rest else n.now, 0, m, 0, 16)
        for (a in axes) Matrix.rotateM(m, 0, a.sign * turn[a.index] * 180f / Math.PI.toFloat(),
            if (a.axis == 0) 1f else 0f, if (a.axis == 1) 1f else 0f, if (a.axis == 2) 1f else 0f)
        val tm = viewer.engine.transformManager
        tm.setTransform(tm.getInstance(n.entity), m)
    }

    private fun axes(part: String, yaw: String, pitch: String, roll: String): List<Axis> {
        val o = spec.optJSONObject("axes")?.optJSONObject(part)
        return listOf("yaw" to yaw, "pitch" to pitch, "roll" to roll).mapIndexedNotNull { i, (name, fallback) ->
            val v = o?.optString(name)?.ifEmpty { null } ?: if (o == null) fallback else return@mapIndexedNotNull null
            Axis(i, "xyz".indexOf(v.last()), if (v.startsWith("-")) -1f else 1f)
        }
    }

    companion object {
        private var ready = false

        fun ensureFilament() {
            if (!ready) {
                Utils.init()
                ready = true
            }
        }
    }
}
