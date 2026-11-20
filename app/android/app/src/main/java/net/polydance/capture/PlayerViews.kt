package net.polydance.capture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout

// The player's own pieces (PlayerActivity, 2026-10-12). Geometry is worked out when drawn from a few fields;
// draw allocates nothing.

/**
 * A dark frame the shape of the video, at most [maxHeightFraction] of the panel's height; the picture is as
 * large as fits inside it without changing shape, so a tall panel letterboxes rather than stretches.
 */
@SuppressLint("ViewConstructor")
class VideoFrame(context: Context, private val maxHeightFraction: Float) : FrameLayout(context) {
    private var videoW = 16
    private var videoH = 9

    fun setVideoSize(w: Int, h: Int) {
        if (w <= 0 || h <= 0 || (w == videoW && h == videoH)) return
        videoW = w; videoH = h
        requestLayout()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val cap = (resources.displayMetrics.heightPixels * maxHeightFraction).toInt()
        val height = minOf((width.toLong() * videoH / videoW).toInt(), cap)
        val scale = minOf(width.toFloat() / videoW, height.toFloat() / videoH)
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            if (child is SurfaceView) child.measure(exactly((videoW * scale).toInt()), exactly((videoH * scale).toInt()))
            else measureChild(child, exactly(width), exactly(height))
        }
        setMeasuredDimension(width, height)
    }

    private fun exactly(size: Int) = MeasureSpec.makeMeasureSpec(size, MeasureSpec.EXACTLY)
}

/**
 * The player's timeline: the track, how far it has played in amber, the key moments as ticks above it in
 * their kinds' colours, and a thumb. Dragging moves the thumb; letting go goes there ([onSeek]).
 */
class TimelineBar(context: Context) : View(context) {
    var durationMs = 0L
        set(value) { field = maxOf(0, value); describe(); invalidate() }
    var positionMs = 0L
        set(value) { field = value; describe(); invalidate() }
    /** Each moment's time and colour. */
    var moments: List<Pair<Long, Int>> = emptyList()
        set(value) { field = value; invalidate() }
    var onSeek: ((Long) -> Unit)? = null
    var dragging = false
        private set

    private val d = context.resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND }
    private val tick = RectF()

    init { isClickable = true; isFocusable = true; describe() }

    private fun describe() { contentDescription = "Timeline, ${InboxText.clock(positionMs)} of ${InboxText.clock(durationMs)}" }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), (46 * d).toInt())
    }

    private val left get() = 10 * d
    private val right get() = width - 10 * d
    private fun x(ms: Long) = if (durationMs <= 0) left else left + (right - left) * (ms.coerceIn(0, durationMs).toFloat() / durationMs)
    private fun at(x: Float) = if (right <= left) 0L else ((x - left) / (right - left)).coerceIn(0f, 1f).let { (it * durationMs).toLong() }

    override fun onDraw(canvas: Canvas) {
        val cy = height * 0.64f
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 4 * d
        paint.color = Retro.EDGE
        canvas.drawLine(left, cy, right, cy, paint)
        paint.color = Retro.AMBER
        canvas.drawLine(left, cy, x(positionMs), cy, paint)
        paint.style = Paint.Style.FILL
        for ((ms, colour) in moments) {
            val tx = x(ms)
            tick.set(tx - 1.5f * d, cy - 17 * d, tx + 1.5f * d, cy - 7 * d)
            paint.color = colour
            canvas.drawRoundRect(tick, 1.5f * d, 1.5f * d, paint)
        }
        paint.color = Retro.CREAM
        canvas.drawCircle(x(positionMs), cy, (if (dragging) 10 else 8) * d, paint)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (durationMs <= 0) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { dragging = true; parent?.requestDisallowInterceptTouchEvent(true); positionMs = at(event.x) }
            MotionEvent.ACTION_MOVE -> positionMs = at(event.x)
            MotionEvent.ACTION_UP -> { positionMs = at(event.x); dragging = false; performClick(); onSeek?.invoke(positionMs) }
            MotionEvent.ACTION_CANCEL -> { dragging = false; invalidate() }
        }
        return true
    }

    override fun performClick(): Boolean { super.performClick(); return true }
}
