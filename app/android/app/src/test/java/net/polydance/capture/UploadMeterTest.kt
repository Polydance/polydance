package net.polydance.capture

import org.junit.Assert.*
import org.junit.Test

/**
 * How an upload's progress is measured and said: the iPhone's UploadMeterTests
 * (ios/Core/Tests/PolydancePhoneCoreTests/UploadMeterTests.swift), ported case for case so the headset's words
 * are the iPhone's, then what UploadLive adds between the worker and the inbox.
 */
class UploadMeterTest {
    @Test fun rateIsOverTheLastHalfMinute() {
        val meter = UploadMeter()
        meter.record(0, 100.0)
        assertNull(meter.rate(101.0)) // not settled yet
        // 2 MB a second for a minute, then 1 MB a second for half a minute.
        for (s in 1..60) meter.record(s * 2_000_000L, 100.0 + s)
        assertEquals(2_000_000.0, meter.rate(160.0)!!, 0.0)
        for (s in 1..30) meter.record(120_000_000L + s * 1_000_000L, 160.0 + s)
        assertEquals(1_000_000.0, meter.rate(190.0)!!, 0.0)
        assertTrue(meter.samples.size <= 32)
    }

    @Test fun manyReportsASecondKeepFewSamples() {
        val meter = UploadMeter()
        // 1 MB a second for a minute, reported every millisecond.
        for (ms in 0..60_000) meter.record(ms * 1_000L, ms / 1000.0)
        assertTrue(meter.samples.size <= 125)
        assertEquals(60_000_000L, meter.samples.last().sent)
        assertEquals(1_000_000.0, meter.rate(60.0)!!, 20_000.0)
    }

    @Test fun aPauseLowersTheRateAndThenStalls() {
        val meter = UploadMeter()
        for (s in 0..10) meter.record(s * 1_000_000L, s.toDouble())
        assertNull(meter.stalled(20.0))
        // The same count again is not movement.
        meter.record(10_000_000, 25.0)
        assertEquals(20, meter.stalled(30.0))
        assertEquals(42, meter.stalled(52.5))
        // 10 MB over the 30 s behind it, then nothing at all over the window.
        val rate = meter.rate(30.0)!!
        assertTrue(rate > 333_000 && rate < 334_000)
        assertEquals(0.0, meter.rate(40.0)!!, 0.0)
        meter.record(11_000_000, 53.0)
        assertNull(meter.stalled(53.0))
    }

    @Test fun aRangeSentAgainStartsTheRateOverButIsNotMovement() {
        val meter = UploadMeter()
        meter.record(0, 0.0)
        meter.record(8_000_000, 4.0)
        meter.record(12_000_000, 6.0)
        // The connection dropped mid-chunk: back to the confirmed 8 MB.
        meter.record(8_000_000, 30.0)
        assertNull(meter.rate(31.0))
        assertEquals(24, meter.stalled(30.0))
        meter.record(9_000_000, 34.0)
        assertNull(meter.stalled(34.0))
        assertEquals(250_000.0, meter.rate(34.0)!!, 0.0)
    }

    @Test fun wordsForAVideoOnItsWay() {
        val p = UploadProgress(UploadProgress.Stage.VIDEO, sent = 460_400_000, total = 1_087_200_000, rate = 2_100_000.0)
        assertEquals("42%", p.percent)
        assertEquals("460 of 1,087 MB", p.amount)
        assertEquals(299, p.secondsLeft)
        assertEquals("2.1 MB/s · about 5 min left", p.pace)
        assertEquals("42% · 460 of 1,087 MB · 2.1 MB/s · about 5 min left", p.line)
        assertEquals("460 of 1,087 MB · 2.1 MB/s · about 5 min left", p.detail)
        assertFalse(p.isStuck)
    }

    @Test fun neverSaysAllBeforeItIsAll() {
        assertEquals("99%", UploadProgress(UploadProgress.Stage.VIDEO, sent = 999, total = 1000).percent)
        assertEquals(0.0, UploadProgress(UploadProgress.Stage.VIDEO, sent = 5, total = 0).fraction, 0.0)
    }

    @Test fun wordsForAStuckUpload() {
        val p = UploadProgress(UploadProgress.Stage.VIDEO, sent = 8_000_000, total = 61_400_000, rate = 100_000.0, stalledSeconds = 40, waiting = "waiting for Wi-Fi")
        assertTrue(p.isStuck)
        assertNull(p.secondsLeft)
        assertEquals("13% · 8.0 of 61 MB · nothing sent for 40 s · waiting for Wi-Fi", p.line)
        val retry = UploadProgress(UploadProgress.Stage.VIDEO, sent = 0, total = 9_800_000, waiting = "sending again in 25 s")
        assertEquals("sending again in 25 s", retry.pace)
    }

    @Test fun wordsBeforeTheVideo() {
        assertEquals("getting the take ready to send", UploadProgress(UploadProgress.Stage.PREPARING).line)
        assertEquals("getting the take ready to send", UploadProgress(UploadProgress.Stage.PREPARING).detail)
        assertEquals("sending the words first · 3.1 of 14 MB", UploadProgress(UploadProgress.Stage.WORDS, sent = 3_100_000, total = 14_000_000).line)
        // The headsets' logs go before anything else (docs/LOGS.md); the whole of a take of logs alone.
        assertEquals("sending the logs · 0.4 of 2.0 MB", UploadProgress(UploadProgress.Stage.LOGS, sent = 400_000, total = 2_000_000).line)
        assertEquals("sending the logs · 0.4 of 2.0 MB", UploadProgress(UploadProgress.Stage.LOGS, sent = 400_000, total = 2_000_000).detail)
    }

