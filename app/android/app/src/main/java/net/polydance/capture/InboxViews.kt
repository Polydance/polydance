package net.polydance.capture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.widget.LinearLayout

// Pieces shared by the deck and the inbox panel. Geometry is built when the size changes; draw
// allocates nothing.

/** Clamps a column to a readable width and centres it in a wide panel. */
class ClampedColumn(context: Context, private val maxWidth: Int) : LinearLayout(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val size = MeasureSpec.getSize(widthMeasureSpec)
        val spec = if (size > maxWidth) MeasureSpec.makeMeasureSpec(maxWidth, MeasureSpec.getMode(widthMeasureSpec)) else widthMeasureSpec
        super.onMeasure(spec, heightMeasureSpec)
    }
}

/**
 * One recording's progress on its card in the inbox, as a short strip of the transfer unit's segments:
 * amber while uploading, cyan while the receiver processes it (sixth pass, 2026-10-04).
 */
class LedStrip(context: Context) : android.view.View(context) {
    var fraction = 0f
        set(value) { val v = value.coerceIn(0f, 1f); if (field != v) { field = v; invalidate() } }
    var processing = false
        set(value) { if (field != value) { field = value; invalidate() } }
    /** Nothing has moved for a while (UploadProgress.isStuck): the lit part dims, as the iPhone's TransferStrip. */
    var stuck = false
        set(value) { if (field != value) { field = value; invalidate() } }

    private val d = context.resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val segment = RectF()
    private val segments = 20
    /** The LED's colour at 40% of its light. */
    private val dim = 0x66 shl 24

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec).coerceAtMost((240 * d).toInt()), (12 * d).toInt())
    }

    override fun onDraw(canvas: Canvas) {
        val lit = (fraction * segments).toInt()
        val w = width.toFloat() / segments
        for (i in 0 until segments) {
            segment.set(i * w + d, d, (i + 1) * w - d, height - d)
            paint.color = when {
                i < lit -> if (processing) Retro.PROCESSING else if (stuck) dim or (Retro.UPLOADING and 0xFFFFFF) else Retro.UPLOADING
                else -> if (processing) Retro.PROCESSING_OFF else Retro.LED_OFF
            }
            canvas.drawRoundRect(segment, 1.5f * d, 1.5f * d, paint)
        }
    }
}

/** The inbox's filter key: a funnel outline in the key's print colour (seventh pass, 2026-10-04). */
class FunnelDrawable(private val density: Float, colour: Int) : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.8f * density; color = colour; strokeJoin = Paint.Join.ROUND }
    private val path = Path()

    override fun getIntrinsicWidth() = (18 * density).toInt()
    override fun getIntrinsicHeight() = (16 * density).toInt()

    override fun draw(canvas: Canvas) {
        val b = bounds; val d = density
        val cx = b.exactCenterX(); val mid = b.top + b.height() * 0.48f
        path.reset()
        path.moveTo(b.left + d, b.top + d)
        path.lineTo(b.right - d, b.top + d)
        path.lineTo(cx + 2.2f * d, mid)
        path.lineTo(cx + 2.2f * d, b.bottom - d)
        path.lineTo(cx - 2.2f * d, b.bottom - 3.4f * d)
        path.lineTo(cx - 2.2f * d, mid)
        path.close()
        canvas.drawPath(path, paint)
    }

    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/**
 * Who sent a message, at a glance (2026-10-04, Robin: colleagues are coming): a person as a circle with
 * their initial in their colour, an agent as a rounded square with its first letter in its owner's colour.
 * A person without a colour gets one from their name, the same every time.
 */
class Avatar(context: Context, private val initial: String, private val colour: Int, private val agent: Boolean, private val sizeDp: Float = 26f) : android.view.View(context) {
    private val d = context.resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; typeface = Retro.LABEL; textSize = 13 * d * sizeDp / 26f; textAlign = Paint.Align.CENTER }
    private val box = RectF()

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) { setMeasuredDimension((sizeDp * d).toInt(), (sizeDp * d).toInt()) }

    override fun onDraw(canvas: Canvas) {
        box.set(d, d, width - d, height - d)
        paint.color = colour
        if (agent) canvas.drawRoundRect(box, 6 * d * sizeDp / 26f, 6 * d * sizeDp / 26f, paint) else canvas.drawOval(box, paint)
        canvas.drawText(initial, box.centerX(), box.centerY() - (text.ascent() + text.descent()) / 2, text)
    }

    companion object {
        private val PALETTE = intArrayOf(Color.rgb(217, 58, 43), Color.rgb(64, 132, 160), Color.rgb(120, 150, 70), Color.rgb(170, 110, 40), Color.rgb(130, 90, 160), Color.rgb(60, 140, 120))

        /** Their own colour when they have one, else one from the palette that is the same for them every time. */
        fun fill(colour: String?, key: String): Int =
            colour?.let { runCatching { Color.parseColor(it) }.getOrNull() } ?: PALETTE[(key.hashCode() and 0x7fffffff) % PALETTE.size]

        /**
         * A sender's avatar from the message: its person and colour if it has them, else its label. A person's
         * [letter] is their email's first when the thread knows it (2026-10-12); an agent keeps its own name's.
         */
        fun of(context: Context, name: String, user: String?, colour: String?, agent: String?, letter: String? = null, sizeDp: Float = 26f): Avatar {
            val who = user ?: name
            val initial = if (agent == null && letter != null) letter else ((agent ?: who).firstOrNull { it.isLetterOrDigit() } ?: '?').uppercaseChar().toString()
            return Avatar(context, initial, fill(colour, who), agent != null, sizeDp)
        }
    }
}


