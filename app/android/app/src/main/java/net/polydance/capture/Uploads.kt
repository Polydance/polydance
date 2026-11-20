package net.polydance.capture

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Where recordings go after Stop: the hosted receiver's address and this headset's upload token (from
 * the flavor's sign-in, HeadsetSignIn (Meta on Quest), or on a debug build over adb; kept in app-private preferences and never
 * logged), each recording's upload state in its own folder, and the WorkManager jobs that move them.
 */
object UploadSettings {
    private const val PREFS = "upload"
    private val tokens = TokenGuard()
    val TOKEN = Regex("^polycap_[0-9a-f]{64}$")

    /**
     * [account] and [accountName] are set when the token came from the flavor's own sign-in (HeadsetSignIn):
     * Meta's user id on Quest, the receiver's `google-` grant id on Android XR. A token configured over adb has
     * neither. They are stored under the keys "metaUser" and "metaName", their names before Android XR had a
     * sign-in, so a headset already signed in stays signed in.
     */
    data class Config(val server: String, val token: String, val deviceId: String, val account: String? = null, val accountName: String? = null)

    fun load(context: Context): Config? = tokens.access {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val server = prefs.getString("server", null) ?: return@access null
        val token = prefs.getString("token", null) ?: return@access null
        Config(server, token, deviceId(context), prefs.getString("metaUser", null), prefs.getString("metaName", null))
    }

    /** Returns an error message, or null when saved. */
    fun save(context: Context, server: String, token: String, account: String? = null, accountName: String? = null): String? = tokens.access {
        val url = server.trimEnd('/')
        if (!Regex("^https?://[A-Za-z0-9.:\\[\\]-]+(:\\d+)?$").matches(url)) return@access "server must look like https://host or http://192.168.1.10:8787"
        if (!TOKEN.matches(token)) return@access "token must be an polycap_ token from `polycap token new`"
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("server", url).putString("token", token)
            .putString("metaUser", account).putString("metaName", accountName).apply()
        null
    }

    internal fun saveIfMissing(context: Context, server: String, token: String, user: String, name: String): String? = tokens.access {
        if (load(context) != null) null else save(context, server, token, user, name)
    }

    /** Drops a token the receiver no longer takes; the server stays, so this headset's uploads are still known there. */
    fun forgetToken(context: Context, rejectedToken: String): Boolean = tokens.access {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // Developer-configured tokens cannot be renewed by signing in again.
        if (prefs.getString("metaUser", null) == null) return@access false
        tokens.reject(rejectedToken, { prefs.getString("token", null) }) {
            prefs.edit().remove("token").remove("metaUser").remove("metaName").apply()
        }
    }

    /** A random id per install, so two headsets never send the same client id for different files. */
    fun deviceId(context: Context): String = tokens.access {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().replace("-", "").take(8).also {
            prefs.edit().putString("deviceId", it).apply()
        }
    }
}

