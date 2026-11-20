package net.polydance.capture

import android.Manifest
import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Which app was in front during a recording, and its version, from the system's own usage log, so a
 * bundle can say "00:12 Marimba Studio 2.3" and an agent need not guess whether the native app or the
 * browser was on screen (Robin, 2026-10-02). It needs Usage access, which the user turns on in Settings
 * from the button behind the gear: no adb, no developer mode. The log is read once when a recording
 * stops, for that window, so nothing polls while recording. Only apps with a launcher entry count, which
 * leaves out the system shell's own activities; a page's address in the browser is not available to us.
 */
object AppSwitches {
    private const val MAX = 200

    fun allowed(context: Context): Boolean {
        val ops = context.getSystemService(AppOpsManager::class.java)
        val mode = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        return if (mode == AppOpsManager.MODE_DEFAULT) {
            context.checkCallingOrSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED
        } else mode == AppOpsManager.MODE_ALLOWED
    }

    /** Android's own Usage access page for this app; Horizon OS resolves it to the stock settings screen. */
    fun settingsIntent(context: Context): Intent =
        Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:${context.packageName}"))

    /**
     * Writes apps.json in the run folder: the app in front when recording started, then each app that came
     * to the front, with clocks relative to the start (run.json's startedAt). Without Usage access it
     * writes `{"allowed": false}`, so the bundle can say why there is no list.
     */
    fun record(context: Context, dir: File, endedAt: Long) {
        val out = JSONObject().put("version", 1)
        runCatching {
            val startedAt = JSONObject(File(dir, "run.json").readText()).getLong("startedAt")
            if (!allowed(context)) { out.put("allowed", false); return@runCatching }
            val pm = context.packageManager
            val launchable = HashMap<String, Boolean>()
            fun counts(pkg: String) = launchable.getOrPut(pkg) { pm.getLaunchIntentForPackage(pkg) != null }
            val events = context.getSystemService(UsageStatsManager::class.java).queryEvents(startedAt - 10 * 60_000, endedAt)
            val event = UsageEvents.Event()
            var before: String? = null
            val switches = ArrayList<Pair<Long, String>>()
            while (events.hasNextEvent()) {
                events.getNextEvent(event)
                if (event.eventType != UsageEvents.Event.ACTIVITY_RESUMED) continue
                val pkg = event.packageName ?: continue
                if (!counts(pkg)) continue
                if (event.timeStamp < startedAt) { before = pkg; continue }
                if ((switches.lastOrNull()?.second ?: before) == pkg) continue
                switches += event.timeStamp - startedAt to pkg
            }
            val entries = (listOfNotNull(before?.let { 0L to it }) + switches).take(MAX)
            val apps = JSONArray()
            for ((atMs, pkg) in entries) {
                val entry = JSONObject().put("atMs", atMs).put("package", pkg)
                runCatching {
                    val info = pm.getPackageInfo(pkg, 0)
                    entry.put("label", pm.getApplicationLabel(info.applicationInfo!!).toString().take(120))
                    info.versionName?.let { entry.put("versionName", it.take(80)) }
                    entry.put("versionCode", info.longVersionCode)
                }
                apps.put(entry)
            }
            out.put("allowed", true).put("apps", apps)
        }.onFailure { Log.w("PolydanceCapture", "app switches not recorded: $it"); out.put("error", it.toString().take(200)) }
        runCatching { File(dir, "apps.json").writeText(out.toString(2)) }
    }

    /** The list as the upload sends it, or null when there is none. */
    fun forUpload(dir: File): JSONArray? = runCatching {
        JSONObject(File(dir, "apps.json").readText()).optJSONArray("apps")?.takeIf { it.length() > 0 }
    }.getOrNull()
}
