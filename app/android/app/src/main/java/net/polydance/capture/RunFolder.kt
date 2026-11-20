package net.polydance.capture

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import net.polydance.capture.platform.headsetPlatform
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * A take's folder under runs/ (RecorderService.runsDir), and the two ends every take shares, whether the recorder
 * service makes it (a picture, or sound alone) or it is a take of logs alone, which has no service (LogsTake):
 *  - [open], when it begins: run.json (how it is recorded, the headset, the build, the notice accepted, the boot count),
 *    thread.json (where it goes, so the upload names its thread even after a restart) and the addresses to invite;
 *  - [handOff], once its summary.json is written: the headset's logs read when Logs was on (DeviceLogs, off the main
 *    thread: Android's prompt can keep it minutes), and only then the upload queued, held as Uploads.holdFor says.
 */
object RunFolder {
    private const val TAG = "PolydanceCapture"

    /** Makes the folder, named for now, and writes run.json and thread.json; null when it cannot be made. */
    fun open(context: Context, config: JSONObject, consent: JSONObject, thread: String?, invite: List<String>?): Pair<File, JSONObject>? {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val dir = File(RecorderService.runsDir(context), stamp).apply { mkdirs() }
        if (!dir.isDirectory) return null
        val run = JSONObject().put("run", stamp).put("startedAt", System.currentTimeMillis())
            .put("config", config).put("device", deviceInfo()).put("app", appInfo(context)).put("consent", consent)
            .put("boot", DeviceLogs.bootCount(context))
        write(dir, run)
        if (thread != null) File(dir, "thread.json").writeText(thread)
        invite?.let { Invites.write(dir, it) }
        return dir to run
    }

    fun write(dir: File, run: JSONObject) { File(dir, "run.json").writeText(run.toString(2)) }

    /** The take's 0:00 on the wall clock, when its recorder started (or a take of logs alone began): logcat reads from it. */
    fun markZero(dir: File, run: JSONObject, zeroAt: Long = System.currentTimeMillis()) { write(dir, run.put("zeroAt", zeroAt)) }

    fun deviceInfo(): JSONObject = JSONObject()
        .put("manufacturer", Build.MANUFACTURER).put("brand", Build.BRAND).put("model", Build.MODEL)
        .put("device", Build.DEVICE).put("product", Build.PRODUCT).put("sdk", Build.VERSION.SDK_INT)
        .put("release", Build.VERSION.RELEASE).put("display", Build.DISPLAY).put("incremental", Build.VERSION.INCREMENTAL)

    fun appInfo(context: Context): JSONObject {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return JSONObject().put("package", context.packageName).put("versionName", info.versionName)
            // The installed package and its resources, never compile-time constants: Kotlin copies those into each
            // class, and one not rebuilt kept an older build's (2026-10-05: 0.9.0 recordings said "(8) 0f2e3dd-dirty").
            .put("versionCode", info.longVersionCode).put("commit", context.getString(R.string.git_commit))
            .put("targetSdk", context.applicationInfo.targetSdkVersion).put("platform", headsetPlatform.id)
    }

    /**
     * After a take stops and its summary.json is written: reads its logs when [logs], then queues its upload when [send],
     * held a moment first (longer when short, [ranMs]) so a take made by mistake can be deleted before it goes; a report
     * goes at once, having no card to undo it from. While the logs are read CaptureState.readingLogs holds the deck and
     * keeps the card from offering Upload. [done] runs on the main thread at the end.
     */
    fun handOff(context: Context, dir: File, send: Boolean, logs: Boolean, ranMs: Long?, done: () -> Unit = {}) {
        val app = context.applicationContext
        val main = Handler(Looper.getMainLooper())
        val queue = {
            if (send && dir.isDirectory) Uploads.enqueue(app, dir.name, holdMs = if (Reports.isReport(dir)) 0 else Uploads.holdFor(ranMs))
            CaptureState.readingLogs = false
            done()
        }
        if (!logs) { queue(); return }
        CaptureState.readingLogs = true
        // Measured now, while the press that stopped the take still has Polydance in front, or not.
        val onTop = DeviceLogs.onTop()
        thread(name = "polydance-logs") {
            runCatching { DeviceLogs.collect(app, dir, onTop) }.onFailure { Log.w(TAG, "logs for ${dir.name} not read: $it") }
            main.post(queue)
        }
    }
}