/** upload.json beside the video: what this headset knows about the recording's trip to the receiver. */
data class UploadState(
    /** none, waiting, uploading, uploaded, failed, not_configured */
    val state: String = "none",
    val uploadId: String? = null,
    val sha256: String? = null,
    val bytes: Long = 0,
    val sent: Long = 0,
    /** The receiver's own status once all bytes arrived: received, processing, ready, failed. */
    val server: String? = null,
    val sessionId: String? = null,
    val error: String? = null,
    val updatedAt: Long = 0,
    /** Claude's few words and one sentence for this recording, from the receiver once it has them. */
    val title: String? = null,
    val summary: String? = null,
    /** The receiver's pipeline steps finished and in all, for the transfer bar while it processes. */
    val stepsDone: Int? = null,
    val stepsTotal: Int? = null,
    /** The thread the receiver put it in (MUS-12), once the upload exists there. */
    val thread: String? = null,
    /** Held until then after Stop, so a mistaken recording can be deleted before it goes up (CAP-1 #20). */
    val holdUntil: Long? = null,
) {
    fun toJson(): JSONObject = JSONObject().put("state", state).put("uploadId", uploadId).put("sha256", sha256)
        .put("bytes", bytes).put("sent", sent).put("server", server).put("sessionId", sessionId).put("error", error)
        .put("updatedAt", updatedAt).put("title", title).put("summary", summary).put("stepsDone", stepsDone).put("stepsTotal", stepsTotal)
        .put("thread", thread).put("holdUntil", holdUntil)

    companion object {
        fun read(dir: File): UploadState {
            val file = File(dir, "upload.json")
            if (!file.exists()) return UploadState()
            return runCatching {
                val j = JSONObject(file.readText())
                fun str(key: String) = if (j.isNull(key)) null else j.optString(key)
                UploadState(
                    j.optString("state", "none"), str("uploadId"), str("sha256"), j.optLong("bytes"), j.optLong("sent"),
                    str("server"), str("sessionId"), str("error"), j.optLong("updatedAt"), str("title"), str("summary"),
                    if (j.has("stepsDone") && !j.isNull("stepsDone")) j.optInt("stepsDone") else null,
                    if (j.has("stepsTotal") && !j.isNull("stepsTotal")) j.optInt("stepsTotal") else null,
                    str("thread"),
                    if (j.has("holdUntil") && !j.isNull("holdUntil")) j.optLong("holdUntil") else null,
                )
            }.getOrElse { UploadState(state = "failed", error = "upload.json unreadable: $it") }
        }

        /** Written to a temporary file and renamed, so the screen never reads half a file. */
        @Synchronized
        fun write(dir: File, state: UploadState) {
            // Deletion uses this same monitor. Late workers/polls must not recreate a removed folder.
            if (!dir.isDirectory) return
            val temp = File(dir, "upload.json.tmp")
            temp.writeText(state.copy(updatedAt = System.currentTimeMillis()).toJson().toString(2))
            if (!temp.renameTo(File(dir, "upload.json"))) throw IOException("Could not save upload state")
        }
    }
}

/**
 * One finished or in-progress run folder, as the recordings list shows it. [kind] is what it recorded (Takes): a
 * picture (video.mp4), sound alone (audio.m4a) or logs alone (no media file); [bytes] counts the media and logcat.txt,
 * which both go up.
 */
