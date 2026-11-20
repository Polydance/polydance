package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** The words and sums behind Connect your agent (Agents.kt): the code's clock, each agent's line, and when the inbox offers it. */
class AgentsTest {
    private val london = ZoneId.of("Europe/London")
    private val asked = Instant.parse("2026-11-20T12:00:00Z").toEpochMilli()
    private val code = Agents.Code("token", "K7QF-2MXD", asked + Agents.CODE_MS)
    private fun agent(id: String = "paired-0a1b2c3d", expired: Boolean = false, used: String? = "2026-11-20") =
        Agents.Agent(id, "Mac", "2026-11-12T09:30:00Z", "Quest 3", "2027-02-10T09:30:00Z", used, expired)

    @Test fun theCodesClockRunsDownToNothing() {
        assertEquals("polycap connect K7QF-2MXD", Agents.command(code))
        assertEquals("10:00 left", Agents.left(code, asked))
        assertEquals("9:41 left", Agents.left(code, asked + 19_000))
        // A part of a second counts as the whole of it, so the clock never reads 0:00 while the code still works.
        assertEquals("9:42 left", Agents.left(code, asked + 18_500))
        assertEquals("0:01 left", Agents.left(code, asked + Agents.CODE_MS - 1))
        assertNull(Agents.left(code, asked + Agents.CODE_MS))
        assertEquals(1f, Agents.fraction(code, asked), 0f)
        assertEquals(0.5f, Agents.fraction(code, asked + Agents.CODE_MS / 2), 0.001f)
        assertEquals(0f, Agents.fraction(code, asked + Agents.CODE_MS + 5_000), 0f)
        // A headset whose clock runs behind the receiver's never shows more than the whole strip.
        assertEquals(1f, Agents.fraction(code, asked - 60_000), 0f)
    }

    @Test fun anAgentsLineSaysWhenItWasConnectedUsedAndRunsOut() {
        val today = LocalDate.of(2026, 11, 20)
        assertEquals("connected 12 Nov from Quest 3  ·  last used today  ·  until 10 Feb", Agents.detail(agent(), today, london))
        assertEquals("connected 12 Nov from Quest 3  ·  last used 14 Nov  ·  until 10 Feb", Agents.detail(agent(used = "2026-11-14"), today, london))
        assertEquals("connected 12 Nov from Quest 3  ·  not used yet  ·  until 10 Feb", Agents.detail(agent(used = null), today, london))
        assertEquals("connected 12 Nov from Quest 3  ·  last used today  ·  ran out 10 Feb", Agents.detail(agent(expired = true), today, london))
        // What the receiver did not say, or said in a shape this build does not know, is left out.
        assertEquals("not used yet", Agents.detail(Agents.Agent("paired-0a1b2c3d", "Mac", "", "", "soon", "yesterday", false), today, london))
        assertEquals("connected 12 Nov  ·  not used yet", Agents.detail(agent(used = null).copy(connectedFrom = "", expiresAt = ""), today, london))
    }

    @Test fun theInboxOffersItOnlyWhenNoAgentWorksAndTheCardIsNotPutAway() {
        val none = Agents.State("token", emptyList(), 5)
        val one = Agents.State("token", listOf(agent()), 5)
        val lapsed = Agents.State("token", listOf(agent(expired = true)), 5)
        assertTrue(Agents.offer(true, none, false))
        assertTrue(Agents.offer(true, lapsed, false))
        assertFalse(Agents.offer(true, one, false))
        assertFalse(Agents.offer(true, none, true))
        // An older receiver, or a list not read yet: nothing is offered on a guess.
        assertFalse(Agents.offer(false, none, false))
        assertFalse(Agents.offer(true, null, false))
        assertEquals(listOf("paired-0a1b2c3d"), one.connected.map { it.id })
        assertTrue(lapsed.connected.isEmpty())
    }

    @Test fun fiveIsFullAndExpiredOnesDoNotCount() {
        val five = (1..5).map { agent(id = "paired-0000000$it") }
        assertTrue(Agents.State("token", five, 5).full)
        assertFalse(Agents.State("token", five.dropLast(1) + agent(id = "paired-00000009", expired = true), 5).full)
        assertEquals("You have 5 agents connected, which is as many as one person may. Disconnect one first.", Agents.full(Agents.State("token", five, 5)))
    }

    @Test fun theWelcomesAnswerIsKnownByItsSenderAndItsName() {
        fun message(by: String, delivery: String?) = Threads.Message(2, "2026-11-20T12:00:00Z", by, "Polydance", "Here is what Polydance made of your recording", emptyList(), null, emptyList(), deliveryId = delivery)
        assertTrue(Agents.isWelcomeAnswer(message("polydance", "welcome-next")))
        // The Welcome's first message, and anyone else's message that borrows the name.
        assertFalse(Agents.isWelcomeAnswer(message("polydance", null)))
        assertFalse(Agents.isWelcomeAnswer(message("paired-0a1b2c3d", "welcome-next")))
        assertFalse(Agents.isWelcomeAnswer(message("meta-2001", "welcome-next")))
    }

    @Test fun aRefusalIsSaidInWordsAPersonCanActOn() {
        val full = Agents.State("token", (1..5).map { agent(id = "paired-0000000$it") }, 5)
        assertEquals("Can't reach the server. Check the connection and try again.", Agents.problem(IOException("timeout"), null))
        assertEquals(Agents.full(full), Agents.problem(ReceiverClient.Refused("server denied this request (403)", 403), full))
        assertEquals("This account cannot connect an agent.", Agents.problem(ReceiverClient.Refused("server denied this request (403)", 403), null))
        assertEquals("This server doesn't connect agents yet.", Agents.problem(ReceiverClient.Refused("server refused (404): not found", 404), null))
        assertEquals("Too many codes just now. Try again in a few minutes.", Agents.problem(ReceiverClient.Refused("server refused (429): too many codes", 429), null))
    }
}