/**
 * Who is in a thread at a glance, the Gmail way (Robin, 2026-10-12): one person's circle for a thread of their
 * own, overlapping circles when several are in it, the last reading +N past three. Each circle holds the first
 * letter of the person's email, or of their name until they have one. Someone invited by email who has not
 * joined yet is drawn as an outline. [ring] is the colour behind, so overlapping circles stay apart.
 */
@SuppressLint("ViewConstructor")
class AvatarStack(context: Context, private val ring: Int, private val sizeDp: Float = 44f) : android.view.View(context) {
    data class Face(val initial: String, val colour: Int, val invited: Boolean = false)

    var faces: List<Face> = emptyList()
        set(value) { field = value; contentDescription = "${value.size} ${if (value.size == 1) "person" else "people"}"; invalidate() }
    /** How many people in all, when [faces] holds only the first few. */
    var total = 0
        set(value) { field = value; invalidate() }

    private val d = context.resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Retro.LABEL; textAlign = Paint.Align.CENTER }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) { setMeasuredDimension((sizeDp * d).toInt(), (sizeDp * d).toInt()) }

    override fun onDraw(canvas: Canvas) {
        val shown = faces.take(3)
        val more = maxOf(total, faces.size) - shown.size
        val w = width.toFloat()
        // Centres and radius for one, two (a diagonal pair) or three (a triangle) circles in the square.
        val (r, centres) = when (shown.size) {
            0, 1 -> w * 0.46f to listOf(w / 2 to w / 2)
            2 -> w * 0.32f to listOf(w * 0.34f to w * 0.34f, w * 0.66f to w * 0.66f)
            else -> w * 0.27f to listOf(w * 0.29f to w * 0.3f, w * 0.71f to w * 0.3f, w * 0.5f to w * 0.71f)
        }
        shown.forEachIndexed { i, face ->
            val (cx, cy) = centres[i]
            paint.style = Paint.Style.FILL; paint.color = ring
            canvas.drawCircle(cx, cy, r + 2 * d, paint)
            val last = i == shown.size - 1 && more > 0
            if (face.invited && !last) {
                paint.color = Retro.CASING; canvas.drawCircle(cx, cy, r, paint)
                paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.6f * d; paint.color = face.colour
                canvas.drawCircle(cx, cy, r - 0.8f * d, paint)
                text.color = face.colour
            } else {
                paint.color = if (last) Retro.EDGE else face.colour
                canvas.drawCircle(cx, cy, r, paint)
                text.color = Color.WHITE
            }
            val label = if (last) "+${more + 1}" else face.initial
            text.textSize = r * (if (label.length > 2) 0.8f else 0.95f)
            canvas.drawText(label, cx, cy - (text.ascent() + text.descent()) / 2, text)
        }
    }
}

/**
 * This headset's person in the corner of the search bar (Gmail's profile picture): the first letter of their
 * email in their colour, or of their name until they give one, with an amber ring while there is no email.
 */
class ProfileBadge(context: Context) : android.view.View(context) {
    private val d = context.resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; typeface = Retro.LABEL; textAlign = Paint.Align.CENTER; textSize = 18 * d }
    private var initial = "?"
    private var colour = Retro.EDGE
    private var hasEmail = false

    init { isClickable = true; isFocusable = true; contentDescription = "Your account" }

    fun show(initial: String, colour: Int, hasEmail: Boolean) {
        this.initial = initial; this.colour = colour; this.hasEmail = hasEmail
        contentDescription = if (hasEmail) "Your account" else "Your account: add your email"
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) { setMeasuredDimension((44 * d).toInt(), (44 * d).toInt()) }

    override fun onDraw(canvas: Canvas) {
        val c = width / 2f; val r = c - 3 * d
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 2.5f * d
        paint.color = if (hasEmail) Retro.EDGE else Retro.AMBER
        canvas.drawCircle(c, c, r, paint)
        paint.style = Paint.Style.FILL; paint.color = if (isPressed) Retro.EDGE else colour
        canvas.drawCircle(c, c, r - 3.5f * d, paint)
        canvas.drawText(initial, c, c - (text.ascent() + text.descent()) / 2, text)
    }

    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
}
