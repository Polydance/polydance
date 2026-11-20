package net.polydance.capture

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Process
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The headset's log for a take (docs/LOGS.md, Robin 2026-11-16): when a take with Logs on stops, logcat runs once,
 * from the take's 0:00, and what it prints is kept as logcat.txt beside logs.json, which says what the file holds and
 * why. Nothing polls while recording, and the headset does no other processing: the receiver's pipeline reads the lines.
 *
 * Whose lines arrive is Android's decision. READ_LOGS is a development permission only adb can grant, and Meta's store
 * prohibits it, so only debug builds declare it (src/debug). From Android 13 an app holding it that reads the log makes
 * the system ask "Allow … to access all device logs?", but only while the app is on top (LogcatManagerService,
 * PROCESS_STATE_TOP); in the background it is declined at once, and an answer holds 60 s. Declined, or without the
 * grant, an app still reads its own lines. So the read runs at Stop, from the deck, where Polydance is on top; a take
 * stopped elsewhere keeps Polydance's own lines and logs.json's note says why. Android's prompt gives up after 400 s on
 * user builds and logcat waits on it, so the read is given seven minutes before it is stopped.
 *
 * The command runs through ProcessBuilder with an argument list (no shell), off the main thread, reading at most
 * 32 MiB, cut at the last whole line. The pure parts (the command, a line's uid, the copy, the note, logs.json's
 * shape) are tested on the JVM.
 */
object DeviceLogs {
    const val FILE = "logcat.txt"
    const val SUMMARY = "logs.json"
    /** The receiver's limit (MAX_LOGS in src/session.ts). */
    const val MAX_BYTES = 32L * 1024 * 1024
    /** Longer than Android's own 400 s for its prompt, which logcat waits on. */
    const val TIMEOUT_MS = 7 * 60_000L
    const val MAX_PACKAGES = 300
    /** What a person runs from a computer to let Polydance read every app's log; `npm run app -- logs` runs it. */
    const val GRANT = "adb shell pm grant net.polydance.capture android.permission.READ_LOGS"
    private const val LOGCAT = "/system/bin/logcat"
    private const val TAG = "PolydanceCapture"

    /** What Polydance may read: the permission is in this build, and the headset has granted it. */
    enum class Access { NOT_DECLARED, NOT_GRANTED, GRANTED }

    /** The take's 0:00 as logcat's -T reads an epoch time: seconds, a point, milliseconds. */
    fun since(zeroAt: Long): String = String.format(Locale.US, "%d.%03d", zeroAt / 1000, zeroAt % 1000)

    /** docs/LOGS.md's command, as an argument list: every line since 0:00 in the main, system and crash buffers, once. */
    fun command(zeroAt: Long): List<String> = listOf(
        LOGCAT, "-d", "-b", "main,system,crash", "-v", "threadtime", "-v", "epoch", "-v", "uid", "-v", "printable", "-T", since(zeroAt),
    )

    /**
     * `         1763290000.123 10123: 4567  4589 E chromium: …`, as AOSP's logprint.cpp prints it (android14-release): the
     * epoch seconds right-aligned in 19, the milliseconds, then the uid as "%5d:" (or a name of five letters or fewer,
     * "%5s:"), straight against the pid's "%5d", so a five-digit pid follows the colon with no space; then tid and level.
     * Without the uid ("-v uid" not honoured) the colon field is absent.
     */
    private val HEADER = Regex("^\\s*\\d+\\.\\d+\\s+(?:([A-Za-z0-9_.]+):\\s*)?\\d+\\s+\\d+\\s+[VDIWEFSA]\\s")

    /** The uid field of one log line, without its colon, or null for a line without one or anything else ("--------- beginning of main"). */
    fun uidOf(line: String): String? = HEADER.find(line)?.groups?.get(1)?.value

    /** `device` when a line came from another uid than [mine] (a number, or a name such as root), else `app`. */
    fun scope(uids: Set<String>, mine: Int): String = if (uids.any { it != mine.toString() }) "device" else "app"

    /**
     * The uids that are apps', whose packages logs.json names: Process.FIRST_APPLICATION_UID to LAST_APPLICATION_UID in
     * any user (100 000 uids each). System and isolated uids have no package of their own.
     */
    fun appUids(uids: Set<String>): List<Int> =
        uids.mapNotNull { it.toIntOrNull() }.filter { (it % 100_000) in 10_000..19_999 }.sorted().take(MAX_PACKAGES)

