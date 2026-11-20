package net.polydance.capture

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The inbox's rules that need no Android (2026-10-12, the Gmail-style inbox): email addresses as people type
 * them, the letter in an avatar, a row's time, what a search matches and a recording's clock. Pure, so the
 * JVM tests run them without a headset; the receiver checks every address again and is the authority.
 */
object InboxText {
    /** The receiver's own rule (zod's email check): no leading dot, no "..", a letter TLD of two or more. */
    private val EMAIL = Regex("^(?!\\.)(?!.*\\.\\.)[A-Za-z0-9_'+\\-.]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\\.)+[A-Za-z]{2,}$")
    private val SEPARATORS = Regex("[\\s,;]+")

    /** A typed address, trimmed and lowercased, or null when it is not one. */
    /**
     * A project's name as POST /v1/projects takes it (src/threads.ts newProjectSchema, 2026-11-13): trimmed, 1 to 60
     * UTF-16 units as JavaScript counts them, no control characters. Null when the receiver would refuse it.
     */
    fun projectName(input: String): String? = input.trim().takeIf { it.isNotEmpty() && it.length <= 60 && it.none(Char::isISOControl) }

    fun email(input: String): String? {
        val e = input.trim().lowercase(Locale.ROOT)
        return e.takeIf { it.length <= 254 && EMAIL.matches(it) }
    }

    /** Addresses typed or pasted together, split on commas, semicolons and spaces: the good ones and the rest. */
    fun emails(input: String): Pair<List<String>, List<String>> {
        val words = input.split(SEPARATORS).filter { it.isNotBlank() }
        val good = words.mapNotNull { email(it) }.distinct()
        return good to words.filter { email(it) == null }
    }

    /** The letter in a person's circle: the first of their email when known (Robin, 2026-10-12), else of their name. */
    fun initial(email: String?, name: String?): String =
        (email?.firstOrNull { it.isLetterOrDigit() } ?: name?.firstOrNull { it.isLetterOrDigit() } ?: '?').uppercaseChar().toString()

    /** An ISO time from the receiver as epoch milliseconds, or null. */
    fun millis(iso: String?): Long? = iso?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }

    /** Gmail's row time: the clock today, the day and month this year, the full date before. */
    fun rowTime(atMs: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val then = Instant.ofEpochMilli(atMs).atZone(zone)
        val now = Instant.ofEpochMilli(nowMs).atZone(zone)
        val pattern = when {
            then.toLocalDate() == now.toLocalDate() -> "HH:mm"
            then.year == now.year -> "d MMM"
            else -> "d MMM yyyy"
        }
        return then.format(DateTimeFormatter.ofPattern(pattern, Locale.UK))
    }

    /** A recording's clock: 1:05, or 1:02:05 past an hour. */
    fun clock(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return if (s >= 3600) String.format(Locale.US, "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
        else String.format(Locale.US, "%d:%02d", s / 60, s % 60)
    }

    /** Every word of the query appears somewhere in the fields, ignoring case: "menu mus" finds MUS-12 "New menu". */
    fun matches(query: String, fields: List<String?>): Boolean {
        val words = query.trim().lowercase(Locale.ROOT).split(SEPARATORS).filter { it.isNotEmpty() }
        if (words.isEmpty()) return true
        val text = fields.filterNotNull().joinToString(" ").lowercase(Locale.ROOT)
        return words.all { it in text }
    }

    /** "Robin", "Robin and ana@x.com", "Robin, Ana and 2 others" for a thread's people line. */
    fun names(names: List<String>, total: Int = names.size): String {
        val others = total - names.size
        return when {
            names.isEmpty() -> ""
            others > 0 -> "${names.joinToString(", ")} and $others other${if (others == 1) "" else "s"}"
            names.size == 1 -> names[0]
            else -> "${names.dropLast(1).joinToString(", ")} and ${names.last()}"
        }
    }

    /**
     * The line under an invited address in People (2026-11-10): whether the receiver emailed the invitation, when,
     * and the receiver's own note on it. A null [emailed] means this headset cannot see the invitations' state, so
     * the line claims nothing. The note is the receiver's words, shown as they are, cut short if long.
     */
    fun invitedLine(emailed: Boolean?, emailedAtMs: Long?, note: String?, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        val parts = mutableListOf("Invited by email")
        when (emailed) {
            true -> parts += "emailed" + (emailedAtMs?.let { " ${rowTime(it, nowMs, zone)}" } ?: "")
            false -> parts += "not emailed"
            null -> {}
        }
        note?.trim()?.takeIf { it.isNotEmpty() }?.let { parts += if (it.length > NOTE_MAX) it.take(NOTE_MAX - 1).trimEnd() + "…" else it }
        return parts.joinToString("  ·  ")
    }
    private const val NOTE_MAX = 140

    /** The transcript line playing at [ms]: the last that started at or before it, or -1 before the first. */
    fun lineAt(starts: List<Long>, ms: Long): Int {
        var lo = 0; var hi = starts.size - 1; var found = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (starts[mid] <= ms) { found = mid; lo = mid + 1 } else hi = mid - 1
        }
        return found
    }
}
