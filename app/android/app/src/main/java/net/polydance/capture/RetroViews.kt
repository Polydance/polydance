package net.polydance.capture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

// The meter redraws about 30 times a second while recording, so its shaders and rectangles are built
// once per size in onSizeChanged and reused; nothing is allocated in onDraw. The deck, keys and rack
// are in DeckViews.kt.

/**
 * An analog peak meter: a lit cream face with a dB scale and a needle that rises fast and falls slowly,
 * plus a red lamp that holds for a moment when the level nears clipping. `level` gives the latest
 * 16-bit peak; the MIC and APP meters read CaptureState's per-chunk levels, about 25 times a second.
 *
 * The track's own OFF/ON switch sits on the meter's housing strip, a bat-handle toggle like the ones on
 * the Pulsar Modular P252 Robin showed (fourth design pass, 00:21 to 00:45: "move these two switches
 * into the mic and app meters"). Only a press on the switch toggles it; the rest of the meter is inert.
 */
@SuppressLint("ViewConstructor")
class VuMeter(context: Context, private val label: String = "MIC", private val level: () -> Int = { VuMeter.micLevel() }) : View(context) {
    companion object {
        /** The mic's latest chunk peak, or the once-a-second heartbeat value when chunks are not flowing. */
        fun micLevel(): Int = if (SystemClock.elapsedRealtime() - CaptureState.liveMicAt < 400) CaptureState.liveMicLevel else (CaptureState.micAmplitude ?: 0)
        fun appLevel(): Int = if (SystemClock.elapsedRealtime() - CaptureState.liveAppAt < 400) CaptureState.liveAppLevel else (CaptureState.appAmplitude ?: 0)
    }

    var active = false
        set(value) { if (field != value) { field = value; invalidate() } }
    /** The track switch: on means the track will be recorded. */
    var switchOn = true
        set(value) { if (field != value) { field = value; contentDescription = "$label track ${if (value) "on" else "off"}"; invalidate() } }
    /** Tracks are chosen before recording, so the switch is locked while a recording runs. */
    var switchEnabled = true
        set(value) { if (field != value) { field = value; invalidate() } }
    var onSwitch: (() -> Unit)? = null
    /** A press on the switch while it is locked for a reason the deck can say (APP needs the screen). */
    var onRefused: (() -> Unit)? = null

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var shown = 0f
    private var peakUntil = 0L
    private var switchPressed = false
    private val ticks = intArrayOf(-40, -30, -20, -10, -6, -3)
    private val tickText = arrayOf("40", "30", "20", "10", "6", "3")
    private val face = RectF()
    private val zone = RectF()
    private val housing = RectF()
    private val switchHit = RectF()
    private val point = FloatArray(2)
    private var litFace: Shader? = null
    private var darkFace: Shader? = null
    /** The face's reference height; the housing strip below it is taller than the face's own edge. */
    private var f = 0f
    private var housingTop = 0f
    private var switchX = 0f; private var switchY = 0f
    private var pivotX = 0f; private var pivotY = 0f; private var arc = 0f; private var radius = 0f
    private val brown = Color.rgb(60, 44, 30)

    init { isClickable = true; contentDescription = "$label track on" }

    /** dBFS to needle position: -40 dB at the left stop, -3 dB at the right. */
    private fun position(db: Float) = ((db + 40f) / 37f).coerceIn(0f, 1f)