data class Recording(
    val name: String, val dir: File, val bytes: Long, val durationMs: Long?, val tracks: String, val upload: UploadState,
    val kind: TakeKind = TakeKind.VIDEO,
) {
    val video get() = File(dir, "video.mp4")

    /** The file the upload sends as its media, or null for a take of logs alone. */
    val media: File? get() = mediaOf(dir, kind)

    /** "Sound only" or "Logs only" where a picture would be shown; null for a take with the picture. */
    val without: String? get() = withoutPicture(kind)

    /** Where it was going when recording started (thread.json): a thread's key, or a project for a new thread. */
    val destination: JSONObject? get() = runCatching { JSONObject(File(dir, "thread.json").readText()) }.getOrNull()

    /** The thread it is in, or will be once uploaded; null for a new thread not made yet, or a recording from before threads. */
    val threadKey: String? get() = upload.thread ?: destination?.optString("key")?.ifEmpty { null }

    /** Made with the deck's bug key: the Polydance team's, not in the inbox or on the tape (Reports). */
    val report: Boolean get() = Reports.isReport(destination)

    /**
     * Cut off before Stop (the app was killed: an update installed over it, a force stop, a crash). The
     * MP4 index is only written at Stop, so the file cannot be played or processed.
     */
    val interrupted get() = !File(dir, "summary.json").exists() && !CaptureState.busy(dir)

    companion object {
        /** The recordings the inbox shows and the tape counts: every run but reports. */
        fun list(context: Context): List<Recording> = all(context).filterNot { it.report }

        /** Reports from the bug key still on this headset, waiting to go or about to be removed. */
        fun reports(context: Context): List<Recording> = all(context).filter { it.report }

        /** The media file a take of [kind] writes, or null for logs alone. */
        fun mediaOf(dir: File, kind: TakeKind): File? = when (kind) {
            TakeKind.VIDEO -> File(dir, "video.mp4")
            TakeKind.SOUND -> File(dir, "audio.m4a")
            TakeKind.LOGS, TakeKind.NONE -> null
        }

        fun withoutPicture(kind: TakeKind): String? = when (kind) {
            TakeKind.SOUND -> "Sound only"
            TakeKind.LOGS -> "Logs only"
            TakeKind.VIDEO, TakeKind.NONE -> null
        }

        /** What a run folder recorded: run.json's kind, or, for a run from before it was written, the file it has. */
        private fun kindOf(dir: File, config: JSONObject?): TakeKind? = when {
            config?.has("kind") == true -> TakeKind.of(config.optString("kind"))
            File(dir, "video.mp4").exists() -> TakeKind.VIDEO
            else -> null
        }

        /** Every run on this headset, reports included: for uploads, which treat both alike. */
        fun all(context: Context): List<Recording> {
            val runs = RecorderService.runsDir(context).listFiles { f -> f.isDirectory } ?: return emptyList()
            return runs.sortedByDescending { it.name }.mapNotNull { dir ->
                val config = runCatching { JSONObject(File(dir, "run.json").readText()).getJSONObject("config") }.getOrNull()
                val kind = kindOf(dir, config) ?: return@mapNotNull null
                // A take with a picture or sound is listed once its file exists, as before; one of logs alone from the start.
                val media = mediaOf(dir, kind)
                if (media != null && !media.exists()) return@mapNotNull null
                val summary = runCatching { JSONObject(File(dir, "summary.json").readText()) }.getOrNull()
                val tracks = config?.optJSONArray("audioTracks")?.let { a -> (0 until a.length()).joinToString("+") { a.getString(it) } }
                    ?: if (config?.optBoolean("mic") == true) "mic" else "no audio"
                Recording(
                    dir.name, dir, (media?.length() ?: 0L) + File(dir, DeviceLogs.FILE).length(),
                    summary?.takeIf { !it.isNull("durationMs") }?.optLong("durationMs"), tracks, UploadState.read(dir), kind,
                )
            }
        }
    }
}

object Uploads {
    private fun workName(run: String) = "upload-$run"

    /** Under this a recording is more likely a mistake, so it waits longer before going up (Robin, 2026-10-06). */
    const val SHORT_MS = 20_000L

    /** How long a stopped recording waits before it uploads: 5 s to undo, 30 s for one under 20 s. */
    fun holdFor(durationMs: Long?): Long = if (durationMs != null && durationMs < SHORT_MS) 30_000L else 5_000L

