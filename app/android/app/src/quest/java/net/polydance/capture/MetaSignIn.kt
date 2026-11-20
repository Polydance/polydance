package net.polydance.capture

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.meta.horizon.platform.ovr.Core
import com.meta.horizon.platform.ovr.requests.Entitlements
import com.meta.horizon.platform.ovr.requests.Request
import com.meta.horizon.platform.ovr.requests.Users
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Quest's [HeadsetSignIn]: the only source set that links Meta's Platform SDK (app/PLATFORMS.md). */
fun createSignIn(): HeadsetSignIn = MetaSignIn

/**
 * Local entitlement is checked once per process, even with a saved receiver token, without requiring
 * our server or an internet connection. Only that check gates recording; receiver sign-in may wait
 * for connectivity. Neither success path starts a recording. Every SDK call/registration and state
 * transition runs on main; HTTP runs on io. Deadlines ignore late callbacks (SDK 77 has no cancel API).
 */
object MetaSignIn : HeadsetSignIn {
    enum class Phase { IDLE, WORKING, SIGNED_IN, NOT_INVITED, FAILED }
    data class State(val phase: Phase, val message: String = "")
    private const val RETRY_MS = 60_000L
    private val gate = EntitlementGate()
    private val attempt = AuthAttempt()
    private val sdk = SdkInitialization()
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val waiters = mutableListOf<() -> Unit>()
    private var lastTry: Long? = null
    private var timeout: Runnable? = null
    @Volatile var state = State(Phase.IDLE)
        private set

    fun appId(context: Context): String? = context.getString(R.string.meta_app_id).takeIf { it.isNotBlank() }
    private fun server(context: Context): String = defaultServer(context)
    override fun mayRecord(): Boolean = gate.mayRecord(BuildConfig.DEBUG)
    override fun retryLater(context: Context) = MetaSignInWorker.enqueue(context)

    override fun deckText(context: Context): String = when {
        appId(context) == null -> "Not connected to a server. On the Mac: npm run app -- configure (see README)."
        state.phase == Phase.IDLE -> "Signing in with your Meta account…"
        else -> state.message
    }
    override fun inboxText(): String = when (state.phase) {
        Phase.WORKING -> "Signing in with your Meta account to load server history…"
        Phase.NOT_INVITED -> "This Meta account is not admitted to the test. Check your invitation or ask the team for access."
        Phase.FAILED -> "Cannot sign in to the server. Check your connection and Meta test invitation; sign-in will retry automatically."
        else -> "Sign in with your Meta account to see server history. Sign-in will retry automatically when connected."
    }
    override val expiredText = "Server sign-in expired. Signing in again with your Meta account…"
    override fun refusedText(): String = "Recording is unavailable until Horizon OS confirms entitlement. " + state.message
    override val consentName = "your Meta name"
    override fun signedInText(model: String) = "Signed in with your Meta account on this $model."
    override fun accountText(id: String) = "Signed-in Meta account ID (app-scoped): $id"
    override fun signedInAs(name: String) = "Signed in with Meta as $name."

    /** Called on process launch, from the deck, and by durable sign-in work. */
    override fun ensure(context: Context, completed: (() -> Unit)?) {
        val app = context.applicationContext
        main.post {
            completed?.let { waiters.add(it) }
            if (state.phase == Phase.WORKING) return@post
            if (!gate.needsAuthentication(UploadSettings.load(app) != null)) { complete(); return@post }
            val now = SystemClock.elapsedRealtime()
            if (lastTry?.let { now - it < RETRY_MS } == true) { complete(); return@post }
            lastTry = now
            state = State(Phase.WORKING, if (gate.established) "Signing in with your Meta account…" else "Checking this headset's Meta entitlement…")
            val id = attempt.begin(now, 10_000)
            armTimeout(id, 10_000)
            guarded(id) {
                val appId = appId(app) ?: error("Meta app id is missing")
                when (sdk.phase) {
                    SdkInitialization.Phase.READY -> checkEntitlement(app, id)
                    SdkInitialization.Phase.FAILED -> fail(Phase.FAILED, "Horizon OS sign-in could not initialise. Close Polydance completely and reopen it; if needed restart the headset.")
                    SdkInitialization.Phase.WAITING -> fail(Phase.FAILED, "Horizon OS sign-in is still initialising. If this persists, close the app completely and reopen it.")
                    SdkInitialization.Phase.NEW -> {
                        sdk.begin()
                        try {
                            val request = Core.asyncInitialize(appId, app) ?: error("SDK initialization unavailable")
                            // Init's late answer updates SDK state even if this auth attempt timed out.
                            // It never establishes entitlement itself or starts a recording.
                            request.onSuccess { main.post {
                                sdk.completed(true)
                                if (attempt.accepts(id, SystemClock.elapsedRealtime())) guarded(id) { checkEntitlement(app, id) }
                                else { lastTry = null; ensure(app) }
                            } }.onError { main.post {
                                sdk.completed(false)
                                if (attempt.accepts(id, SystemClock.elapsedRealtime()))
                                    fail(Phase.FAILED, "Horizon OS sign-in could not initialise. Close the app completely and reopen it; if needed restart the headset.")
                            } }
                        } catch (e: Exception) { sdk.completed(false); throw e }
                        catch (e: LinkageError) { sdk.completed(false); throw e }
                    }
                }
            }
        }
    }

    /** Compare the token actually refused, under the same lock as save, before forgetting anything. */
    override fun rejected(context: Context, rejectedToken: String) {
        if (!UploadSettings.forgetToken(context, rejectedToken)) return
        main.post {
            if (state.phase != Phase.WORKING) {
                lastTry = null
                state = State(Phase.IDLE)
            }
            Timeline.log("meta", "token_rejected")
            ensure(context)
        }
        MetaSignInWorker.enqueue(context)
    }

