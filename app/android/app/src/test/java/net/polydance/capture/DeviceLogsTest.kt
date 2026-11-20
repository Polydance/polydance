package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest

/** The pure parts of reading a take's log (DeviceLogs, docs/LOGS.md): no headset, no logcat. Made-up lines only. */
class DeviceLogsTest {
    private val mine = 10057
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** Hands out at most [step] bytes a read, so a line arrives in pieces as it can from a pipe. */
    private class Trickle(private val bytes: ByteArray, private val step: Int) : InputStream() {
        private var at = 0
        override fun read(): Int = if (at < bytes.size) bytes[at++].toInt() and 0xff else -1
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (at >= bytes.size) return -1
            val n = minOf(len, step, bytes.size - at)
            System.arraycopy(bytes, at, b, off, n)
            at += n
            return n
        }
    }

    /** As AOSP's logprint.cpp prints them: epoch in 19, "%5d:" uid against a "%5d" pid (a five-digit pid has no space before it). */
    private val lines = listOf(
        "--------- beginning of main",
        "         1763290000.123 10057: 4321  4321 I PolydanceCapture: take began",
        "         1763290001.500 10123:15555 15601 E chromium: [ERROR:example.cc(12)] made-up failure",
        "         1763290002.007  root:  123   123 W initx   : made-up warning",
        "         1763290003.250  1000: 1500  1520 D WindowManagerX: made-up line",
    )

    @Test fun theCommandIsDocsLogsMdsAsAnArgumentList() {
        assertEquals("1763290000.123", DeviceLogs.since(1_763_290_000_123))
        assertEquals("1763290000.005", DeviceLogs.since(1_763_290_000_005))
        assertEquals(
            listOf("/system/bin/logcat", "-d", "-b", "main,system,crash", "-v", "threadtime", "-v", "epoch", "-v", "uid", "-v", "printable", "-T", "1763290000.123"),
            DeviceLogs.command(1_763_290_000_123),
        )
    }

    @Test fun eachLinesUidIsReadNumberOrNameAndOtherLinesAreNot() {
        assertNull(DeviceLogs.uidOf(lines[0]))
        assertEquals("10057", DeviceLogs.uidOf(lines[1]))
        assertEquals("10123", DeviceLogs.uidOf(lines[2]))
        assertEquals("root", DeviceLogs.uidOf(lines[3]))
        assertEquals("1000", DeviceLogs.uidOf(lines[4]))
        // Without -v uid there is no uid field: pid, tid and the level follow the time.
        assertNull(DeviceLogs.uidOf("         1763290000.123   4321  4321 I PolydanceCapture: no uid"))
        assertNull(DeviceLogs.uidOf("not a log line at all"))
    }

    @Test fun theScopeIsTheDeviceOnlyWhenAnotherUidWrote() {
        assertEquals("app", DeviceLogs.scope(emptySet(), mine))
        assertEquals("app", DeviceLogs.scope(setOf("10057"), mine))
        assertEquals("device", DeviceLogs.scope(setOf("10057", "10123"), mine))
        assertEquals("device", DeviceLogs.scope(setOf("10057", "root"), mine))
    }

    @Test fun onlyAppUidsAreNamedByPackageInAnyUser() {
        assertEquals(listOf(10057, 10123, 1010123), DeviceLogs.appUids(setOf("10123", "1000", "root", "99001", "1010123", "10057", "9999")))
        assertEquals(DeviceLogs.MAX_PACKAGES, DeviceLogs.appUids((10_000 until 10_400).map { it.toString() }.toSet()).size)
    }

    @Test fun aCopyKeepsWholeLinesHashesThemAndNotesTheirUids() {
        val text = lines.joinToString("\n", postfix = "\n").toByteArray()
        val out = ByteArrayOutputStream()
        val copy = DeviceLogs.copy(Trickle(text, 7), out)
        assertArrayEquals(text, out.toByteArray())
        assertEquals(text.size.toLong(), copy.bytes)
        assertEquals(sha(text), copy.sha256)
        assertFalse(copy.truncated)
        assertEquals(setOf("10057", "10123", "root", "1000"), copy.uids)
    }

    @Test fun theLimitCutsAtTheLastWholeLine() {
        val text = lines.joinToString("\n", postfix = "\n").toByteArray()
        val firstTwo = (lines[0] + "\n" + lines[1] + "\n").toByteArray()
        val out = ByteArrayOutputStream()
        // Room for the first two lines and part of the third: the third is left out whole.
        val copy = DeviceLogs.copy(ByteArrayInputStream(text), out, max = firstTwo.size + 10L)
        assertArrayEquals(firstTwo, out.toByteArray())
        assertEquals(firstTwo.size.toLong(), copy.bytes)
        assertEquals(sha(firstTwo), copy.sha256)
        assertTrue(copy.truncated)
        assertEquals(setOf("10057"), copy.uids)
    }

    @Test fun aLastLineWithoutANewlineIsKeptWhenItFits() {
        val text = (lines[1] + "\n" + lines[2]).toByteArray()
        val out = ByteArrayOutputStream()
        val copy = DeviceLogs.copy(Trickle(text, 64 * 1024), out)
        assertArrayEquals(text, out.toByteArray())
        assertFalse(copy.truncated)
        assertEquals(setOf("10057", "10123"), copy.uids)
        val empty = DeviceLogs.copy(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream())
        assertEquals(0L, empty.bytes)
        assertEquals(sha(ByteArray(0)), empty.sha256)
    }

    @Test fun theNoteSaysWhyOnlyPolydancesLinesAreThere() {
        assertNull(DeviceLogs.note("device", DeviceLogs.Access.GRANTED, onTop = true))
        assertTrue(DeviceLogs.note("app", DeviceLogs.Access.NOT_DECLARED, onTop = true)!!.contains("store builds"))
        val grant = DeviceLogs.note("app", DeviceLogs.Access.NOT_GRANTED, onTop = true)!!
        assertTrue(grant.endsWith("adb shell pm grant net.polydance.capture android.permission.READ_LOGS"))
        assertTrue(DeviceLogs.note("app", DeviceLogs.Access.GRANTED, onTop = false)!!.contains("not in front"))
        assertTrue(DeviceLogs.note("app", DeviceLogs.Access.GRANTED, onTop = true)!!.contains("declined or not answered"))
        // A restart is said even when the headset's lines are there, and every note fits the receiver's 300 characters.
        assertTrue(DeviceLogs.note("device", DeviceLogs.Access.GRANTED, onTop = true, restarted = true)!!.startsWith("The headset restarted"))
        for (access in DeviceLogs.Access.entries) for (top in listOf(true, false)) {
            assertTrue(DeviceLogs.note("app", access, top, restarted = true)!!.length <= 300)
        }
        assertTrue(DeviceLogs.note("app", DeviceLogs.Access.NOT_GRANTED, onTop = true, restarted = true)!!.contains(DeviceLogs.GRANT))
    }

    @Test fun logsJsonHasDocsLogsMdsShape() {
        val copy = DeviceLogs.Copy(123_456, "a".repeat(64), truncated = false, uids = setOf("10123"))
        val full = DeviceLogs.summary(copy, 1_763_290_000_123, 1_763_290_160_456, "device", null, mapOf("10123" to "com.example.browser"))
        assertEquals(listOf("version", "bytes", "sha256", "zeroAt", "readAt", "scope", "truncated", "packages"), full.keys.toList())
        assertEquals(1, full["version"])
        assertEquals(123_456L, full["bytes"])
        assertEquals(1_763_290_000_123, full["zeroAt"])
        assertEquals(mapOf("10123" to "com.example.browser"), full["packages"])
        val app = DeviceLogs.summary(copy, 1, 2, "app", "why", emptyMap(), error = "e".repeat(400))
        assertEquals(listOf("version", "bytes", "sha256", "zeroAt", "readAt", "scope", "truncated", "note", "error"), app.keys.toList())
        assertEquals(300, (app["error"] as String).length)
    }
}
