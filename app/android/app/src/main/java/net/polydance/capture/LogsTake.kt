package net.polydance.capture

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import net.polydance.capture.platform.headsetPlatform
import org.json.JSONObject
import java.io.File

/**
 * A take of logs alone (Screen and Mic off, Logs on; docs/LOGS.md, Robin 2026-11-16): nothing records while it runs,
 * and the headset's log is read once, at Stop, from the take's 0:00.
 *
 * It has no service on purpose. A foreground service needs a type that names what it does, and nothing is running
 * here; while the person is in the browser for many minutes Android may kill Polydance's process, and that must not
 * lose the take. So the take is its run folder: run.json, written when it begins, holds startedAt, zeroAt and the
 * destination (thread.json beside it), and there is no summary.json until it stops. That makes it durable for free:
 *  - [restore], from CaptureApplication at every process start, finds the newest run folder, and when it is a take of
 *    logs alone that has not stopped, puts CaptureState back as it was (recording, its folder, its destination, its
 *    clock, the timeline appended to), so the deck shows it recording and its key stops it;
 *  - [stop], from the deck, writes summary.json and hands off to RunFolder, which reads the log and queues the upload.
 *    Stopping from the deck is the design: that is when Polydance is on top, the only time Android asks to share
 *    other apps' logs.
 * Because Recording.interrupted is "no summary.json and not the take in progress", a take restored here is never shown
 * cut off, and one whose folder is not the newest (it cannot be: no take starts while one runs) would be.
 *
 * An ongoing notification says it is running and opens the deck; it has no Stop of its own, which would read the log
 * from the background. There is no time limit: nothing is running to enforce one, and the log is cut at 32 MiB.
 */
object LogsTake {
    private const val NOTIFICATION_ID = 2
    private const val CHANNEL = "recording"
    private const val TAG = "PolydanceCapture"

    /** Starts one; returns why not, or null once it is recording. Call from the activity, on the main thread. */
    fun begin(context: Context, maxMinutes: Int, destination: String?, invite: List<String>?): String? {
        if (CaptureState.occupied) return "Already recording."
        if (!signIn.mayRecord()) return signIn.refusedText()
        val consent = Consent.snapshot(context) ?: return "Accept the notice before recording."
        val config = JSONObject()
            .put("kind", TakeKind.LOGS.id).put("screen", false).put("mic", false).put("appAudio", false).put("logs", true)
            .put("maxMinutes", maxMinutes).put("platform", headsetPlatform.id).put("engine", "none")
            .put("audioTracks", org.json.JSONArray())
        val (dir, run) = RunFolder.open(context, config, consent, destination, invite) ?: return "Could not make a folder for the take."
        Timeline.open(File(dir, "timeline.jsonl"))
        Timeline.anchorElapsed = SystemClock.elapsedRealtime()
        RunFolder.markZero(dir, run, run.optLong("startedAt"))
        CaptureState.endReason = null
        CaptureState.bytes = 0; CaptureState.heartbeats = 0; CaptureState.maxIntervalMs = 0
        resume(dir, destination, Timeline.anchorElapsed)
        Timeline.log("logs_take", "begin", "dir" to dir.absolutePath, "thread" to destination, "device" to run.optJSONObject("device"))
        post(context)
        return null
    }

    /** At process start: the take of logs alone that was running when the last process ended, if there is one. */
    fun restore(context: Context) {
        if (CaptureState.occupied) return
        val newest = RecorderService.runsDir(context).listFiles { f -> f.isDirectory && File(f, "run.json").exists() }
            ?.maxByOrNull { it.name } ?: return
        if (File(newest, "summary.json").exists()) return
        val run = runCatching { JSONObject(File(newest, "run.json").readText()) }.getOrNull() ?: return
        if (TakeKind.of(run.optJSONObject("config")?.optString("kind")) != TakeKind.LOGS) return
        val zeroAt = run.optLong("zeroAt").takeIf { it > 0 } ?: return
        // elapsedRealtime survives a killed process but not a restart of the headset, so the clock comes from the wall.
        val since = (System.currentTimeMillis() - zeroAt).coerceAtLeast(0)
        Timeline.open(File(newest, "timeline.jsonl"), append = true)
        Timeline.anchorElapsed = SystemClock.elapsedRealtime() - since
        resume(newest, runCatching { File(newest, "thread.json").readText() }.getOrNull(), Timeline.anchorElapsed)
        Timeline.log("logs_take", "restored", "run" to newest.name, "runningMs" to since)
        Log.i(TAG, "take of logs alone ${newest.name} restored after ${since / 1000} s")
    }

    private fun resume(dir: File, destination: String?, anchor: Long) {
        CaptureState.kind = TakeKind.LOGS
        CaptureState.logs = true
        CaptureState.runDir = dir
        CaptureState.destination = destination
        CaptureState.startedElapsed = anchor
        CaptureState.recording = true
    }

    /** True while the take in progress is one of logs alone, which [stop] ends rather than the recorder service. */
    fun running(): Boolean = CaptureState.recording && CaptureState.kind == TakeKind.LOGS

    /** Ends it: a cancelled one is deleted; otherwise summary.json, which apps were in front, then the logs and the upload. */
    fun stop(context: Context, reason: String) {
        if (!running()) return
        val dir = CaptureState.runDir ?: return
        val app = context.applicationContext
        val endedAt = System.currentTimeMillis()
        val ranMs = if (Timeline.anchorElapsed >= 0) SystemClock.elapsedRealtime() - Timeline.anchorElapsed else null
        val discard = CaptureState.discard
        CaptureState.discard = false
        CaptureState.endReason = reason
        app.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
        if (discard) {
            Timeline.log("logs_take", "cancelled")
            Timeline.close()
            CaptureState.recording = false
            Log.i(TAG, "take of logs ${dir.name} cancelled: deleted ${runCatching { dir.deleteRecursively() }.getOrDefault(false)}")
            return
        }
        val config = runCatching { JSONObject(File(dir, "run.json").readText()).optJSONObject("config") }.getOrNull() ?: JSONObject()
        val summary = JSONObject().put("reason", reason).put("endedAt", endedAt).put("durationMs", ranMs ?: JSONObject.NULL)
            .put("bytes", 0).put("heartbeats", 0).put("maxHeartbeatIntervalMs", 0).put("config", config)
        Timeline.log("logs_take", "run_end", "summary" to summary)
        runCatching { File(dir, "summary.json").writeText(summary.toString(2)) }
        AppSwitches.record(app, dir, endedAt)
        Timeline.close()
        // readingLogs is set before recording clears, so the deck never shows ready in between.
        RunFolder.handOff(app, dir, send = true, logs = true, ranMs = ranMs)
        CaptureState.recording = false
    }

    /** "Keeping the headset's logs": a take with nothing on the microphone or the screen is otherwise invisible. */
    private fun post(context: Context) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle("Polydance")
            .setContentText("Keeping the headset's logs. Open Polydance and press Stop on the deck to send them.")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        runCatching { manager.notify(NOTIFICATION_ID, notification) }.onFailure { Log.w(TAG, "logs take notification not posted: $it") }
    }
}