    /**
     * Queues one recording, after [holdMs] when it has just stopped. `restart` replaces a job already queued
     * (Retry, or Send now during the hold); otherwise it is kept.
     */
    fun enqueue(context: Context, run: String, restart: Boolean = false, holdMs: Long = 0): Unit = DeleteJournal.access {
        if (DeleteJournal.deleted(context, run)) return@access
        val dir = File(RecorderService.runsDir(context), run)
        if (!dir.isDirectory) return@access
        val current = UploadState.read(dir)
        val until = if (holdMs > 0) System.currentTimeMillis() + holdMs else null
        if (current.state != "uploaded") UploadState.write(dir, current.copy(state = "waiting", error = null, holdUntil = until))
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(workDataOf(UploadWorker.RUN to run))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, UploadLive.BACKOFF_SECONDS, TimeUnit.SECONDS)
            .apply { if (holdMs > 0) setInitialDelay(holdMs, TimeUnit.MILLISECONDS) }
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            workName(run), if (restart) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request,
        )
    }

    fun cancel(context: Context, run: String) { WorkManager.getInstance(context).cancelUniqueWork(workName(run)) }

    /**
     * Deletes a recording from this headset and the receiver. The local copy goes now; the server copy
     * is deleted by a queued job, so it happens even when the headset is offline at the time.
     */
    fun deleteEverywhere(context: Context, run: String): Boolean = DeleteJournal.access {
        val dir = File(RecorderService.runsDir(context), run)
        // Synchronous commit BEFORE cancel/removal: a process death must not lose the remote intent.
        try {
            DeleteJournal.request(context, run, UploadState.read(dir))
        } catch (_: IOException) {
            return@access false // Keep the files when the durable intent could not be saved.
        }
        cancel(context, run)
        UploadLive.forget(run)
        DeleteWorker.enqueue(context, run)
        synchronized(UploadState) { dir.deleteRecursively() }
    }

    /**
     * A different server has none of this headset's uploads: recordings marked uploaded to the old one
     * go back to "not uploaded" so they can be sent again. Nothing on either server is touched.
     */
    fun forgetServer(context: Context) {
        for (recording in Recording.all(context)) {
            if (recording.upload.state != "none") UploadState.write(recording.dir, UploadState(state = "none"))
        }
    }

    /** After the server is configured: everything that stopped for want of it goes again. */
    fun resumeWaiting(context: Context) {
        DeleteWorker.resumePending(context)
        for (recording in Recording.all(context)) {
            if (!recording.interrupted && !CaptureState.busy(recording.dir) &&
                recording.upload.state in setOf("not_configured", "waiting", "uploading")) {
                val remainingHold = ((recording.upload.holdUntil ?: 0) - System.currentTimeMillis()).coerceAtLeast(0)
                enqueue(context, recording.name, holdMs = remainingHold)
            }
        }
    }
}

/**
 * What this headset has stored on the receiver against its allowance, as last heard from the server,
 * plus recordings still waiting to upload (they will count once they arrive). When that reaches the
 * allowance, recording stops until recordings are deleted. Offline, the last known figures apply.
 */
object StorageStatus {
    private const val PREFS = "storage"

    data class Status(val usedBytes: Long?, val allowanceBytes: Long?, val waitingBytes: Long, val checkedAt: Long) {
        val totalBytes get() = (usedBytes ?: 0) + waitingBytes
        val full get() = allowanceBytes != null && totalBytes >= allowanceBytes
        val fraction get() = if (allowanceBytes == null || allowanceBytes == 0L) 0.0 else totalBytes.toDouble() / allowanceBytes
    }

    fun save(context: Context, account: ReceiverClient.Account) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong("used", account.usedBytes).putLong("allowance", account.allowanceBytes)
            .putLong("at", System.currentTimeMillis()).apply()
    }

    fun forget(context: Context) { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply() }

    fun current(context: Context, recordings: List<Recording> = Recording.list(context)): Status {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val known = prefs.contains("allowance")
        val waiting = recordings.filter { it.upload.state !in setOf("uploaded", "uploading") && !it.interrupted }.sumOf { it.bytes }
        return Status(
            if (known) prefs.getLong("used", 0) else null, if (known) prefs.getLong("allowance", 0) else null,
            waiting, prefs.getLong("at", 0),
        )
    }
}

