package net.polydance.capture

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/**
 * The notice a person accepts before their first recording (private/docs/STORE.md): what is recorded, where it goes
 * and how to delete it, with the full text at the receiver's /privacy. Nothing is captured before it.
 * Acceptance is remembered with its version and every upload carries that version as `consent`, which the
 * receiver requires from testers; a new version asks again. The shape is copied from Polydance's
 * recorded-session consent (polydance2 docs/RECORDING.md): disclose first, record only after Agree.
 */
object Consent {
    /**
     * Matches CONSENT_VERSION in src/server/privacy.ts; change both, and the text, together, and keep the old
     * version in both lists of earlier notices (ConsentEvidence.EARLIER, ACCEPTED_CONSENT_VERSIONS). capture-hosted-3
     * (2026-11-16) added what Logs sends (docs/LOGS.md).
     */
    const val VERSION = ConsentEvidence.VERSION
    private const val PREFS = "consent"

    private val TEXT = """
        Polydance records what you see in the headset, including passthrough of your room, with your microphone and the apps' sound. Each can be switched off on the deck or in a reply's Settings.

        Logs, when on, also sends the headset's logs from each take: Polydance's own, and other apps' only if this headset was given access over adb and you allow Android's prompt when the take stops.

        Each recording uploads to capture.polydance.net, into the thread you record it in. Gladia transcribes your voice, Claude (Anthropic) titles and summarises it, and ${signIn.consentName} shows on it.

        After you stop, a recording waits a few seconds before it uploads. Delete removes it from this headset and queues deletion from the server. Server deletion may wait for connectivity or sign-in.
    """.trimIndent()

    fun accepted(context: Context): Boolean = snapshot(context) != null

    /** Copied into run.json before any media is captured. Older runs are never backfilled. */
    fun snapshot(context: Context): JSONObject? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val evidence = ConsentEvidence(prefs.getString("version", null).orEmpty(), prefs.getLong("at", 0))
        if (!evidence.current(System.currentTimeMillis())) return null
        return JSONObject().put("version", evidence.version).put("acceptedAt", evidence.acceptedAt)
    }

    /** The server accepts the version string; the acceptance time stays in the local run metadata. */
    fun forUpload(run: JSONObject?): String? {
        val evidence = run?.optJSONObject("consent") ?: return null
        return ConsentEvidence(evidence.optString("version"), evidence.optLong("acceptedAt"))
            .uploadVersion(run.optLong("startedAt"))
    }

    /** Shows the notice; [then] runs only after Agree, [declined] after Not now. */
    fun ask(activity: Activity, then: () -> Unit, declined: () -> Unit = {}) {
        Timeline.log("consent", "shown", "version" to VERSION)
        AlertDialog.Builder(activity).setTitle("Before you record")
            .setMessage(TEXT)
            .setPositiveButton("Agree and record") { _, _ ->
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("version", VERSION).putLong("at", System.currentTimeMillis()).apply()
                Timeline.log("consent", "accepted", "version" to VERSION)
                then()
            }
            .setNegativeButton("Not now") { _, _ -> Timeline.log("consent", "declined", "version" to VERSION); declined() }
            .setNeutralButton("Full notice") { _, _ ->
                declined()
                runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(defaultServer(activity) + "/privacy"))) }
            }
            .setOnCancelListener { declined() }
            .show()
    }
}
