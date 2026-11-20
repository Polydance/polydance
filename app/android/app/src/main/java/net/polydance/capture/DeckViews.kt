package net.polydance.capture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.graphics.Shader
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.LinearLayout
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

// Design passes recorded in the headset shaped these views. The second (session ..._23-03-11) asked for
// a reel-to-reel deck after the Technics RS-1700 illustration; the third (..._23-29-57) moved to the
// colours and controls of a 1960s portable deck: a cream metal plate with clear reels and orange labels,
// a black control panel with white lettering and a red RECORDING key. The fourth (2026-10-02T00-31-08)
// put the track switches on the meters, took out the duplicated RECORDING lettering and left the counter
// and the big key; the fifth (..._00-33-28) replaced the UPLOAD lamp with a transfer bar, and the eighth
// (CAP-1, 2026-10-05) took the bar off again for UPLOAD and PROCESSING lamps beside the counter.
// Nothing is allocated in onDraw: geometry is built per size.

/**
 * The top plate: two clear reels with brown tape and orange labels on brushed cream metal, turning
 * only while recording to tape (sixth pass, 2026-10-04), "POLYDANCE" printed around the left
 * reel and the ballerina printed on the right reel's label. Storage is tape: the take-up reel (right)
 * fills and the supply reel (left) empties as the allowance is used; red tape when it is full. The
 * seventh pass (2026-10-04, thread CAP-1): the reels spin up from still and run down to a stop like a
 * real transport, the right reel has no hub so the logo shows whole, the plate grows to fill the height
 * the rack left, and a small list key beside the storage readout opens the recordings page.
 */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class DeckView(context: Context) : View(context) {
    /** 1 while recording, 0 still: where the reels' speed is heading, not the speed itself. */
    var spin = 0
        set(value) { if (field != value) { field = value; invalidate() } }
    /** The list key beside the storage readout: opens the recordings stored on this headset. */
    var onStorage: (() -> Unit)? = null
    /** Fraction of the allowance used, 0 to 1; null while unknown, which shows both reels half full. */
    var used: Float? = null
        set(value) { if (field != value) { field = value; invalidate() } }
    var full = false
        set(value) { if (field != value) { field = value; invalidate() } }
    var storageLabel = ""
        set(value) { if (field != value) { field = value; invalidate() } }

    private val logo: Bitmap? = runCatching { BitmapFactory.decodeResource(resources, R.drawable.polydance_mark) }.getOrNull()
    private val logoPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
        // Printed on the label in the deck's ink, not in its own colour.
        colorFilter = PorterDuffColorFilter(Color.rgb(40, 22, 12), PorterDuff.Mode.SRC_IN)
    }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Retro.LABEL; color = Retro.PRINT; textAlign = Paint.Align.CENTER }
    private val namePath = Path()
    private val plate = RectF()
    private val window = RectF()
    private val logoRect = RectF()
    private var plateShader: Shader? = null
    private var r = 0f; private var lx = 0f; private var rx = 0f; private var cy = 0f
    private var nameOffset = 0f
    private var angle = 0f
    private var lastFrame = 0L
    /** The reels' speed as a fraction of full, eased towards [spin]. */
    private var speed = 0f
    private val storageKey = RectF()
    private var storagePressed = false
    private val name = "POLYDANCE"

    private companion object {
        const val REEL = 0.19f
        /** As large as the reels get in a tall plate, just short of touching each other. */
        const val REEL_MAX = 0.225f
        const val TOP_DP = 42f
        const val BOTTOM_DP = 40f
        /** Full speed in degrees per millisecond, and how long spinning up and running down take. */
        const val FULL = 0.15f
        const val SPIN_UP_MS = 1600f
        const val RUN_DOWN_MS = 1200f
    }

    private fun dp(v: Float) = Retro.dp(context, v)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val natural = (dp(TOP_DP) + width * REEL * 2 + dp(BOTTOM_DP)).toInt()
        // Given more height (the space the rack left), the plate takes it and the reels grow into it.
        val height = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) maxOf(natural, MeasureSpec.getSize(heightMeasureSpec)) else natural
        setMeasuredDimension(width, height)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val room = h - dp(TOP_DP) - dp(BOTTOM_DP)
        r = (room / 2f).coerceIn(w * REEL, w * REEL_MAX)
        lx = w * 0.27f; rx = w * 0.73f; cy = dp(TOP_DP) + room / 2f
        plate.set(0f, 0f, w.toFloat(), h.toFloat())
        plateShader = LinearGradient(0f, 0f, 0f, h.toFloat(), Retro.PLATE_LIGHT, Retro.PLATE_DARK, Shader.TileMode.CLAMP)
        val arc = r * 1.14f
        namePath.reset()
        namePath.addArc(RectF(lx - arc, cy - arc, lx + arc, cy + arc), 205f, 130f)
        text.textSize = dp(13f); text.letterSpacing = 0.32f
        nameOffset = ((2 * PI * arc * 130 / 360).toFloat() - text.measureText(name)) / 2
        val half = r * 0.25f
        logoRect.set(rx - half, cy - half, rx + half, cy + half)
    }

    private fun reel(canvas: Canvas, x: Float, tape: Float, hub: Boolean = true) {
        val minPack = r * 0.42f
        val pack = minPack + (r * 0.92f - minPack) * tape.coerceIn(0f, 1f)
        fill.color = if (full) Color.rgb(140, 40, 28) else Color.rgb(74, 52, 38)
        canvas.drawCircle(x, cy, pack, fill)
        // A clear plastic flange: a faint fill and a dark rim, three windows turning with it.
        fill.color = Color.argb(40, 255, 255, 255)
        canvas.drawCircle(x, cy, r, fill)
        line.color = Color.rgb(96, 86, 72); line.strokeWidth = dp(1.6f)
        canvas.drawCircle(x, cy, r, line)
        line.strokeWidth = dp(1.2f); line.color = Color.argb(150, 96, 86, 72)
        for (i in 0 until 3) {
            canvas.save()
            canvas.rotate(angle + i * 120f, x, cy)
            window.set(x - r * 0.15f, cy - r * 0.86f, x + r * 0.15f, cy - r * 0.46f)
            canvas.drawRoundRect(window, r * 0.1f, r * 0.1f, line)
            canvas.restore()
        }
        // The orange label, a dark hub and three spindle teeth; the right reel's label carries the logo instead.
        fill.color = Retro.ORANGE
        canvas.drawCircle(x, cy, r * 0.36f, fill)
        line.color = Color.rgb(176, 64, 22); line.strokeWidth = dp(1.4f)
        canvas.drawCircle(x, cy, r * 0.36f, line)
        if (!hub) return
        fill.color = Color.rgb(42, 34, 27)
        canvas.drawCircle(x, cy, r * 0.1f, fill)
        line.color = Retro.WHITE_PRINT; line.strokeWidth = dp(2f)
        for (i in 0 until 3) {
            val a = (angle + i * 120f) * PI / 180
            canvas.drawLine(x, cy, x + (r * 0.09f * sin(a)).toFloat(), cy - (r * 0.09f * cos(a)).toFloat(), line)
        }
    }

    override fun onDraw(canvas: Canvas) {
        // Spin up from still and run down to a stop, as a tape transport does, rather than jumping.
        val now = SystemClock.uptimeMillis()
        val dt = if (lastFrame > 0) (now - lastFrame).coerceAtMost(100L).toFloat() else 0f
        val target = if (spin != 0) 1f else 0f
        speed = if (speed < target) (speed + dt / SPIN_UP_MS).coerceAtMost(target) else (speed - dt / RUN_DOWN_MS).coerceAtLeast(target)
        // Eased: a slow start and a soft finish, not a straight ramp.
        val eased = speed * speed * (3f - 2f * speed)
        angle = (angle + eased * dt * FULL) % 360f
        lastFrame = if (speed > 0f || target > 0f) now else 0L
        val w = width.toFloat(); val h = height.toFloat()

        // Brushed cream metal with a hairline edge and a screw in each corner.
        fill.shader = plateShader
        canvas.drawRoundRect(plate, dp(3f), dp(3f), fill)
        fill.shader = null
        line.color = Color.argb(22, 0, 0, 0); line.strokeWidth = dp(1f)
        var y = dp(5f)
        while (y < h) { canvas.drawLine(0f, y, w, y, line); y += dp(5f) }
        line.color = Retro.PLATE_EDGE; line.strokeWidth = dp(2f)
        canvas.drawRoundRect(plate, dp(3f), dp(3f), line)
        screw(canvas, dp(14f), dp(14f)); screw(canvas, w - dp(14f), dp(14f))
        screw(canvas, dp(14f), h - dp(14f)); screw(canvas, w - dp(14f), h - dp(14f))

        val known = used
        reel(canvas, lx, if (known == null) 0.5f else 1f - known)
        reel(canvas, rx, known ?: 0.5f, hub = false)
        logo?.let {
            canvas.save(); canvas.rotate(angle, rx, cy)
            canvas.drawBitmap(it, null, logoRect, logoPaint)
            canvas.restore()
        }

        text.color = Retro.PRINT; text.textSize = dp(13f); text.letterSpacing = 0.32f
        canvas.drawTextOnPath(name, namePath, nameOffset, 0f, text)
        text.textSize = dp(11f); text.letterSpacing = 0.25f
        canvas.drawText("TAPE", lx, cy + r + dp(22f), text)
        if (storageLabel.isNotEmpty()) {
            text.color = if (full) Color.rgb(170, 36, 24) else Retro.PRINT; text.textSize = dp(12f); text.letterSpacing = 0.18f
            val labelY = cy + r + dp(22f)
            canvas.drawText(storageLabel, rx, labelY, text)
            // The list key just right of the readout: a small dark key with three printed lines.
            val left = rx + text.measureText(storageLabel) / 2f + dp(10f)
            storageKey.set(left, labelY - dp(15f), left + dp(26f), labelY + dp(5f))
            fill.color = if (storagePressed) Retro.SURFACE else Retro.PANEL
            canvas.drawRoundRect(storageKey, dp(3f), dp(3f), fill)
            line.color = Retro.WHITE_PRINT; line.strokeWidth = dp(1.6f)
            for (i in 0 until 3) {
                val ly = storageKey.top + dp(6f) + i * dp(4f)
                canvas.drawLine(storageKey.left + dp(6f), ly, storageKey.right - dp(6f), ly, line)
            }
        } else storageKey.setEmpty()
        if (lastFrame > 0L) postInvalidateDelayed(33)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val hit = RectF(storageKey).apply { inset(-dp(10f), -dp(10f)) }
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> if (!storageKey.isEmpty && hit.contains(event.x, event.y)) { storagePressed = true; invalidate(); return true }
            MotionEvent.ACTION_UP -> if (storagePressed) {
                storagePressed = false; invalidate()
                if (hit.contains(event.x, event.y)) onStorage?.invoke()
                return true
            }
            MotionEvent.ACTION_CANCEL -> if (storagePressed) { storagePressed = false; invalidate(); return true }
        }
        return storagePressed || super.onTouchEvent(event)
    }

    private fun screw(canvas: Canvas, x: Float, y: Float) {
        val sr = dp(4.5f)
        fill.color = Color.rgb(176, 166, 144)
        canvas.drawCircle(x, y, sr, fill)
        line.color = Color.rgb(110, 100, 82); line.strokeWidth = dp(1.2f)
        canvas.drawCircle(x, y, sr, line)
        canvas.drawLine(x - sr * 0.6f, y - sr * 0.6f, x + sr * 0.6f, y + sr * 0.6f, line)
    }
}