    /** Why the file holds Polydance's own lines only, in words a person reads; null when it holds the headset's. */
    fun note(scope: String, access: Access, onTop: Boolean, restarted: Boolean = false): String? {
        val why = if (scope == "device") null else when (access) {
            Access.NOT_DECLARED -> "Only Polydance's own lines: this build of Polydance cannot read other apps' logs (store builds leave the permission out). A development build can, once the headset grants it over adb."
            Access.NOT_GRANTED -> "Only Polydance's own lines: the headset has not given Polydance access to its logs. Grant it once over adb: $GRANT"
            Access.GRANTED -> if (!onTop) "Only Polydance's own lines: the take stopped while Polydance was not in front, so Android could not ask to share the headset's logs. Stop on the deck to include other apps'."
                else "Only Polydance's own lines: Android's prompt to share the headset's logs was declined or not answered."
        }
        val restart = "The headset restarted during the take, so its lines from before the restart are gone.".takeIf { restarted }
        return listOfNotNull(why, restart).joinToString(" ").ifEmpty { null }?.take(300)
    }

    /** What a copy of logcat's output kept: its size and hash, whether the limit cut it, and the uids in its lines. */
    class Copy(val bytes: Long, val sha256: String, val truncated: Boolean, val uids: Set<String>)

    /**
     * Copies whole lines from [input] to [output] until the input ends or the next line would pass [max] bytes, hashing
     * what is kept and noting each line's uid. A line is written only once it is whole, so a cut never splits one.
     */
    fun copy(input: InputStream, output: OutputStream, max: Long = MAX_BYTES): Copy {
        val digest = MessageDigest.getInstance("SHA-256")
        val uids = HashSet<String>()
        val chunk = ByteArray(64 * 1024)
        var line = ByteArray(8 * 1024)
        var length = 0
        var written = 0L
        var truncated = false
        fun emit(): Boolean {
            if (written + length > max) return false
            output.write(line, 0, length)
            digest.update(line, 0, length)
            written += length
            uidOf(String(line, 0, minOf(length, 120), Charsets.ISO_8859_1))?.let { uids += it }
            length = 0
            return true
        }
        fun append(from: Int, count: Int) {
            if (length + count > line.size) line = line.copyOf(maxOf(line.size * 2, length + count))
            System.arraycopy(chunk, from, line, length, count)
            length += count
        }
        reading@ while (true) {
            val n = input.read(chunk)
            if (n < 0) break
            var start = 0
            while (start < n) {
                var end = start
                while (end < n && chunk[end] != '\n'.code.toByte()) end++
                if (end == n) { append(start, n - start); break }
                append(start, end - start + 1)
                if (!emit()) { truncated = true; break@reading }
                start = end + 1
            }
        }
        if (!truncated && length > 0 && !emit()) truncated = true
        return Copy(written, digest.digest().joinToString("") { "%02x".format(it) }, truncated, uids)
    }

    /** logs.json, as docs/LOGS.md gives it; [error] is the headset's own note when logcat could not be read, never sent. */
    fun summary(
        copy: Copy, zeroAt: Long, readAt: Long, scope: String, note: String?, packages: Map<String, String>, error: String? = null,
    ): Map<String, Any> = linkedMapOf<String, Any>(
        "version" to 1, "bytes" to copy.bytes, "sha256" to copy.sha256, "zeroAt" to zeroAt, "readAt" to readAt,
        "scope" to scope, "truncated" to copy.truncated,
    ).apply {
        note?.let { put("note", it) }
        if (packages.isNotEmpty()) put("packages", packages)
        error?.let { put("error", it.take(300)) }
    }

    // ---- On the headset.

    fun access(context: Context): Access {
        val declared = runCatching {
            context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty()
                .contains(Manifest.permission.READ_LOGS)
        }.getOrDefault(false)
        return when {
            !declared -> Access.NOT_DECLARED
            context.checkSelfPermission(Manifest.permission.READ_LOGS) != PackageManager.PERMISSION_GRANTED -> Access.NOT_GRANTED
            else -> Access.GRANTED
        }
    }

    /** Whether Polydance has an activity on top now: the only time Android asks to share the headset's logs. */
    fun onTop(): Boolean = ActivityManager.RunningAppProcessInfo().also { ActivityManager.getMyMemoryState(it) }.importance ==
        ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND

