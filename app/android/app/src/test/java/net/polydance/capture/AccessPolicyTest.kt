package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

class AccessPolicyTest {
    @Test fun queuedOrFailedSdkInitializationNeverCountsAsReady() {
        val sdk = SdkInitialization()
        assertTrue(sdk.begin())
        assertEquals(SdkInitialization.Phase.WAITING, sdk.phase)
        assertFalse(sdk.begin()) // Core's queued flag must not bypass the callback.
        sdk.completed(false)
        assertEquals(SdkInitialization.Phase.FAILED, sdk.phase)
        assertFalse(sdk.begin()) // A restart, not an unsupported in-process reset, is required.
        assertEquals(SdkInitialization.Phase.NEW, SdkInitialization().phase)
    }

    @Test fun lateSdkSuccessMayPrepareNextAttemptButDoesNotGrantEntitlement() {
        val sdk = SdkInitialization()
        val auth = AuthAttempt()
        val gate = EntitlementGate()
        sdk.begin()
        val id = auth.begin(100, 10)
        assertFalse(auth.accepts(id, 111))
        auth.finish()
        sdk.completed(true)
        assertEquals(SdkInitialization.Phase.READY, sdk.phase)
        assertFalse(gate.mayRecord(debug = false))
        assertTrue(gate.needsAuthentication(hasToken = true))
    }

    @Test fun releaseRequiresAProcessLocalCheckEvenWithSavedCredentials() {
        val process = EntitlementGate()
        assertTrue(process.needsAuthentication(hasToken = true))
        assertFalse(process.mayRecord(debug = false))
        process.checked(true)
        assertTrue(process.mayRecord(debug = false))
        assertFalse(process.needsAuthentication(hasToken = true))
        assertTrue(process.needsAuthentication(hasToken = false))
        // Recreating the process never restores entitlement from upload preferences.
        assertFalse(EntitlementGate().mayRecord(debug = false))
    }

    @Test fun denialFailsClosedButDebugCanStillRecord() {
        val gate = EntitlementGate()
        gate.checked(false)
        assertFalse(gate.mayRecord(debug = false))
        assertTrue(gate.mayRecord(debug = true))
    }

    @Test fun localCheckDoesNotRequireAnUploadToken() {
        val gate = EntitlementGate()
        gate.checked(true)
        assertTrue(TransferPolicy.awaitingAuth(hasToken = false))
        assertTrue(gate.mayRecord(debug = false))
    }

    @Test fun lateCallbackCannotSucceedAfterTimeoutOrReplaceNewAttempt() {
        val attempts = AuthAttempt()
        val old = attempts.begin(100, 10)
        assertTrue(attempts.accepts(old, 109))
        assertFalse(attempts.accepts(old, 110))
        val next = attempts.begin(120, 10)
        assertFalse(attempts.accepts(old, 121))
        assertTrue(attempts.accepts(next, 121))
        attempts.finish()
        assertFalse(attempts.accepts(next, 122))
    }

    @Test fun receiverStageMayExtendDeadlineButExpiredAnswerCannot() {
        val attempts = AuthAttempt()
        val id = attempts.begin(100, 10)
        attempts.extend(id, 105, 50)
        assertTrue(attempts.accepts(id, 154))
        assertFalse(attempts.accepts(id, 155))
        attempts.extend(id, 156, 50)
        assertFalse(attempts.accepts(id, 157))
    }

    @Test fun staleRejectionLeavesRenewedTokenIntact() {
        val guard = TokenGuard()
        var stored: String? = "old"
        guard.access { stored = "new" }
        assertFalse(guard.reject("old", { stored }) { stored = null })
        assertEquals("new", stored)
        assertTrue(guard.reject("new", { stored }) { stored = null })
        assertNull(stored)
        assertFalse(guard.reject("new", { stored }) { fail("already cleared") })
    }

