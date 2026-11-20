package net.polydance.capture

import android.os.SystemClock
import java.io.File
import java.util.Locale

/**
 * Live counters shared by the service (which writes them every heartbeat) and the screen (which
 * reads them). Process-wide rather than per-activity so an away period survives the activity being
 * destroyed while the user is in another app.
 */
object CaptureState {
    @Volatile var recording = false
    /** What the take in progress records (Takes): a picture, sound alone, or logs alone. */
    @Volatile var kind = TakeKind.VIDEO
    /** The take in progress keeps the headset's logs, read when it stops (DeviceLogs). */
    @Volatile var logs = false
    /** A take has stopped and its logs are being read (Android's prompt may be up); its upload waits for them. */
    @Volatile var readingLogs = false
    /** Cancel was pressed: the recording in progress is deleted when it stops, and never uploaded (CAP-1 #24). */
    @Volatile var discard = false
    @Volatile var runDir: File? = null
    @Volatile var startedElapsed = 0L
    @Volatile var bytes = 0L
    @Volatile var bytesPerSecond = 0L
    @Volatile var heartbeats = 0
    @Volatile var maxIntervalMs = 0L
    @Volatile var micAmplitude: Int? = null
    /** The mic's peak over the last ~40 ms audio chunk, for the level meter; 0 when not recording. */
    @Volatile var liveMicLevel = 0
    @Volatile var liveMicAt = 0L
    /** The same for the in-app audio track, for the APP meter. */
    @Volatile var liveAppLevel = 0
    @Volatile var liveAppAt = 0L
    @Volatile var appAmplitude: Int? = null
    @Volatile var framesPerBeat: Int? = null
    @Volatile var endReason: String? = null
    /** The thread the current recording goes in, as JSON (a key, or a project for a new thread). */
    @Volatile var destination: String? = null
    @Volatile var activityState = "none"

    /** The take in progress, or the one whose logs are being read, is [dir]: nothing may upload, retry or delete it yet. */
    fun busy(dir: File): Boolean = (recording || readingLogs) && runDir == dir

    /** A take is recording or finishing its logs, so no other may start. */
    val occupied: Boolean get() = recording || readingLogs

    /** One away period: from the screen being hidden (onStop) to it showing again (onStart). */
    class Away(val startElapsed: Long, val startBytes: Long, val startBeats: Int) {
        @Volatile var maxIntervalMs = 0L
        @Volatile var micPeak = 0
        @Volatile var appPeak = 0
    }
    @Volatile var away: Away? = null
    @Volatile var lastAwaySummary: String? = null

    fun beginAway() {
        away = if (recording) Away(SystemClock.elapsedRealtime(), bytes, heartbeats) else null
    }

    /** Closes the away period, logs it, and returns a one-line verdict for the screen. */
    fun endAway(): String? {
        val a = away ?: return null
        away = null
        val ms = SystemClock.elapsedRealtime() - a.startElapsed
        val seconds = ms / 1000.0
        val grew = bytes - a.startBytes
        val beats = heartbeats - a.startBeats
        val rate = if (seconds > 0) grew / seconds / 1024 else 0.0
        Timeline.log(
            "probe", "away_summary",
            "ms" to ms, "recording" to recording, "bytesGrown" to grew,
            "kbPerSecond" to rate.toLong(), "heartbeats" to beats, "maxIntervalMs" to a.maxIntervalMs,
            "micPeak" to a.micPeak, "appPeak" to a.appPeak, "endReason" to endReason,
        )
        val state = if (recording) "recording ALIVE" else "recording ENDED (${endReason ?: "unknown"})"
        val summary = String.format(
            Locale.US, "Away %.1f s · %s · file +%.1f MB (%.0f KB/s) · %d heartbeats · longest gap %.2f s · mic peak %d · app audio peak %d",
            seconds, state, grew / 1_048_576.0, rate, beats, a.maxIntervalMs / 1000.0, a.micPeak, a.appPeak,
        )
        lastAwaySummary = summary
        return summary
    }
}
