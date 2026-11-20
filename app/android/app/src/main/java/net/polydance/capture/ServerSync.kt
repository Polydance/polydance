package net.polydance.capture

import android.content.Context
import android.util.Log

/**
 * Asks the receiver how this headset's recordings are doing: its storage against the allowance, and for
 * each uploaded recording its status, thread, pipeline steps and Claude's title and summary, written into
 * the recording's upload.json for the deck's transfer unit and the inbox's cards. It was the rack's poll
 * until the rack came off the deck in the sixth pass (2026-10-04); the deck and the inbox both run it, and
 * a poll asked for sooner than [MIN_GAP_MS] after the last is skipped.
 */
object ServerSync {
    private const val MIN_GAP_MS = 2_500L
    @Volatile private var last = 0L

    /** True while the receiver is still building one of this headset's recordings: poll often then. */
    fun busy(context: Context) = Recording.list(context).any { it.upload.state == "uploaded" && it.upload.server !in setOf("ready", "failed", "deleted") }

    @Synchronized
    fun poll(context: Context) {
        val now = System.currentTimeMillis()
        if (now - last < MIN_GAP_MS) return
        last = now
        val config = UploadSettings.load(context) ?: return
        val client = ReceiverClient(config)
        runCatching { StorageStatus.save(context, client.account()) }.onFailure {
            Log.w("PolydanceCapture", "storage poll failed: $it")
            // A token from signing in with Meta that the receiver no longer takes: sign in again.
            if (it is ReceiverClient.Refused && it.code == 401) signIn.rejected(context, config.token)
        }
        val open = Recording.list(context).filter { it.upload.state == "uploaded" && it.upload.server != "deleted" }
        if (open.isEmpty()) return
        val byClient = open.associateBy { "${config.deviceId}-${it.name}" }
        runCatching { client.statuses(byClient.keys.toList()) }
            .onSuccess { uploads ->
                // A recording deleted and sent again has a tombstone and a live upload; the live one wins.
                for ((clientId, all) in uploads.groupBy { it.clientId }) {
                    val recording = byClient[clientId] ?: continue
                    val u = all.firstOrNull { it.status != "deleted" } ?: all.first()
                    val error = if (u.status == "deleted") u.deletedReason else u.error
                    UploadState.write(
                        recording.dir,
                        recording.upload.copy(
                            server = u.status, sessionId = u.sessionId, error = error,
                            title = u.title ?: recording.upload.title, summary = u.summary ?: recording.upload.summary,
                            stepsDone = u.stepsDone, stepsTotal = u.stepsTotal, thread = u.thread ?: recording.upload.thread,
                        ),
                    )
                }
            }
            .onFailure {
                Log.w("PolydanceCapture", "status poll failed: $it")
                if (it is ReceiverClient.Refused && it.code == 401) signIn.rejected(context, config.token)
            }
    }
}
