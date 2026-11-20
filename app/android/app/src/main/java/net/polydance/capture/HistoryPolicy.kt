package net.polydance.capture

/** Presentation only: the authenticated receiver, not this filter, decides account ownership. */
object HistoryPolicy {
    interface Record {
        val id: String
        val clientId: String
        val status: String
    }

    data class Local(val uploadId: String?, val clientId: String?)

    /** Keep receiver order (newest first). Tombstones never mask a live retry of the same client id. */
    fun <T : Record> serverOnly(records: List<T>, locals: List<Local>): List<T> {
        val localIds = locals.mapNotNull { it.uploadId?.takeIf(String::isNotBlank) }.toSet()
        val localClients = locals.mapNotNull { it.clientId?.takeIf(String::isNotBlank) }.toSet()
        val seenIds = mutableSetOf<String>()
        val seenClients = mutableSetOf<String>()
        return records.filter { r ->
            if (r.status == "deleted" || r.id.isBlank() || r.id in localIds ||
                (r.clientId.isNotBlank() && r.clientId in localClients)) return@filter false
            val duplicate = r.id in seenIds || (r.clientId.isNotBlank() && r.clientId in seenClients)
            seenIds.add(r.id)
            if (r.clientId.isNotBlank()) seenClients.add(r.clientId)
            !duplicate
        }
    }

    /** A lifecycle/configuration epoch: changing away and back still invalidates an old request. */
    class Guard<S : Any> {
        data class Ticket<S>(val scope: S, val generation: Long)
        private var scope: S? = null
        private var active = false
        private var generation = 0L

        @Synchronized fun update(next: S?, showing: Boolean): Boolean {
            if (scope == next && active == showing) return false
            scope = next
            active = showing
            generation++
            return true
        }

        @Synchronized fun invalidate() { generation++ }

        @Synchronized fun ticket(): Ticket<S>? = scope?.takeIf { active }?.let { Ticket(it, generation) }

        /** Compare freshly loaded settings too, even if their change notification has not run yet. */
        @Synchronized fun accepts(ticket: Ticket<S>, current: S?): Boolean =
            active && generation == ticket.generation && scope == ticket.scope && scope == current
    }
}
