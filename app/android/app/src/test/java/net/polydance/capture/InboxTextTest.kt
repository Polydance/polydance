package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class InboxTextTest {
    private val london = ZoneId.of("Europe/London")
    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int) = ZonedDateTime.of(y, mo, d, h, mi, 0, 0, london).toInstant().toEpochMilli()

    @Test fun addressesAreTrimmedLowercasedAndCheckedLikeTheReceiver() {
        assertEquals("ana.b+test@example.co.uk", InboxText.email("  Ana.B+Test@Example.CO.UK "))
        for (bad in listOf("", "ana", "ana@", "@example.com", "ana@example", "ana@example.c", ".ana@example.com", "ana..b@example.com", "ana b@example.com", "ana@exa_mple.com"))
            assertNull(bad, InboxText.email(bad))
        assertNull(InboxText.email("a".repeat(250) + "@x.com"))
    }

    @Test fun aProjectNameIsCheckedLikeTheReceiver() {
        assertEquals("Spottisphone", InboxText.projectName("  Spottisphone "))
        assertEquals("a".repeat(60), InboxText.projectName("a".repeat(60)))
        for (bad in listOf("", "   ", "a".repeat(61), "Two\nlines", "Tab\there")) assertNull(bad, InboxText.projectName(bad))
    }

    @Test fun pastedAddressesSplitIntoGoodOnesAndTheRest() {
        val (good, bad) = InboxText.emails("ana@example.com, Bob@Example.com;nope  ana@example.com\nchris@test.org")
        assertEquals(listOf("ana@example.com", "bob@example.com", "chris@test.org"), good)
        assertEquals(listOf("nope"), bad)
    }

    @Test fun theAvatarLetterComesFromTheEmailThenTheName() {
        assertEquals("R", InboxText.initial("robin@example.com", "Ana"))
        assertEquals("A", InboxText.initial(null, "ana"))
        assertEquals("7", InboxText.initial("7up@example.com", null))
        assertEquals("?", InboxText.initial(null, "  "))
    }

    @Test fun rowTimesReadLikeGmail() {
        val now = at(2026, 10, 12, 17, 30)
        assertEquals("17:20", InboxText.rowTime(at(2026, 10, 12, 17, 20), now, london))
        assertEquals("9 Oct", InboxText.rowTime(at(2026, 10, 9, 8, 0), now, london))
        assertEquals("30 Dec 2025", InboxText.rowTime(at(2025, 12, 30, 8, 0), now, london))
        assertEquals(at(2026, 10, 12, 16, 20), InboxText.millis("2026-10-12T15:20:00.000Z"))
        assertNull(InboxText.millis("yesterday"))
    }

    @Test fun clocksAndTheLinePlaying() {
        assertEquals("0:00", InboxText.clock(-5))
        assertEquals("1:05", InboxText.clock(65_400))
        assertEquals("1:02:05", InboxText.clock(3_725_000))
        val starts = listOf(0L, 4_000L, 9_000L)
        assertEquals(-1, InboxText.lineAt(listOf(2_000L, 4_000L), 1_000))
        assertEquals(0, InboxText.lineAt(starts, 3_999))
        assertEquals(1, InboxText.lineAt(starts, 4_000))
        assertEquals(2, InboxText.lineAt(starts, 60_000))
    }

    @Test fun searchNeedsEveryWordSomewhere() {
        val fields = listOf("New menu", "MUS-12", "Marimba", null)
        assertTrue(InboxText.matches("menu mus", fields))
        assertTrue(InboxText.matches("  ", fields))
        assertFalse(InboxText.matches("menu settings", fields))
    }

    @Test fun peopleLines() {
        assertEquals("Robin", InboxText.names(listOf("Robin")))
        assertEquals("Robin and ana@x.com", InboxText.names(listOf("Robin", "ana@x.com")))
        assertEquals("Robin, Ana and Bo", InboxText.names(listOf("Robin", "Ana", "Bo")))
        assertEquals("Robin, Ana and 2 others", InboxText.names(listOf("Robin", "Ana"), 4))
    }

    @Test fun anInvitedAddressSaysWhetherTheReceiverEmailedIt() {
        val now = at(2026, 11, 10, 18, 0)
        assertEquals("Invited by email  ·  emailed 14:05", InboxText.invitedLine(true, at(2026, 11, 10, 14, 5), null, now, london))
        assertEquals("Invited by email  ·  emailed 3 Nov", InboxText.invitedLine(true, at(2026, 11, 3, 9, 0), null, now, london))
        assertEquals("Invited by email  ·  emailed", InboxText.invitedLine(true, null, null, now, london))
        assertEquals("Invited by email  ·  not emailed", InboxText.invitedLine(false, null, "  ", now, london))
        assertEquals("Invited by email  ·  not emailed  ·  Added by a tester", InboxText.invitedLine(false, null, " Added by a tester ", now, london))
        // Without the thread's participants (not in it) the line claims nothing either way.
        assertEquals("Invited by email", InboxText.invitedLine(null, null, null, now, london))
        val long = InboxText.invitedLine(false, null, "x".repeat(300), now, london)
        assertTrue(long.endsWith("…"))
        assertEquals("Invited by email  ·  not emailed  ·  ".length + 140, long.length)
    }
}
