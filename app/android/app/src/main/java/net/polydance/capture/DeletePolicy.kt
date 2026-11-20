package net.polydance.capture

/** Pure journal transitions. A run tombstone outlives both its files and confirmed remote deletions. */
internal object DeletePolicy {
    data class Owner(val server: String, val account: String)
    data class Target(
        val clientId: String,
        val owner: Owner?,
        val ids: Set<String> = emptySet(),
        // Set durably before POST. A lost response cannot be disproved by an empty GET (or an old tombstone).
        val outstandingCreates: Int = 0,
        val confirmed: Boolean = false,
    )
    data class Entry(val deleted: Boolean = false, val targets: List<Target> = emptyList()) {
        val pending get() = deleted && targets.any { !it.confirmed }
    }

    fun beforeCreate(entry: Entry, clientId: String, owner: Owner): Entry? {
        if (entry.deleted) return null
        val target = entry.targets.firstOrNull { it.clientId == clientId && it.owner == owner }
            ?: Target(clientId, owner)
        return replace(entry, target.copy(outstandingCreates = target.outstandingCreates + 1, confirmed = false))
    }

    /** Also called for late responses: never clears the run tombstone or authorizes more content. */
    fun created(entry: Entry, clientId: String, owner: Owner, id: String): Entry {
        val target = entry.targets.firstOrNull { it.clientId == clientId && it.owner == owner }
            ?: Target(clientId, owner)
        return replace(entry, target.copy(ids = target.ids + id, outstandingCreates = (target.outstandingCreates - 1).coerceAtLeast(0), confirmed = false))
    }

    fun request(entry: Entry) = entry.copy(deleted = true)
    fun mayUpload(entry: Entry) = !entry.deleted
    fun owns(target: Target, owner: Owner) = target.owner != null && target.owner == owner

    /** Recovery must find a live upload, not mistake a historical deleted copy for the outstanding POST. */
    fun recover(target: Target, liveIds: Set<String>): Target =
        target.copy(ids = target.ids + liveIds, confirmed = false)

    /** A lost POST response remains ambiguous: deleting a visible copy could race another admitted
     * create. Continue lookups with backoff rather than declaring that no later copy can appear.
     */
    fun confirm(entry: Entry, expected: Target): Entry =
        if (entry.targets.contains(expected) && expected.ids.isNotEmpty() && expected.outstandingCreates == 0)
            replace(entry, expected.copy(confirmed = true)) else entry

    fun replace(entry: Entry, target: Target): Entry = entry.copy(
        targets = entry.targets.filterNot { it.clientId == target.clientId && it.owner == target.owner } + target,
    )
}