/** One of the deck's lights with its name under it: REC, UPLOAD and PROCESSING pulse while lit, READY is steady. */
@SuppressLint("ViewConstructor")
class Lamp(context: Context, private val name: String, private val color: Int, private val pulses: Boolean) : View(context) {
    var lit = false; set(v) { if (field != v) { field = v; invalidate() } }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Retro.LABEL; color = Retro.WHITE_PRINT; textAlign = Paint.Align.CENTER }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // As wide as its name needs: PROCESSING is far longer than REC (eighth pass, 2026-10-05).
        label.textSize = Retro.dp(context, 11f); label.letterSpacing = 0.24f
        setMeasuredDimension(maxOf(Retro.dp(context, 76f), label.measureText(name) + Retro.dp(context, 12f)).toInt(), Retro.dp(context, 56f).toInt())
    }

    override fun onDraw(canvas: Canvas) {
        val x = width / 2f; val y = Retro.dp(context, 16f); val r = Retro.dp(context, 8f)
        val glow = if (!lit) 0f else if (pulses) 0.5f + 0.5f * abs(sin(SystemClock.uptimeMillis() / 600.0 * PI)).toFloat() else 1f
        if (lit) { paint.color = color; paint.alpha = (90 * glow).toInt(); canvas.drawCircle(x, y, r * 1.9f, paint) }
        paint.color = if (lit) color else Color.rgb(Color.red(color) / 4, Color.green(color) / 4, Color.blue(color) / 4)
        paint.alpha = if (lit) (155 + 100 * glow).toInt() else 255
        canvas.drawCircle(x, y, r, paint)
        paint.alpha = 255
        paint.style = Paint.Style.STROKE; paint.strokeWidth = Retro.dp(context, 1.2f); paint.color = Color.rgb(90, 84, 76)
        canvas.drawCircle(x, y, r, paint)
        paint.style = Paint.Style.FILL
        label.textSize = Retro.dp(context, 11f); label.letterSpacing = 0.24f
        canvas.drawText(name, x, y + r + Retro.dp(context, 16f), label)
        if (lit && pulses) postInvalidateDelayed(50)
    }
}

