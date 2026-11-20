package net.polydance.capture

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * Who this headset is on the receiver (2026-10-12, Robin: tie threads to email addresses): the person behind
 * its token, as `GET /v1/me` names them, and the email they give for themselves. Horizon OS gives the app a
 * Meta user id, display name and picture, but never an email, so the person types it once, here. The receiver
 * emails a link to confirm it (2026-11-10) and keeps it unverified until the person follows that link; once it
 * is confirmed, the threads that invited that address join their inbox. Kept per token, so another account's
 * address never shows.
 */
object Account {
    data class Me(val token: String, val name: String, val email: String?, val verified: Boolean, val colour: String?, val device: String?) {
        val initial: String get() = InboxText.initial(email, name)
    }

    @Volatile private var cached: Me? = null
    /** The receiver has no /v1/me (older than 2026-10-12): it keeps no email, so the account sheet says so. */
    @Volatile var unsupported = false
        private set

    /** The last answer for this token only. */
    fun cached(config: UploadSettings.Config?): Me? = cached?.takeIf { config != null && it.token == config.token }

    private fun parse(token: String, j: JSONObject): Me {
        val p = j.getJSONObject("person")
        fun JSONObject.str(name: String) = if (has(name) && !isNull(name)) optString(name).ifEmpty { null } else null
        return Me(token, p.str("name") ?: "You", p.str("email"), p.optBoolean("emailVerified"), p.str("colour"), j.str("device"))
    }

    /** Asks the receiver; null when it is older than accounts. Network trouble is the caller's IOException. */
    fun fetch(config: UploadSettings.Config): Me? = try {
        parse(config.token, ReceiverClient(config).json("GET", "/v1/me")).also { cached = it; unsupported = false }
    } catch (e: ReceiverClient.Refused) {
        if (e.code == 404) { unsupported = true; null } else throw e
    }

    /** Sets or clears ([email] null) this person's address; the receiver checks it again. */
    fun setEmail(config: UploadSettings.Config, email: String?): Me =
        parse(config.token, ReceiverClient(config).json("POST", "/v1/me", JSONObject().put("email", email ?: JSONObject.NULL))).also { cached = it }
}

/**
 * Addresses chosen in New thread before recording (2026-10-12: copy people in as in an email). The thread does
 * not exist until the recording's upload makes it, so they wait beside the recording in invite.json, never in
 * thread.json, whose shape the receiver checks strictly. Once the receiver has named the thread, the upload
 * adds them; one refused by the receiver is recorded and not tried again, network trouble is tried again.
 */
object Invites {
    private const val FILE = "invite.json"
    private const val TAG = "PolydanceCapture"

    fun write(dir: File, emails: List<String>) {
        if (emails.isEmpty()) return
        File(dir, FILE).writeText(JSONObject().put("emails", JSONArray(emails)).put("state", "waiting").toString(2))
    }

    /** Adds the waiting addresses to [key]; quiet when there are none, or they went already. */
    fun send(dir: File, client: ReceiverClient, key: String?) {
        val file = File(dir, FILE)
        if (key == null || !file.exists()) return
        val j = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return
        if (j.optString("state") != "waiting") return
        val emails = j.optJSONArray("emails")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
        if (emails.isEmpty()) return
        try {
            Threads.people(client, key, add = emails)
            file.writeText(j.put("state", "added").put("thread", key).put("at", System.currentTimeMillis()).toString(2))
            Timeline.log("invites", "added", "key" to key, "count" to emails.size)
        } catch (e: ReceiverClient.Refused) {
            // An expired token is renewed for the upload itself; the addresses go on the next try.
            if (e.code == 401) return
            // An older receiver (404) or an address it will not take: the recording still goes up.
            file.writeText(j.put("state", "refused").put("thread", key).put("error", e.message?.take(200)).toString(2))
            Log.w(TAG, "invites for $key refused: ${e.code}")
            Timeline.log("invites", "refused", "key" to key, "code" to e.code)
        } catch (e: IOException) {
            Log.w(TAG, "invites for $key will retry: $e")
        }
    }
}