/** App-private durable journal, separate from removable run folders. No bearer tokens are retained. */
internal object DeleteJournal {
    private const val PREFS = "uploadDeletionJournal"
    @Synchronized fun <T> access(block: () -> T): T = block()
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun owner(config: UploadSettings.Config): DeletePolicy.Owner = DeletePolicy.Owner(
        config.server.trimEnd('/'),
        config.account?.let { "meta:$it" } ?: "token:" + MessageDigest.getInstance("SHA-256")
            .digest(config.token.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) },
    )

    @Synchronized fun read(context: Context, run: String): DeletePolicy.Entry {
        val raw = prefs(context).getString(run, null) ?: return DeletePolicy.Entry()
        try {
            val j = JSONObject(raw)
            val targets = j.getJSONArray("targets")
            return DeletePolicy.Entry(j.getBoolean("deleted"), (0 until targets.length()).map { i ->
                val t = targets.getJSONObject(i)
                val o = t.optJSONObject("owner")
                val ids = t.getJSONArray("ids")
                DeletePolicy.Target(t.getString("clientId"), o?.let { DeletePolicy.Owner(it.getString("server"), it.getString("account")) },
                    (0 until ids.length()).map { ids.getString(it) }.toSet(), t.getInt("outstandingCreates"), t.getBoolean("confirmed"))
            })
        } catch (e: Exception) {
            throw IOException("Deletion journal unreadable; recording must not upload", e)
        }
    }

    @Synchronized fun save(context: Context, run: String, entry: DeletePolicy.Entry) {
        val targets = org.json.JSONArray()
        for (t in entry.targets) targets.put(JSONObject().put("clientId", t.clientId)
            .put("owner", t.owner?.let { JSONObject().put("server", it.server).put("account", it.account) })
            .put("ids", org.json.JSONArray(t.ids.toList())).put("outstandingCreates", t.outstandingCreates).put("confirmed", t.confirmed))
        if (!prefs(context).edit().putString(run, JSONObject().put("deleted", entry.deleted).put("targets", targets).toString()).commit())
            throw IOException("Could not persist deletion journal")
    }

    @Synchronized fun deleted(context: Context, run: String): Boolean =
        try { read(context, run).deleted } catch (_: IOException) { true } // fail closed

    @Synchronized fun beforeCreate(context: Context, run: String, config: UploadSettings.Config): Boolean {
        val entry = DeletePolicy.beforeCreate(read(context, run), "${config.deviceId}-$run", owner(config)) ?: return false
        save(context, run, entry)
        return true
    }

    /** Returns false for a late answer after delete; its ID is still durably added to the delete work. */
    @Synchronized fun created(context: Context, run: String, config: UploadSettings.Config, id: String): Boolean {
        val entry = DeletePolicy.created(read(context, run), "${config.deviceId}-$run", owner(config), id)
        save(context, run, entry)
        if (entry.deleted) DeleteWorker.enqueue(context, run, afterCurrent = true)
        return DeletePolicy.mayUpload(entry)
    }

    @Synchronized fun request(context: Context, run: String, state: UploadState) {
        var entry = read(context, run)
        // Pre-journal uploads have no trustworthy owner. Do not silently assign them to today's login.
        val untrackedId = state.uploadId?.takeIf { id -> entry.targets.none { id in it.ids } }
        if (untrackedId != null || (entry.targets.isEmpty() &&
                (state.state in setOf("uploading", "uploaded", "failed", "not_configured") || state.sha256 != null))) {
            entry = DeletePolicy.replace(entry, DeletePolicy.Target("${UploadSettings.deviceId(context)}-$run", null,
                untrackedId?.let { setOf(it) } ?: emptySet(), outstandingCreates = if (untrackedId == null) 1 else 0))
        }
        save(context, run, DeletePolicy.request(entry))
    }

    @Synchronized fun confirm(context: Context, run: String, target: DeletePolicy.Target) {
        save(context, run, DeletePolicy.confirm(read(context, run), target))
    }

    @Synchronized fun recover(context: Context, run: String, target: DeletePolicy.Target, ids: Set<String>): DeletePolicy.Target? {
        val entry = read(context, run)
        if (!entry.targets.contains(target)) return null
        val recovered = DeletePolicy.recover(target, ids)
        save(context, run, DeletePolicy.replace(entry, recovered))
        return recovered
    }

    @Synchronized fun pendingRuns(context: Context): List<String> = prefs(context).all.keys.filter {
        try { read(context, it).pending } catch (_: IOException) { true }
    }
}