/**
 * The big red RECORDING key, after the deck's red push keys: press to record, press again to stop. Up
 * and lettered REC when ready; held down, darker, lettered STOP and glowing while recording; amber
 * while starting; grey and lettered FULL when storage is full. The word RECORDING above it went in the
 * fourth pass (00:53): the REC lamp already says it.
 */
@SuppressLint("ViewConstructor")
class RecordKey(context: Context) : View(context) {
    enum class Mode { READY, STARTING, RECORDING, DISABLED }

    var mode = Mode.READY
        set(value) {
            if (field == value) return
            field = value
            isEnabled = value == Mode.READY || value == Mode.RECORDING
            contentDescription = when (value) {
                Mode.READY -> "Start recording"; Mode.RECORDING -> "Stop recording"
                Mode.STARTING -> "Starting"; Mode.DISABLED -> "Storage full"
            }
            invalidate()
        }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Retro.LABEL; textAlign = Paint.Align.CENTER }
    private val key = RectF()
    private val shadow = RectF()
    private val glow = RectF()
    private val faces = HashMap<Mode, Shader>()

    init { isClickable = true; isFocusable = true; contentDescription = "Start recording" }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // A fifth smaller than before the one panel (CAP-10, 2026-10-21), so the deck's narrower column has room.
        setMeasuredDimension(Retro.dp(context, 176f).toInt(), Retro.dp(context, 80f).toInt())
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val cx = w / 2f
        key.set(cx - Retro.dp(context, 66f), Retro.dp(context, 8f), cx + Retro.dp(context, 66f), h - Retro.dp(context, 10f))
        shadow.set(key.left, key.top + Retro.dp(context, 5f), key.right, key.bottom + Retro.dp(context, 5f))
        glow.set(key.left - Retro.dp(context, 6f), key.top - Retro.dp(context, 3f), key.right + Retro.dp(context, 6f), key.bottom + Retro.dp(context, 9f))
        fun face(top: Int, bottom: Int) = LinearGradient(0f, key.top, 0f, key.bottom, top, bottom, Shader.TileMode.CLAMP)
        faces[Mode.READY] = face(Color.rgb(236, 84, 60), Color.rgb(176, 44, 28))
        faces[Mode.RECORDING] = face(Color.rgb(150, 34, 22), Color.rgb(190, 48, 30))
        faces[Mode.STARTING] = face(Color.rgb(246, 186, 88), Color.rgb(196, 128, 36))
        faces[Mode.DISABLED] = face(Color.rgb(140, 133, 123), Color.rgb(98, 92, 84))
    }

    override fun setPressed(pressed: Boolean) { super.setPressed(pressed); invalidate() }

    override fun onDraw(canvas: Canvas) {
        val radius = Retro.dp(context, 5f)
        val sunk = mode == Mode.RECORDING || isPressed
        if (mode == Mode.RECORDING) {
            val phase = (SystemClock.uptimeMillis() % 1200) / 1200.0
            paint.color = Retro.RED; paint.alpha = (60 + 120 * abs(sin(phase * PI))).toInt()
            canvas.drawRoundRect(glow, radius * 2, radius * 2, paint)
            paint.alpha = 255
            postInvalidateDelayed(33)
        }
        if (!sunk) { paint.color = Color.rgb(8, 7, 6); canvas.drawRoundRect(shadow, radius, radius, paint) }
        canvas.save()
        if (sunk) canvas.translate(0f, Retro.dp(context, 4f))
        paint.shader = faces[mode]
        canvas.drawRoundRect(key, radius, radius, paint)
        paint.shader = null
        paint.style = Paint.Style.STROKE; paint.strokeWidth = Retro.dp(context, 1.4f); paint.color = Color.rgb(70, 18, 10)
        canvas.drawRoundRect(key, radius, radius, paint)
        paint.style = Paint.Style.FILL
        label.textSize = Retro.dp(context, 18f); label.letterSpacing = 0.3f
        label.color = if (mode == Mode.DISABLED) Color.rgb(220, 214, 204) else Color.rgb(255, 244, 236)
        val word = when (mode) { Mode.READY -> "REC"; Mode.RECORDING -> "STOP"; Mode.STARTING -> "…"; Mode.DISABLED -> "FULL" }
        canvas.drawText(word, key.centerX(), key.centerY() + Retro.dp(context, 6.5f), label)
        canvas.restore()
    }
}