    @Test fun durations() {
        assertEquals("40 s", UploadProgress.duration(40))
        assertEquals("1 min", UploadProgress.duration(60))
        assertEquals("2 min", UploadProgress.duration(61))
        assertEquals("1 h", UploadProgress.duration(3600))
        assertEquals("1 h 12 min", UploadProgress.duration(4320))
    }

    /** Swift's String(format: "%.1f"), checked on the Mac 2026-11-15: 2.2 0.1 9.9 2.4. Java's %.1f says 2.3 and 10.0. */
    @Test fun oneDecimalRoundsAsTheIPhoneDoes() {
        assertEquals(listOf("2.2", "0.1", "9.9", "2.4"), listOf(2.25, 0.05, 9.95, 2.35).map { UploadProgress.oneDecimal(it) })
        assertEquals("9.9", UploadProgress.megabytes(9_950_000))
        assertEquals("2.2 MB/s", UploadProgress(UploadProgress.Stage.VIDEO, total = 100, rate = 2_250_000.0, stalledSeconds = null).pace?.substringBefore(" ·"))
    }

    // ---- UploadLive: the worker's reports and upload.json, as the inbox reads them.

    private val sending = UploadState(state = "uploading", sha256 = "ab", bytes = 61_400_000, sent = 8_388_608, uploadId = "u1")

    @Test fun theWorkerPreparingSaysSo() {
        UploadLive.preparing("t1")
        assertEquals(UploadProgress(UploadProgress.Stage.PREPARING), UploadLive.progress("t1", UploadState(state = "waiting"), true, 0.0, 0))
        UploadLive.forget("t1")
    }

    @Test fun bytesInFlightMoveTheShareBetweenChunks() {
        UploadLive.sending("t2", UploadProgress.Stage.VIDEO, 8_388_608, 61_400_000, 0.0)
        UploadLive.sending("t2", UploadProgress.Stage.VIDEO, 12_000_000, 61_400_000, 4.0)
        val p = UploadLive.progress("t2", sending, true, 4.0, 0)!!
        assertEquals(12_000_000L, p.sent)
        assertEquals("19%", p.percent)
        assertEquals(903_000.0, p.rate!!, 1_000.0)
        assertFalse(p.isStuck)
        UploadLive.forget("t2")
    }

    @Test fun theWordsGoFirstWithTheirOwnSize() {
        UploadLive.sending("t3", UploadProgress.Stage.WORDS, 3_100_000, 14_000_000, 0.0)
        val p = UploadLive.progress("t3", sending.copy(sent = 0), true, 1.0, 0)!!
        assertEquals("sending the words first · 3.1 of 14 MB", p.line)
        UploadLive.forget("t3")
    }

    @Test fun aRetrysWaitCountsDownThenWaitsForTheNetwork() {
        UploadLive.sending("t4", UploadProgress.Stage.VIDEO, 9_000_000, 61_400_000, 0.0)
        val waiting = sending.copy(state = "waiting", error = "retrying: timeout")
        // The request in flight is lost: back to the confirmed 8 MB, and WorkManager goes again in 30 s.
        UploadLive.settled("t4", waiting, 10.0 + UploadLive.retryDelay(0), 10.0)
        val p = UploadLive.progress("t4", waiting, true, 15.0, 0)!!
        assertEquals(8_388_608L, p.sent)
        assertEquals("sending again in 25 s", p.waiting)
        assertTrue(p.isStuck)
        // Past the retry with no Wi-Fi, WorkManager waits for the network.
        val later = UploadLive.progress("t4", waiting, false, 50.0, 0)!!
        assertEquals("13% · 8.4 of 61 MB · nothing sent for 50 s · waiting for Wi-Fi", later.line)
        UploadLive.forget("t4")
    }

    @Test fun notUnderWayIsNothing() {
        assertNull(UploadLive.progress("t5", UploadState(state = "waiting", holdUntil = 2_000), true, 0.0, 1_000))
        assertNull(UploadLive.progress("t5", UploadState(state = "waiting"), true, 0.0, 0)) // queued, never hashed
        assertNull(UploadLive.progress("t5", sending.copy(state = "uploaded"), true, 0.0, 0))
        assertNull(UploadLive.progress("t5", sending.copy(state = "failed"), true, 0.0, 0))
        // Sent, failed or deleted, the worker's report is forgotten.
        UploadLive.sending("t5", UploadProgress.Stage.VIDEO, 9_000_000, 61_400_000, 0.0)
        UploadLive.settled("t5", sending.copy(state = "uploaded"), null, 1.0)
        assertEquals(8_388_608L, UploadLive.progress("t5", sending, true, 2.0, 0)!!.sent)
        UploadLive.forget("t5")
    }

    @Test fun firstSightAfterALaunchStartsTheStallClock() {
        assertNull(UploadLive.progress("t6", sending, true, 100.0, 0)!!.stalledSeconds)
        assertEquals("nothing sent for 20 s", UploadLive.progress("t6", sending, true, 120.0, 0)!!.pace)
        UploadLive.forget("t6")
    }

    @Test fun backoffIsWorkManagersDoubling() {
        assertEquals(listOf(30.0, 60.0, 120.0, 240.0), (0..3).map { UploadLive.retryDelay(it) })
        assertEquals(5 * 3600.0, UploadLive.retryDelay(20), 0.0)
    }
}
