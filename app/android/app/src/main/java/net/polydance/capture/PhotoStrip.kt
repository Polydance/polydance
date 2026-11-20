package net.polydance.capture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.LruCache
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

/**
 * A message's photos as a row of tiles under its words (docs/THREADS.md, Photos, 2026-11-07), each as wide
 * as its shape at one height. Each is fetched through the thread once the row is on screen, checked against
 * its sha256 (Photos), and drawn shrunk to the tile; pressing one hands its file to [open], which shows it
 * large. A photo that cannot be fetched says why on its tile and is tried again when the thread is drawn again.
 */
@SuppressLint("ViewConstructor")
class PhotoStrip(
    context: Context, private val key: String, private val photos: List<Threads.Photo>, private val open: (Threads.Photo, File) -> Unit,
) : HorizontalScrollView(context) {
    private val ui = Handler(Looper.getMainLooper())
    private val density = resources.displayMetrics.density
    private fun dp(v: Float) = (v * density).toInt()
    private val height = dp(TILE_HEIGHT_DP)
    private var started = false

    init {
        isHorizontalScrollBarEnabled = false
        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        photos.forEachIndexed { i, photo -> row.addView(tile(photo, i), LinearLayout.LayoutParams(width(photo), height).apply { if (i > 0) leftMargin = dp(8f) }) }
        addView(row)
    }

    private fun width(photo: Threads.Photo) = (height * photo.width.toFloat() / photo.height).toInt().coerceIn(dp(60f), dp(320f))

    private fun tile(photo: Threads.Photo, index: Int): FrameLayout = FrameLayout(context).apply {
        background = GradientDrawable().apply { setColor(Retro.SURFACE); cornerRadius = dp(6f).toFloat(); setStroke(dp(1f), Retro.EDGE) }
        clipToOutline = true
        contentDescription = "Photo ${index + 1} of ${photos.size}, ${photo.width} by ${photo.height}"
        addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; tag = IMAGE },
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        addView(Retro.body(context, 12f, Retro.TAN).apply { text = "Fetching…"; gravity = Gravity.CENTER; tag = STATUS; setPadding(dp(6f), 0, dp(6f), 0) },
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    /** Fetches the photos once the row is on screen. */
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (started) return
        started = true
        val row = getChildAt(0) as LinearLayout
        val config = UploadSettings.load(context)
        photos.forEachIndexed { i, photo ->
            val tile = row.getChildAt(i) as FrameLayout
            val image = tile.findViewWithTag<ImageView>(IMAGE)
            val status = tile.findViewWithTag<View>(STATUS) as android.widget.TextView
            thumbs.get(photo.sha256)?.let { cached -> show(tile, image, status, photo, cached.first, cached.second); return@forEachIndexed }
            if (config == null) { status.text = "Not signed in"; return@forEachIndexed }
            loader.execute {
                val result = runCatching {
                    val file = Photos.obtain(context.filesDir, photo) { part -> ReceiverClient(config).download("/v1/threads/$key/photos/${photo.sha256}", part, photo.bytes) }
                    val bitmap = decode(file, photo, height) ?: throw IOException("the photo could not be drawn")
                    thumbs.put(photo.sha256, file to bitmap)
                    file to bitmap
                }
                ui.post {
                    result.onSuccess { (file, bitmap) -> show(tile, image, status, photo, file, bitmap) }.onFailure { e ->
                        Log.w(TAG, "photo ${photo.sha256.take(12)}: ${e.javaClass.simpleName}")
                        Timeline.log("photo", "fetch_failed", "key" to key, "sha256" to photo.sha256.take(12), "error" to e.toString().take(200))
                        status.text = when {
                            (e as? ReceiverClient.Refused)?.code == 403 -> "Only people in this thread can see it"
                            (e as? ReceiverClient.Refused)?.code == 404 -> "Not on the server"
                            e is IOException -> "Can't fetch it"
                            else -> "Can't draw it"
                        }
                        started = false
                    }
                }
            }
        }
    }

    private fun show(tile: FrameLayout, image: ImageView, status: android.widget.TextView, photo: Threads.Photo, file: File, bitmap: Bitmap) {
        image.setImageBitmap(bitmap)
        status.visibility = View.GONE
        tile.isClickable = true; tile.isFocusable = true
        tile.contentDescription = "${tile.contentDescription}. Press to see it large"
        tile.setOnClickListener { open(photo, file); Timeline.log("photo", "open", "key" to key, "sha256" to photo.sha256.take(12)) }
    }

    companion object {
        private const val TAG = "PhotoStrip"
        const val TILE_HEIGHT_DP = 150f
        private const val IMAGE = "image"
        private const val STATUS = "status"
        /** Two at a time: a message holds up to ten, and the inbox fetches nothing else meanwhile. */
        private val loader = Executors.newFixedThreadPool(2)
        /** Thumbnails already drawn, by sha256, so a redraw of the thread does not decode them again (about 16 MB). */
        private val thumbs = object : LruCache<String, Pair<File, Bitmap>>(16 * 1024 * 1024) {
            override fun sizeOf(key: String, value: Pair<File, Bitmap>) = value.second.byteCount
        }

        /** The photo shrunk by a power of two so its longer side is still at least [target] pixels; null when it cannot be read. */
        fun decode(file: File, photo: Threads.Photo, target: Int): Bitmap? =
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = Photos.sampleSize(photo.width, photo.height, target) })
    }
}
