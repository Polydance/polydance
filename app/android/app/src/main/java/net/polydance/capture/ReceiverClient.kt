package net.polydance.capture

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The hosted receiver's upload and thread APIs (see src/server/http.ts and thread-routes.ts in the
 * repository), over plain HttpURLConnection so the app needs no HTTP library. Network trouble is an
 * IOException the caller retries; a refused token or request is a [Refused], whose status lets the
 * caller distinguish renewable authentication from a permanent refusal.
 */
class ReceiverClient(private val config: UploadSettings.Config) {

    /**
     * [title] and [summary] are Claude's label for the recording, once the receiver has made one;
     * [stepsDone] of [stepsTotal] is how far its pipeline has got.
     */
    data class Upload(
        override val id: String, override val clientId: String, val received: Long, override val status: String, val sessionId: String?, val error: String?,
        val deletedReason: String? = null, val title: String? = null, val summary: String? = null,
        val stepsDone: Int? = null, val stepsTotal: Int? = null,
        /** The thread the receiver put the recording in (docs/THREADS.md). */
        val thread: String? = null,
        /** A declared narration: "expected" until it arrives, then "received". */
        val narration: String? = null,
        val recordedAt: String? = null,
        val bytes: Long? = null,
        /** Declared logs (docs/LOGS.md): "expected" until they arrive, then "received". */
        val logs: String? = null,
    ) : HistoryPolicy.Record

    data class Account(val usedBytes: Long, val allowanceBytes: Long, val recordings: Int)

    /** The server will never accept this as sent (bad token, too large, conflicting id); [code] is its HTTP status. */
    class Refused(message: String, val code: Int = 0) : Exception(message)