    private fun strip() = Retro.dp(context, 50f)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = resolveSize(Retro.dp(context, 300f).toInt(), widthMeasureSpec)
        setMeasuredDimension(w, resolveSize((w * 0.46f * 0.8f + strip()).toInt(), heightMeasureSpec))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        f = w * 0.46f
        housingTop = f * 0.8f
        face.set(0f, 0f, w.toFloat(), h.toFloat())
        radius = Retro.dp(context, 12f)
        litFace = RadialGradient(w / 2f, f * 0.9f, w * 0.75f, Color.rgb(250, 236, 200), Color.rgb(226, 205, 160), Shader.TileMode.CLAMP)
        darkFace = RadialGradient(w / 2f, f * 0.9f, w * 0.75f, Color.rgb(196, 186, 162), Color.rgb(160, 150, 128), Shader.TileMode.CLAMP)
        pivotX = w / 2f; pivotY = f * 1.1f; arc = f * 0.86f
        zone.set(pivotX - arc, pivotY - arc, pivotX + arc, pivotY + arc)
        housing.set(0f, housingTop, w.toFloat(), h.toFloat())
        // The switch alone, centred on the strip (CAP-10, 2026-10-21: PEAK came off, and OFF and ON had spilled
        // out of the window at the one panel's narrower deck). The whole strip is its target, well over 48 dp.
        switchX = w / 2f; switchY = (housingTop + h) / 2f
        switchHit.set(0f, housingTop, w.toFloat(), h.toFloat())
    }

    /** Fills `point` with the spot at needle position f and distance rr from the pivot. */
    private fun at(fraction: Float, rr: Float) {
        val angle = (-48 + 96 * fraction) * PI / 180
        point[0] = pivotX + rr * sin(angle).toFloat()
        point[1] = pivotY - rr * cos(angle).toFloat()
    }

    private fun target(): Float = if (!active) 0f else position(20f * log10(max(level(), 1) / 32767f))

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (!switchHit.contains(event.x, event.y)) return false
                switchPressed = true; invalidate(); return true
            }
            MotionEvent.ACTION_UP -> {
                val hit = switchPressed && switchHit.contains(event.x, event.y)
                switchPressed = false; invalidate()
                if (hit) performClick()
                return true
            }
            MotionEvent.ACTION_CANCEL -> { switchPressed = false; invalidate(); return true }
        }
        return switchPressed
    }

    override fun performClick(): Boolean {
        super.performClick()
        if (switchEnabled) onSwitch?.invoke() else onRefused?.invoke()
        return true
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        paint.shader = if (active) litFace else darkFace
        canvas.drawRoundRect(face, radius, radius, paint)
        paint.shader = null
        paint.style = Paint.Style.STROKE; paint.strokeWidth = Retro.dp(context, 2f); paint.color = Retro.EDGE
        canvas.drawRoundRect(face, radius, radius, paint)

        // The red zone, then the scale and its numbers.
        paint.strokeWidth = Retro.dp(context, 5f); paint.color = Color.rgb(196, 52, 38)
        val zoneStart = -138f + 96f * position(-6f)
        canvas.drawArc(zone, zoneStart, -42f - zoneStart, false, paint)
        paint.strokeWidth = Retro.dp(context, 1.5f); paint.color = brown
        canvas.drawArc(zone, -138f, 96f, false, paint)
        paint.style = Paint.Style.FILL
        paint.typeface = Retro.LABEL; paint.textSize = Retro.dp(context, 11f); paint.textAlign = Paint.Align.CENTER
        for (i in ticks.indices) {
            val p = position(ticks[i].toFloat())
            val red = ticks[i] >= -6
            paint.color = if (red) Color.rgb(170, 40, 28) else brown
            at(p, arc); val x1 = point[0]; val y1 = point[1]
            at(p, arc + Retro.dp(context, 8f))
            canvas.drawLine(x1, y1, point[0], point[1], paint)
            at(p, arc + Retro.dp(context, 18f))
            canvas.drawText(tickText[i], point[0], point[1] + Retro.dp(context, 4f), paint)
        }
        paint.color = brown; paint.textSize = Retro.dp(context, 13f); paint.letterSpacing = 0.2f
        canvas.drawText("$label  dB", pivotX, f * 0.62f, paint)
        paint.letterSpacing = 0f

        // Needle ballistics: quick attack, slow release, like a real meter.
        val goal = target()
        shown += (goal - shown) * (if (goal > shown) 0.45f else 0.1f)
        if (goal >= position(-6f)) peakUntil = SystemClock.uptimeMillis() + 600
        at(shown, arc * 1.04f)
        paint.color = Color.rgb(40, 28, 18); paint.strokeWidth = Retro.dp(context, 2.5f)
        canvas.drawLine(pivotX, pivotY, point[0], point[1], paint)
        // The housing strip hides where the needle meets its spindle and carries the switch.
        paint.color = Color.rgb(46, 40, 34)
        canvas.drawRoundRect(housing, radius, radius, paint)
        canvas.drawRect(0f, housingTop, w, housingTop + radius, paint)
        drawSwitch(canvas)

        if (active || shown > 0.002f || SystemClock.uptimeMillis() < peakUntil) postInvalidateDelayed(33)
    }

    /** OFF and ON lettered either side of a chrome bushing, with the bat lever thrown towards the setting. */
    private fun drawSwitch(canvas: Canvas) {
        val dim = if (switchEnabled) 255 else 110
        val gapX = Retro.dp(context, 22f)
        paint.typeface = Retro.LABEL; paint.textSize = Retro.dp(context, 12f); paint.letterSpacing = 0.16f
        val base = switchY + Retro.dp(context, 4.5f)
        paint.textAlign = Paint.Align.RIGHT
        paint.color = if (!switchOn) Retro.WHITE_PRINT else Color.rgb(112, 104, 94); paint.alpha = dim
        canvas.drawText("OFF", switchX - gapX, base, paint)
        paint.textAlign = Paint.Align.LEFT
        paint.color = if (switchOn) Retro.WHITE_PRINT else Color.rgb(112, 104, 94); paint.alpha = dim
        canvas.drawText("ON", switchX + gapX, base, paint)
        paint.letterSpacing = 0f; paint.textAlign = Paint.Align.CENTER
        if (switchPressed && switchEnabled) {
            paint.color = Retro.AMBER; paint.alpha = 70
            canvas.drawCircle(switchX, switchY, Retro.dp(context, 18f), paint)
        }
        // The hex nut and bushing.
        paint.color = Color.rgb(150, 146, 138); paint.alpha = dim
        canvas.drawCircle(switchX, switchY, Retro.dp(context, 10f), paint)
        paint.color = Color.rgb(84, 80, 74); paint.alpha = dim
        canvas.drawCircle(switchX, switchY, Retro.dp(context, 6f), paint)
        // The bat: a tapered steel lever thrown left (off) or right (on), with a rounded tip.
        val end = switchX + (if (switchOn) 1 else -1) * Retro.dp(context, 15f)
        val tipY = switchY - Retro.dp(context, 3f)
        paint.style = Paint.Style.STROKE; paint.strokeCap = Paint.Cap.ROUND
        paint.strokeWidth = Retro.dp(context, 5f); paint.color = Color.rgb(60, 58, 54); paint.alpha = dim
        canvas.drawLine(switchX, switchY, end, tipY, paint)
        paint.strokeWidth = Retro.dp(context, 3f); paint.color = Color.rgb(214, 210, 202); paint.alpha = dim
        canvas.drawLine(switchX, switchY, end, tipY, paint)
        paint.style = Paint.Style.FILL; paint.strokeCap = Paint.Cap.BUTT
        paint.color = Color.rgb(230, 226, 218); paint.alpha = dim
        canvas.drawCircle(end, tipY, Retro.dp(context, 3.5f), paint)
        paint.alpha = 255
    }
}

