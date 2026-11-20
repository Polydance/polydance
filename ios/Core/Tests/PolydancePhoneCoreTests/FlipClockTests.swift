// The flip's gap and camera spans as the capture sink measures them (FlipClock), fed the frames a flip
// gives on the phone: the old camera's last frames still arriving after the swap, the new camera's first
// frames dropped for their size, a flip pressed before the take's first frame, and a second flip while the
// first still waits. The real camera's timing is I0's to find out on the phone.
import Foundation
import Testing
@testable import PolydancePhoneCore

@Suite struct FlipClockTests {
    static let start = 1000.0
    static let frame = 1.0 / 30

    /// Feeds frames at `times` (seconds after `start`) from `facing`, all written.
    func feed(_ clock: inout FlipClock, _ times: [Double], _ facing: String, written: Bool = true) -> [FlipClock.Report] {
        times.compactMap { clock.frame(pts: Self.start + $0, written: written, facing: facing, sessionStart: Self.start) }
    }

    @Test func theGapRunsFromTheLastWrittenFrameOfAnyCamera() {
        var clock = FlipClock()
        #expect(feed(&clock, (0...45).map { Double($0) * Self.frame }, "back").isEmpty)
        clock.expect("front")
        // The back camera's last two frames arrive after the swap: they are written and move the gap's start.
        #expect(feed(&clock, [46 * Self.frame, 47 * Self.frame], "back").isEmpty)
        // The front camera's first frames are the wrong size and never written: they do not end the gap.
        #expect(feed(&clock, [1.80, 1.833], "front", written: false).isEmpty)
        let firstFront = 47 * Self.frame + 0.3
        let reports = feed(&clock, [firstFront, firstFront + Self.frame], "front")
        #expect(reports == [FlipClock.Report(facing: "front", gapMs: 300, atMs: 1867)])
        #expect(clock.awaited == nil)
    }

    @Test func aFlipBeforeAnyFrameIsWhereTheFileBegins() {
        var clock = FlipClock()
        clock.expect("front")
        // The back camera's frames before the swap were never written (the take had not begun).
        #expect(feed(&clock, [0, Self.frame], "back", written: false).isEmpty)
        let report = clock.frame(pts: Self.start + 0.1, written: true, facing: "front", sessionStart: Self.start + 0.1)
        #expect(report == FlipClock.Report(facing: "front", gapMs: nil, atMs: 0))
        var cameras = [CameraSpan(atMs: 0, facing: "back")]
        var gaps: [Int] = []
        report?.apply(cameras: &cameras, flipGapsMs: &gaps)
        #expect(cameras == [CameraSpan(atMs: 0, facing: "front")], "the camera named at REC wrote nothing")
        #expect(gaps.isEmpty, "no gap was measured")
    }

    @Test func eachFlipAddsItsSpanAndGap() {
        var clock = FlipClock()
        var cameras = [CameraSpan(atMs: 0, facing: "back")]
        var gaps: [Int] = []
        _ = feed(&clock, [0, 0.5, 1.0], "back")
        clock.expect("front")
        feed(&clock, [1.4, 2.0], "front").forEach { $0.apply(cameras: &cameras, flipGapsMs: &gaps) }
        clock.expect("back")
        feed(&clock, [2.25, 3.0], "back").forEach { $0.apply(cameras: &cameras, flipGapsMs: &gaps) }
        #expect(cameras == [CameraSpan(atMs: 0, facing: "back"), CameraSpan(atMs: 1400, facing: "front"), CameraSpan(atMs: 2250, facing: "back")])
        #expect(gaps == [400, 250])
    }

    @Test func aSecondFlipReplacesOneStillWaitingAndSaysSo() {
        var clock = FlipClock()
        _ = feed(&clock, [0, 0.5], "back")
        #expect(clock.expect("front") == nil)
        #expect(clock.expect("back") == "front", "the front camera's flip will never be reported")
        #expect(clock.expect("back") == nil, "asking again for the same camera abandons nothing")
        // No front frame arrives; the back camera's next frame ends the second flip's gap.
        #expect(feed(&clock, [0.9], "back") == [FlipClock.Report(facing: "back", gapMs: 400, atMs: 900)])
        // Stopping the wait reports nothing more.
        clock.expect("front")
        clock.expect(nil)
        #expect(feed(&clock, [1.0], "front").isEmpty)
    }

    @Test func aFrameWithNoCameraOrNoClockNeverReports() {
        var clock = FlipClock()
        clock.expect("front")
        #expect(clock.frame(pts: Self.start, written: true, facing: nil, sessionStart: Self.start) == nil)
        #expect(clock.frame(pts: .nan, written: true, facing: "front", sessionStart: Self.start) == nil)
        #expect(clock.awaited == "front")
        // No session start yet (the writer had not begun): the camera begins at 0.
        #expect(clock.frame(pts: Self.start + 0.2, written: true, facing: "front", sessionStart: nil) == FlipClock.Report(facing: "front", gapMs: 200, atMs: 0))
    }
}
