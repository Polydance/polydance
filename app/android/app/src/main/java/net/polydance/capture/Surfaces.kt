package net.polydance.capture

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.Drawable
import java.util.Random
import kotlin.math.min
import kotlin.math.sin

// The cabinet and its plates, from the fourth design pass (session 2026-10-02T00-31-08): "change the
// background to a light wooden texture" (01:15) and "little screws in each corner so that every plate
// looks like it's been screwed on" (01:20). Geometry is built when the bounds change; draw allocates nothing.

/**
 * Light wood boards behind everything: horizontal boards of two tones, wavy grain lines and a dark
 * seam between boards. Generated from a fixed seed rather than shipped as a bitmap, so it is crisp at
 * any panel size and looks the same every time.
 */
class WoodDrawable(private val density: Float) : Drawable() {
    private val board = Paint()
    private val grain = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Retro.WOOD_GRAIN }
    private val seam = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val boards = ArrayList<RectF>()
    private val tones = ArrayList<Int>()
    private val grains = ArrayList<Path>()
    private val grainAlpha = ArrayList<Int>()
    private val grainWidth = ArrayList<Float>()

    override fun onBoundsChange(bounds: Rect) {
        boards.clear(); tones.clear(); grains.clear(); grainAlpha.clear(); grainWidth.clear()
        val random = Random(1966)
        val left = bounds.left.toFloat(); val right = bounds.right.toFloat()
        var top = bounds.top.toFloat()
        var index = 0
        while (top < bounds.bottom) {
            val bottom = min(top + 150 * density, bounds.bottom.toFloat())
            boards += RectF(left, top, right, bottom)
            val base = if (index % 2 == 0) Retro.WOOD_LIGHT else Retro.WOOD_MID
            val shift = random.nextInt(9) - 4
            tones += Color.rgb(Color.red(base) + shift, Color.green(base) + shift, Color.blue(base) + shift)
            val lines = 10 + random.nextInt(6)
            for (k in 0 until lines) {
                val y0 = top + (k + random.nextFloat()) * (bottom - top) / lines
                val amp = (1f + random.nextFloat() * 4f) * density
                val wave = (220f + random.nextFloat() * 420f) * density
                val drift = (random.nextFloat() - 0.5f) * 10f * density
                val phase = random.nextFloat() * 6.283f
                val path = Path()
                var x = left
                path.moveTo(x, y0 + amp * sin(phase))
                while (x < right) {
                    x += 10 * density
                    path.lineTo(x, y0 + amp * sin(phase + x / wave * 6.283f) + drift * (x - left) / (right - left))
                }
                grains += path
                grainAlpha += 26 + random.nextInt(64)
                grainWidth += (0.6f + random.nextFloat() * 1.5f) * density
            }
            top = bottom; index++
        }
    }

    override fun draw(canvas: Canvas) {
        for (i in boards.indices) { board.color = tones[i]; canvas.drawRect(boards[i], board) }
        for (i in grains.indices) { grain.alpha = grainAlpha[i]; grain.strokeWidth = grainWidth[i]; canvas.drawPath(grains[i], grain) }
        for (i in 1 until boards.size) {
            val y = boards[i].top
            seam.color = Retro.WOOD_SEAM; seam.strokeWidth = 2 * density
            canvas.drawLine(boards[i].left, y, boards[i].right, y, seam)
            seam.color = Color.argb(90, 255, 240, 214); seam.strokeWidth = density
            canvas.drawLine(boards[i].left, y + 1.6f * density, boards[i].right, y + 1.6f * density, seam)
        }
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.OPAQUE
}

/** A dark faceplate screwed to the cabinet: a hairline edge and a slotted screw in each corner. */
class PlateDrawable(private val density: Float, private val fill: Int = Retro.PANEL) : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rect = RectF()

    override fun onBoundsChange(bounds: Rect) { rect.set(bounds) }

    override fun draw(canvas: Canvas) {
        Screws.plate(canvas, rect, fill, density, paint)
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/** The one way a dark plate and its screws are drawn, so the control panel and the transfer unit match the rack. */
object Screws {
    fun plate(canvas: Canvas, rect: RectF, fill: Int, density: Float, paint: Paint) {
        paint.style = Paint.Style.FILL; paint.color = fill
        canvas.drawRoundRect(rect, 2 * density, 2 * density, paint)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 2 * density; paint.color = Retro.EDGE
        canvas.drawRoundRect(rect, 2 * density, 2 * density, paint)
        val inset = 11 * density
        dark(canvas, rect.left + inset, rect.top + inset, density, paint)
        dark(canvas, rect.right - inset, rect.top + inset, density, paint)
        dark(canvas, rect.left + inset, rect.bottom - inset, density, paint)
        dark(canvas, rect.right - inset, rect.bottom - inset, density, paint)
    }

    /** A steel screw head on a dark plate: a rim, a lighter face and the slot at 45 degrees. */
    fun dark(canvas: Canvas, x: Float, y: Float, density: Float, paint: Paint) {
        val r = 4.5f * density
        paint.style = Paint.Style.FILL; paint.color = Color.rgb(132, 124, 112)
        canvas.drawCircle(x, y, r, paint)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.2f * density; paint.color = Color.rgb(36, 32, 28)
        canvas.drawCircle(x, y, r, paint)
        canvas.drawLine(x - r * 0.6f, y - r * 0.6f, x + r * 0.6f, y + r * 0.6f, paint)
        paint.style = Paint.Style.FILL
    }
}
