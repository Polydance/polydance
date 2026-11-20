package net.polydance.capture

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Reports from the deck's bug key (docs/THREADS.md, Reports, 2026-10-12): a recording of a bug or a feature
 * request about Polydance itself, for the Polydance team. It records and uploads like any recording, but
 * its upload names `{ "report": true }` as its thread, so the receiver opens a thread only the team sees.
 * Here it is not in the inbox and not on the tape, it uploads without the hold (there is no card to undo it
 * from), and once the receiver has verified every byte this headset's copy is deleted. The sweep, at each
 * process start, clears what is left by ReportPolicy's rules. Nothing is deleted on the receiver from here.
 */
object Reports {
    private const val TAG = "PolydanceCapture"

    /** What a report's thread.json holds; the upload sends it as its thread. */
    fun destination(): JSONObject = JSONObject().put("report", true)

    fun isReport(destination: JSONObject?): Boolean = destination?.optBoolean("report") == true
    fun isReport(json: String?): Boolean = isReport(json?.let { runCatching { JSONObject(it) }.getOrNull() })
    fun isReport(dir: File): Boolean = isReport(runCatching { File(dir, "thread.json").readText() }.getOrNull())

    /** Called by the upload once it finishes: the receiver's [status] says whether it has the verified file. */
    fun sent(context: Context, dir: File, status: String?) {
        if (!ReportPolicy.verified(status)) { Log.w(TAG, "report ${dir.name} uploaded but the receiver says $status; kept for the sweep"); return }
        // The worker calling this is the run's own job, so there is nothing to cancel.
        delete(context, dir, "sent", cancelWork = false)
    }

    /** Applies ReportPolicy to every report on this headset; run off the main thread. */
    fun sweep(context: Context) {
        val now = System.currentTimeMillis()
        for (report in Recording.reports(context)) {
            val startedAt = runCatching { JSONObject(File(report.dir, "run.json").readText()).optLong("startedAt") }.getOrNull()?.takeIf { it > 0 }
                ?: report.video.lastModified()
            val seen = ReportPolicy.Report(
                report.upload.state, report.upload.server, report.bytes, report.interrupted,
                CaptureState.busy(report.dir), startedAt,
            )
            when (ReportPolicy.decide(seen, now)) {
                ReportPolicy.Action.DELETE -> delete(context, report.dir, if (report.upload.state == "uploaded") "sent" else "unsendable or a week old (${report.upload.state})")
                ReportPolicy.Action.RETRY -> { Timeline.log("report", "retry", "run" to report.name, "error" to report.upload.error); Uploads.enqueue(context, report.name, restart = true) }
                ReportPolicy.Action.KEEP -> Unit
            }
        }
    }

    /** Under the same monitors as Delete, so a late upload worker or status poll cannot write the folder back. */
    private fun delete(context: Context, dir: File, why: String, cancelWork: Boolean = true) = DeleteJournal.access {
        if (cancelWork) Uploads.cancel(context, dir.name)
        val gone = synchronized(UploadState) { dir.deleteRecursively() }
        Timeline.log("report", "deleted_here", "run" to dir.name, "why" to why, "ok" to gone)
        Log.i(TAG, "report ${dir.name} deleted from this headset ($why): $gone")
    }
}
