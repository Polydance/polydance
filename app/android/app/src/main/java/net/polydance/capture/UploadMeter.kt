package net.polydance.capture

import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor

/*
 * How a recording's upload is going, in the numbers and words the inbox shows (Robin, 2026-11-14: "no idea how
 * much is left or if it's stuck"): the share sent, megabytes sent of the whole, the rate over the last half
 * minute, the time left at that rate, and how long since a byte last moved. A port of the iPhone's UploadMeter
 * (ios/Core/Sources/PolydancePhoneCore/UploadMeter.swift), word for word, so the Quest, Android XR, the Vision Pro
 * and the iPhone say the same; its tests are the iPhone's, ported. The worker feeds it what the receiver has
 * confirmed plus what the running request has written (ReceiverClient's counting body), so it moves within each
 * 8 MB chunk. Pure: nothing here is stored, sent or logged, and no Android class is used, so the JVM tests it.
 */

/** One part of a recording's upload (its words, then its video) over time: enough for the rate and the stall. */
class UploadMeter {
    companion object {
        /** The rate is taken over this many seconds, so one slow chunk does not swing the time left. */
        const val WINDOW = 30.0
        /** The rate needs this much time behind it before it is shown. */
        const val SETTLE = 3.0
        /** No byte for this long, and the screen says so. */
        const val STALL_SECONDS = 20.0
        /** Samples are kept at least this far apart, so a half minute holds about 120 of them. */
        const val SPACING = 0.25
    }

    internal data class Sample(val at: Double, val sent: Long)

    internal val samples = ArrayList<Sample>()

    /** When the count last went up, or when the meter began. */
    var lastMoved: Double? = null
        private set

    /**
     * [sent]: bytes of this part the headset has sent, confirmed or in flight. A lower count than before (a range
     * sent again after a dropped connection) starts the rate over, but is not movement.
     */
    fun record(sent: Long, now: Double) {
        val last = samples.lastOrNull()
        if (last == null) {
            samples.add(Sample(now, sent))
            lastMoved = now
            return
        }
        if (sent < last.sent) {
            samples.clear()
            samples.add(Sample(now, sent))
            return
        }
        // Nothing moved: the older sample stays, so the rate spans the pause and falls.
        if (sent == last.sent) return
        lastMoved = now
        // A request's body is written in many small pieces a second: samples stay SPACING apart, the newest moving up.
        if (samples.size > 1 && now - samples[samples.size - 2].at < SPACING) samples[samples.size - 1] = Sample(now, sent)
        else samples.add(Sample(now, sent))
        // One sample at or before the window's start stays as the rate's anchor.
        while (samples.size > 2 && samples[1].at <= now - WINDOW) samples.removeAt(0)
    }

    /** Bytes a second over the last WINDOW seconds up to [now], or null until it spans SETTLE seconds. */
    fun rate(now: Double): Double? {
        val newest = samples.lastOrNull() ?: return null
        val anchor = samples.lastOrNull { it.at <= now - WINDOW } ?: samples[0]
        val span = now - anchor.at
        if (span < SETTLE) return null
        return (newest.sent - anchor.sent) / span
    }

    /** Whole seconds since a byte moved, once that is STALL_SECONDS or more; else null. */
    fun stalled(now: Double): Int? {
        val moved = lastMoved ?: return null
        if (now - moved < STALL_SECONDS) return null
        return (now - moved).toInt()
    }
}

