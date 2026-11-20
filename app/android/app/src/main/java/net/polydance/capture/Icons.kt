package net.polydance.capture

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.widget.ImageView

/**
 * The inbox's icons, drawn rather than taken from a font so they are crisp at any panel density and the
 * same on every headset (2026-10-12, the Gmail-style inbox: a menu and search bar, archive, delete and more
 * in a thread's top bar, a camera on Reply). Each is a stroke drawing on a 24-unit grid, Material's size.
 */
class Glyph(private val kind: Kind, colour: Int, private val density: Float, private val sizeDp: Float = 24f) : Drawable() {
    enum class Kind { MENU, SEARCH, CLOSE, BACK, ARCHIVE, UNARCHIVE, TRASH, MORE, CAMERA, REPLY, FORWARD, SHARE, SMILE, PLAY, PAUSE, BACK10, AHEAD10, PERSON_ADD }

    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeWidth = 2f; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; color = colour
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = colour }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = colour; textSize = 6.5f; typeface = Retro.LABEL; textAlign = Paint.Align.CENTER }
    private val path = Path()
    private val oval = RectF()

    override fun getIntrinsicWidth() = (sizeDp * density).toInt()
    override fun getIntrinsicHeight() = (sizeDp * density).toInt()

    override fun draw(canvas: Canvas) {
        val b = bounds
        canvas.save()
        canvas.translate(b.left.toFloat(), b.top.toFloat())
        canvas.scale(b.width() / 24f, b.height() / 24f)
        when (kind) {
            Kind.MENU -> for (y in floatArrayOf(6f, 12f, 18f)) canvas.drawLine(3.5f, y, 20.5f, y, stroke)
            Kind.SEARCH -> { canvas.drawCircle(10f, 10f, 6f, stroke); canvas.drawLine(14.5f, 14.5f, 20f, 20f, stroke) }
            Kind.CLOSE -> { canvas.drawLine(6f, 6f, 18f, 18f, stroke); canvas.drawLine(18f, 6f, 6f, 18f, stroke) }
            Kind.BACK -> canvas.lines(15f, 5f, 8f, 12f, 15f, 19f)
            Kind.ARCHIVE, Kind.UNARCHIVE -> {
                oval.set(3f, 4f, 21f, 8.5f); canvas.drawRoundRect(oval, 1f, 1f, stroke)
                canvas.lines(5f, 8.5f, 5f, 20f, 19f, 20f, 19f, 8.5f)
                if (kind == Kind.ARCHIVE) { canvas.drawLine(12f, 11f, 12f, 17f, stroke); canvas.lines(9f, 14.5f, 12f, 17.5f, 15f, 14.5f) }
                else { canvas.drawLine(12f, 11f, 12f, 17.5f, stroke); canvas.lines(9f, 13.5f, 12f, 10.5f, 15f, 13.5f) }
            }
            Kind.TRASH -> {
                canvas.drawLine(4f, 6f, 20f, 6f, stroke)
                canvas.lines(9f, 6f, 9f, 3.5f, 15f, 3.5f, 15f, 6f)
                canvas.lines(6f, 6f, 7f, 20.5f, 17f, 20.5f, 18f, 6f)
                canvas.drawLine(10f, 10f, 10f, 17f, stroke); canvas.drawLine(14f, 10f, 14f, 17f, stroke)
            }
            Kind.MORE -> for (y in floatArrayOf(5f, 12f, 19f)) canvas.drawCircle(12f, y, 2f, fill)
            Kind.CAMERA -> {
                oval.set(2.5f, 7f, 15f, 17f); canvas.drawRoundRect(oval, 2f, 2f, stroke)
                path.reset(); path.moveTo(15f, 10.5f); path.lineTo(21f, 7.5f); path.lineTo(21f, 16.5f); path.lineTo(15f, 13.5f); path.close()
                canvas.drawPath(path, fill)
            }
            Kind.REPLY -> {
                canvas.lines(9.5f, 6f, 4f, 11.5f, 9.5f, 17f)
                path.reset(); path.moveTo(4f, 11.5f); path.lineTo(13f, 11.5f); path.quadTo(20f, 11.5f, 20f, 18.5f); canvas.drawPath(path, stroke)
            }
            Kind.FORWARD -> {
                canvas.lines(14.5f, 6f, 20f, 11.5f, 14.5f, 17f)
                path.reset(); path.moveTo(20f, 11.5f); path.lineTo(11f, 11.5f); path.quadTo(4f, 11.5f, 4f, 18.5f); canvas.drawPath(path, stroke)
            }
            Kind.SMILE -> {
                canvas.drawCircle(12f, 12f, 9f, stroke)
                canvas.drawCircle(9f, 10f, 1.3f, fill); canvas.drawCircle(15f, 10f, 1.3f, fill)
                oval.set(7.5f, 8.5f, 16.5f, 16.5f); canvas.drawArc(oval, 25f, 130f, false, stroke)
            }
            Kind.PLAY -> { path.reset(); path.moveTo(7.5f, 4.5f); path.lineTo(19.5f, 12f); path.lineTo(7.5f, 19.5f); path.close(); canvas.drawPath(path, fill) }
            Kind.PAUSE -> { canvas.drawRect(6.5f, 5f, 10.5f, 19f, fill); canvas.drawRect(13.5f, 5f, 17.5f, 19f, fill) }
            Kind.BACK10, Kind.AHEAD10 -> {
                val back = kind == Kind.BACK10
                oval.set(3.5f, 3.5f, 20.5f, 20.5f)
                canvas.drawArc(oval, if (back) -60f else -120f, if (back) -240f else 240f, false, stroke)
                if (back) canvas.lines(4f, 3f, 4.5f, 8f, 9.5f, 7.5f) else canvas.lines(20f, 3f, 19.5f, 8f, 14.5f, 7.5f)
                canvas.drawText("10", 12f, 14.3f, text)
            }
            // Three linked dots, the usual share mark (CAP-7, 2026-10-15: Share instead of Forward).
            Kind.SHARE -> {
                canvas.drawLine(8.5f, 10.8f, 15.5f, 7.2f, stroke); canvas.drawLine(8.5f, 13.2f, 15.5f, 16.8f, stroke)
                canvas.drawCircle(18f, 6f, 2.6f, stroke); canvas.drawCircle(6f, 12f, 2.6f, stroke); canvas.drawCircle(18f, 18f, 2.6f, stroke)
            }
            Kind.PERSON_ADD -> {
                canvas.drawCircle(9f, 8f, 3.5f, stroke)
                oval.set(2.5f, 14f, 15.5f, 26f); canvas.drawArc(oval, 180f, 180f, false, stroke)
                canvas.drawLine(19f, 6f, 19f, 12f, stroke); canvas.drawLine(16f, 9f, 22f, 9f, stroke)
            }
        }
        canvas.restore()
    }

    /** A stroked polyline through the given x, y pairs. */
    private fun Canvas.lines(vararg xy: Float) {
        path.reset(); path.moveTo(xy[0], xy[1])
        var i = 2
        while (i < xy.size) { path.lineTo(xy[i], xy[i + 1]); i += 2 }
        drawPath(path, stroke)
    }

    override fun setAlpha(alpha: Int) { stroke.alpha = alpha; fill.alpha = alpha; text.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { stroke.colorFilter = colorFilter; fill.colorFilter = colorFilter; text.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

    companion object {
        /** A round key holding one icon, 48 dp across for a controller ray, with a pressed ripple. */
        fun key(context: Context, kind: Kind, colour: Int, description: String, onClick: () -> Unit) = ImageView(context).apply {
            val d = context.resources.displayMetrics.density
            setImageDrawable(Glyph(kind, colour, d))
            val p = (12 * d).toInt(); setPadding(p, p, p, p)
            minimumWidth = (48 * d).toInt(); minimumHeight = (48 * d).toInt()
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 239, 230, 210)), null, GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) })
            contentDescription = description
            isClickable = true; isFocusable = true
            setOnClickListener { onClick() }
        }
    }
}
