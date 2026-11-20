package net.polydance.capture

import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The evidence: an append-only JSON-lines file per run, one object per event, flushed line by line
 * so a killed process still leaves everything up to the kill. Each line carries wall time `t`,
 * `up` (elapsedRealtime, which keeps counting through sleep) and `rel`, milliseconds since the
 * recorder started, which lines up with the video's own clock. Events logged before a run opens
 * (permissions, consent) are held and written first when it does.
 */
object Timeline {
    private const val TAG = "PolydanceCapture"
    private var writer: BufferedWriter? = null
    private val pending = ArrayDeque<String>()
    private val recent = ArrayDeque<String>()
    private val clock = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    /** elapsedRealtime when MediaRecorder.start() returned; -1 when no recording is running. */
    @Volatile var anchorElapsed: Long = -1L

    @Synchronized
    fun log(src: String, ev: String, vararg fields: Pair<String, Any?>) {
        val now = System.currentTimeMillis()
        val up = SystemClock.elapsedRealtime()
        val json = JSONObject()
            .put("t", now)
            .put("up", up)
            .put("rel", if (anchorElapsed >= 0) up - anchorElapsed else JSONObject.NULL)
            .put("src", src)
            .put("ev", ev)
        for ((key, value) in fields) json.put(key, value ?: JSONObject.NULL)
        val line = json.toString()
        val out = writer
        if (out != null) {
            out.write(line); out.newLine(); out.flush()
        } else {
            pending.addLast(line)
            while (pending.size > 200) pending.removeFirst()
        }
        Log.i(TAG, line)
        if (ev != "heartbeat") {
            val detail = fields.joinToString(" ") { (k, v) -> "$k=$v" }
            recent.addLast("${clock.format(Date(now))}  $src $ev $detail".trimEnd())
            while (recent.size > 60) recent.removeFirst()
        }
    }

    /** The user pressed Start: what is still held (the last run's teardown, idle screen events) is not this run's. */
    @Synchronized
    fun beginRequest() { if (writer == null) pending.clear() }

    /** [append] carries on a file already begun: a take of logs alone, restored after its process was killed (LogsTake). */
    @Synchronized
    fun open(file: File, append: Boolean = false) {
        close()
        writer = (if (append) java.io.FileOutputStream(file, true).bufferedWriter() else file.bufferedWriter()).also { out ->
            for (line in pending) { out.write(line); out.newLine() }
            out.flush()
        }
        pending.clear()
    }

    @Synchronized
    fun close() {
        runCatching { writer?.close() }
        writer = null
        anchorElapsed = -1L
    }

    /** Newest last; heartbeats are left out so the screen shows what changed. */
    @Synchronized
    fun recentLines(max: Int): List<String> = recent.toList().takeLast(max)
}