/** Deletes a tombstoned run's remote copies, including an ID recovered after a lost POST response. */
class DeleteWorker(context: Context, params: androidx.work.WorkerParameters) : androidx.work.Worker(context, params) {
    companion object {
        private const val RUN = "run"
        // Old work/markers are retained as unresolved: they did not capture server/account ownership.
        const val UPLOAD_ID = "uploadId"
        private const val LEGACY_PREFS = "pendingDeletes"

        fun pending(context: Context): Int = DeleteJournal.pendingRuns(context).size +
            context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE).all.size

        fun errors(context: Context): String {
            val messages = context.getSharedPreferences("deleteErrors", Context.MODE_PRIVATE).all.values.map { it.toString() }.toMutableList()
            if (context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE).all.isNotEmpty())
                messages.add("Older server deletions pending: original server/account unknown.")
            return messages.distinct().joinToString("; ")
        }

        fun resumePending(context: Context) {
            for (run in DeleteJournal.pendingRuns(context)) enqueue(context, run)
        }

        fun enqueue(context: Context, run: String, afterCurrent: Boolean = false) {
            val request = OneTimeWorkRequestBuilder<DeleteWorker>()
                .setInputData(workDataOf(RUN to run))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // A response arriving as the current delete worker finishes must not be dropped by KEEP.
            WorkManager.getInstance(context).enqueueUniqueWork("delete-run-$run",
                if (afterCurrent) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP, request)
        }
    }

    override fun doWork(): Result {
        val run = inputData.getString(RUN) ?: return Result.failure() // legacy ownership is unknown
        val errors = applicationContext.getSharedPreferences("deleteErrors", Context.MODE_PRIVATE)
        fun waiting(message: String): Result {
            errors.edit().putString(run, "Server deletion pending: $message").apply()
            return Result.retry()
        }
        val config = UploadSettings.load(applicationContext)
        try {
            val entry = DeleteJournal.read(applicationContext, run)
            if (!entry.deleted || !entry.pending) {
                errors.edit().remove(run).apply()
                return Result.success()
            }
            if (config == null) {
                signIn.retryLater(applicationContext)
                return waiting("waiting to sign in.")
            }
            val owner = DeleteJournal.owner(config)
            val client = ReceiverClient(config)
            for (original in entry.targets.filter { !it.confirmed }) {
                if (!DeletePolicy.owns(original, owner)) continue // Still delete targets belonging to this login.

                var target = original
                if (target.outstandingCreates > 0 || target.ids.isEmpty()) {
                    val live = client.statuses(listOf(target.clientId)).filter { it.clientId == target.clientId && it.status != "deleted" }
                    // An empty lookup or an old deleted copy cannot settle a POST whose response was lost.
                    if (live.isEmpty()) return waiting("upload creation is unresolved; no live matching upload is visible yet.")
                    target = DeleteJournal.recover(applicationContext, run, target, live.map { it.id }.toSet())
                        ?: return waiting("upload identity changed; checking again.")
                }
                for (id in target.ids) {
                    if (!client.delete(id)) return waiting("receiver is still receiving/processing; retrying with backoff (409).")
                }
                DeleteJournal.confirm(applicationContext, run, target)
            }
            val remaining = DeleteJournal.read(applicationContext, run).targets.filter { !it.confirmed }
            if (remaining.isNotEmpty()) return waiting(when {
                remaining.any { it.owner == null } -> "original server/account unknown; ownership cannot be verified."
                remaining.any { !DeletePolicy.owns(it, owner) } -> "sign in to the original account on the original server."
                else -> "upload creation/identity is still unresolved; checking again with backoff."
            })
            errors.edit().remove(run).apply()
            return Result.success()
        } catch (e: ReceiverClient.Refused) {
            if (config != null && TransferPolicy.awaitingAuth(true, e.code)) {
                signIn.rejected(applicationContext, config.token)
                signIn.retryLater(applicationContext)
            }
            // Includes 404: it can conceal another grant's upload, not prove it was deleted.
            return waiting("not confirmed: ${e.message}.")
        } catch (_: IOException) {
            return waiting("waiting for the server or durable deletion journal to be available.")
        }
    }
}