    companion object {
        /** A request body is written in pieces this size: small enough that the meter moves on a slow network. */
        private const val PIECE = 64 * 1024

        /**
         * Signs a headset in, with its Meta account (MetaSignIn, /v1/testers/meta) or its Google account
         * (GoogleSignIn, /v1/testers/google): the one call made without a token. Returns
         * the status and the answer, the token among it on 201; network trouble is an IOException.
         */
        fun signIn(server: String, body: JSONObject, path: String = "/v1/testers/meta"): Pair<Int, JSONObject> {
            val conn = URL("$server$path").openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.setRequestProperty("Content-Type", "application/json")
                val bytes = body.toString().toByteArray()
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(bytes.size)
                conn.outputStream.use { it.write(bytes) }
                val code = conn.responseCode
                val text = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                return code to runCatching { JSONObject(text) }.getOrElse { JSONObject().put("error", text.take(200)) }
            } finally {
                conn.disconnect()
            }
        }
    }

    private fun JSONObject.optionalString(key: String): String? =
        (opt(key) as? String)?.takeIf { it.isNotBlank() }

    private fun parse(j: JSONObject) = Upload(
        j.getString("id"), j.getString("clientId"), j.getLong("received"), j.getString("status"),
        j.optionalString("sessionId"), j.optionalString("error"), j.optionalString("deletedReason"),
        j.optionalString("title"), j.optionalString("summary"),
        j.optJSONObject("steps")?.let { if (it.isNull("done")) null else it.optInt("done") },
        j.optJSONObject("steps")?.let { if (it.isNull("total")) null else it.optInt("total") },
        j.optionalString("thread"), j.optionalString("narration"), j.optionalString("recordedAt"),
        if (j.isNull("bytes")) null else j.optLong("bytes", -1).takeIf { it >= 0 },
        j.optionalString("logs")?.takeIf { it == "expected" || it == "received" },
    )

    /** This token's history, including only legacy aliases explicitly linked by the receiver.
     * No device/clientId filter: a fresh install has a different device id. Never request global sessions.
     */
    fun history(): List<Upload> {
        val uploads = request("GET", "/v1/uploads", null, null).json.getJSONArray("uploads")
        return (0 until uploads.length()).map { parse(uploads.getJSONObject(it)) }
    }

    fun create(body: JSONObject): Upload = parse(request("POST", "/v1/uploads", body.toString().toByteArray(), "application/json").json)

    /**
     * Sends bytes [start, end] of the file. A 409 carries the offset the server actually has, which is returned.
     * [written] hears how many of this chunk's bytes have gone into the connection so far, so the inbox's meter
     * moves within a chunk (UploadLive); with a fixed length nothing is buffered beyond the socket's own.
     */
    fun put(uploadId: String, file: File, start: Long, end: Long, total: Long, written: (Long) -> Unit = {}): Upload {
        val length = end - start + 1
        val response = request("PUT", "/v1/uploads/$uploadId/content", null, "application/octet-stream", allow409 = true) { conn ->
            conn.setRequestProperty("Content-Range", "bytes $start-$end/$total")
            conn.setFixedLengthStreamingMode(length)
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(start)
                val buffer = ByteArray(PIECE)
                var left = length
                conn.outputStream.use { out ->
                    while (left > 0) {
                        val n = raf.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                        if (n < 0) throw IOException("file ended early")
                        out.write(buffer, 0, n)
                        left -= n
                        written(length - left)
                    }
                }
            }
        }
        if (response.code == 409) {
            val received = response.json.optLong("received", -1)
            if (received < 0) throw Refused("server refused the chunk: ${response.json.optString("error")}")
            return Upload(uploadId, "", received, response.json.optString("status", "uploading"), null, response.json.optString("error"))
        }
        return parse(response.json)
    }

    /**
     * The narration (the mic track alone), whole, before the video; the receiver checks it against the create.
     * [written] hears the bytes gone so far, as for [put].
     */
    fun putNarration(uploadId: String, file: File, written: (Long) -> Unit = {}): Upload = putWhole(uploadId, "narration", "audio/mp4", file, written)

    /**
     * The take's logcat.txt, whole, before the narration and the media (docs/LOGS.md); the receiver checks its length
     * and sha256 against the create. For a take of logs alone its arrival completes the upload.
     */
    fun putLogs(uploadId: String, file: File, written: (Long) -> Unit = {}): Upload = putWhole(uploadId, "logs", "text/plain; charset=utf-8", file, written)

    private fun putWhole(uploadId: String, part: String, type: String, file: File, written: (Long) -> Unit): Upload {
        val length = file.length()
        val response = request("PUT", "/v1/uploads/$uploadId/$part", null, type) { conn ->
            conn.setFixedLengthStreamingMode(length)
            file.inputStream().use { input ->
                conn.outputStream.use { out ->
                    val buffer = ByteArray(PIECE)
                    var sent = 0L
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        sent += n
                        written(sent)
                    }
                }
            }
        }
        return parse(response.json)
    }

    fun account(): Account = request("GET", "/v1/account", null, null).json.let {
        Account(it.getLong("usedBytes"), it.getLong("allowanceBytes"), it.getInt("recordings"))
    }

    /** True only on confirmed deletion (including a deleted tombstone); false when the server is busy.
     * A 404 also hides an upload owned by another grant: it cannot honestly confirm deletion after an
     * account change. Keep the pending request/error rather than claiming that copy is gone.
     */
    fun delete(uploadId: String): Boolean {
        val response = request("DELETE", "/v1/uploads/$uploadId", null, null, allow409 = true)
        if (response.code == 409) return false
        if (response.json.optString("id") != uploadId || response.json.optString("status") != "deleted")
            throw IOException("Receiver did not confirm the requested upload was deleted")
        return true
    }

    fun statuses(clientIds: List<String>): List<Upload> {
        val query = clientIds.joinToString("&") { "clientId=" + URLEncoder.encode(it, "UTF-8") }
        val uploads: JSONArray = request("GET", "/v1/uploads?$query", null, null).json.getJSONArray("uploads")
        return (0 until uploads.length()).map { parse(uploads.getJSONObject(it)) }
    }

    /**
     * A file from the receiver, such as a thread's 3D model, written to [into]; more than [maxBytes] is
     * refused part way rather than filling the headset. [progress] hears the bytes so far.
     */
    fun download(path: String, into: File, maxBytes: Long, progress: (Long) -> Unit = {}) {
        val conn = URL(config.server + path).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            conn.setRequestProperty("Authorization", "Bearer ${config.token}")
            val code = conn.responseCode
            if (code !in 200..299) {
                val said = conn.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val error = runCatching { JSONObject(said).optString("error") }.getOrDefault(said.take(200))
                if (code in 400..499) throw Refused("server refused ($code): $error", code)
                throw IOException("server error $code: $error")
            }
            if (conn.contentLengthLong > maxBytes) throw Refused("the file is ${conn.contentLengthLong} bytes, over the $maxBytes allowed")
            conn.inputStream.use { input ->
                into.outputStream().use { out ->
                    val buffer = ByteArray(256 * 1024)
                    var total = 0L
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        total += n
                        if (total > maxBytes) throw Refused("the file is over the $maxBytes bytes allowed")
                        out.write(buffer, 0, n)
                        progress(total)
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    /** A JSON call for the thread routes (docs/THREADS.md); [Threads] reads the answers. */
    fun json(method: String, path: String, body: JSONObject? = null): JSONObject =
        request(method, path, body?.toString()?.toByteArray(), body?.let { "application/json" }).json

    private class Response(val code: Int, val json: JSONObject)

    private fun request(
        method: String, path: String, body: ByteArray?, contentType: String?, allow409: Boolean = false,
        write: ((HttpURLConnection) -> Unit)? = null,
    ): Response {
        val conn = URL(config.server + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 120_000
            conn.setRequestProperty("Authorization", "Bearer ${config.token}")
            if (contentType != null) conn.setRequestProperty("Content-Type", contentType)
            if (body != null) {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            } else if (write != null) {
                conn.doOutput = true
                write(conn)
            }
            val code = conn.responseCode
            val text = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject().put("error", text.take(200)) }
            return when {
                code in 200..299 -> Response(code, json)
                code == 409 && allow409 -> Response(code, json)
                code == 401 -> throw Refused("server rejected the token (401)", code)
                code == 403 -> throw Refused("server denied this request (403)", code)
                code in 400..499 || code == 507 -> throw Refused("server refused ($code): ${json.optString("error")}", code)
                else -> throw IOException("server error $code: ${json.optString("error")}")
            }
        } finally {
            conn.disconnect()
        }
    }
}
