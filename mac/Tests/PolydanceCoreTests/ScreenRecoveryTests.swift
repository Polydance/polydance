// C14 and C15 without a screen or a full disk: which stops of the screen capture are tried again, how
// often and how far apart, the gaps they leave for the metadata, and when low free space is told. The
// errors are ScreenCaptureKit's own codes (SCError.h); the case of 2026-11-11 is -3821, "Stream was
// stopped by the system", 18:31 into a call.
import Foundation
import PolydanceCore
import XCTest

final class ScreenRecoveryTests: XCTestCase {
    let domain = ScreenStopCause.errorDomain
    let stoppedBySystem = "Stream was stopped by the system"

    func testErrorsAreSortedByWhatStoppedTheStream() {
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3821), .system)
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3805), .interrupted)
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3804), .interrupted)
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3811), .interrupted)
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3817), .user)
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3801), .permission)
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3803), .permission)
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3815), .display)
        XCTAssertEqual(ScreenStopCause(domain: domain, code: -3999), .other)
        XCTAssertEqual(ScreenStopCause(domain: NSCocoaErrorDomain, code: -3821), .other, "the code means something only in ScreenCaptureKit's domain")
        XCTAssertTrue(ScreenStopCause.system.restartable)
        XCTAssertTrue(ScreenStopCause.interrupted.restartable)
        for cause in [ScreenStopCause.user, .permission, .display, .other] { XCTAssertFalse(cause.restartable, "\(cause)") }
    }

    /// 2026-11-11: stopped by the system at 18:31; with the restart the picture is back on the first try.
    func testAStopByTheSystemIsTriedAgainAndTheGapEndsAtTheFirstFrame() {
        var recovery = ScreenRecovery()
        XCTAssertFalse(recovery.isOpen)
        XCTAssertEqual(recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: 1_111_000, allowed: true),
                       .retry(after: ScreenRecovery.waits[0], attempt: 1, of: ScreenRecovery.waits.count))
        XCTAssertTrue(recovery.isOpen)
        XCTAssertEqual(recovery.gaps, [VideoGap(fromMs: 1_111_000, reason: stoppedBySystem)])
        recovery.resumed(atMs: 1_114_500)
        XCTAssertFalse(recovery.isOpen)
        XCTAssertEqual(recovery.gaps, [VideoGap(fromMs: 1_111_000, toMs: 1_114_500, reason: stoppedBySystem)])
        XCTAssertEqual(recovery.attempts, 0)
        XCTAssertNil(recovery.gaveUp)
    }

    func testFailedTriesWaitLongerEachTimeThenLetGo() {
        var recovery = ScreenRecovery()
        var waits = [Double]()
        if case .retry(let after, _, _) = recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: 5_000, allowed: true) { waits.append(after) }
        while case .retry(let after, _, _) = recovery.tryFailed(reason: "The stream failed to start", allowed: true) { waits.append(after) }
        XCTAssertEqual(waits, ScreenRecovery.waits)
        XCTAssertEqual(waits, waits.sorted(), "each wait is at least as long as the one before")
        XCTAssertEqual(recovery.gaveUp, "5 tries to start it again failed, the last with: The stream failed to start")
        XCTAssertTrue(recovery.isOpen, "a gap that never ended has no toMs")
        XCTAssertEqual(recovery.gaps.count, 1)
        // Once let go, nothing starts it again.
        XCTAssertEqual(recovery.tryFailed(reason: "again", allowed: true), .giveUp(recovery.gaveUp!))
        XCTAssertEqual(recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: 9_000, allowed: true), .giveUp(recovery.gaveUp!))
    }

    /// 2026-11-13: macOS took 5.9 s to start the stream (its screen-recording prompt), past the 5 s
    /// deadline. The picture is black from 0 and the late stream's first frame ends the gap.
    func testALateFirstStartIsAGapFromTheStartThatItsFirstFrameEnds() throws {
        var recovery = ScreenRecovery()
        recovery.startingLate(afterSeconds: 5)
        XCTAssertTrue(recovery.isOpen)
        XCTAssertEqual(recovery.attempts, 0, "the first start is still under way: no try is planned")
        let reason = ScreenRecovery.lateReason(afterSeconds: 5)
        XCTAssertEqual(reason, "screen capture took over 5 s to start; macOS may have been asking to allow screen recording", "whole, within the contract's 120")
        XCTAssertEqual(recovery.gaps, [VideoGap(fromMs: 0, reason: reason)])
        recovery.resumed(atMs: 900)
        XCTAssertFalse(recovery.isOpen)
        XCTAssertEqual(recovery.gaps, [VideoGap(fromMs: 0, toMs: 900, reason: reason)])
        XCTAssertNil(recovery.gaveUp)

        // What the metadata says: the screen recorded, black for its first 0.9 s, and the contract takes it.
        let facts = RecordingFacts(mode: .call(meetingCode: "abc-defg-hij"), startedAt: Date(timeIntervalSince1970: 1_800_000_000),
                                   endedAt: Date(timeIntervalSince1970: 1_800_000_600), videoRecorded: true, videoGaps: recovery.gaps)
        let meta = facts.meta()
        XCTAssertEqual(meta.call?.video, .recorded)
        XCTAssertEqual(meta.call?.videoGaps, [VideoGap(fromMs: 0, toMs: 900, reason: reason)])
        XCTAssertNoThrow(try RecordingMeta.decode(try meta.encoded()))
    }

    /// Only the first start can be late: once the picture has stopped or been let go, it opens nothing.
    func testALateStartIsOnlyEverTheFirstGap() {
        var recovery = ScreenRecovery()
        _ = recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: 5_000, allowed: true)
        recovery.startingLate(afterSeconds: 5)
        XCTAssertEqual(recovery.gaps, [VideoGap(fromMs: 5_000, reason: stoppedBySystem)])
        XCTAssertEqual(recovery.attempts, 1)
    }

    /// A late start that fails is a failed try: tried again when the error is one that passes, let go
    /// when capture was refused (the prompt answered no) or the error is not one that is tried again.
    func testALateStartThatFailsIsAFailedTry() {
        var tried = ScreenRecovery()
        tried.startingLate(afterSeconds: 5)
        XCTAssertEqual(tried.stopped(cause: .interrupted, reason: "The stream failed to start", atMs: 7_000, allowed: true),
                       .retry(after: ScreenRecovery.waits[0], attempt: 1, of: ScreenRecovery.waits.count))
        XCTAssertEqual(tried.gaps.count, 1, "the same gap, from 0")

        var refused = ScreenRecovery()
        refused.startingLate(afterSeconds: 5)
        XCTAssertEqual(refused.stopped(cause: .permission, reason: "The user declined", atMs: 7_000, allowed: false),
                       .giveUp("screen recording is no longer allowed for Polydance"))
        XCTAssertTrue(refused.isOpen, "black from 0 to the end")

        var notAllowedNow = ScreenRecovery()
        notAllowedNow.startingLate(afterSeconds: 5)
        XCTAssertEqual(notAllowedNow.stopped(cause: .system, reason: stoppedBySystem, atMs: 7_000, allowed: false),
                       .giveUp("screen recording is no longer allowed for Polydance"))
    }

    /// A restarted stream that stops again before its first frame is the same gap, one try further on.
    func testAStopBeforeTheFirstFrameBackIsAFailedTry() {
        var recovery = ScreenRecovery()
        _ = recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: 5_000, allowed: true)
        XCTAssertEqual(recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: 8_000, allowed: true),
                       .retry(after: ScreenRecovery.waits[1], attempt: 2, of: ScreenRecovery.waits.count))
        XCTAssertEqual(recovery.gaps, [VideoGap(fromMs: 5_000, reason: stoppedBySystem)])
    }

    func testTheUserThePermissionAndAGoneDisplayAreNotTriedAgain() {
        let cases: [(ScreenStopCause, String)] = [
            (.user, "it was stopped from macOS's screen-sharing controls"),
            (.permission, "screen recording is no longer allowed for Polydance"),
            (.display, "the recorded display is gone"),
            (.other, "that error is not one that is tried again"),
        ]
        for (cause, why) in cases {
            var recovery = ScreenRecovery()
            XCTAssertEqual(recovery.stopped(cause: cause, reason: "stopped", atMs: 60_000, allowed: true), .giveUp(why), "\(cause)")
            XCTAssertEqual(recovery.gaps, [VideoGap(fromMs: 60_000, reason: "stopped")], "the gap is noted whatever stopped it")
        }
        // Stopped by the system, but the screen permission was withdrawn meanwhile.
        var recovery = ScreenRecovery()
        XCTAssertEqual(recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: 1, allowed: false),
                       .giveUp("screen recording is no longer allowed for Polydance"))
        var later = ScreenRecovery()
        _ = later.stopped(cause: .system, reason: stoppedBySystem, atMs: 1, allowed: true)
        XCTAssertEqual(later.tryFailed(reason: "x", allowed: false), .giveUp("screen recording is no longer allowed for Polydance"))
    }

    /// A picture macOS keeps stopping is let go after maxGaps restarts, and every gap is kept.
    func testARecordingWhosePictureKeepsStoppingIsLetGo() {
        var recovery = ScreenRecovery()
        for n in 0..<ScreenRecovery.maxGaps {
            guard case .retry = recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: n * 10_000, allowed: true) else {
                return XCTFail("gap \(n + 1) should be tried again")
            }
            recovery.resumed(atMs: n * 10_000 + 4_000)
        }
        XCTAssertEqual(recovery.stopped(cause: .system, reason: stoppedBySystem, atMs: 99_000, allowed: true),
                       .giveUp("it had stopped \(ScreenRecovery.maxGaps + 1) times"))
        XCTAssertEqual(recovery.gaps.count, ScreenRecovery.maxGaps + 1)
        XCTAssertEqual(recovery.gaps.filter { $0.toMs == nil }.count, 1)
        XCTAssertLessThanOrEqual(recovery.gaps.count, RecordingMeta.maxVideoGaps, "every gap fits the contract")
    }

    func testAGapsReasonFitsTheContract() throws {
        var recovery = ScreenRecovery()
        _ = recovery.stopped(cause: .system, reason: String(repeating: "w", count: 500), atMs: 1, allowed: true)
        _ = recovery.stopped(cause: .other, reason: "  ", atMs: 2, allowed: true)
        XCTAssertEqual(recovery.gaps.first?.reason.count, RecordingMeta.maxGapReasonLength)
        recovery.resumed(atMs: 0)
        XCTAssertEqual(recovery.gaps.first?.toMs, 1, "a gap never ends before it began")
        var other = ScreenRecovery()
        _ = other.stopped(cause: .other, reason: " \n", atMs: 2, allowed: true)
        XCTAssertEqual(other.gaps.first?.reason, "the screen capture stopped")
        // The recovery's gaps go into metadata that validates.
        let facts = RecordingFacts(mode: .call(meetingCode: "abc-defg-hij"), startedAt: Date(), videoRecorded: true, videoGaps: recovery.gaps + other.gaps)
        XCTAssertNoThrow(try facts.meta().encoded())
    }

    // MARK: C15

    func testLowFreeSpaceIsToldOncePerRecording() {
        var watch = DiskSpaceWatch()
        XCTAssertFalse(watch.isLow)
        XCTAssertNil(watch.warning)
        XCTAssertFalse(watch.observe(freeBytes: 120_000_000_000), "plenty of room")
        XCTAssertNil(watch.warning)
        // The level at which the 2026-11-11 purge stopped the screen is under the threshold.
        XCTAssertTrue(watch.observe(freeBytes: 22_223_126_528))
        XCTAssertEqual(watch.warning?.hasPrefix("Only 22 GB free on this Mac."), true)
        XCTAssertFalse(watch.observe(freeBytes: 21_000_000_000), "told once per recording")
        XCTAssertTrue(watch.isLow)
        XCTAssertFalse(watch.observe(freeBytes: 40_000_000_000))
        XCTAssertNil(watch.warning, "the menu's line goes once there is room again")
        XCTAssertFalse(watch.observe(freeBytes: 5_000_000_000), "still once per recording")
        XCTAssertEqual(watch.warning?.hasPrefix("Only 5.0 GB free"), true)
        XCTAssertGreaterThan(DiskSpaceWatch.lowBytes, 22_223_126_528)
    }

    func testFreeSpaceIsReadFromTheVolume() throws {
        let free = try XCTUnwrap(DiskSpaceWatch.freeBytes(atPath: NSTemporaryDirectory()))
        XCTAssertGreaterThan(free, 0)
        XCTAssertNil(DiskSpaceWatch.freeBytes(atPath: "/no/such/place/\(UUID().uuidString)"))
        XCTAssertEqual(DiskSpaceWatch.gigabytes(22_747_385_856), "22 GB")
        XCTAssertEqual(DiskSpaceWatch.gigabytes(4_560_000_000), "4.5 GB")
        XCTAssertEqual(DiskSpaceWatch.gigabytes(-1), "0.0 GB")
    }
}