    @Test fun tokenSaveCannotInterleaveWithCompareAndClear() {
        val guard = TokenGuard()
        var stored: String? = "old"
        val compared = CountDownLatch(1)
        val allowClear = CountDownLatch(1)
        val saving = CountDownLatch(1)
        val saved = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val reject = thread {
            try {
                guard.reject("old", { stored }) {
                    compared.countDown()
                    check(allowClear.await(5, TimeUnit.SECONDS))
                    stored = null
                }
            } catch (e: Throwable) { failure.set(e) }
        }
        assertTrue(compared.await(5, TimeUnit.SECONDS))
        val save = thread {
            saving.countDown()
            guard.access { stored = "new" }
            saved.countDown()
        }
        try {
            assertTrue(saving.await(5, TimeUnit.SECONDS))
            assertFalse("save must wait for the atomic clear", saved.await(100, TimeUnit.MILLISECONDS))
        } finally {
            allowClear.countDown()
            reject.join(5000); save.join(5000)
        }
        assertNull(failure.get())
        assertTrue(saved.await(1, TimeUnit.SECONDS))
        assertEquals("new", guard.access { stored })
    }

    @Test fun missingAndRejectedCredentialsAreRetryable() {
        assertTrue(TransferPolicy.awaitingAuth(false))
        assertTrue(TransferPolicy.awaitingAuth(true, 401))
        assertFalse(TransferPolicy.awaitingAuth(true, 400))
        assertFalse(TransferPolicy.awaitingAuth(true, 403))
        assertFalse(TransferPolicy.awaitingAuth(true, 201))
    }

    @Test fun deletionRetriesAuthPermissionBusyAndTransientFailures() {
        for (code in listOf(401, 403, 409, 429, 500, 503)) assertTrue("$code", TransferPolicy.retryDeletion(code))
        // 404 may mean a different grant, not a deleted file. Keep its pending marker for attention.
        assertFalse(TransferPolicy.retryDeletion(404))
        assertFalse(TransferPolicy.retryDeletion(400))
    }

    @Test fun uploadUsesTheNoticeAcceptedBeforeThisRecording() {
        val captured = ConsentEvidence("capture-hosted-3", 100)
        assertEquals("capture-hosted-3", captured.uploadVersion(100))
        assertEquals("capture-hosted-3", captured.uploadVersion(200))
        val laterAcceptance = ConsentEvidence("capture-hosted-3", 300)
        assertNull(laterAcceptance.uploadVersion(200))
        // Accepting a later notice does not rewrite existing evidence.
        val laterVersion = ConsentEvidence("capture-hosted-4", 300)
        assertNull(laterVersion.uploadVersion(400))
        assertEquals("capture-hosted-3", captured.uploadVersion(200))
    }

    @Test fun recordingsUnderEitherEarlierNoticeStillUploadButANewOneAsksAgain() {
        // capture-hosted-2 (2026-11-11) and -1 did not mention logs (capture-hosted-3, 2026-11-16).
        for (version in listOf("capture-hosted-2", "capture-hosted-1")) {
            val earlier = ConsentEvidence(version, 100)
            assertEquals(version, earlier.uploadVersion(200))
            assertFalse(earlier.current(200))
        }
        assertEquals("capture-hosted-3", ConsentEvidence.VERSION)
        assertEquals(listOf("capture-hosted-2", "capture-hosted-1"), ConsentEvidence.EARLIER.toList())
        assertTrue(ConsentEvidence("capture-hosted-3", 100).current(200))
        assertFalse(ConsentEvidence("capture-hosted-3", 300).current(200))
        assertFalse(ConsentEvidence("capture-hosted-3", 0).current(200))
        assertFalse(ConsentEvidence("", 100).current(200))
    }

    @Test fun missingUnknownOrUnversionedEvidenceCannotAuthorizeHostedUpload() {
        assertNull(ConsentEvidence("", 100).uploadVersion(200))
        assertNull(ConsentEvidence("capture-hosted-0", 100).uploadVersion(200))
        assertNull(ConsentEvidence("capture-hosted-4", 100).uploadVersion(200))
        assertNull(ConsentEvidence("capture-hosted-3", 0).uploadVersion(200))
        assertNull(ConsentEvidence("capture-hosted-3", -1).uploadVersion(200))
        assertNull(ConsentEvidence("capture-hosted-3", 100).uploadVersion(0))
        assertNull(ConsentEvidence("capture-hosted-2", 0).uploadVersion(200))
        assertNull(ConsentEvidence("capture-hosted-1", 0).uploadVersion(200))
    }
}
