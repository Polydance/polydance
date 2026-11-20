package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test

class RecordingRequestStateTest {
    private fun request(mic: Boolean = true, appAudio: Boolean = true) = RecordingRequest(
        width = 1280, height = 720, bitrate = 5_000_000,
        mic = mic, appAudio = appAudio, maxMinutes = 12,
        destination = "{\"key\":\"CAP-42\"}",
        launchJson = "{\"steps\":[{\"url\":\"https://example.com\"}]}",
        fromMessage = 7, fromOption = 2, openInbox = true, platformPermission = true,
    )

    @Test fun doubleStartRejectsBeforeAnyIntentMutationInEveryPendingPhase() {
        val state = RecordingRequestState()
        val first = state.accept(false) { request() }
        fun rejectedWithoutMutation() {
            var mutations = 0
            // The three entry points all put their settings/thread/launch changes inside accept.
            repeat(3) {
                assertNull(state.accept(false) { mutations++; request(false, false) })
            }
            assertEquals(0, mutations)
            assertEquals(first, state.accepted)
        }
        rejectedWithoutMutation()
        assertTrue(state.requestConsent())
        rejectedWithoutMutation()
        assertNotNull(state.consentGranted(100))
        rejectedWithoutMutation()
    }

    @Test fun alreadyRecordingRejectsWithoutExecutingPreparation() {
        val state = RecordingRequestState()
        assertFalse(state.canStart(true))
        assertNull(state.accept(true) { fail("Recording must reject before changing settings or routing"); request() })
        assertNull(state.accepted)
        assertEquals(RecordingRequestState.Phase.IDLE, state.phase)
    }

    @Test fun snapshotsBothAudioSwitchesOnAndOffAtAcceptanceNotAtConsent() {
        for (mic in listOf(false, true)) for (app in listOf(false, true)) {
            val state = RecordingRequestState()
            var settings = request(mic, app)
            val accepted = state.accept(false) { settings.copy() }!!
            // Represents preferences/UI and navigation changing while the consent screen is open.
            settings = settings.copy(
                mic = !mic, appAudio = !app, width = 1920, height = 1080, bitrate = 8_000_000,
                maxMinutes = 180, destination = "{\"key\":\"OTHER-1\"}", launchJson = null,
                fromMessage = null, fromOption = null, openInbox = false, platformPermission = false,
            )
            assertNotEquals(accepted, settings)
            assertTrue(state.requestConsent())
            val granted = state.consentGranted(500)!!
            assertEquals(request(mic, app), granted)
            assertEquals(mic, granted.mic)
            assertEquals(app, granted.appAudio)
        }
    }

    @Test fun unresolvedPermissionsAndConsentNeverExpireEvenAfterSixtySeconds() {
        val state = RecordingRequestState()
        state.accept(false) { request() }
        assertFalse(state.observe(false, 600_000))
        assertFalse(state.canStart(false))
        state.requestConsent()
        assertFalse(state.observe(false, 1_200_000))
        assertFalse(state.canStart(false))
        assertFalse(state.requestConsent())
        state.consentGranted(1_200_000)
        assertNull(state.consentGranted(1_200_001))
        assertFalse(state.observe(false, 1_259_999))
        assertFalse(state.canStart(false))
        assertTrue(state.observe(false, 1_260_000))
        assertTrue(state.canStart(false))
    }

    @Test fun deniedAudioOnlyChangesAudioInTheAcceptedRequest() {
        val state = RecordingRequestState()
        state.accept(false) { request() }
        state.audioPermissionDenied()
        state.requestConsent()
        assertEquals(request(false, false), state.consentGranted(10))
    }

    @Test fun cancellationAndFailuresClearAllPendingValuesAndAllowRetry() {
        for (phase in listOf(RecordingRequestState.Phase.PERMISSIONS, RecordingRequestState.Phase.CONSENT, RecordingRequestState.Phase.WAITING_SERVICE)) {
            val state = RecordingRequestState()
            state.accept(false) { request() }
            if (phase != RecordingRequestState.Phase.PERMISSIONS) state.requestConsent()
            if (phase == RecordingRequestState.Phase.WAITING_SERVICE) state.consentGranted(10)
            state.reset() // Permission/consent launch failure, decline, or service-start exception.
            assertTrue(state.canStart(false))
            assertNull(state.accepted)
            assertNull(state.consentGranted(20))
            val retry = request(false, true).copy(launchJson = null, fromMessage = null, fromOption = null, openInbox = false)
            assertEquals(retry, state.accept(false) { retry })
        }
    }

