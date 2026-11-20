package net.polydance.capture

import net.polydance.capture.ReportPolicy.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReportPolicyTest {
    private val now = 1_760_000_000_000L
    private fun report(state: String, server: String? = null, bytes: Long = 5_000_000, interrupted: Boolean = false, recording: Boolean = false, ageMs: Long = 60_000) =
        ReportPolicy.Report(state, server, bytes, interrupted, recording, now - ageMs)

    @Test fun deletedHereOnlyOnceTheReceiverHasVerifiedEveryByte() {
        for (status in listOf("received", "processing", "ready", "failed")) {
            assertTrue(status, ReportPolicy.verified(status))
            assertEquals(status, Action.DELETE, ReportPolicy.decide(report("uploaded", status), now))
        }
        for (status in listOf(null, "uploading", "deleted", "")) {
            assertFalse("$status", ReportPolicy.verified(status))
            assertEquals("$status", Action.KEEP, ReportPolicy.decide(report("uploaded", status), now))
        }
    }

    @Test fun neverTouchesTheRecordingInProgress() {
        assertEquals(Action.KEEP, ReportPolicy.decide(report("none", bytes = 0, interrupted = true, recording = true, ageMs = 30L * 24 * 3600_000), now))
    }

    @Test fun clearsWhatCanNeverBeSentAtOnce() {
        assertEquals(Action.DELETE, ReportPolicy.decide(report("waiting", interrupted = true), now))
        assertEquals(Action.DELETE, ReportPolicy.decide(report("none", bytes = 0), now))
    }

    @Test fun retriesARefusedReportForAWeekThenLetsItGo() {
        assertEquals(Action.RETRY, ReportPolicy.decide(report("failed"), now))
        assertEquals(Action.RETRY, ReportPolicy.decide(report("none"), now))
        assertEquals(Action.RETRY, ReportPolicy.decide(report("failed", ageMs = ReportPolicy.KEEP_UNSENT_MS), now))
        assertEquals(Action.DELETE, ReportPolicy.decide(report("failed", ageMs = ReportPolicy.KEEP_UNSENT_MS + 1), now))
    }

    @Test fun leavesQueuedUploadsToWorkManagerUntilTheWeekIsUp() {
        for (state in listOf("waiting", "uploading", "not_configured")) {
            assertEquals(state, Action.KEEP, ReportPolicy.decide(report(state), now))
            assertEquals(state, Action.DELETE, ReportPolicy.decide(report(state, ageMs = ReportPolicy.KEEP_UNSENT_MS + 1), now))
        }
        // A clock set back after recording is not a reason to delete.
        assertEquals(Action.KEEP, ReportPolicy.decide(report("waiting", ageMs = -3600_000), now))
    }
}
