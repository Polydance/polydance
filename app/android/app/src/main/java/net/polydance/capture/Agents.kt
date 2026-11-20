package net.polydance.capture

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * A person's own coding agents (2026-11-20, docs/THREADS.md "Connecting your own agent"): the headset asks the
 * receiver for a one-time code, the person types it into `polycap connect` on their computer, and the agent on
 * that machine then reads their threads and recordings and posts in them, as them. The headset is where the
 * code is shown and where the connected agents are listed and disconnected; the token itself never comes here.
 *
 * Robin's picks of four mockups, 2026-11-20: D, a card in the inbox until an agent is connected and the same
 * card in the Welcome's answer, "and then C too", a page of their own from the menu. Kept per token, as
 * [Account] is, so another account's agents never show. The words and sums are here, without Android, so
 * AgentsTest proves them.
 */
object Agents {
    data class Agent(
        val id: String, val label: String, val connectedAt: String, val connectedFrom: String, val expiresAt: String,
        val lastUsedOn: String?, val expired: Boolean,
    )
    /** A code as the receiver showed it, "K7QF-2MXD", and when it runs out. */
    data class Code(val token: String, val code: String, val expiresAtMs: Long)
    data class State(val token: String, val agents: List<Agent>, val limit: Int) {
        /** Those that still work. */
        val connected: List<Agent> get() = agents.filter { !it.expired }
        val full: Boolean get() = connected.size >= limit
    }

    /** The receiver's own author and the delivery id of the Welcome's answer (src/server/welcome.ts). */
    private const val WELCOME_BY = "polydance"
    private const val WELCOME_NEXT = "welcome-next"
    /** A code's whole life, for the strip that runs down with it. */
    const val CODE_MS = 10 * 60_000L

    @Volatile private var state: State? = null
    @Volatile private var code: Code? = null

    fun cached(config: UploadSettings.Config?): State? = state?.takeIf { config != null && it.token == config.token }
    /** The code on show, while it still works and for this token only. */
    fun code(config: UploadSettings.Config?, now: Long = System.currentTimeMillis()): Code? =
        code?.takeIf { config != null && it.token == config.token && it.expiresAtMs > now }

    fun fetch(config: UploadSettings.Config): State =
        parseList(config.token, ReceiverClient(config).json("GET", "/v1/agents")).also { state = it }

    /** Asks for a code; the receiver's last one for this person stops working. */
    fun ask(config: UploadSettings.Config): Code =
        parseCode(config.token, ReceiverClient(config).json("POST", "/v1/agents/codes", JSONObject())).also { code = it }

    fun disconnect(config: UploadSettings.Config, id: String): State {
        ReceiverClient(config).json("DELETE", "/v1/agents/$id")
        return fetch(config)
    }

    /** A code that has been used shows no longer: the list has someone new in it. */
    fun settle(before: State?, after: State) {
        if (before != null && after.agents.any { a -> before.agents.none { it.id == a.id } }) code = null
    }

    // ---- Reading the receiver's answers.

    private fun JSONObject.str(name: String) = if (has(name) && !isNull(name)) optString(name).ifEmpty { null } else null

    fun parseList(token: String, j: JSONObject): State {
        val list = j.optJSONArray("agents")
        val agents = (0 until (list?.length() ?: 0)).mapNotNull { i ->
            val a = list!!.optJSONObject(i) ?: return@mapNotNull null
            // One this build cannot name or disconnect is left out, never guessed at.
            val id = a.str("id")?.takeIf { Regex("^paired-[0-9a-f]{8}$").matches(it) } ?: return@mapNotNull null
            Agent(id, a.str("label") ?: "Computer", a.str("connectedAt").orEmpty(), a.str("connectedFrom").orEmpty(), a.str("expiresAt").orEmpty(), a.str("lastUsedOn"), a.optBoolean("expired"))
        }
        return State(token, agents, j.optInt("limit", 5))
    }

    fun parseCode(token: String, j: JSONObject): Code {
        val code = j.getString("code")
        require(Regex("^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$").matches(code)) { "not a code" }
        return Code(token, code, Instant.parse(j.getString("expiresAt")).toEpochMilli())
    }

    // ---- What is shown.

    /** The line to type on the computer. */
    fun command(code: Code) = "polycap connect ${code.code}"

    /** "9:41 left", or null once it has run out. */
    fun left(code: Code, now: Long): String? {
        val ms = code.expiresAtMs - now
        if (ms <= 0) return null
        val s = (ms + 999) / 1000
        return String.format(Locale.US, "%d:%02d left", s / 60, s % 60)
    }

    /** How much of the code's ten minutes is left, 0 to 1, for the strip. */
    fun fraction(code: Code, now: Long): Float = ((code.expiresAtMs - now).toFloat() / CODE_MS).coerceIn(0f, 1f)

    private val dayMonth = DateTimeFormatter.ofPattern("d MMM", Locale.UK)
    private fun day(iso: String?, zone: ZoneId): LocalDate? = iso?.let { text ->
        runCatching { Instant.parse(text).atZone(zone).toLocalDate() }.recoverCatching { LocalDate.parse(text) }.getOrNull()
    }

    /** "connected 12 Nov from Quest 3 · last used today · until 10 Feb", leaving out what the receiver did not say. */
    fun detail(a: Agent, today: LocalDate, zone: ZoneId = ZoneId.systemDefault()): String {
        val parts = mutableListOf<String>()
        day(a.connectedAt, zone)?.let { parts += "connected ${it.format(dayMonth)}${if (a.connectedFrom.isNotBlank()) " from ${a.connectedFrom}" else ""}" }
        // The receiver notes the day of use in UTC, so it is a day, not a moment.
        parts += when (val used = a.lastUsedOn?.let { runCatching { LocalDate.parse(it) }.getOrNull() }) {
            null -> "not used yet"
            today -> "last used today"
            else -> "last used ${used.format(dayMonth)}"
        }
        day(a.expiresAt, zone)?.let { parts += if (a.expired) "ran out ${it.format(dayMonth)}" else "until ${it.format(dayMonth)}" }
        return parts.joinToString("  ·  ")
    }

    /**
     * Whether the inbox shows the card that offers to connect one: the receiver connects agents, this person's
     * list has been read and has none that works, and they have not put the card away.
     */
    fun offer(supported: Boolean, state: State?, dismissed: Boolean): Boolean =
        supported && !dismissed && state != null && state.connected.isEmpty()

    /** The Welcome's answer to a newcomer's first recording, which carries the same card (welcome.ts). */
    fun isWelcomeAnswer(m: Threads.Message): Boolean = m.byId == WELCOME_BY && m.deliveryId == WELCOME_NEXT

    /** Why a code could not be had, in words a person can act on. */
    fun problem(e: Throwable, state: State?): String = when ((e as? ReceiverClient.Refused)?.code) {
        null -> "Can't reach the server. Check the connection and try again."
        401 -> "Sign-in expired; signing in again."
        403 -> if (state?.full == true) full(state) else "This account cannot connect an agent."
        404 -> "This server doesn't connect agents yet."
        429 -> "Too many codes just now. Try again in a few minutes."
        else -> "The server refused. Try again in a moment."
    }

    fun full(state: State) = "You have ${state.limit} agents connected, which is as many as one person may. Disconnect one first."
}
