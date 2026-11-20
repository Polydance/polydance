package net.polydance.capture

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.view.Surface
import java.io.File

/** What the recorder service runs for a take: something that writes one file, started and stopped once. */
interface Engine {
    /** Short name for run.json and the timeline. */
    val engine: String
    /** Audio tracks in file order, for example ["mic", "app"]; known after it is prepared. */
    val audioTracks: List<String>

    fun start()
    /** Stops and finalises the file; returns an error description, or null when the file is good. */
    fun stop(): String?

    /** Peaks and counts since the previous call; null where the engine cannot measure it. */
    fun levels(): Levels

    /** Reports a failure the engine detects on its own after start (the service ends the run). */
    var onError: ((String) -> Unit)?
}

/**
 * A recording engine for the picture: something with a Surface for the virtual display to draw into, that writes
 * one MP4. Two exist so the proven path stays available for comparison: MediaRecorder (video plus mic, the first
 * Quest runs) and [MuxerCapture] (video, mic and in-app audio as separate tracks).
 */
interface Capture : Engine {
    /** True when [start] must run before the virtual display exists, so no early frame is lost. */
    val startBeforeDisplay: Boolean

    fun prepare(): Surface
}

data class Levels(val micPeak: Int?, val appPeak: Int?, val videoFrames: Int?)

/** The original engine: MediaRecorder with a surface source and, optionally, the microphone. */
class RecorderCapture(
    private val context: Context, private val output: File,
    private val width: Int, private val height: Int, private val bitrate: Int,
    private val mic: Boolean, private val maxMinutes: Int, private val onMaxDuration: () -> Unit,
) : Capture {
    override val engine = "mediarecorder"
    override val audioTracks = if (mic) listOf("mic") else emptyList()
    override val startBeforeDisplay = false
    override var onError: ((String) -> Unit)? = null
    private var recorder: MediaRecorder? = null

    override fun prepare(): Surface {
        val rec = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        recorder = rec
        if (mic) rec.setAudioSource(MediaRecorder.AudioSource.MIC)
        rec.setVideoSource(MediaRecorder.VideoSource.SURFACE)
        rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        rec.setOutputFile(output.absolutePath)
        rec.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
        rec.setVideoSize(width, height)
        rec.setVideoFrameRate(30)
        rec.setVideoEncodingBitRate(bitrate)
        if (mic) {
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioSamplingRate(48_000)
            rec.setAudioEncodingBitRate(128_000)
            rec.setAudioChannels(1)
        }
        rec.setMaxDuration(maxMinutes * 60_000)
        rec.setOnInfoListener { _, what, extra ->
            Timeline.log("recorder", "info", "what" to what, "extra" to extra)
            if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) onMaxDuration()
        }
        rec.setOnErrorListener { _, what, extra ->
            Timeline.log("recorder", "error", "what" to what, "extra" to extra)
            onError?.invoke("recorder_error")
        }
        rec.prepare()
        return rec.surface
    }

    override fun start() { recorder!!.start() }

    override fun stop(): String? {
        val rec = recorder ?: return "never prepared"
        recorder = null
        return try {
            rec.stop(); null
        } catch (e: RuntimeException) {
            // MediaRecorder throws here when it never received a frame; the file is then unplayable.
            e.toString()
        } finally {
            runCatching { rec.release() }
        }
    }

    override fun levels() = Levels(
        micPeak = if (mic) runCatching { recorder?.maxAmplitude }.getOrNull() else null,
        appPeak = null, videoFrames = null,
    )
}

/**
 * The microphone alone, for a take with Screen off and Mic on (docs/LOGS.md): MediaRecorder from the MIC source into
 * audio.m4a, AAC at 48 kHz mono and 128 kbps, the same as the mic track of a recording with the picture, so the
 * receiver transcribes it alike. No screen capture and no prompt for one; the service holds it as a microphone
 * foreground service, which Android 14 lets start only while Polydance is in front.
 */
class SoundCapture(
    private val context: Context, private val output: File, private val maxMinutes: Int, private val onMaxDuration: () -> Unit,
) : Engine {
    override val engine = "mediarecorder-audio"
    override val audioTracks = listOf("mic")
    override var onError: ((String) -> Unit)? = null
    private var recorder: MediaRecorder? = null

    fun prepare() {
        val rec = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        recorder = rec
        rec.setAudioSource(MediaRecorder.AudioSource.MIC)
        rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        rec.setOutputFile(output.absolutePath)
        rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        rec.setAudioSamplingRate(48_000)
        rec.setAudioEncodingBitRate(128_000)
        rec.setAudioChannels(1)
        rec.setMaxDuration(maxMinutes * 60_000)
        rec.setOnInfoListener { _, what, extra ->
            Timeline.log("recorder", "info", "what" to what, "extra" to extra)
            if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) onMaxDuration()
        }
        rec.setOnErrorListener { _, what, extra ->
            Timeline.log("recorder", "error", "what" to what, "extra" to extra)
            onError?.invoke("recorder_error")
        }
        rec.prepare()
    }

    override fun start() { recorder!!.start() }

    override fun stop(): String? {
        val rec = recorder ?: return "never prepared"
        recorder = null
        return try {
            rec.stop(); null
        } catch (e: RuntimeException) {
            // As for the picture: MediaRecorder throws when it never received a sample, and the file is then unplayable.
            e.toString()
        } finally {
            runCatching { rec.release() }
        }
    }

    override fun levels() = Levels(micPeak = runCatching { recorder?.maxAmplitude }.getOrNull(), appPeak = null, videoFrames = null)
}