    @Test fun rejectedPreparationAndExceptionDoNotLeaveGateLocked() {
        val state = RecordingRequestState()
        assertNull(state.accept(false) { null }) // Full storage or invalid thread launch.
        assertTrue(state.canStart(false))
        try {
            state.accept(false) { throw IllegalArgumentException("invalid request") }
            fail("Exception expected")
        } catch (_: IllegalArgumentException) { }
        assertTrue(state.canStart(false))
        assertNull(state.accepted)
    }

    @Test fun observedServiceStartClearsPendingButRecordingStillBlocksNewStart() {
        val state = RecordingRequestState()
        state.accept(false) { request() }
        state.requestConsent()
        state.consentGranted(10)
        assertFalse(state.observe(true, 20))
        assertFalse(state.starting)
        assertNull(state.accepted)
        assertFalse(state.canStart(true))
        assertTrue(state.canStart(false))
    }

    @Test fun plainReplyCarriesExplicitKeyAndNeverLaunchesAnything() {
        var inboxKey: String? = "CAP-42"
        val reply = ThreadReplyRoute(inboxKey!!)
        inboxKey = null // Same-task deck relaunch destroys the inbox and clears Threads.openKey.
        assertNull(inboxKey)
        assertEquals("CAP-42", reply.threadKey)
        assertFalse(reply.open)
        val state = RecordingRequestState()
        val accepted = state.accept(false) {
            request().copy(destination = "{\"key\":\"${reply.threadKey}\"}", launchJson = null, fromMessage = null, fromOption = null)
        }!!
        assertEquals("{\"key\":\"CAP-42\"}", accepted.destination)
        assertNull(accepted.launchJson)
    }

    @Test fun aTakeWithoutThePictureSkipsConsentAndStartsOnce() {
        for (mic in listOf(true, false)) {
            val state = RecordingRequestState()
            val accepted = state.accept(false) { request(mic = mic).copy(screen = false, logs = true) }!!
            assertEquals(if (mic) TakeKind.SOUND else TakeKind.LOGS, accepted.kind)
            assertEquals(accepted, state.startWithoutPicture(100))
            assertEquals(RecordingRequestState.Phase.WAITING_SERVICE, state.phase)
            // No consent dialog to wait for, and no second start from a late callback.
            assertFalse(state.requestConsent())
            assertNull(state.startWithoutPicture(101))
            assertNull(state.consentGranted(102))
            assertFalse(state.observe(true, 103))
            assertTrue(state.canStart(false))
        }
    }

    @Test fun thePictureStillWaitsForConsentAndCannotStartWithoutIt() {
        val state = RecordingRequestState()
        state.accept(false) { request().copy(logs = true) }
        assertNull(state.startWithoutPicture(10))
        assertEquals(RecordingRequestState.Phase.PERMISSIONS, state.phase)
        assertTrue(state.requestConsent())
        assertEquals(request().copy(logs = true), state.consentGranted(20))
    }

    @Test fun aRefusedMicLeavesLogsAloneOrNothingToRecord() {
        val logs = RecordingRequestState()
        logs.accept(false) { request().copy(screen = false, logs = true) }
        logs.audioPermissionDenied()
        assertEquals(TakeKind.LOGS, logs.startWithoutPicture(10)?.kind)
        val nothing = RecordingRequestState()
        nothing.accept(false) { request().copy(screen = false, logs = false) }
        nothing.audioPermissionDenied()
        assertEquals(TakeKind.NONE, nothing.accepted?.kind)
        assertNull(nothing.startWithoutPicture(10))
        // The gate opens again: there was nothing to start.
        assertEquals(RecordingRequestState.Phase.IDLE, nothing.phase)
        assertTrue(nothing.canStart(false))
    }

    @Test(expected = IllegalArgumentException::class)
    fun plainReplyCannotFallBackToANewThreadWhenKeyIsBlank() {
        ThreadReplyRoute(" ")
    }
}