/** A recording's upload as the inbox shows it at one moment. */
data class UploadProgress(
    val stage: Stage,
    /** Of this stage's part: the narration's bytes while WORDS, the video's while VIDEO. */
    val sent: Long = 0,
    val total: Long = 0,
    /** Bytes a second; null until it is known. */
    val rate: Double? = null,
    /** Whole seconds since a byte moved, once that is long enough to say. */
    val stalledSeconds: Int? = null,
    /** Why it is not moving, when the headset knows: "waiting for Wi-Fi", "sending again in 25 s". */
    val waiting: String? = null,
) {
    enum class Stage {
        /** Hashing the video and asking the receiver for an upload. */
        PREPARING,
        /**
         * The take's logcat.txt, sent before anything else (docs/LOGS.md, 2026-11-16): the whole of a take of logs alone.
         * The headsets' own: the Vision Pro and the iPhone keep no logs, so their meters have no such stage.
         */
        LOGS,
        /** The narration, sent first so the title and transcript arrive early. */
        WORDS,
        /** The media file: the video, or the sound of a take without the picture. */
        VIDEO,
    }

    val fraction: Double get() = if (total > 0) (sent.toDouble() / total).coerceIn(0.0, 1.0) else 0.0

    /** "42%", rounded down so it never says 100% before the receiver has it all. */
    val percent: String get() = "${floor(fraction * 100).toInt()}%"

    /** Seconds left at the current rate; null while the rate is unknown, nothing is moving, or it has stalled. */
    val secondsLeft: Int? get() {
        val r = rate
        if (stalledSeconds != null || r == null || r <= 0) return null
        return ceil(maxOf(0L, total - sent) / r).toInt()
    }

    /** Whether the screen should say it is not moving. */
    val isStuck: Boolean get() = stalledSeconds != null || waiting != null

    /** "460 of 1,087 MB". */
    val amount: String get() = "${megabytes(sent)} of ${megabytes(total)} MB"

    /**
     * "2.1 MB/s · about 5 min left"; when stuck, "nothing sent for 40 s · waiting for Wi-Fi"; null when there is
     * nothing to say yet.
     */
    val pace: String? get() {
        if (isStuck) return listOfNotNull(stalledSeconds?.let { "nothing sent for ${duration(it)}" }, waiting).joinToString(" · ")
        val r = rate ?: return null
        val speed = "${oneDecimal(r / 1_000_000)} MB/s"
        val left = secondsLeft ?: return speed
        return "$speed · about ${duration(left)} left"
    }

    /** The whole of it in one line: "42% · 460 of 1,087 MB · 2.1 MB/s · about 5 min left". */
    val line: String get() = when (stage) {
        Stage.PREPARING -> "getting the take ready to send"
        Stage.LOGS -> (listOf("sending the logs", amount) + listOfNotNull(pace)).joinToString(" · ")
        Stage.WORDS -> (listOf("sending the words first", amount) + listOfNotNull(pace)).joinToString(" · ")
        Stage.VIDEO -> (listOf(percent, amount) + listOfNotNull(pace)).joinToString(" · ")
    }

    /** What goes under the strip: the amount and the pace for the video, the whole line before it. */
    val detail: String get() = if (stage == Stage.VIDEO) listOfNotNull(amount, pace).joinToString(" · ") else line

    companion object {
        /** From a meter and the part's size at [now]. */
        fun of(stage: Stage, meter: UploadMeter, sent: Long, total: Long, now: Double, waiting: String? = null) =
            UploadProgress(stage, sent, total, meter.rate(now), meter.stalled(now), waiting)

        /** "460" and "1,087" for whole megabytes, "9.8" below ten, as the iPhone writes them. */
        fun megabytes(bytes: Long): String {
            val mb = bytes / 1_000_000.0
            if (mb < 10) return oneDecimal(mb)
            return String.format(Locale.UK, "%,d", floor(mb).toLong())
        }

        /** "40 s", "5 min", "1 h 12 min": seconds under a minute, else rounded up to the minute. */
        fun duration(seconds: Int): String {
            if (seconds < 60) return "${maxOf(0, seconds)} s"
            val minutes = (seconds + 59) / 60
            if (minutes < 60) return "$minutes min"
            return if (minutes % 60 == 0) "${minutes / 60} h" else "${minutes / 60} h ${minutes % 60} min"
        }

        /**
         * One decimal place as Swift's String(format: "%.1f") writes it: the double's exact value, a tie to even
         * (2.25 is "2.2", 9.95 is "9.9"). Java's own %.1f rounds the shortest decimal half up, and would say 10.0.
         */
        internal fun oneDecimal(value: Double): String = BigDecimal(value).setScale(1, RoundingMode.HALF_EVEN).toPlainString()
    }
}

/**
 * Each recording's upload as it happens, in memory only, between UploadWorker and the inbox (they share the
 * app's one process): the worker says what it is doing and how many bytes have gone, and InboxPane asks each
 * second how it is going. upload.json still says what is confirmed; this adds the bytes in flight, the rate,
 * the stall and the wait before WorkManager tries again. A process that starts again starts the stall clock
 * again: what happened while the app was not running is unknown. Times are seconds on one clock the callers
 * choose (UploadWorker.clock, SystemClock's elapsed time).
 */