/** A gear, drawn, for the settings button: eight teeth, a body and a hole, in the given ink. */
@SuppressLint("ViewConstructor")
class GearIcon(context: Context, private val ink: Int = Retro.TAN, private val hole: Int = Retro.CASING) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val tooth = RectF()
    private var cx = 0f; private var cy = 0f; private var r = 0f

    init {
        isClickable = true
        isFocusable = true
        contentDescription = "Settings"
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val size = Retro.dp(context, 48f).toInt()
        setMeasuredDimension(size, size)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        cx = w / 2f; cy = h / 2f; r = min(w, h) / 2f * 0.62f
        tooth.set(cx - r * 0.2f, cy - r * 1.28f, cx + r * 0.2f, cy - r * 0.6f)
    }

    override fun setPressed(pressed: Boolean) { super.setPressed(pressed); invalidate() }

    override fun onDraw(canvas: Canvas) {
        paint.color = if (isPressed) Retro.AMBER else ink
        for (i in 0 until 8) {
            canvas.save()
            canvas.rotate(i * 45f, cx, cy)
            canvas.drawRoundRect(tooth, r * 0.06f, r * 0.06f, paint)
            canvas.restore()
        }
        canvas.drawCircle(cx, cy, r * 0.92f, paint)
        paint.color = hole
        canvas.drawCircle(cx, cy, r * 0.38f, paint)
    }
}

/**
 * The bug key beside the gear on the deck plate (2026-10-12): a beetle printed in the plate's ink, amber
 * while pressed, that opens the pop-up for reporting a bug or suggesting a feature (Reports). Drawn rather
 * than an emoji so it matches the gear's flat print.
 */
@SuppressLint("ViewConstructor")
class BugIcon(context: Context, private val ink: Int = Retro.TAN, private val hole: Int = Retro.CASING) : View(context) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val body = RectF()
    private var cx = 0f; private var cy = 0f; private var r = 0f

    init {
        isClickable = true
        isFocusable = true
        contentDescription = "Report a bug or suggest a feature"
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val size = Retro.dp(context, 48f).toInt()
        setMeasuredDimension(size, size)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        cx = w / 2f; cy = h / 2f; r = min(w, h) / 2f * 0.62f
        body.set(cx - r * 0.62f, cy - r * 0.45f, cx + r * 0.62f, cy + r * 1.05f)
        line.strokeWidth = r * 0.13f
    }

    override fun setPressed(pressed: Boolean) { super.setPressed(pressed); invalidate() }

    override fun onDraw(canvas: Canvas) {
        val colour = if (isPressed) Retro.AMBER else ink
        fill.color = colour; line.color = colour
        // Three legs a side, then the antennae, under the shell and head.
        for (i in 0..2) {
            val y = cy - r * 0.1f + i * r * 0.45f
            val reach = r * (1.12f - 0.08f * i)
            canvas.drawLine(cx - r * 0.4f, y, cx - reach, y + r * (0.18f * i - 0.22f), line)
            canvas.drawLine(cx + r * 0.4f, y, cx + reach, y + r * (0.18f * i - 0.22f), line)
        }
        canvas.drawLine(cx - r * 0.18f, cy - r * 0.78f, cx - r * 0.5f, cy - r * 1.22f, line)
        canvas.drawLine(cx + r * 0.18f, cy - r * 0.78f, cx + r * 0.5f, cy - r * 1.22f, line)
        canvas.drawOval(body, fill)
        canvas.drawCircle(cx, cy - r * 0.62f, r * 0.34f, fill)
        // The seam between the wing cases, in the plate's colour.
        line.color = hole
        canvas.drawLine(cx, cy - r * 0.3f, cx, cy + r * 0.95f, line)
    }
}