/**
 * Recording time on a mechanical counter: four digit drums that roll to the next number rather than
 * jumping, with a colon between minutes and seconds.
 */
@SuppressLint("ViewConstructor")
class RollingCounter(context: Context) : View(context) {
    var seconds = 0L
        set(value) {
            if (field == value) return
            field = value
            val next = digits(value)
            val now = SystemClock.uptimeMillis()
            for (i in 0 until 4) if (next[i] != shown[i]) { from[i] = shown[i]; shown[i] = next[i]; since[i] = now }
            invalidate()
        }

    private val shown = IntArray(4)
    private val from = IntArray(4)
    private val since = LongArray(4)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Retro.COUNTER; color = Retro.CREAM; textAlign = Paint.Align.CENTER }
    private val frame = Paint(Paint.ANTI_ALIAS_FLAG)
    private val cell = RectF()
    private val window = RectF()
    private var drum: Shader? = null
    private val cellW get() = Retro.dp(context, 30f)
    private val gap get() = Retro.dp(context, 4f)
    private val colon get() = Retro.dp(context, 14f)

    private fun digits(v: Long): IntArray {
        val m = (v / 60) % 100; val s = v % 60
        return intArrayOf((m / 10).toInt(), (m % 10).toInt(), (s / 10).toInt(), (s % 10).toInt())
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val pad = Retro.dp(context, 8f)
        setMeasuredDimension((cellW * 4 + gap * 2 + colon + pad * 2).toInt(), Retro.dp(context, 50f).toInt())
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        window.set(0f, 0f, w.toFloat(), h.toFloat())
        val inset = Retro.dp(context, 6f)
        drum = LinearGradient(0f, inset, 0f, h - inset, intArrayOf(Color.rgb(14, 12, 10), Color.rgb(58, 51, 44), Color.rgb(14, 12, 10)), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
        paint.textSize = h * 0.58f
    }

    override fun onDraw(canvas: Canvas) {
        val h = height.toFloat()
        frame.shader = null; frame.color = Color.rgb(10, 9, 8)
        canvas.drawRoundRect(window, Retro.dp(context, 8f), Retro.dp(context, 8f), frame)
        frame.style = Paint.Style.STROKE; frame.strokeWidth = Retro.dp(context, 1.5f); frame.color = Retro.EDGE
        canvas.drawRoundRect(window, Retro.dp(context, 8f), Retro.dp(context, 8f), frame)
        frame.style = Paint.Style.FILL

        val inset = Retro.dp(context, 6f)
        val baseline = h / 2 - (paint.descent() + paint.ascent()) / 2
        val now = SystemClock.uptimeMillis()
        var animating = false
        var x = Retro.dp(context, 8f)
        for (i in 0 until 4) {
            if (i == 2) {
                colonDots(canvas, x + colon / 2, h)
                x += colon
            }
            cell.set(x, inset, x + cellW, h - inset)
            frame.shader = drum
            canvas.drawRect(cell, frame)
            frame.shader = null
            canvas.save()
            canvas.clipRect(cell)
            val p = ((now - since[i]) / 260f).coerceIn(0f, 1f)
            val cx = x + cellW / 2
            if (p < 1f) {
                animating = true
                canvas.drawText(from[i].toString(), cx, baseline - p * h, paint)
                canvas.drawText(shown[i].toString(), cx, baseline + (1 - p) * h, paint)
            } else {
                canvas.drawText(shown[i].toString(), cx, baseline, paint)
            }
            canvas.restore()
            x += cellW + if (i == 0 || i == 2) gap else 0f
        }
        if (animating) postInvalidateDelayed(16)
    }

    /** The colon: two small lamps between the minute and second drums. */
    private fun colonDots(canvas: Canvas, cx: Float, h: Float) {
        frame.color = Retro.CREAM
        canvas.drawCircle(cx, h * 0.36f, Retro.dp(context, 2.5f), frame)
        canvas.drawCircle(cx, h * 0.64f, Retro.dp(context, 2.5f), frame)
    }
}

