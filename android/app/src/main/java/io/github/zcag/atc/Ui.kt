package io.github.zcag.atc

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** The native screens' pieces, drawn from the page's palette so setup, dialogs and the offline screen look like atc. */
class Ui(val c: Context, val pal: Palette = Look.palette(c)) {
    fun dp(v: Number) = (v.toFloat() * c.resources.displayMetrics.density).toInt()

    private fun shape(fill: Int, stroke: Int? = null, radius: Int = 7) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        if (stroke != null) setStroke(dp(1), stroke)
    }

    fun text(s: CharSequence, size: Float = 14f, color: Int = pal.ink, bold: Boolean = false, mono: Boolean = false) = TextView(c).apply {
        text = s
        textSize = size
        setTextColor(color)
        setLineSpacing(0f, 1.2f)
        typeface = Typeface.create(if (mono) Typeface.MONOSPACE else Typeface.SANS_SERIF, if (bold) Typeface.BOLD else Typeface.NORMAL)
    }

    fun heading(s: String) = text(s, 22f, bold = true)

    fun mark() = text("atc", 12f, pal.board, bold = true, mono = true).apply {
        gravity = Gravity.CENTER
        background = shape(pal.ink)
        layoutParams = LinearLayout.LayoutParams(dp(34), dp(34))
    }

    fun button(label: String, primary: Boolean = false, quiet: Boolean = false, go: () -> Unit) = text(label, 14f, if (primary) pal.board else if (quiet) pal.dim else pal.ink, bold = primary).apply {
        gravity = Gravity.CENTER
        minHeight = dp(44)
        setPadding(dp(14), 0, dp(14), 0)
        isClickable = true
        isFocusable = true
        val fill = if (primary) pal.ink else if (quiet) Color.TRANSPARENT else pal.board
        background = RippleDrawable(ColorStateList.valueOf(pal.line), shape(fill, if (primary || quiet) null else pal.line), shape(Color.WHITE))
        setOnClickListener { go() }
    }

    fun field(hint: String) = EditText(c).apply {
        this.hint = hint
        textSize = 14f
        typeface = Typeface.MONOSPACE
        setTextColor(pal.ink)
        setHintTextColor(pal.faint)
        isSingleLine = true
        minHeight = dp(44)
        setPadding(dp(10), 0, dp(10), 0)
        background = shape(pal.board, pal.lineStrong)
    }

    /** One line of a check: done is a tick, anything else a warning on the needs wash. */
    fun check(title: String, sub: String? = null, detail: String? = null, ok: Boolean = false) = LinearLayout(c).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(text(if (ok) "✓" else "!", 15f, if (ok) pal.ink else pal.needsText, bold = true).apply { gravity = Gravity.CENTER_HORIZONTAL },
            LinearLayout.LayoutParams(dp(20), ViewGroup.LayoutParams.WRAP_CONTENT))
        addView(column(dp(4),
            text(title, 14f, bold = true),
            sub?.let { text(it, 13f, pal.dim) },
            detail?.let { text(it, 12f, pal.faint, mono = true).apply { setTextIsSelectable(true) } },
        ).apply { setPadding(dp(6), 0, 0, 0) }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (!ok) {
            background = shape(pal.wash)
            setPadding(dp(8), dp(8), dp(10), dp(10))
        }
    }

    /** The web's stale line: the off icon, what is stale since when, and Retry, on the sunk strip with a hairline under it. */
    fun staleLine(what: CharSequence, retry: TextView?) = LinearLayout(c).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(44)
        setPadding(dp(16), dp(8), dp(12), dp(8))
        background = android.graphics.drawable.LayerDrawable(arrayOf(ColorDrawable(pal.line), ColorDrawable(pal.sunk))).apply { setLayerInset(1, 0, 0, 0, dp(1)) }
        addView(View(c).apply { background = StrokeIcon(OFF_ICON, pal.dim) }, LinearLayout.LayoutParams(dp(16), dp(16)).apply { marginEnd = dp(12) })
        addView(text(what, 14f), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        retry?.let { addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(12) }) }
    }

    fun mono(s: String) = android.text.SpannableString(s).apply { setSpan(android.text.style.TypefaceSpan("monospace"), 0, s.length, 0) }

    fun column(gap: Int, vararg views: View?) = LinearLayout(c).apply {
        orientation = LinearLayout.VERTICAL
        views.filterNotNull().forEachIndexed { i, v ->
            addView(v, (v.layoutParams as? LinearLayout.LayoutParams ?: LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
                .apply { if (i > 0) topMargin = gap })
        }
    }

    /** Buttons in a row at the end, or with [grow] taking the room left. */
    fun actions(buttons: List<TextView>, grow: TextView? = null) = LinearLayout(c).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.END
        buttons.forEachIndexed { i, b ->
            addView(b, LinearLayout.LayoutParams(if (b === grow) 0 else ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, if (b === grow) 1f else 0f)
                .apply { if (i > 0) marginStart = dp(8) })
        }
    }

    fun bullets(lines: List<String>) = column(dp(4), *lines.map { line ->
        LinearLayout(c).apply {
            addView(text("•", 14f, pal.faint), LinearLayout.LayoutParams(dp(14), ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(text(line).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
    }.toTypedArray())

    class Act(val label: String, val primary: Boolean = false, val go: () -> Unit = {})

    /** A dialog on the page's surface: a title, a mono line under it, its body, and buttons with the primary last. */
    fun dialog(title: String, meta: String? = null, body: View? = null, acts: List<Act>, cancelable: Boolean = true, onCancel: () -> Unit = {}): Dialog {
        val d = Dialog(c)
        val buttons = acts.map { a -> button(a.label, primary = a.primary, quiet = !a.primary) { d.dismiss(); a.go() } }
        val card = LinearLayout(c).apply {
            orientation = LinearLayout.VERTICAL
            background = shape(pal.board, pal.line, 10)
            setPadding(dp(18), dp(18), dp(18), dp(14))
            fun add(v: View?, gap: Int) = v?.let { addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(gap) }) }
            add(text(title, 17f, bold = true), 0)
            add(meta?.let { text(it, 13f, pal.faint, mono = true).apply { setTextIsSelectable(true) } }, 2)
            add(body, 12)
            if (buttons.isNotEmpty()) add(actions(buttons), 14)
        }
        d.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        d.setContentView(card)
        d.setCancelable(cancelable)
        d.setOnCancelListener { onCancel() }
        d.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(c.resources.displayMetrics.widthPixels.coerceAtMost(dp(420)) - dp(36), ViewGroup.LayoutParams.WRAP_CONTENT)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setDimAmount(if (pal.dark) .6f else .32f)
        }
        if (c !is Activity || !c.isFinishing) d.show()
        return d
    }

    fun menu(title: String, items: List<Act>) {
        lateinit var d: Dialog
        val rows = items.map { a -> button(a.label, quiet = true) { d.dismiss(); a.go() }.apply { setTextColor(pal.ink); gravity = Gravity.START or Gravity.CENTER_VERTICAL; setPadding(0, 0, 0, 0) } }
        d = dialog(title, body = column(0, *rows.toTypedArray()), acts = emptyList())
    }

    fun message(title: String, message: String, vararg acts: Act) =
        dialog(title, body = text(message, 14f, pal.dim).apply { setTextIsSelectable(true) }, acts = acts.toList().ifEmpty { listOf(Act("OK", primary = true)) })
}

/** The page's 16px line icons, from the same path data. */
const val OFF_ICON = "M2 2l12 12M5.5 5.6A3.5 3.5 0 0 0 4.5 12H11M7 4.1A4 4 0 0 1 12 7.5a2.3 2.3 0 0 1 1.6 3.8"

class StrokeIcon(path: String, color: Int) : android.graphics.drawable.Drawable() {
    private val path = androidx.core.graphics.PathParser.createPathFromPathData(path)
    private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.STROKE
        strokeWidth = 1.5f
        strokeCap = android.graphics.Paint.Cap.ROUND
        strokeJoin = android.graphics.Paint.Join.ROUND
        this.color = color
    }
    override fun draw(canvas: android.graphics.Canvas) {
        canvas.save()
        canvas.translate(bounds.left.toFloat(), bounds.top.toFloat())
        canvas.scale(bounds.width() / 16f, bounds.height() / 16f)
        canvas.drawPath(path, paint)
        canvas.restore()
    }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(cf: android.graphics.ColorFilter?) { paint.colorFilter = cf }
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
}
