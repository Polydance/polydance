package net.polydance.capture

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.Executors

/** Android XR's [HeadsetSignIn]: Google accounts through Credential Manager (app/PLATFORMS.md, private/docs/PLAY.md). */
fun createSignIn(): HeadsetSignIn = GoogleSignIn

/**
 * The receiver's web client id is compiled in (google_server_client_id); Credential Manager returns an ID
 * token naming it, with a nonce made here for this sign-in, and the receiver (src/server/google.ts) checks
 * Google's signature and admits invited addresses only. There is no store entitlement to wait for, so
 * recording is allowed at once; the system's capture consent still guards every recording, and recordings
 * wait on the headset until a token arrives. A debug build can still take a server and token over adb.
 * Every state change and callback runs on main; HTTP runs on io.
 */
object GoogleSignIn : HeadsetSignIn {
    private enum class Phase { IDLE, WORKING, SIGNED_IN, NOT_INVITED, FAILED }
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val random = SecureRandom()
    @Volatile private var phase = Phase.IDLE
    @Volatile private var message = ""
    /** One quiet try per process: a returning account signs in without a chooser, a new one waits for a press. */
    private var triedQuietly = false

    private fun clientId(context: Context): String? = context.getString(R.string.google_server_client_id).takeIf { it.isNotBlank() }
    private fun server(context: Context): String = defaultServer(context)

    override fun mayRecord(): Boolean = true
    override fun ensure(context: Context, completed: (() -> Unit)?) { completed?.invoke() }
    override fun retryLater(context: Context) = Unit
    override val interactive: Boolean get() = true

    override fun rejected(context: Context, rejectedToken: String) {
        if (!UploadSettings.forgetToken(context, rejectedToken)) return
        main.post { phase = Phase.IDLE; message = ""; triedQuietly = false }
        Timeline.log("sign_in", "token_rejected")
    }

    override fun begin(activity: Activity, quiet: Boolean) {
        check(Looper.myLooper() == Looper.getMainLooper())
        val app = activity.applicationContext
        val clientId = clientId(app) ?: return
        if (UploadSettings.load(app) != null || phase == Phase.WORKING) return
        if (quiet) { if (triedQuietly) return; triedQuietly = true }
        val nonce = ByteArray(24).also(random::nextBytes).let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP) }
        val option = GetGoogleIdOption.Builder().setServerClientId(clientId).setNonce(nonce)
            .setFilterByAuthorizedAccounts(quiet).setAutoSelectEnabled(quiet).build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        phase = Phase.WORKING; message = "Signing in with Google…"
        Timeline.log("sign_in", "google_started", "quiet" to quiet)
        try {
            CredentialManager.create(activity).getCredentialAsync(activity, request, null, activity.mainExecutor,
                object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                    override fun onResult(result: GetCredentialResponse) {
                        val credential = result.credential
                        if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                            fail(Phase.FAILED, "Google did not return an account. Press here to try again."); return
                        }
                        val id = runCatching { GoogleIdTokenCredential.createFrom(credential.data) }.getOrNull()
                            ?: run { fail(Phase.FAILED, "Google's answer could not be read. Press here to try again."); return }
                        message = "Signing in to the server…"
                        io.execute { post(app, id.idToken, nonce) }
                    }
                    override fun onError(e: GetCredentialException) {
                        when {
                            // Quiet and nobody chosen before, or the person closed the chooser: wait for a press.
                            quiet && e is NoCredentialException -> { phase = Phase.IDLE; message = "" }
                            e is GetCredentialCancellationException -> { phase = Phase.IDLE; message = "" }
                            e is NoCredentialException -> fail(Phase.FAILED, "No Google account is on this headset. Add one in the system settings, then press here.")
                            else -> fail(Phase.FAILED, "Google sign-in did not finish (${e.type}). Press here to try again.")
                        }
                    }
                })
        } catch (e: RuntimeException) {
            // Without Google Play services there is no Credential Manager provider; say so rather than crash.
            fail(Phase.FAILED, "Google sign-in is unavailable on this headset: ${e.javaClass.simpleName}.")
        }
    }

    private fun post(app: Context, idToken: String, nonce: String) {
        try {
            val body = JSONObject().put("idToken", idToken).put("nonce", nonce)
                .put("deviceId", UploadSettings.deviceId(app)).put("label", Build.MODEL.take(40))
            val (code, json) = ReceiverClient.signIn(server(app), body, "/v1/testers/google")
            main.post {
                when {
                    code == 201 -> {
                        // Do not overwrite a configuration saved over adb while this request was in flight.
                        val error = UploadSettings.saveIfMissing(app, server(app), json.optString("token"), json.optString("grantId"), json.optString("name"))
                        if (error != null) { fail(Phase.FAILED, "The server's answer could not be used."); return@post }
                        phase = Phase.SIGNED_IN; message = "Signed in for uploads."
                        Timeline.log("sign_in", "google_signed_in")
                        Uploads.resumeWaiting(app)
                    }
                    code == 403 && json.optString("reason") == "not_invited" -> fail(Phase.NOT_INVITED, "This Google account is not invited to the test. Ask the team to invite its address, then press here.")
                    code == 403 && json.optString("reason") == "full" -> fail(Phase.FAILED, "The test is full for now. Ask the team for a place.")
                    code == 403 && json.optString("reason") == "blocked" -> fail(Phase.NOT_INVITED, "This Google account is blocked on this server.")
                    else -> fail(Phase.FAILED, "The server could not sign you in (HTTP $code). Press here to try again.")
                }
            }
        } catch (_: Exception) {
            main.post { fail(Phase.FAILED, "Could not reach the server to sign in. Press here to try again.") }
        }
    }

    private fun fail(next: Phase, text: String) {
        phase = next; message = text
        Log.w("PolydanceCapture", "Google sign-in: $next")
        Timeline.log("sign_in", "google_failed", "phase" to next.name)
    }

    override fun deckText(context: Context): String = when {
        clientId(context) == null && BuildConfig.DEBUG -> "Not connected to a server. On the Mac: npm run app -- configure --platform android-xr (app/PLATFORMS.md). Recordings stay on this headset until then."
        clientId(context) == null -> "This build cannot sign in yet, so recordings stay on this headset."
        phase == Phase.IDLE -> "Sign in with Google to send recordings and see your threads. Press here."
        else -> message
    }
    override fun inboxText(): String = when (phase) {
        Phase.WORKING -> "Signing in with Google to load your threads…"
        Phase.IDLE -> "Sign in with Google on the deck to see your threads and send recordings."
        else -> message
    }
    override val expiredText = "Server sign-in expired. Sign in with Google again on the deck."
    override fun refusedText(): String = ""
    override val consentName = "your Google account name"
    override fun signedInText(model: String) = "Signed in with Google on this $model."
    override fun accountText(id: String) = "Signed in with Google ($id)."
    override fun signedInAs(name: String) = "Signed in with Google as $name."
}