/**
 * One recording as a rack-mounted unit: a face between two ears, each ear with two screws, and its
 * content (lamp, date, length, a one-word status, buttons) in between.
 */
@SuppressLint("ViewConstructor")
class RackUnit(context: Context) : LinearLayout(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val face = RectF()
    private val earL = RectF()
    private val earR = RectF()
    private val ear = Retro.dp(context, 22f)

    init {
        orientation = HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        setWillNotDraw(false)
        val padH = (ear + Retro.dp(context, 12f)).toInt(); val padV = Retro.dp(context, 10f).toInt()
        setPadding(padH, padV, padH, padV)
        minimumHeight = Retro.dp(context, 66f).toInt()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        face.set(0f, 0f, w.toFloat(), h.toFloat())
        earL.set(0f, 0f, ear, h.toFloat())
        earR.set(w - ear, 0f, w.toFloat(), h.toFloat())
    }

    override fun onDraw(canvas: Canvas) {
        val radius = Retro.dp(context, 4f)
        paint.style = Paint.Style.FILL; paint.color = Retro.SURFACE
        canvas.drawRoundRect(face, radius, radius, paint)
        paint.color = Color.rgb(50, 44, 38)
        canvas.drawRoundRect(earL, radius, radius, paint)
        canvas.drawRoundRect(earR, radius, radius, paint)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = Retro.dp(context, 1f); paint.color = Retro.EDGE
        canvas.drawRoundRect(face, radius, radius, paint)
        // Two screws in each ear, slotted.
        screw(canvas, ear / 2, height * 0.25f); screw(canvas, ear / 2, height * 0.75f)
        screw(canvas, width - ear / 2, height * 0.25f); screw(canvas, width - ear / 2, height * 0.75f)
    }

    private fun screw(canvas: Canvas, x: Float, y: Float) = Screws.dark(canvas, x, y, resources.displayMetrics.density, paint)
}
