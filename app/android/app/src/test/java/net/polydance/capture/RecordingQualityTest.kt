package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test

class RecordingQualityTest {
    @Test fun mediumIsTheDefaultAndWhatTakesHadBefore() {
        val medium = RecordingQuality.DEFAULT
        assertEquals(RecordingQuality.MEDIUM, medium)
        assertEquals(listOf(1920, 1080, 8_000_000), listOf(medium.width, medium.height, medium.bitrate))
    }

    @Test fun highAndLowAreEitherSideOfMedium() {
        val (low, medium, high) = RecordingQuality.entries
        assertTrue(low.bitrate < medium.bitrate && medium.bitrate < high.bitrate)
        assertEquals(1280 to 720, low.width to low.height)
        assertEquals(1920 to 1080, high.width to high.height)
        assertEquals(16_000_000, high.bitrate)
    }

    @Test fun parsesOnlyTheThreeKeys() {
        assertEquals(RecordingQuality.HIGH, RecordingQuality.parse("high"))
        assertEquals(RecordingQuality.LOW, RecordingQuality.parse("low"))
        assertNull(RecordingQuality.parse("HIGH"))
        assertNull(RecordingQuality.parse("ultra"))
        assertNull(RecordingQuality.parse(null))
    }

    @Test fun theOldSizeSettingCarriesOver() {
        assertEquals(RecordingQuality.MEDIUM, RecordingQuality.remembered(null, null))
        assertEquals(RecordingQuality.MEDIUM, RecordingQuality.remembered(null, 0)) // 1920 × 1080
        assertEquals(RecordingQuality.LOW, RecordingQuality.remembered(null, 1)) // 1280 × 720
        assertEquals(RecordingQuality.MEDIUM, RecordingQuality.remembered(null, 2)) // 1024 × 1024, no longer offered
        // Once chosen, the new setting wins over the old one.
        assertEquals(RecordingQuality.HIGH, RecordingQuality.remembered("high", 1))
        assertEquals(RecordingQuality.MEDIUM, RecordingQuality.remembered("bogus", 0))
    }

    @Test fun eachSaysItsSizeAndBitrate() {
        assertTrue(RecordingQuality.LOW.detail.startsWith("1280 × 720 at 4 Mbit/s."))
        assertTrue(RecordingQuality.HIGH.detail.startsWith("1920 × 1080 at 16 Mbit/s."))
    }
}