    /** Settings.Global.BOOT_COUNT, noted when a take starts: a different one at Stop means the log before it is gone. */
    fun bootCount(context: Context): Int = runCatching { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1) }.getOrDefault(-1)

    /**
     * Reads the take's log into [dir] and writes logs.json; returns it. Blocks for as long as Android's prompt is up,
     * so never on the main thread. [onTop] is whether Polydance was in front when the take stopped.
     */
    fun collect(context: Context, dir: File, onTop: Boolean): JSONObject {
        val run = runCatching { JSONObject(File(dir, "run.json").readText()) }.getOrNull()
        val zeroAt = run?.optLong("zeroAt")?.takeIf { it > 0 } ?: run?.optLong("startedAt")?.takeIf { it > 0 } ?: dir.lastModified()
        val boot = run?.optInt("boot", -1) ?: -1
        val restarted = boot >= 0 && bootCount(context).let { it >= 0 && it != boot }
        val access = access(context)
        val readAt = System.currentTimeMillis()
        // Polydance's own line, so a file is never empty while logcat works.
        Log.i(TAG, "reading the headset's logs for ${dir.name} since ${since(zeroAt)} (access ${access.name.lowercase(Locale.US)}, in front $onTop)")
        val part = File(dir, "$FILE.part")
        var got = Copy(0, "", false, emptySet())
        var error: String? = null
        val process = try { ProcessBuilder(command(zeroAt)).start() } catch (e: IOException) { error = "logcat did not start: ${e.message}"; null }
        if (process != null) {
            val stderr = StringBuilder()
            // Drained apart, so a full error pipe never stalls logcat.
            val drain = thread(name = "polydance-logcat-err", isDaemon = true) {
                runCatching { process.errorStream.bufferedReader().useLines { lines -> for (l in lines) if (stderr.length < 2000) stderr.appendLine(l) } }
            }
            val timedOut = AtomicBoolean(false)
            val watchdog = thread(name = "polydance-logcat-watchdog", isDaemon = true) {
                try { if (!process.waitFor(TIMEOUT_MS, TimeUnit.MILLISECONDS)) { timedOut.set(true); process.destroy() } } catch (_: InterruptedException) {}
            }
            try {
                part.outputStream().use { out -> process.inputStream.use { got = copy(it, out) } }
            } catch (e: IOException) {
                error = "logcat could not be read: ${e.message}"
            } finally {
                if (process.isAlive) process.destroy()
                runCatching { process.waitFor(5, TimeUnit.SECONDS) }
                watchdog.interrupt()
                runCatching { drain.join(1000) }
            }
            if (timedOut.get()) error = "logcat had not finished after ${TIMEOUT_MS / 60_000} minutes and was stopped"
            if (got.bytes == 0L && error == null) error = stderr.toString().trim().ifEmpty { "logcat exited with ${runCatching { process.exitValue() }.getOrNull()} and printed nothing" }
        }
        val kept = got.bytes > 0 && part.renameTo(File(dir, FILE))
        if (!kept) part.delete()
        val scope = scope(got.uids, Process.myUid())
        val pm = context.packageManager
        val packages = appUids(got.uids).mapNotNull { uid ->
            pm.getPackagesForUid(uid)?.sorted()?.joinToString(",")?.take(300)?.ifEmpty { null }?.let { uid.toString() to it }
        }.toMap()
        val summary = JSONObject(summary(if (kept) got else Copy(0, "", false, emptySet()), zeroAt, readAt, scope, note(scope, access, onTop, restarted), packages, error))
        val temp = File(dir, "$SUMMARY.tmp")
        temp.writeText(summary.toString(2))
        if (!temp.renameTo(File(dir, SUMMARY))) throw IOException("could not save $SUMMARY")
        Timeline.log("logs", "read", "run" to dir.name, "bytes" to got.bytes, "scope" to scope, "truncated" to got.truncated, "error" to error)
        return summary
    }

    /** logs.json as the upload declares it, or null when there is no file to send (logs off, or logcat gave nothing). */
    fun forUpload(dir: File): JSONObject? = runCatching {
        val j = JSONObject(File(dir, SUMMARY).readText())
        val bytes = j.getLong("bytes")
        val sha = j.getString("sha256")
        if (bytes !in 1..MAX_BYTES || !Regex("[0-9a-f]{64}").matches(sha) || File(dir, FILE).length() != bytes) return@runCatching null
        val scope = j.getString("scope").takeIf { it == "device" || it == "app" } ?: return@runCatching null
        JSONObject().put("bytes", bytes).put("sha256", sha).put("zeroAt", j.getLong("zeroAt")).put("scope", scope).apply {
            if (j.optBoolean("truncated")) put("truncated", true)
            j.optString("note").takeIf { it.isNotBlank() }?.let { put("note", it.take(300)) }
            j.optJSONObject("packages")?.takeIf { it.length() > 0 }?.let { put("packages", it) }
        }
    }.getOrNull()

    /** Why logs.json has no file, for a take of logs alone that cannot upload without one. */
    fun problem(dir: File): String = runCatching { JSONObject(File(dir, SUMMARY).readText()).optString("error") }.getOrNull()
        ?.takeIf { it.isNotBlank() } ?: "the headset's logs could not be read"
}
