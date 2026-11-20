package net.polydance.capture

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.widget.TextView

/**
 * The look: a vintage portable tape recorder in a dark room. Warm charcoal casing, cream printed
 * labels, an amber-lit meter, one red record button. Dark on purpose, because a bright panel in a
 * headset is tiring; every colour here keeps cream text well above 7:1 contrast on the casing.
 */
object Retro {
    val CASING = Color.rgb(28, 25, 22)
    val SURFACE = Color.rgb(38, 34, 30)
    val EDGE = Color.rgb(64, 57, 49)
    val CREAM = Color.rgb(239, 230, 210)
    val TAN = Color.rgb(184, 173, 151)
    val AMBER = Color.rgb(240, 168, 48)
    val RED = Color.rgb(217, 58, 43)
    val GREEN = Color.rgb(120, 190, 110)
    val BLUE = Color.rgb(140, 180, 220)

    // The third design pass took its colours from a 1960s portable deck: a cream metal top plate,
    // clear reels with orange labels, a black control panel with white lettering, red push keys.
    val PLATE_LIGHT = Color.rgb(230, 221, 197)
    val PLATE_DARK = Color.rgb(205, 194, 166)
    val PLATE_EDGE = Color.rgb(150, 138, 110)
    val PRINT = Color.rgb(58, 44, 32)
    val ORANGE = Color.rgb(240, 92, 34)
    val PANEL = Color.rgb(18, 16, 14)
    val WHITE_PRINT = Color.rgb(236, 232, 222)

    // The fourth and fifth passes (2026-10-02) put the plates on a light wooden cabinet, after the
    // Pulsar Modular P252 plugin Robin showed: a dark faceplate screwed into wood, amber LED bars.
    val WOOD_LIGHT = Color.rgb(224, 194, 148)
    val WOOD_MID = Color.rgb(210, 176, 126)
    val WOOD_GRAIN = Color.rgb(150, 106, 62)
    val WOOD_SEAM = Color.rgb(112, 76, 44)
    /** Lettering burnt into the wood. */
    val BURNT = Color.rgb(82, 44, 18)
    val LED = Color.rgb(255, 152, 44)
    val LED_OFF = Color.rgb(54, 32, 14)

    // The sixth pass (2026-10-04, thread CAP-1): uploading and processing in colours of their own, the
    // transfer unit's legends lit in them and every status word that says which one a recording is doing.
    val UPLOADING = LED
    val PROCESSING = Color.rgb(84, 204, 232)
    val PROCESSING_OFF = Color.rgb(12, 40, 48)

    /** Printed-label type: condensed, bold, spaced out, like the lettering on hardware. */
    val LABEL: Typeface = Typeface.create("sans-serif-condensed", Typeface.BOLD)
    val BODY: Typeface = Typeface.create("sans-serif-condensed", Typeface.NORMAL)
    /** Typewriter digits for the tape counter. Falls back to plain monospace where the font is absent. */
    val COUNTER: Typeface = Typeface.create("serif-monospace", Typeface.BOLD)

    fun dp(context: Context, value: Float) = value * context.resources.displayMetrics.density

    fun label(context: Context, text: String, size: Float, color: Int = TAN, spacing: Float = 0.14f) = TextView(context).apply {
        this.text = text
        textSize = size
        typeface = LABEL
        letterSpacing = spacing
        setTextColor(color)
    }

    fun body(context: Context, size: Float, color: Int = CREAM) = TextView(context).apply {
        textSize = size
        typeface = BODY
        setTextColor(color)
    }

    fun panel(context: Context, fill: Int = SURFACE, radius: Float = 14f, stroke: Int = EDGE) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(context, radius)
        setStroke(dp(context, 1f).toInt(), stroke)
    }

    /** A flat, outlined button with a pressed ripple, sized for a controller ray. */
    fun button(context: Context, text: String, color: Int = CREAM, small: Boolean = false, onClick: () -> Unit) = TextView(context).apply {
        this.text = text.uppercase()
        textSize = if (small) 13f else 15f
        typeface = LABEL
        letterSpacing = 0.12f
        setTextColor(color)
        gravity = Gravity.CENTER
        val padH = dp(context, if (small) 12f else 18f).toInt(); val padV = dp(context, if (small) 8f else 10f).toInt()
        setPadding(padH, padV, padH, padV)
        minWidth = dp(context, if (small) 0f else 96f).toInt()
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 239, 230, 210)), panel(context, CASING, 10f, color), null)
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }
}
