// How an upload's progress is measured and said (docs/IPHONE.md S5): the rate over the window, the time
// left, the stall, and the words.
import Foundation
import Testing
@testable import PolydancePhoneCore

@Suite struct UploadMeterTests {
    @Test func rateIsOverTheLastHalfMinute() {
        var meter = UploadMeter()
        meter.record(0, at: 100)
        #expect(meter.rate(at: 101) == nil)   // not settled yet
        // 2 MB a second for a minute, then 1 MB a second for half a minute.
        for s in 1...60 { meter.record(Int64(s) * 2_000_000, at: 100 + Double(s)) }
        #expect(meter.rate(at: 160) == 2_000_000)
        for s in 1...30 { meter.record(120_000_000 + Int64(s) * 1_000_000, at: 160 + Double(s)) }
        #expect(meter.rate(at: 190) == 1_000_000)
        #expect(meter.samples.count <= 32)
    }

    @Test func manyReportsASecondKeepFewSamples() {
        var meter = UploadMeter()
        // 1 MB a second for a minute, reported every millisecond.
        for ms in 0...60_000 { meter.record(Int64(ms) * 1_000, at: Double(ms) / 1000) }
        #expect(meter.samples.count <= 125)
        #expect(meter.samples.last?.sent == 60_000_000)
        let rate = meter.rate(at: 60)!
        #expect(abs(rate - 1_000_000) < 20_000)
    }

    @Test func aPauseLowersTheRateAndThenStalls() {
        var meter = UploadMeter()
        for s in 0...10 { meter.record(Int64(s) * 1_000_000, at: Double(s)) }
        #expect(meter.stalled(at: 20) == nil)
        // The same count again is not movement.
        meter.record(10_000_000, at: 25)
        #expect(meter.stalled(at: 30) == 20)
        #expect(meter.stalled(at: 52.5) == 42)
        // 10 MB over the 30 s behind it, then nothing at all over the window.
        #expect(meter.rate(at: 30)! > 333_000 && meter.rate(at: 30)! < 334_000)
        #expect(meter.rate(at: 40) == 0)
        meter.record(11_000_000, at: 53)
        #expect(meter.stalled(at: 53) == nil)
    }

    @Test func aRangeSentAgainStartsTheRateOverButIsNotMovement() {
        var meter = UploadMeter()
        meter.record(0, at: 0)
        meter.record(8_000_000, at: 4)
        meter.record(12_000_000, at: 6)
        // The connection dropped mid-chunk: back to the confirmed 8 MB.
        meter.record(8_000_000, at: 30)
        #expect(meter.rate(at: 31) == nil)
        #expect(meter.stalled(at: 30) == 24)
        meter.record(9_000_000, at: 34)
        #expect(meter.stalled(at: 34) == nil)
        #expect(meter.rate(at: 34) == 250_000)
    }

    @Test func wordsForAVideoOnItsWay() {
        let p = UploadProgress(stage: .video, sent: 460_400_000, total: 1_087_200_000, rate: 2_100_000)
        #expect(p.percent == "42%")
        #expect(p.amount == "460 of 1,087 MB")
        #expect(p.secondsLeft == 299)
        #expect(p.pace == "2.1 MB/s · about 5 min left")
        #expect(p.line == "42% · 460 of 1,087 MB · 2.1 MB/s · about 5 min left")
        #expect(!p.isStuck)
    }

    @Test func neverSaysAllBeforeItIsAll() {
        #expect(UploadProgress(stage: .video, sent: 999, total: 1000).percent == "99%")
        #expect(UploadProgress(stage: .video, sent: 5, total: 0).fraction == 0)
    }

    @Test func wordsForAStuckUpload() {
        let p = UploadProgress(stage: .video, sent: 8_000_000, total: 61_400_000, rate: 100_000, stalledSeconds: 40, waiting: "waiting for Wi-Fi")
        #expect(p.isStuck)
        #expect(p.secondsLeft == nil)
        #expect(p.line == "13% · 8.0 of 61 MB · nothing sent for 40 s · waiting for Wi-Fi")
        let retry = UploadProgress(stage: .video, sent: 0, total: 9_800_000, waiting: "sending again in 25 s")
        #expect(retry.pace == "sending again in 25 s")
    }

    @Test func wordsBeforeTheVideo() {
        #expect(UploadProgress(stage: .preparing).line == "getting the take ready to send")
        #expect(UploadProgress(stage: .words, sent: 3_100_000, total: 14_000_000).line == "sending the words first · 3.1 of 14 MB")
    }

    @Test func durations() {
        #expect(UploadProgress.duration(40) == "40 s")
        #expect(UploadProgress.duration(60) == "1 min")
        #expect(UploadProgress.duration(61) == "2 min")
        #expect(UploadProgress.duration(3600) == "1 h")
        #expect(UploadProgress.duration(4320) == "1 h 12 min")
    }
}
