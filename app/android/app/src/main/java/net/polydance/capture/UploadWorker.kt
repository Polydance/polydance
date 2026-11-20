package net.polydance.capture

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Moves one recording to the receiver: hash it, create (or find) its upload, send its logs when it kept them
 * (docs/LOGS.md: logcat.txt, whole, before anything else), its narration (the mic track alone, a few MB) so the
 * words are ready first, then 8 MB chunks of its media from wherever the server says it got to. The media is the
 * video, or audio.m4a for a take without the picture; a take of logs alone has none, and its logs complete it. Network trouble returns retry, so WorkManager tries again with
 * backoff once there is a network; expired credentials renew with durable retries. The local recording
 * is never touched, except a report's, which is deleted once the receiver has verified it (Reports).
 * What it is doing and how many bytes have gone, within each chunk too, it tells UploadLive for the inbox.
 */
class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    companion object {
        const val RUN = "run"
        private const val CHUNK = 8L * 1024 * 1024
        private const val TAG = "PolydanceCapture"

        /** UploadLive's clock: seconds since boot, which a change to the headset's time cannot move. */
        fun clock() = SystemClock.elapsedRealtime() / 1000.0
    }

    override fun doWork(): Result {
        val run = inputData.getString(RUN) ?: return Result.failure()
        val dir = File(RecorderService.runsDir(applicationContext), run)
        val take = runCatching { JSONObject(File(dir, "run.json").readText()).optJSONObject("config") }.getOrNull()
        val kind = TakeKind.of(take?.optString("kind"))
        val media = Recording.mediaOf(dir, kind)
        if (DeleteJournal.deleted(applicationContext, run) || !dir.isDirectory || (media != null && !media.exists())) return Result.success()
        fun stopped() = isStopped || DeleteJournal.deleted(applicationContext, run) || !dir.isDirectory
        fun save(next: UploadState) = DeleteJournal.access {
            if (!stopped()) UploadState.write(dir, next)
        }
        // Still recording, or its logs still being read at Stop: it goes once they are written.
        if (CaptureState.busy(dir)) return Result.retry()
        var state = UploadState.read(dir)
        if (state.state == "uploaded") return Result.success()
        val config = UploadSettings.load(applicationContext)
        if (config == null) {
            // Keep this work alive across process death, including while Meta/receiver sign-in is unavailable.
            save(state.copy(state = "not_configured", error = "waiting to sign in"))
            signIn.retryLater(applicationContext)
            return Result.retry()
        }
        UploadLive.preparing(run)
        // When WorkManager tries again, if this run ends asking it to.
        var retryAt: Double? = null
        try {
            // A take whose Stop never got to its logs (the process ended first) reads them now: Polydance's own lines
            // when it is not in front, and Android asks for the rest when it is, as it is when Upload is pressed.
            if (take?.optBoolean("logs") == true && !File(dir, DeviceLogs.SUMMARY).exists()) DeviceLogs.collect(applicationContext, dir, DeviceLogs.onTop())
            val logs = if (take?.optBoolean("logs") == true) DeviceLogs.forUpload(dir) else null
            if (media == null && logs == null) throw ReceiverClient.Refused("this take of logs alone has nothing to send: ${DeviceLogs.problem(dir)}")
            // upload.json counts the media file, or the logs when they are all there is.
            val bytes = media?.length() ?: logs!!.getLong("bytes")
            val sha = state.sha256?.takeIf { state.bytes == bytes } ?: media?.let { sha256(it) } ?: logs!!.getString("sha256")
            state = state.copy(state = "uploading", sha256 = sha, bytes = bytes, error = null, holdUntil = null)
            save(state)
            val client = ReceiverClient(config)
            val body = createBody(run, dir, kind, media?.let { bytes }, media?.let { sha }, config)
            logs?.let { body.put("logs", it) }
            // Narration.prepare never creates the parent directory, so deletion cannot resurrect it. Sound alone is
            // already only the mic, so it has none.
            if (stopped()) return Result.success()
            val narration = if (kind == TakeKind.VIDEO && media != null) Narration.prepare(dir, media, roles(dir)) else null
            narration?.let { body.put("narration", JSONObject().put("bytes", it.length()).put("sha256", sha256(it))) }
            if (stopped()) return Result.success()
            val created = create(client, body, run, config) ?: return Result.success()
            // Persist the server identity before any subsequent request can reject our token. A
            // deletion during renewal must still know which remote copy needs removing.
            state = state.copy(uploadId = created.id, sent = created.received, thread = created.thread ?: state.thread)
            save(state)
            if (stopped()) return Result.success()
            // People copied in when this thread was started (New thread): the receiver has just made it.
            Invites.send(dir, client, state.thread)
            var status = created.status
            // The logs before anything else. They are not in the media, so once declared a refusal fails the upload.
            if (logs != null && created.logs == "expected" && status == "uploading") {
                val file = File(dir, DeviceLogs.FILE)
                val total = file.length()
                UploadLive.sending(run, UploadProgress.Stage.LOGS, 0, total, clock())
                status = client.putLogs(created.id, file) { n -> UploadLive.sending(run, UploadProgress.Stage.LOGS, n, total, clock()) }.status
                Log.i(TAG, "upload $run: logs sent ahead of ${if (media == null) "nothing: it is logs alone" else "the media"}")
            }
            if (media == null) {
                // Logs alone: their arrival completes the upload, which the receiver says by no longer waiting.
                if (stopped()) return Result.success()
                if (status == "uploading") throw ReceiverClient.Refused("the server did not take this take's logs (it still says uploading)")
                save(state.copy(state = "uploaded", sent = bytes, server = status, sessionId = null, error = null))
                Invites.send(dir, client, state.thread)
                Log.i(TAG, "upload $run complete (logs alone): ${created.id} $status")
                return Result.success()
            }
            if (narration != null && created.narration == "expected" && status == "uploading") {
                val words = narration.length()
                UploadLive.sending(run, UploadProgress.Stage.WORDS, 0, words, clock())
                try {
                    client.putNarration(created.id, narration) { n -> UploadLive.sending(run, UploadProgress.Stage.WORDS, n, words, clock()) }
                    Log.i(TAG, "upload $run: narration sent ahead of the video")
                } catch (e: ReceiverClient.Refused) {
                    if (e.code == 401) throw e
                    // The video carries the same sound, so a refused narration only costs time.
                    Log.w(TAG, "upload $run: narration refused (${e.message}); the video follows as usual")
                }
            }
            var offset = created.received
            var resets = 0
            var stuck = 0
            UploadLive.sending(run, UploadProgress.Stage.VIDEO, offset, bytes, clock())
            while (status == "uploading" && offset < bytes) {
                if (stopped()) return Result.success()
                val start = offset
                val end = minOf(start + CHUNK, bytes) - 1
                val result = client.put(created.id, media, start, end, bytes) { n -> UploadLive.sending(run, UploadProgress.Stage.VIDEO, start + n, bytes, clock()) }
                if (result.received == 0L && offset > 0) {
                    // The server found the finished file did not match its hash and started over.
                    if (++resets > 1) throw ReceiverClient.Refused("the server's copy failed verification twice: ${result.error}")
                }
                // A 409 for "busy" leaves the offset where it was; give the old request a moment to end.
                stuck = if (result.received == offset) stuck + 1 else 0
                if (stuck > 0) Thread.sleep(minOf(1000L * stuck, 10_000L))
                if (stuck > 20) throw IOException("the server kept refusing the chunk at $offset")
                offset = result.received
                status = result.status
                state = state.copy(sent = offset)
                save(state)
                UploadLive.sending(run, UploadProgress.Stage.VIDEO, offset, bytes, clock())
            }
            if (stopped()) return Result.success()
            save(state.copy(state = "uploaded", sent = bytes, server = status, sessionId = null, error = null))
            Invites.send(dir, client, state.thread)
            Log.i(TAG, "upload $run complete: ${created.id} $status")
            // A report is the team's once the receiver has it: this headset keeps no copy.
            if (Reports.isReport(dir)) Reports.sent(applicationContext, dir, status)
            return Result.success()
        } catch (e: ReceiverClient.Refused) {
            if (stopped()) return Result.success()
            if (TransferPolicy.awaitingAuth(true, e.code)) {
                // The receiver no longer takes this headset's token: sign in again, then this goes again.
                save(state.copy(state = "not_configured", error = if (config.account != null) "token rejected; waiting to sign in again" else "token rejected; update the developer server configuration"))
                signIn.rejected(applicationContext, config.token)
                signIn.retryLater(applicationContext)
                return Result.retry()
            }
            save(state.copy(state = "failed", error = e.message))
            Log.w(TAG, "upload $run refused: ${e.message}")
            return Result.failure()
        } catch (e: IOException) {
            if (stopped()) return Result.success()
            save(state.copy(state = "waiting", error = "retrying: ${e.message}"))
            Log.w(TAG, "upload $run will retry: $e")
            retryAt = clock() + UploadLive.retryDelay(runAttemptCount)
            return Result.retry()
        } finally {
            // However it ended: forgotten once sent, failed or deleted; else back to what the receiver confirmed.
            UploadLive.settled(run, UploadState.read(dir), retryAt, clock())
        }
    }

    /**
     * Creates the upload, or finds it. What a receiver refuses and the recording can do without is left
     * out and the create tried again: a narration (an older receiver does not know it, and the video has
     * the same sound), a launch log in a newer shape than the receiver reads, and a thread the receiver no
     * longer has (the recording opens a new thread instead).
     * Anything else stops the upload.
     */
    private fun create(client: ReceiverClient, body: JSONObject, run: String, config: UploadSettings.Config): ReceiverClient.Upload? {
        val hasMedia = body.has("fileName")
        while (true) {
            // This commit shares the delete/enqueue monitor. Once a POST is admitted, deletion knows
            // its exact receiver/account/clientId even if cancellation loses the HTTP response.
            if (isStopped || !DeleteJournal.beforeCreate(applicationContext, run, config)) return null
            try {
                val created = client.create(body)
                if (!DeleteJournal.created(applicationContext, run, config, created.id)) return null
                return created
            } catch (e: ReceiverClient.Refused) {
                if (e.code == 401 || e.code == 403) throw e
                val why = e.message.orEmpty()
                when {
                    body.has("narration") && why.contains("narration") -> {
                        Log.w(TAG, "upload $run: its narration was refused ($why); sending the video alone")
                        body.remove("narration")
                    }
                    // A receiver older than logs (2026-11-16) refuses them; a picture or sound still goes without.
                    // A take of logs alone is nothing without them, so its refusal stands.
                    hasMedia && body.has("logs") && why.contains("logs") -> {
                        Log.w(TAG, "upload $run: its logs were refused ($why); sending the media without them")
                        body.remove("logs")
                    }
                    hasMedia && body.has("durationMs") && why.contains("durationMs") -> {
                        Log.w(TAG, "upload $run: its length was refused ($why); sending it without")
                        body.remove("durationMs")
                    }
                    // A receiver older than the app's launch log (which option, from 0.11.0) refuses its fields.
                    body.has("opened") && why.contains("opened") -> {
                        Log.w(TAG, "upload $run: its launch log was refused ($why); sending it without")
                        body.remove("opened")
                    }
                    // Never for a report: as a new thread it would land in the sender's own inbox.
                    body.has("thread") && !Reports.isReport(body.optJSONObject("thread")) &&
                        Regex("no thread|no project|has no message|has no launch").containsMatchIn(why) -> {
                        Log.w(TAG, "upload $run: its thread was refused ($why); sending it as a new thread")
                        body.remove("thread")
                    }
                    else -> throw e
                }
            }
        }
    }

    /** Which audio track is which, in file order, as run.json noted when recording started. */
    private fun roles(dir: File): List<String> {
        val tracks = runCatching { JSONObject(File(dir, "run.json").readText()) }.getOrNull()?.optJSONObject("config")?.optJSONArray("audioTracks")
        return (0 until (tracks?.length() ?: 0)).map { tracks!!.optString(it) }
    }

    /**
     * The create's body. [bytes] and [sha] describe the media file, and are null together for a take of logs alone,
     * which has none (docs/LOGS.md): it says how long it was instead, as every take now does.
     */
    private fun createBody(run: String, dir: File, kind: TakeKind, bytes: Long?, sha: String?, config: UploadSettings.Config): JSONObject {
        val runJson = runCatching { JSONObject(File(dir, "run.json").readText()) }.getOrNull()
        val startedAt = runJson?.optLong("startedAt")?.takeIf { it > 0 } ?: dir.lastModified()
        val device = runJson?.optJSONObject("device")
        val body = JSONObject().put("clientId", "${config.deviceId}-$run")
        if (bytes != null && sha != null) body.put("bytes", bytes).put("sha256", sha).put("fileName", if (kind == TakeKind.SOUND) "audio.m4a" else "$run.mp4")
        runCatching { JSONObject(File(dir, "summary.json").readText()) }.getOrNull()
            ?.takeIf { !it.isNull("durationMs") }?.optLong("durationMs")?.takeIf { it in 1..24 * 3_600_000L }?.let { body.put("durationMs", it) }
        body
            // Local time with its offset: the receiver names the bundle by when it was recorded.
            .put("recordedAt", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date(startedAt)))
            .put("appPackage", applicationContext.packageName)
        if (device != null) {
            body.put("device", JSONObject()
                .put("manufacturer", device.optString("manufacturer")).put("model", device.optString("model"))
                .put("sdk", device.optInt("sdk")).put("build", device.optString("display")))
        }
        // The notice accepted before recording (Consent), which the receiver requires from testers.
        val consent = Consent.forUpload(runJson)
        if (consent == null && (!BuildConfig.DEBUG || config.account != null))
            throw ReceiverClient.Refused("This recording has no valid consent evidence from before it started; it cannot upload to the hosted test.")
        consent?.let { body.put("consent", it) }
        // Which apps were in front and when, if Usage access was on (AppSwitches).
        AppSwitches.forUpload(dir)?.let { body.put("apps", it) }
        // What the app opened from launches while recording, and when: which build or variant was on screen.
        runCatching { JSONArray(File(dir, "opened.json").readText()) }.getOrNull()?.takeIf { it.length() > 0 }?.let { body.put("opened", it) }
        // The thread it goes in, as chosen when recording started (docs/THREADS.md); a report names only that it is one.
        val thread = runCatching { JSONObject(File(dir, "thread.json").readText()) }.getOrNull()
        if (Reports.isReport(thread)) body.put("thread", Reports.destination())
        else thread?.takeIf { it.has("key") || it.has("project") }?.let { body.put("thread", it) }
        // Which audio track is which (mic, then app), so a clip can later be cut with one and not the other.
        val roles = roles(dir)
        if (roles.isNotEmpty() && roles.all { it == "mic" || it == "app" }) body.put("audioTracks", JSONArray(roles))
        // The build that made the recording, as run.json noted it when recording started (an update
        // installed before the upload must not relabel it). Runs from before 0.3.0 carry no commit.
        val app = runJson?.optJSONObject("app")
        val versionName = app?.optString("versionName").orEmpty()
        if (Regex("[A-Za-z0-9._+-]{1,40}").matches(versionName)) {
            val build = JSONObject().put("versionName", versionName)
            if (app!!.has("versionCode")) build.put("versionCode", app.optInt("versionCode"))
            app.optString("commit").takeIf { Regex("([0-9a-f]{7,40}(-dirty)?|unknown)").matches(it) }?.let { build.put("commit", it) }
            body.put("app", build)
        }
        return body
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
