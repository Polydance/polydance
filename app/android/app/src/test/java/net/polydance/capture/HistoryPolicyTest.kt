package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test

class HistoryPolicyTest {
    private data class Record(
        override val id: String,
        override val clientId: String,
        override val status: String = "ready",
    ) : HistoryPolicy.Record

    // Mirrors every Config field, without any Android/JSON dependency or real credentials.
    private data class Scope(
        val server: String = "https://receiver.example",
        val token: String = "test-token",
        val device: String = "install",
        val account: String? = "test-account",
        val name: String? = "Tester",
    )

    @Test fun freshInstallShowsRetainedAccountHistoryWithoutCurrentDevicePrefix() {
        val remote = listOf(Record("one", "previous-install-run"), Record("two", "linked-legacy-run"))
        assertEquals(remote, HistoryPolicy.serverOnly(remote, emptyList()))
    }

    @Test fun localUploadIdOrClientIdSuppressesTheServerDuplicate() {
        val remote = listOf(Record("one", "old-install"), Record("two", "current-run"), Record("three", "server-only"))
        val local = listOf(HistoryPolicy.Local("one", "new-install"), HistoryPolicy.Local(null, "current-run"))
        assertEquals(listOf(remote[2]), HistoryPolicy.serverOnly(remote, local))
    }

    @Test fun deletedRowsDoNotHideALiveRetryAndRemoteDuplicatesAreCollapsedInReceiverOrder() {
        val remote = listOf(
            Record("deleted", "retry", "deleted"), Record("live", "retry", "processing"),
            Record("live", "retry", "processing"), Record("other", "retry"), Record("last", "distinct", "failed"),
        )
        assertEquals(listOf(remote[1], remote[4]), HistoryPolicy.serverOnly(remote, emptyList()))
        assertEquals(emptyList<Record>(), HistoryPolicy.serverOnly(listOf(remote[0]), emptyList()))
    }

    @Test fun missingIdsNeverMatchOtherMissingIds() {
        val remote = listOf(Record("one", ""), Record("two", ""), Record("", "client"))
        assertEquals(remote.take(2), HistoryPolicy.serverOnly(remote, listOf(HistoryPolicy.Local("", ""), HistoryPolicy.Local(null, null))))
    }

    @Test fun noTicketWithoutVisibleLifecycleAndSignedInConfig() {
        val guard = HistoryPolicy.Guard<Scope>()
        assertNull(guard.ticket())
        guard.update(null, true)
        assertNull(guard.ticket())
        guard.update(Scope(), false)
        assertNull(guard.ticket())
    }

    @Test fun everyConfigurationFieldAndSignOutRejectAnInFlightAnswer() {
        val original = Scope()
        val changed = listOf(
            original.copy(server = "https://other.example"), original.copy(token = "renewed"),
            original.copy(account = "other-account"), original.copy(account = null),
            original.copy(device = "other-install"), original.copy(name = "Other name"), null,
        )
        for (next in changed) {
            val guard = HistoryPolicy.Guard<Scope>()
            guard.update(original, true)
            val ticket = guard.ticket()!!
            assertTrue(guard.accepts(ticket, original))
            // Even before the preferences callback, compare the actual current configuration.
            assertFalse(guard.accepts(ticket, next))
            assertTrue(guard.update(next, true))
            assertFalse(guard.accepts(ticket, next))
            guard.update(original, true)
            assertFalse(guard.accepts(ticket, original))
        }
    }

    @Test fun pauseAndResumeCannotReviveAResponseOrCachedThreadButton() {
        val guard = HistoryPolicy.Guard<Scope>()
        val scope = Scope()
        guard.update(scope, true)
        val ticket = guard.ticket()!!
        assertFalse(guard.update(scope, true)) // Ordinary UI ticks do not invalidate valid history.
        assertTrue(guard.accepts(ticket, scope))
        guard.update(scope, false)
        assertFalse(guard.accepts(ticket, scope))
        guard.update(scope, true)
        assertFalse(guard.accepts(ticket, scope))
        assertTrue(guard.accepts(guard.ticket()!!, scope))
    }

    @Test fun rapidChangeAwayAndBackStillInvalidatesHistory() {
        val guard = HistoryPolicy.Guard<Scope>()
        val scope = Scope()
        guard.update(scope, true)
        val ticket = guard.ticket()!!
        guard.invalidate() // Preferences notifications may see only the final configuration.
        assertFalse(guard.accepts(ticket, scope))
        assertTrue(guard.accepts(guard.ticket()!!, scope))
    }
}