    private fun checkEntitlement(app: Context, id: Long) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (gate.established) { entitled(app, id); return }
        @Suppress("UNCHECKED_CAST")
        val request = Entitlements.getIsViewerEntitled() as? Request<Any?> ?: error("SDK entitlement unavailable")
        request.onSuccess { onMain(id) { gate.checked(true); entitled(app, id) } }
            .onError { onMain(id) {
                gate.checked(false)
                fail(Phase.NOT_INVITED, "Horizon OS could not confirm this account's entitlement. Recording is unavailable. Check the Meta test invitation and try again.")
            } }
    }

    private fun entitled(app: Context, id: Long) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (UploadSettings.load(app) != null) {
            state = State(Phase.SIGNED_IN)
            complete()
            return
        }
        // Local entitlement remains valid if obtaining a proof or contacting our server fails offline.
        state = State(Phase.WORKING, "This headset is entitled. Signing in for uploads…")
        extend(id, 20_000)
        Users.getLoggedInUser().onSuccess { user -> onMain(id) {
            val name = user.displayName?.takeIf { it.isNotBlank() } ?: user.oculusID.orEmpty()
            Users.getUserProof().onSuccess { proof -> onMain(id) {
                extend(id, 50_000)
                io.execute { post(app, id, user.id.toString(), proof.value, name) }
            } }.onError { onMain(id) { fail(Phase.FAILED, "Horizon OS would not vouch for this account. Uploads will retry.") } }
        } }.onError { onMain(id) { fail(Phase.FAILED, "Horizon OS did not say who is signed in. Uploads will retry.") } }
    }

    private fun post(app: Context, id: Long, userId: String, nonce: String, name: String) {
        try {
            val body = JSONObject().put("userId", userId).put("nonce", nonce)
                .put("deviceId", UploadSettings.deviceId(app)).put("label", Build.MODEL.take(40))
            if (name.isNotBlank()) body.put("name", name.take(60))
            val (code, json) = ReceiverClient.signIn(server(app), body)
            onMain(id) {
                when {
                    code == 201 -> {
                        // Do not overwrite a configuration saved while this request was in flight.
                        val error = UploadSettings.saveIfMissing(app, server(app), json.optString("token"), userId, json.optString("name").ifEmpty { name })
                        if (error != null) { fail(Phase.FAILED, "The server's answer could not be used."); return@onMain }
                        state = State(Phase.SIGNED_IN, "Signed in for uploads.")
                        complete()
                        Uploads.resumeWaiting(app)
                    }
                    code == 403 && json.optString("reason") == "not_invited" -> fail(Phase.NOT_INVITED, "The receiver has not admitted this Meta account to the test. Ask the team for an invitation. Uploads are waiting.")
                    code == 403 && json.optString("reason") == "full" -> fail(Phase.FAILED, "The test is full for now. Ask the team for a place. Uploads are waiting.")
                    else -> fail(Phase.FAILED, "The server could not sign you in (HTTP $code). Uploads will retry.")
                }
            }
        } catch (_: Exception) {
            onMain(id) { fail(Phase.FAILED, "Could not sign in to the server; uploads will retry.") }
        }
    }

    private fun onMain(id: Long, block: () -> Unit) { main.post { guarded(id, block) } }
    private fun guarded(id: Long, block: () -> Unit) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (!attempt.accepts(id, SystemClock.elapsedRealtime())) return
        try { block() } catch (_: Exception) {
            fail(Phase.FAILED, "Horizon OS did not answer sign-in. Trying again shortly.")
        } catch (_: LinkageError) {
            fail(Phase.FAILED, "The Meta SDK is unavailable on this device.")
        }
    }
    private fun extend(id: Long, millis: Long) {
        attempt.extend(id, SystemClock.elapsedRealtime(), millis)
        armTimeout(id, millis)
    }
    private fun armTimeout(id: Long, millis: Long) {
        timeout?.let { main.removeCallbacks(it) }
        timeout = Runnable {
            // Removed on completion/extension; no unbounded WORKING state if the SDK never answers.
            if (!attempt.accepts(id, SystemClock.elapsedRealtime()))
                fail(Phase.FAILED, if (gate.established) "Sign-in timed out. Local recording is available; uploads will retry." else "Entitlement check timed out. Recording is unavailable; trying again shortly.")
        }.also { main.postDelayed(it, millis) }
    }
    private fun fail(phase: Phase, message: String) {
        state = State(phase, message)
        Log.w("PolydanceCapture", "Meta sign-in: $phase")
        Timeline.log("meta", "sign_in_failed", "phase" to phase.name)
        complete()
    }
    private fun complete() {
        attempt.finish()
        timeout?.let { main.removeCallbacks(it) }; timeout = null
        val callbacks = waiters.toList(); waiters.clear()
        callbacks.forEach { it() }
    }
}

/** The SDK flow is asynchronous, but its owner remains alive until completion or a bounded timeout. */
class MetaSignInWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    companion object {
        fun enqueue(context: Context) {
            val work = OneTimeWorkRequestBuilder<MetaSignInWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 60, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniqueWork("meta-sign-in", ExistingWorkPolicy.KEEP, work)
        }
    }
    override fun doWork(): Result {
        val done = CountDownLatch(1)
        MetaSignIn.ensure(applicationContext) { done.countDown() }
        return try {
            if (done.await(90, TimeUnit.SECONDS) && UploadSettings.load(applicationContext) != null) Result.success()
            else Result.retry()
        } catch (_: InterruptedException) { Result.retry() }
    }
}
