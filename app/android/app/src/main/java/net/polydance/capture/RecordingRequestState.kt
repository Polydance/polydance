package net.polydance.capture

/** Values accepted at Record, not live controls/preferences read after the system dialogs return.
 * JSON is kept as a string so a caller cannot mutate the accepted destination or launch in place.
 */
internal data class RecordingRequest(
    val width: Int,
    val height: Int,
    val bitrate: Int,
    val mic: Boolean,
    val appAudio: Boolean,
    val maxMinutes: Int,
    val destination: String?,
    val launchJson: String? = null,
    val fromMessage: Int? = null,
    val fromOption: Int? = null,
    val openInbox: Boolean = false,
    val platformPermission: Boolean = false,
    /** Addresses to add to the new thread this recording opens (Invites); only a new thread takes them. */
    val invite: List<String>? = null,
    /** The picture: off, there is no screen-capture prompt and no app sound (Takes, docs/LOGS.md). */
    val screen: Boolean = true,
    /** Keep the headset's logs, read when the take stops (DeviceLogs). */
    val logs: Boolean = false,
) {
    val switches: TakeSwitches get() = TakeSwitches(screen, mic, appAudio, logs)
    val kind: TakeKind get() = switches.kind
}

/** Main-thread request gate, independent of Android so the dialog/timeout rules are testable. */
internal class RecordingRequestState {
    enum class Phase { IDLE, PERMISSIONS, CONSENT, WAITING_SERVICE }

    var phase = Phase.IDLE
        private set
    var accepted: RecordingRequest? = null
        private set
    private var serviceRequestedAt = 0L
    val starting: Boolean get() = phase != Phase.IDLE

    fun canStart(recording: Boolean): Boolean = !recording && !starting

    /** Reject before [prepare]: even intent overrides and destination changes must stay untouched. */
    fun accept(recording: Boolean, prepare: () -> RecordingRequest?): RecordingRequest? {
        if (!canStart(recording)) return null
        phase = Phase.PERMISSIONS
        try {
            accepted = prepare()
            if (accepted == null) reset()
            return accepted
        } catch (e: RuntimeException) {
            reset()
            throw e
        }
    }

    fun audioPermissionDenied() {
        if (phase == Phase.PERMISSIONS) accepted = accepted?.copy(mic = false, appAudio = false)
    }

    fun requestConsent(): Boolean {
        if (phase != Phase.PERMISSIONS) return false
        phase = Phase.CONSENT
        return true
    }

    /**
     * A take without the picture needs no screen-capture consent: from the permissions straight to starting it, once.
     * Null when the request is not at that point, or when it has nothing left to record (the mic was refused and Logs
     * is off), which also resets the gate.
     */
    fun startWithoutPicture(now: Long): RecordingRequest? {
        val request = accepted?.takeIf { phase == Phase.PERMISSIONS && !it.screen } ?: return null
        if (request.kind == TakeKind.NONE) { reset(); return null }
        phase = Phase.WAITING_SERVICE
        serviceRequestedAt = now
        return request
    }

    /** Consumes a consent result once; duplicate or obsolete results cannot start another service. */
    fun consentGranted(now: Long): RecordingRequest? {
        if (phase != Phase.CONSENT) return null
        phase = Phase.WAITING_SERVICE
        serviceRequestedAt = now
        return accepted
    }

    /** Only a service start can time out. An unresolved permission/consent dialog keeps the gate shut. */
    fun observe(recording: Boolean, now: Long): Boolean {
        if (phase != Phase.WAITING_SERVICE) return false
        val timedOut = !recording && now - serviceRequestedAt >= 60_000
        if (recording || timedOut) reset()
        return timedOut
    }

    fun reset() {
        phase = Phase.IDLE
        accepted = null
        serviceRequestedAt = 0L
    }
}

/** Plain replies carry their destination through navigation, never relying on a surviving inbox. */
internal data class ThreadReplyRoute(val threadKey: String) {
    init { require(threadKey.isNotBlank()) }
    val open: Boolean = false
}