object UploadLive {
    /** WorkManager's backoff for an upload, as Uploads.enqueue sets it: 30 s, doubling each attempt. */
    const val BACKOFF_SECONDS = 30L
    /** WorkManager's longest backoff, five hours (WorkRequest.MAX_BACKOFF_MILLIS). */
    private const val MAX_BACKOFF_SECONDS = 5 * 3600.0

    private class Entry(val stage: UploadProgress.Stage, var sent: Long, var total: Long) {
        val meter = UploadMeter()
        /** When WorkManager sends it again, after a retry. */
        var retryAt: Double? = null
    }

    private val entries = HashMap<String, Entry>()

    /** How long WorkManager waits before the next attempt, when the worker in its [attempt]th run (from 0) asks to retry. */
    fun retryDelay(attempt: Int): Double = minOf(BACKOFF_SECONDS * Math.scalb(1.0, attempt.coerceIn(0, 30)), MAX_BACKOFF_SECONDS)

    /** The worker has begun: hashing, the narration, asking the receiver for the upload. */
    @Synchronized fun preparing(run: String) {
        entries[run] = Entry(UploadProgress.Stage.PREPARING, 0, 0)
    }

    /** [sent] of [total] bytes of this part have gone, confirmed or in flight (a new part starts a new meter). */
    @Synchronized fun sending(run: String, stage: UploadProgress.Stage, sent: Long, total: Long, now: Double) {
        val entry = entries[run]?.takeIf { it.stage == stage } ?: Entry(stage, sent, total).also { entries[run] = it }
        entry.sent = sent
        entry.total = total
        entry.retryAt = null
        entry.meter.record(sent, now)
    }

    /**
     * The worker has ended with the upload not finished: [state] is what upload.json says now, and [retryAt]
     * when WorkManager tries again, if it said retry. Finished, failed or deleted, the run is forgotten.
     */
    @Synchronized fun settled(run: String, state: UploadState, retryAt: Double?, now: Double) {
        if (state.state != "uploading" && state.state != "waiting") {
            entries.remove(run)
            return
        }
        // Back to what the receiver has confirmed: bytes in flight when it stopped are sent again.
        sending(run, UploadProgress.Stage.VIDEO, state.sent, state.bytes, now)
        entries[run]?.retryAt = retryAt
    }

    @Synchronized fun forget(run: String) {
        entries.remove(run)
    }

    /**
     * How [run]'s upload is going at [now], from upload.json's [state] and what the worker said; null when it is
     * not under way (not started, held after Stop, sent, failed). Under way is being prepared, being sent, or
     * stopped part way and going again by itself: a retry's wait, or no network ([online] false, and a headset's
     * network is its Wi-Fi). [nowMillis] is the wall clock, for the hold after Stop.
     */
    @Synchronized fun progress(run: String, state: UploadState, online: Boolean, now: Double, nowMillis: Long): UploadProgress? {
        var entry = entries[run]
        if (entry?.stage == UploadProgress.Stage.PREPARING) return UploadProgress(UploadProgress.Stage.PREPARING)
        val held = (state.holdUntil ?: 0) > nowMillis
        // Waiting after the worker hashed it is a retry's wait or a queue behind the network, not a fresh take.
        val underWay = state.state == "uploading" || (state.state == "waiting" && !held && state.bytes > 0 && state.sha256 != null)
        if (!underWay) return null
        if (entry == null) {
            // First sight since the app started: the stall clock starts now.
            entry = Entry(UploadProgress.Stage.VIDEO, state.sent, state.bytes).also { entries[run] = it }
            entry.meter.record(state.sent, now)
        }
        // The words and the logs are sized apart from the media file that upload.json counts.
        val words = entry.stage == UploadProgress.Stage.WORDS || entry.stage == UploadProgress.Stage.LOGS
        val sent = if (words) entry.sent else maxOf(entry.sent, state.sent)
        val total = if (words) entry.total else state.bytes
        var waiting: String? = null
        val retryAt = entry.retryAt
        if (state.state == "waiting" && retryAt != null) {
            val left = ceil(retryAt - now).toInt()
            if (left > 0) waiting = "sending again in ${UploadProgress.duration(left)}"
        }
        if (waiting == null && !online) waiting = "waiting for Wi-Fi"
        return UploadProgress.of(entry.stage, entry.meter, sent, total, now, waiting)
    }
}
