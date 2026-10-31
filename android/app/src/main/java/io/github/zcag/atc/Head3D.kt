package io.github.zcag.atc

import android.content.Context
import android.opengl.Matrix
import android.view.Choreographer
import android.view.SurfaceView
import android.widget.FrameLayout
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
 *  scaled into a unit cube and "lift" raises the view), "focal": mm, "light": key light lux, "ambient"}. */
class Head3D(c: Context, dir: File, private val spec: JSONObject) : FrameLayout(c), Persona, Choreographer.FrameCallback {
    override val view get() = this

    private val surface = SurfaceView(c)
    private val viewer: ModelViewer
    private val animator = Animator((System.nanoTime() % 100_000).toInt())
    private var state = "listening"
    private var last = 0L
    private class Target(val entity: Int, val names: Array<String>, val weights: FloatArray)
    private class Node(val entity: Int, val rest: FloatArray)
    private var targets = emptyList<Target>()
    private val nodes = HashMap<String, Node>()
    private val m = FloatArray(16)
    private class Axis(val index: Int, val axis: Int, val sign: Float)
    private val headAxes = axes("head", "+y", "-x", "+z")
    private val eyeAxes = axes("eye", "+y", "-x", "+z")
    private val turn = FloatArray(3)
    private var light = 0
    private var ambient: IndirectLight? = null

    init {
        ensureFilament()
        addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        val lift = spec.optDouble("lift", 0.0).toFloat()
        val cam = spec.optJSONObject("camera")
        val target = cam?.optJSONArray("target")?.let { a -> FloatArray(3) { a.getDouble(it).toFloat() } } ?: floatArrayOf(0f, lift, -4f)
        val eye = cam?.optJSONArray("eye")?.let { a -> FloatArray(3) { a.getDouble(it).toFloat() } } ?: floatArrayOf(0f, lift, 0f)
        viewer = ModelViewer(surface, Engine.create(), UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK),
            Manipulator.Builder().targetPosition(target[0], target[1], target[2]).orbitHomePosition(eye[0], eye[1], eye[2])
                .build(Manipulator.Mode.ORBIT))
        viewer.autoPlayAnimations = false
        viewer.cameraFocalLength = spec.optDouble("focal", 50.0).toFloat()
        viewer.renderer.clearOptions = Renderer.ClearOptions().apply { clear = true; clearColor = doubleArrayOf(.0074, .0119, .0203, 1.0) }
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
        Choreographer.getInstance().postFrameCallback(this)
    }

    override fun onDetachedFromWindow() {
        Choreographer.getInstance().removeFrameCallback(this)
        viewer.destroyModel()
        ambient?.let { viewer.engine.destroyIndirectLight(it) }
        viewer.engine.destroyEntity(light)
        viewer.engine.destroy()
        super.onDetachedFromWindow()
    }

    override fun doFrame(frameTimeNanos: Long) {
        Choreographer.getInstance().postFrameCallback(this)
        val dt = if (last == 0L) 1f / 60 else ((frameTimeNanos - last) / 1e9f).coerceIn(0f, .1f)
        last = frameTimeNanos
        val (you, it) = Calls.levels()
        val p = animator.step(dt, state, you, it)
        apply(p)
        viewer.render(frameTimeNanos)
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
        System.arraycopy(n.rest, 0, m, 0, 16)
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
