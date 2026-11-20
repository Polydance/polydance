package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test

/** Which threads' models the immersive scene puts on its table; the scene itself needs a headset. */
class ImmersiveTest {
    private fun summary(key: String, project: String = "CAP", at: String, state: String = "open") =
        Threads.Summary(key, project, "Thread $key", state, at, unread = false, waiting = false, lastBy = "", lastText = "", lastMessageAt = at)

    private fun model(n: Int) = Threads.Step.Model(n.toString(16).padStart(64, '0'), "m$n.glb", 1000L + n)

    @Test fun followedIsTheInboxNewestFirstWithinTheFilter() {
        val threads = listOf(
            summary("CAP-1", at = "2026-10-20T10:00:00Z"), summary("MUS-2", "MUS", "2026-10-21T09:00:00Z"),
            summary("CAP-3", at = "2026-10-21T08:00:00Z"), summary("CAP-4", at = "2026-10-21T11:00:00Z", state = "closed"),
        )
        assertEquals(listOf("MUS-2", "CAP-3", "CAP-1"), Immersive.followed(threads, emptySet()).map { it.key })
        assertEquals(listOf("CAP-3", "CAP-1"), Immersive.followed(threads, setOf("CAP")).map { it.key })
        assertEquals(listOf("MUS-2"), Immersive.followed(threads, emptySet(), limit = 1).map { it.key })
    }

    @Test fun latestModelIsTheLastOfTheLastMessageWithOne() {
        assertNull(Immersive.latestModel(emptyList()))
        assertNull(Immersive.latestModel(listOf(emptyList(), emptyList())))
        assertEquals(model(2), Immersive.latestModel(listOf(listOf(model(1)), listOf(model(2)), emptyList())))
        assertEquals(model(4), Immersive.latestModel(listOf(listOf(model(3), model(4)))))
    }

    @Test fun tablePutsTheOpenedPieceFirstAndEachModelOnce() {
        val opened = Immersive.Piece("CAP-10", "A cube", model(1))
        val others = (1..8).map { Immersive.Piece("CAP-$it", "T$it", model(it)) }
        val table = Immersive.table(opened, others)
        assertEquals(Immersive.TABLE_SIZE, table.size)
        assertEquals("CAP-10", table.first().key)
        assertEquals(table.map { it.model.sha256 }.distinct(), table.map { it.model.sha256 })
        assertEquals(listOf("CAP-2", "CAP-3"), Immersive.table(null, others, size = 3).drop(1).map { it.key })
        assertTrue(Immersive.table(null, emptyList()).isEmpty())
    }
}
