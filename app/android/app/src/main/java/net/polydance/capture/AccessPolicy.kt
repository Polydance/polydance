package net.polydance.capture

/** Process-local only: a saved receiver token is not evidence of a Meta entitlement. */
internal class EntitlementGate {
    @Volatile var established = false
        private set
    fun checked(entitled: Boolean) { established = entitled }
    fun mayRecord(debug: Boolean) = debug || established
    fun needsAuthentication(hasToken: Boolean) = !established || !hasToken
}

/** A timed-out SDK/HTTP answer must not finish a newer attempt. Used only on the main thread. */
internal class AuthAttempt {
    private var generation = 0L
    private var deadline = 0L
    private var running = false
    fun begin(now: Long, timeoutMs: Long): Long {
        running = true
        deadline = now + timeoutMs
        return ++generation
    }
    fun accepts(id: Long, now: Long) = running && id == generation && now < deadline
    fun extend(id: Long, now: Long, timeoutMs: Long) {
        if (accepts(id, now)) deadline = now + timeoutMs
    }
    fun finish() { running = false }
}

/** Save and compare-and-clear use the same monitor, including the backing store operations. */
internal class TokenGuard {
    @Synchronized fun <T> access(block: () -> T): T = block()
    @Synchronized fun reject(rejected: String, stored: () -> String?, clear: () -> Unit): Boolean {
        if (stored() != rejected) return false
        clear()
        return true
    }
}

internal object TransferPolicy {
    fun awaitingAuth(hasToken: Boolean, status: Int? = null) = !hasToken || status == 401
    // Never discard a deletion request just because credentials expired or permission was refused.
    fun retryDeletion(status: Int) = status == 401 || status == 403 || status == 409 || status == 429 || status >= 500
}

/** Evidence belongs to the recording, not to whatever notice is accepted at upload time. */
internal data class ConsentEvidence(val version: String, val acceptedAt: Long) {
    companion object {
        /** The notice a new recording needs; CONSENT_VERSION in src/server/privacy.ts. */
        const val VERSION = "capture-hosted-3"
        /**
         * Earlier notices, newest first, still good for recordings made under them so a queue survives an update; the
         * receiver's ACCEPTED_CONSENT_VERSIONS after the current one. capture-hosted-2 (2026-11-11) did not mention logs.
         */
        val EARLIER = setOf("capture-hosted-2", "capture-hosted-1")
    }
    /** Only the current notice lets a new recording start, so a new version asks again. */
    fun current(now: Long): Boolean = version == VERSION && acceptedAt > 0 && acceptedAt <= now
    fun uploadVersion(recordedAt: Long): String? = version.takeIf {
        (it == VERSION || it in EARLIER) && acceptedAt > 0 && acceptedAt <= recordedAt
    }
}

/** Core.isInitialized means queued, not successful; retain the actual callback outcome independently. */
internal class SdkInitialization {
    enum class Phase { NEW, WAITING, READY, FAILED }
    var phase = Phase.NEW
        private set
    fun begin(): Boolean {
        if (phase != Phase.NEW) return false
        phase = Phase.WAITING
        return true
    }
    fun completed(success: Boolean) { if (phase == Phase.WAITING) phase = if (success) Phase.READY else Phase.FAILED }
}
