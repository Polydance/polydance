package net.polydance.capture

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.concurrent.Executors

/**
 * The player (Robin, 2026-10-12: play a recording back, see its timeline, skip to the key parts and read the
 * transcript). Opened from a recording's tile in a thread, over the inbox in its own panel. The video plays
 * from this headset's own copy when it has one, else streams from the receiver, which serves it by range so
 * it can seek. The receiver also sends the transcript and the key moments (what was asked for, the spoken
 * markers, what was opened from the inbox): ticks on the timeline, and lists under it that go to the moment
 * pressed. A recording keeps the narrator's voice and the app's sound on separate tracks and the platform
 * player plays one at a time, so Voice and App sound choose which.
 */
class PlayerActivity : Activity(), SurfaceHolder.Callback {
    companion object {
        const val EXTRA_THREAD = "thread"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_TITLE = "title"
        const val EXTRA_LOCAL = "local"
        /** A take without the picture (docs/LOGS.md): the frame says so where the picture would be. */
        const val EXTRA_SOUND_ONLY = "soundOnly"
        private const val TAG = "PolydanceCapture"
        /** A moment is said a little after what it is about begins: start there, not mid-sentence. */
        private const val LEAD_IN_MS = 2_000L
    }

    data class Line(val startMs: Long, val endMs: Long, val text: String)
    data class Moment(val atMs: Long, val kind: String, val text: String)
    data class Playback(
        val title: String?, val summary: String?, val durationMs: Long?, val videoAvailable: Boolean,
        val audioTracks: List<String>, val transcript: List<Line>, val moments: List<Moment>,
        /** The receiver deleted the video when its kept days ran out (2026-11-12); null while it is there or still coming. */
        val videoKeptDays: Int? = null, val videoDeleted: Boolean = false,
    )

    private val ui = Handler(Looper.getMainLooper())
    private val background = Executors.newSingleThreadExecutor()
    private lateinit var frame: VideoFrame
    private lateinit var surfaceView: SurfaceView
    private lateinit var bigPlay: ImageView
    private lateinit var status: TextView
    private lateinit var timeline: TimelineBar
    private lateinit var playKey: ImageView
    private lateinit var clock: TextView
    private lateinit var sound: LinearLayout
    private lateinit var tabs: LinearLayout
    private lateinit var list: LinearLayout
    private lateinit var listScroll: ScrollView
    private lateinit var about: LinearLayout

    private var key = ""
    private var message = 0
    private var local: File? = null
    private var playback: Playback? = null
    private var remote: Pair<Uri, Map<String, String>>? = null
    private var player: MediaPlayer? = null
    private var holder: SurfaceHolder? = null
    private var prepared = false
    private var wantPlay = true
    private var resumeAt = 0L
    /** The narrator's voice ("mic") or the app's sound ("app"); the roles come in file order. */
    private var role = "mic"
    private var roles: List<String> = emptyList()
    private var showing = Tab.MOMENTS
    private val lineRows = ArrayList<TextView>()
    private var lit = -1
    private var touchedListAt = 0L

    private enum class Tab { MOMENTS, TRANSCRIPT }

