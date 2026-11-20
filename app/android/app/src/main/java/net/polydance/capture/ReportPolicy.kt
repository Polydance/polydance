package net.polydance.capture

/**
 * What happens to a report on this headset (docs/THREADS.md, Reports, 2026-10-12). Pure, so the rules are
 * tested without a device: a report is deleted here once the receiver has verified every byte; one that
 * can never upload goes at once; one still unsent after a week goes too, so reports cannot build up on a
 * headset whose owner never sees them; a refused one is tried again until then.
 */
internal object ReportPolicy {
    /** Long enough to outlast an outage or a sign-in that has lapsed, short enough that nothing piles up. */
    const val KEEP_UNSENT_MS = 7L * 24 * 3600_000

    /** The receiver's statuses once the whole file has arrived and matched its sha256. */
    private val VERIFIED = setOf("received", "processing", "ready", "failed")

    enum class Action { KEEP, DELETE, RETRY }

    /** A report as the sweep sees it, from its upload.json and run files. */
    data class Report(
        /** UploadState.state: none, waiting, uploading, uploaded, failed, not_configured. */
        val state: String,
        /** The receiver's status when the upload finished. */
        val server: String?,
        val bytes: Long,
        /** Cut off before Stop: the MP4 has no index and can never be processed. */
        val interrupted: Boolean,
        /** This run is the one recording now. */
        val recording: Boolean,
        val startedAt: Long,
    )

    /** The receiver holds the whole, verified file, so the headset's copy may go. */
    fun verified(server: String?) = server in VERIFIED

    fun decide(report: Report, now: Long): Action = when {
        report.recording -> Action.KEEP
        report.state == "uploaded" && verified(report.server) -> Action.DELETE
        report.interrupted || report.bytes == 0L -> Action.DELETE
        now - report.startedAt > KEEP_UNSENT_MS -> Action.DELETE
        // A refused report has no Retry key, being nowhere on screen: the sweep is its retry, for a week.
        report.state == "failed" || report.state == "none" -> Action.RETRY
        // Waiting, uploading or waiting to sign in: WorkManager already has it.
        else -> Action.KEEP
    }
}
