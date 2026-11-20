package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Which take the four switches make, and the words under a launch's keys (docs/LOGS.md, 2026-11-16). */
class TakesTest {
    private fun s(screen: Boolean, mic: Boolean, app: Boolean, logs: Boolean) = TakeSwitches(screen, mic, app, logs)

    @Test fun theScreenMakesAVideoElseTheMicSoundElseLogsElseNothing() {
        for (mic in listOf(true, false)) for (app in listOf(true, false)) for (logs in listOf(true, false)) {
            assertEquals(TakeKind.VIDEO, s(true, mic, app, logs).kind)
        }
        for (app in listOf(true, false)) for (logs in listOf(true, false)) assertEquals(TakeKind.SOUND, s(false, true, app, logs).kind)
        for (app in listOf(true, false)) assertEquals(TakeKind.LOGS, s(false, false, app, true).kind)
        // App sound alone records nothing: it rides on the screen capture.
        assertEquals(TakeKind.NONE, s(false, false, true, false).kind)
        assertEquals(TakeKind.NONE, s(false, false, false, false).kind)
    }

    @Test fun appSoundNeedsTheScreenAndCountsAsOffWithoutIt() {
        assertTrue(s(true, true, true, true).app)
        assertFalse(s(false, true, true, true).app)
        assertFalse(s(true, true, true, true).changed)
        // Screen off: App sound is off too, whatever its own switch remembers, so Settings shows its dot.
        assertTrue(s(false, true, true, true).changed)
        assertTrue(s(true, true, true, false).changed)
    }

    @Test fun theWordsSayWhatTheTakeLeavesOut() {
        assertEquals("records", s(true, true, true, true).records())
        assertEquals("records without the logs", s(true, true, true, false).records())
        assertEquals("records without the mic", s(true, false, true, true).records())
        assertEquals("records without the app's sound or the logs", s(true, true, false, false).records())
        assertEquals("records the picture only", s(true, false, false, false).records())
        assertEquals("records the picture and the logs, without sound", s(true, false, false, true).records())
        assertEquals("records the mic and the logs, without the picture", s(false, true, true, true).records())
        assertEquals("records the mic only, without the picture", s(false, true, false, false).records())
        assertEquals("records logs only", s(false, false, true, true).records())
        assertEquals("records nothing", s(false, false, true, false).records())
    }

    @Test fun aRunsKindIsReadFailClosedToTheVideoItAlwaysWas() {
        assertEquals(TakeKind.LOGS, TakeKind.of("logs"))
        assertEquals(TakeKind.SOUND, TakeKind.of("sound"))
        assertEquals(TakeKind.VIDEO, TakeKind.of("video"))
        assertEquals(TakeKind.VIDEO, TakeKind.of(null))
        assertEquals(TakeKind.VIDEO, TakeKind.of(""))
        // "none" never names a run: a take with nothing on is never started.
        assertEquals(TakeKind.VIDEO, TakeKind.of("none"))
        assertEquals(TakeKind.VIDEO, TakeKind.of("hologram"))
    }

    @Test fun eachKindHasItsMediaFileAndItsWordsInPlaceOfThePicture() {
        val dir = File("runs/20261116-101500")
        assertEquals(File(dir, "video.mp4"), Recording.mediaOf(dir, TakeKind.VIDEO))
        assertEquals(File(dir, "audio.m4a"), Recording.mediaOf(dir, TakeKind.SOUND))
        assertNull(Recording.mediaOf(dir, TakeKind.LOGS))
        assertNull(Recording.withoutPicture(TakeKind.VIDEO))
        assertEquals("Sound only", Recording.withoutPicture(TakeKind.SOUND))
        assertEquals("Logs only", Recording.withoutPicture(TakeKind.LOGS))
    }

    @Test fun aThreadsRecordingContentIsReadFailClosed() {
        assertEquals("sound", Threads.content("sound"))
        assertEquals("none", Threads.content("none"))
        assertEquals("video", Threads.content("video"))
        assertEquals("video", Threads.content(null))
        assertEquals("video", Threads.content("hologram"))
    }
}