    private fun dp(v: Float) = Retro.dp(this, v).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        key = intent.getStringExtra(EXTRA_THREAD).orEmpty()
        message = intent.getIntExtra(EXTRA_MESSAGE, 0)
        local = intent.getStringExtra(EXTRA_LOCAL)?.let { File(it) }?.takeIf { it.exists() }
        setContentView(buildUi(intent.getStringExtra(EXTRA_TITLE) ?: "Recording"))
        Timeline.log("player", "open", "key" to key, "message" to message, "local" to (local != null))
        load()
    }

    override fun onPause() {
        player?.takeIf { prepared && it.isPlaying }?.let { it.pause(); wantPlay = false }
        player?.takeIf { prepared }?.let { resumeAt = it.currentPosition.toLong() }
        keepAwake(false)
        updateKeys()
        super.onPause()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        release()
        background.shutdown()
        Timeline.log("player", "close", "key" to key, "message" to message)
        super.onDestroy()
    }

    // ---- What to play.

    private fun load() {
        val config = UploadSettings.load(this)
        if (config == null) { onLoaded(null, local, "Not signed in, so only this headset's own copy can play."); return }
        status("Loading…")
        background.execute {
            val path = "/v1/threads/$key/messages/$message/playback"
            val result = runCatching { parse(ReceiverClient(config).json("GET", path)) }
            ui.post {
                if (isDestroyed) return@post
                result.onSuccess { p ->
                    remote = if (p.videoAvailable) Uri.parse("${config.server}/v1/threads/$key/messages/$message/video") to mapOf("Authorization" to "Bearer ${config.token}") else null
                    onLoaded(p, local, when {
                        local != null || p.videoAvailable -> null
                        p.videoDeleted -> p.videoKeptDays?.let { "The video was deleted $it days after it was sent. The transcript is still here." }
                            ?: "The video was deleted from the server. The transcript is still here."
                        else -> "The video is still on its way to the server. The transcript is here already."
                    })
                }.onFailure { e ->
                    val code = (e as? ReceiverClient.Refused)?.code
                    Log.w(TAG, "playback for $key #$message: ${code ?: e.javaClass.simpleName}")
                    onLoaded(null, local, when {
                        code == 403 -> if (local != null) "Playing this headset's own copy." else "Only people in this thread, and the team, can play its recordings."
                        code == 404 -> if (local != null) "This server doesn't send transcripts yet; playing this headset's own copy." else "This server can't play recordings yet, or the recording is gone."
                        e is IOException -> if (local != null) "Can't reach the server, so there is no transcript; playing this headset's own copy." else "Can't reach the server. Check the connection."
                        else -> "The server's answer could not be read."
                    })
                }
            }
        }
    }

    private fun parse(j: JSONObject): Playback {
        fun JSONObject.str(name: String) = if (has(name) && !isNull(name)) optString(name).ifEmpty { null } else null
        fun <T> JSONArray?.items(read: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).map { read(getJSONObject(it)) }
        val video = j.optJSONObject("video")
        return Playback(
            j.str("title"), j.str("summary"), if (j.has("durationMs")) j.optLong("durationMs") else null,
            video?.optBoolean("available") == true,
            j.optJSONArray("audioTracks")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
            j.optJSONArray("transcript").items { Line(it.getLong("startMs"), it.optLong("endMs", it.getLong("startMs")), it.getString("text")) },
            j.optJSONArray("moments").items { Moment(it.getLong("atMs"), it.optString("kind", "note"), it.getString("text")) }.sortedBy { it.atMs },
            video?.takeIf { it.has("keptDays") }?.optInt("keptDays")?.takeIf { it > 0 },
            video?.has("deletedAt") == true,
        )
    }

    /** Which tracks this headset's own copy has, from how it was recorded (run.json): the mic first, then the app. */
    private fun localRoles(file: File): List<String> = runCatching {
        val config = JSONObject(File(file.parentFile, "run.json").readText()).getJSONObject("config")
        listOfNotNull("mic".takeIf { config.optBoolean("mic", true) }, "app".takeIf { config.optBoolean("appAudio", false) })
    }.getOrDefault(emptyList())

    private fun onLoaded(p: Playback?, own: File?, message: String?) {
        playback = p
        roles = own?.let(::localRoles)?.takeIf { it.isNotEmpty() } ?: p?.audioTracks.orEmpty()
        role = if ("mic" in roles) "mic" else roles.firstOrNull() ?: "mic"
        drawAbout(p)
        drawSound()
        timeline.durationMs = p?.durationMs ?: 0
        timeline.moments = p?.moments.orEmpty().map { it.atMs to colour(it.kind) }
        showing = if (p?.moments.isNullOrEmpty()) Tab.TRANSCRIPT else Tab.MOMENTS
        drawTabs()
        status(message)
        if (own != null || remote != null) open() else updateKeys()
    }

    // ---- The platform player.

    override fun surfaceCreated(h: SurfaceHolder) {
        holder = h
        player?.setDisplay(h)
    }

    override fun surfaceChanged(h: SurfaceHolder, format: Int, width: Int, height: Int) {}

    override fun surfaceDestroyed(h: SurfaceHolder) {
        if (holder === h) holder = null
        player?.setDisplay(null)
    }

    /** (Re)opens the source; the audio track can only be chosen while prepared, so a switch reopens at the same place. */
    private fun open() {
        release()
        val mp = MediaPlayer()
        prepared = false
        try {
            mp.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
            val own = local
            val stream = remote
            when {
                own != null -> mp.setDataSource(own.absolutePath)
                stream != null -> mp.setDataSource(this, stream.first, stream.second)
                else -> { mp.release(); return }
            }
            holder?.let { mp.setDisplay(it) }
            mp.setOnPreparedListener { onPrepared(it) }
            mp.setOnVideoSizeChangedListener { _, w, h -> frame.setVideoSize(w, h) }
            mp.setOnCompletionListener { wantPlay = false; keepAwake(false); updateKeys() }
            mp.setOnInfoListener { _, what, _ ->
                when (what) {
                    MediaPlayer.MEDIA_INFO_BUFFERING_START -> status("Loading…")
                    MediaPlayer.MEDIA_INFO_BUFFERING_END -> status(null)
                }
                false
            }
            mp.setOnErrorListener { _, what, extra ->
                Log.w(TAG, "player error $what/$extra for $key #$message")
                Timeline.log("player", "error", "what" to what, "extra" to extra)
                status("This recording can't be played here ($what, $extra).")
                prepared = false; keepAwake(false); updateKeys()
                true
            }
            status("Loading…")
            mp.prepareAsync()
            player = mp
        } catch (e: Exception) {
            mp.release()
            Log.w(TAG, "player could not open: $e")
            status("This recording can't be opened: ${e.javaClass.simpleName}.")
        }
    }

    private fun onPrepared(mp: MediaPlayer) {
        if (player !== mp) return
        prepared = true
        status(null)
        // The audio tracks in file order, matched to their roles (mic, then app, as Polydance Capture records them).
        val audio = mp.trackInfo.withIndex().filter { it.value.trackType == MediaPlayer.TrackInfo.MEDIA_TRACK_TYPE_AUDIO }.map { it.index }
        val index = roles.indexOf(role)
        if (index in audio.indices && audio.size > 1) runCatching { mp.selectTrack(audio[index]) }.onFailure { Log.w(TAG, "track select failed: $it") }
        if (mp.duration > 0) timeline.durationMs = mp.duration.toLong()
        if (resumeAt > 0) mp.seekTo(resumeAt, MediaPlayer.SEEK_CLOSEST)
        if (wantPlay) { mp.start(); keepAwake(true) }
        updateKeys()
        ui.removeCallbacks(progress); ui.post(progress)
    }

    private fun release() {
        ui.removeCallbacks(progress)
        player?.let { runCatching { it.release() } }
        player = null
        prepared = false
    }

    private val progress = object : Runnable {
        override fun run() {
            val mp = player ?: return
            if (prepared) {
                val at = mp.currentPosition.toLong()
                if (!timeline.dragging) timeline.positionMs = at
                clock.text = "${InboxText.clock(at)} / ${InboxText.clock(timeline.durationMs)}"
                follow(at)
            }
            ui.postDelayed(this, 250)
        }
    }

    private fun toggle() {
        val mp = player
        if (mp == null || !prepared) { wantPlay = !wantPlay; if (mp == null && (local != null || remote != null)) open(); updateKeys(); return }
        if (mp.isPlaying) { mp.pause(); wantPlay = false; keepAwake(false) }
        else { mp.start(); wantPlay = true; keepAwake(true) }
        Timeline.log("player", if (wantPlay) "play" else "pause", "atMs" to mp.currentPosition)
        updateKeys()
    }

    /** Goes to [ms] and plays from there, as pressing a moment or a line should. */
    private fun seek(ms: Long, play: Boolean = true) {
        val at = ms.coerceIn(0, maxOf(0, timeline.durationMs))
        resumeAt = at
        timeline.positionMs = at
        clock.text = "${InboxText.clock(at)} / ${InboxText.clock(timeline.durationMs)}"
        val mp = player
        if (mp != null && prepared) {
            mp.seekTo(at, MediaPlayer.SEEK_CLOSEST)
            if (play && !mp.isPlaying) { mp.start(); wantPlay = true; keepAwake(true) }
        } else if (play) wantPlay = true
        updateKeys()
    }

    private fun skip(by: Long) { seek((player?.takeIf { prepared }?.currentPosition?.toLong() ?: resumeAt) + by, play = false) }

    private fun switchSound(next: String) {
        if (next == role) return
        role = next
        resumeAt = player?.takeIf { prepared }?.currentPosition?.toLong() ?: resumeAt
        wantPlay = player?.takeIf { prepared }?.isPlaying ?: wantPlay
        Timeline.log("player", "sound", "role" to next)
        drawSound()
        open()
    }

    private fun keepAwake(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun status(text: String?) {
        status.text = text.orEmpty()
        status.visibility = if (text == null) View.GONE else View.VISIBLE
    }

    private fun updateKeys() {
        val playing = player?.takeIf { prepared }?.isPlaying == true
        playKey.setImageDrawable(Glyph(if (playing) Glyph.Kind.PAUSE else Glyph.Kind.PLAY, Retro.CREAM, resources.displayMetrics.density, 28f))
        playKey.contentDescription = if (playing) "Pause" else "Play"
        bigPlay.visibility = if (!playing && prepared) View.VISIBLE else View.GONE
    }

    // ---- What is under the video.

    private fun colour(kind: String) = when (kind) {
        "request" -> Retro.AMBER
        "bug" -> Retro.RED
        "idea", "praise" -> Retro.GREEN
        "change" -> Retro.BLUE
        "reference" -> Retro.PROCESSING
        "opened" -> Retro.CREAM
        else -> Retro.TAN
    }

    private fun kindName(kind: String) = when (kind) {
        "request" -> "ASKED FOR"
        else -> kind.uppercase(Locale.UK)
    }

    private fun drawAbout(p: Playback?) {
        about.removeAllViews()
        p?.title?.let { about.addView(Retro.label(this, it, 18f, Retro.CREAM, 0.04f)) }
        p?.summary?.let { about.addView(Retro.body(this, 15f, Retro.TAN).apply { text = it; setPadding(0, dp(4f), 0, 0); setLineSpacing(0f, 1.1f) }) }
        about.visibility = if (about.childCount > 0) View.VISIBLE else View.GONE
    }

    /** Voice and App sound, shown only when the recording has both. */
    private fun drawSound() {
        sound.removeAllViews()
        if (!("mic" in roles && "app" in roles)) return
        for ((name, label) in listOf("mic" to "Voice", "app" to "App sound")) {
            sound.addView(chip(label, role == name) { switchSound(name) },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(6f) })
        }
    }

    private fun drawTabs() {
        val p = playback
        tabs.removeAllViews()
        tabs.addView(chip("Key moments (${p?.moments?.size ?: 0})", showing == Tab.MOMENTS) { showing = Tab.MOMENTS; drawTabs() },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) })
        tabs.addView(chip("Transcript (${p?.transcript?.size ?: 0})", showing == Tab.TRANSCRIPT) { showing = Tab.TRANSCRIPT; drawTabs() })
        list.removeAllViews(); lineRows.clear(); lit = -1
        when {
            p == null -> list.addView(empty("No transcript here: it comes from the server."))
            showing == Tab.MOMENTS && p.moments.isEmpty() -> list.addView(empty("No key moments in this recording yet. They come once its words are ready: what was asked for, and words like “bug” and “it would be nice”."))
            showing == Tab.MOMENTS -> for (m in p.moments) list.addView(momentRow(m))
            p.transcript.isEmpty() -> list.addView(empty("No words yet: the transcript comes once the server has heard the recording."))
            else -> for (l in p.transcript) lineRows += lineRow(l)
        }
        listScroll.scrollTo(0, 0)
    }

    private fun empty(text: String) = Retro.body(this, 15f, Retro.TAN).apply { this.text = text; setPadding(0, dp(12f), 0, 0) }

    private fun row(onClick: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP
        setPadding(dp(10f), dp(10f), dp(10f), dp(10f))
        background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(Color.argb(50, 239, 230, 210)), null, android.graphics.drawable.ColorDrawable(Color.WHITE))
        isClickable = true; isFocusable = true
        setOnClickListener { onClick() }
    }

    private fun momentRow(m: Moment) = row { seek(maxOf(0, m.atMs - LEAD_IN_MS)); Timeline.log("player", "moment", "kind" to m.kind, "atMs" to m.atMs) }.apply {
        contentDescription = "${kindName(m.kind)} at ${InboxText.clock(m.atMs)}: ${m.text}"
        addView(Retro.label(this@PlayerActivity, InboxText.clock(m.atMs), 14f, Retro.CREAM, 0.06f), LinearLayout.LayoutParams(dp(58f), LinearLayout.LayoutParams.WRAP_CONTENT))
        val words = LinearLayout(this@PlayerActivity).apply { orientation = LinearLayout.VERTICAL }
        words.addView(Retro.label(this@PlayerActivity, kindName(m.kind), 12f, colour(m.kind), 0.16f))
        words.addView(Retro.body(this@PlayerActivity, 16f, Retro.CREAM).apply { text = m.text; setLineSpacing(0f, 1.1f) })
        addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    }

    private fun lineRow(l: Line): TextView {
        val text = Retro.body(this, 16f, Retro.CREAM).apply { text = l.text; setLineSpacing(0f, 1.1f) }
        row { seek(l.startMs) }.apply {
            contentDescription = "${InboxText.clock(l.startMs)}: ${l.text}"
            addView(Retro.label(this@PlayerActivity, InboxText.clock(l.startMs), 14f, Retro.TAN, 0.06f), LinearLayout.LayoutParams(dp(58f), LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            list.addView(this)
        }
        return text
    }

    /** Lights the line being spoken and keeps it in view, unless the list was just moved by hand. */
    private fun follow(at: Long) {
        val p = playback ?: return
        if (showing != Tab.TRANSCRIPT || lineRows.isEmpty()) return
        val now = InboxText.lineAt(p.transcript.map { it.startMs }, at)
        if (now == lit) return
        lineRows.getOrNull(lit)?.setTextColor(Retro.CREAM)
        lit = now
        val row = lineRows.getOrNull(now) ?: return
        row.setTextColor(Retro.AMBER)
        if (System.currentTimeMillis() - touchedListAt > 4_000) {
            val parent = row.parent as View
            listScroll.smoothScrollTo(0, maxOf(0, parent.top - dp(60f)))
        }
    }

    /** A switch chip, the inbox's: amber with a tick when on. */
    private fun chip(label: String, on: Boolean, onClick: () -> Unit) = TextView(this).apply {
        text = if (on) "✓  $label" else label
        textSize = 14f; typeface = Retro.LABEL; letterSpacing = 0.06f
        setTextColor(if (on) Retro.CASING else Retro.TAN)
        background = Retro.panel(this@PlayerActivity, if (on) Retro.AMBER else Retro.CASING, 18f, if (on) Retro.AMBER else Retro.EDGE)
        setPadding(dp(14f), dp(7f), dp(14f), dp(7f))
        isClickable = true; isFocusable = true
        contentDescription = "$label: ${if (on) "on" else "off"}"
        setOnClickListener { onClick() }
    }

    // ---- Building the panel.

    @SuppressLint("ClickableViewAccessibility") // the list's touch listener only notes the time and never consumes
    private fun buildUi(title: String): View {
        val density = resources.displayMetrics.density
        window.decorView.setBackgroundColor(Retro.WOOD_MID)
        val column = ClampedColumn(this, dp(900f)).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12f), dp(12f), dp(12f), dp(12f)) }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        bar.addView(Glyph.key(this, Glyph.Kind.BACK, Retro.BURNT, "Back to the thread") { finish() })
        bar.addView(Retro.label(this, title, 18f, Retro.BURNT, 0.08f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(4f) })
        bar.addView(Retro.label(this, "$key  #$message", 13f, Retro.BURNT, 0.14f))
        column.addView(bar)

        // The video, letterboxed in a dark frame the shape of the recording; a press plays or pauses.
        frame = VideoFrame(this, maxHeightFraction = 0.5f).apply {
            setBackgroundColor(Retro.PANEL)
            isClickable = true; setOnClickListener { toggle() }
        }
        surfaceView = SurfaceView(this).apply { holder.addCallback(this@PlayerActivity) }
        frame.addView(surfaceView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))
        bigPlay = ImageView(this).apply { setImageDrawable(Glyph(Glyph.Kind.PLAY, Retro.CREAM, density, 64f)); visibility = View.GONE; alpha = 0.85f }
        frame.addView(bigPlay, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        status = Retro.body(this, 15f, Retro.CREAM).apply {
            gravity = Gravity.CENTER; setPadding(dp(16f), dp(8f), dp(16f), dp(8f))
            background = Retro.panel(this@PlayerActivity, Retro.PANEL, 8f, Retro.EDGE); visibility = View.GONE
        }
        frame.addView(status, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { setMargins(dp(24f), 0, dp(24f), 0) })
        if (intent.getBooleanExtra(EXTRA_SOUND_ONLY, false)) frame.addView(Retro.label(this, "SOUND ONLY  ·  NO PICTURE", 13f, Retro.AMBER, 0.14f),
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply { setMargins(dp(14f), dp(12f), 0, 0) })
        column.addView(frame, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })

        // The transport: the timeline with its moments, then play, ten seconds either way, the clock and the sound.
        val controls = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16f), dp(10f), dp(16f), dp(10f))
            background = PlateDrawable(density)
        }
        timeline = TimelineBar(this).apply { onSeek = { seek(it, play = false) } }
        controls.addView(timeline, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(dp(8f), 0, dp(8f), 0) })
        val keys = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        playKey = Glyph.key(this, Glyph.Kind.PLAY, Retro.CREAM, "Play") { toggle() }
        keys.addView(Glyph.key(this, Glyph.Kind.BACK10, Retro.CREAM, "Back ten seconds") { skip(-10_000) })
        keys.addView(playKey)
        keys.addView(Glyph.key(this, Glyph.Kind.AHEAD10, Retro.CREAM, "Ahead ten seconds") { skip(10_000) })
        clock = Retro.label(this, "0:00 / 0:00", 14f, Retro.CREAM, 0.06f)
        keys.addView(clock, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
        keys.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        sound = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        keys.addView(sound)
        controls.addView(keys)
        column.addView(controls, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })

        // Below: what the recording is, then its key moments or its transcript.
        val lower = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22f), dp(16f), dp(22f), dp(16f))
            background = PlateDrawable(density)
        }
        about = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(4f), 0, dp(4f), dp(12f)); visibility = View.GONE }
        lower.addView(about)
        tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(4f), 0, 0, dp(6f)) }
        lower.addView(tabs)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        listScroll = ScrollView(this).apply {
            addView(list)
            // Moved by hand, it stays put a few seconds instead of following the line being spoken.
            setOnTouchListener { _, _ -> touchedListAt = System.currentTimeMillis(); false }
        }
        lower.addView(listScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        column.addView(lower, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = dp(8f) })

        return FrameLayout(this).apply {
            background = WoodDrawable(density)
            addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER_HORIZONTAL))
        }
    }
}
