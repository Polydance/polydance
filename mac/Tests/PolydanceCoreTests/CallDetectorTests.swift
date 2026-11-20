// The call detector against the situations docs/MAC.md D2 to D5 name: the lobby's flicker, switching
// tabs, muting, leaving, the mic released, the cap, the user stopping, and tabs that cannot be read.
import PolydanceCore
import XCTest

final class CallDetectorTests: XCTestCase {
    let code = "abc-defg-hij"

    /// Feeds one observation a second from `from` to `to` (inclusive) and returns every event.
    private func run(_ detector: inout CallDetector, from: Int, to: Int, autoRecord: Bool = true, otherRecording: Bool = false,
                     mic: (Int) -> Bool, codes: (Int) -> [String]?) -> [(Int, DetectorEvent)] {
        var events: [(Int, DetectorEvent)] = []
        for t in from...to {
            if let event = detector.observe(CallObservation(at: Double(t), micActive: mic(t), meetingCodes: codes(t)),
                                            autoRecord: autoRecord, otherRecording: otherRecording) {
                events.append((t, event))
            }
        }
        return events
    }

    func testStartsOnlyWhenTheMicAndAMeetingCodeAreBothPresent() {
        var d = CallDetector()
        XCTAssertNil(d.observe(CallObservation(at: 0, micActive: true, meetingCodes: [])))
        XCTAssertNil(d.observe(CallObservation(at: 1, micActive: false, meetingCodes: [code])))
        XCTAssertNil(d.observe(CallObservation(at: 2, micActive: true, meetingCodes: nil)), "unread tabs never start a call")
        XCTAssertEqual(d.observe(CallObservation(at: 3, micActive: true, meetingCodes: [code])), .start(meetingCode: code))
        XCTAssertEqual(d.currentCall?.startedAt, 3)
        XCTAssertEqual(d.currentCall?.startedBy, .detector)
    }

    func testLobbyFlickerOfTheMicMakesOneRecording() {
        var d = CallDetector()
        // The lobby's level meter takes and drops the mic for a few seconds at a time, well under 20 s.
        let events = run(&d, from: 0, to: 120, mic: { t in t % 10 < 6 }, codes: { _ in [self.code] })
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.1, .start(meetingCode: code))
    }

    func testTabSwitchKeepsTheCallBecauseEveryTabIsRead() {
        var d = CallDetector()
        // Arc reports the call's tab among others in a different order as Robin switches tabs and spaces.
        let events = run(&d, from: 0, to: 300, mic: { _ in true }, codes: { t in t % 2 == 0 ? [self.code] : ["xyz-wxyz-xyz", self.code] })
        XCTAssertEqual(events.count, 1)
        if case .recording = d.state {} else { XCTFail("still recording") }
    }

    func testMuteThatKeepsTheMicDoesNotStop() {
        var d = CallDetector()
        // Meet keeps the capture open while muted: IsRunningInput stays on for the whole call.
        let events = run(&d, from: 0, to: 3600, mic: { _ in true }, codes: { _ in [self.code] })
        XCTAssertEqual(events.map(\.1), [.start(meetingCode: code)])
    }

    func testMicReleasedFor20SecondsStops() {
        var d = CallDetector()
        let events = run(&d, from: 0, to: 400, mic: { t in t <= 300 }, codes: { _ in [self.code] })
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[1].0, 320, "stops 20 s after the last tick with the mic")
        XCTAssertEqual(events[1].1, .stop(reason: .micReleased, seconds: 320, short: false))
        XCTAssertEqual(d.state, .watching)
    }

    func testMicBackWithin20SecondsKeepsRecording() {
        var d = CallDetector()
        let events = run(&d, from: 0, to: 400, mic: { t in !(100...118).contains(t) }, codes: { _ in [self.code] })
        XCTAssertEqual(events.count, 1)
    }

    func testLeavingTheMeetingStopsAfter5SecondsWithLeftCall() {
        var d = CallDetector()
        let events = run(&d, from: 0, to: 200, mic: { _ in true }, codes: { t in t <= 150 ? [self.code] : [] })
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[1].0, 155)
        XCTAssertEqual(events[1].1, .stop(reason: .leftCall, seconds: 155, short: false))
    }

    func testClosingTheTabAndReleasingTheMicTogetherIsLeftCall() {
        var d = CallDetector()
        let events = run(&d, from: 0, to: 200, mic: { t in t <= 150 }, codes: { t in t <= 150 ? [self.code] : [] })
        XCTAssertEqual(events.last?.1, .stop(reason: .leftCall, seconds: 155, short: false))
    }

    func testArcQuittingEndsTheCall() {
        var d = CallDetector()
        // Arc not running reads as "no codes", which is definite, unlike tabs that could not be read.
        _ = d.observe(CallObservation(at: 0, micActive: true, meetingCodes: [code]))
        let codes = TabReading.arcNotRunning.meetingCodes
        XCTAssertEqual(codes, [])
        var last: DetectorEvent?
        for t in 1...6 { last = d.observe(CallObservation(at: Double(t), micActive: false, meetingCodes: codes)) ?? last }
        XCTAssertEqual(last, .stop(reason: .leftCall, seconds: 5, short: true))
    }

    func testUnreadableTabsNeverEndACallByThemselves() {
        var d = CallDetector()
        // Automation stops answering mid-call; the mic is still held, so the call goes on.
        let events = run(&d, from: 0, to: 600, mic: { _ in true }, codes: { t in t < 10 ? [self.code] : nil })
        XCTAssertEqual(events.count, 1)
        // And when the mic goes too, the call ends by the mic rule.
        let after = run(&d, from: 601, to: 700, mic: { _ in false }, codes: { _ in nil })
        XCTAssertEqual(after.first?.1, .stop(reason: .micReleased, seconds: 620, short: false))
    }

    func testCapStopsAt4HoursAndDoesNotRestartTheSameCall() {
        var d = CallDetector()
        let cap = Int(CallRules.standard.cap)
        let events = run(&d, from: 0, to: cap + 600, mic: { _ in true }, codes: { _ in [self.code] })
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[1].0, cap)
        XCTAssertEqual(events[1].1, .stop(reason: .cap, seconds: Double(cap), short: false))
        if case .standingDown(let down) = d.state { XCTAssertEqual(down.meetingCode, code) } else { XCTFail("stands down after the cap") }
    }

    func testUserStopStandsDownUntilTheCallEndsThenTheNextCallRecords() {
        var d = CallDetector()
        _ = run(&d, from: 0, to: 60, mic: { _ in true }, codes: { _ in [self.code] })
        XCTAssertEqual(d.stopByUser(at: 60.5), .stop(reason: .user, seconds: 60.5, short: true))
        // The call goes on: no new recording.
        XCTAssertTrue(run(&d, from: 61, to: 300, mic: { _ in true }, codes: { _ in [self.code] }).isEmpty)
        // Robin leaves (tab closed, mic released): the detector watches again after the grace.
        XCTAssertTrue(run(&d, from: 301, to: 330, mic: { _ in false }, codes: { _ in [] }).isEmpty)
        XCTAssertEqual(d.state, .watching)
        // The next call records.
        let next = run(&d, from: 331, to: 335, mic: { _ in true }, codes: { _ in ["klm-nopq-rst"] })
        XCTAssertEqual(next.first?.1, .start(meetingCode: "klm-nopq-rst"))
    }

    func testShortRecordingsAreMarked() {
        var d = CallDetector()
        let events = run(&d, from: 0, to: 100, mic: { t in t <= 30 }, codes: { t in t <= 30 ? [self.code] : [] })
        XCTAssertEqual(events.last?.1, .stop(reason: .leftCall, seconds: 35, short: true))
        XCTAssertTrue(CallRules.standard.isShort(seconds: 119.9))
        XCTAssertFalse(CallRules.standard.isShort(seconds: 120))
    }

    func testAutomaticRecordingOffWaitsForTheUser() {
        var d = CallDetector()
        XCTAssertTrue(run(&d, from: 0, to: 30, autoRecord: false, mic: { _ in true }, codes: { _ in [self.code] }).isEmpty)
        XCTAssertEqual(d.startByUser(CallObservation(at: 31, micActive: true, meetingCodes: [code])), .start(meetingCode: code))
        XCTAssertEqual(d.currentCall?.startedBy, .user)
        // Once started by hand, the stop rules still apply.
        let events = run(&d, from: 32, to: 80, autoRecord: false, mic: { _ in true }, codes: { t in t < 40 ? [self.code] : [] })
        XCTAssertEqual(events.first?.1, .stop(reason: .leftCall, seconds: 13, short: true))
    }

    func testStartByUserWithNoCallMeansAWalkthrough() {
        var d = CallDetector()
        XCTAssertNil(d.startByUser(CallObservation(at: 0, micActive: false, meetingCodes: [code])))
        XCTAssertNil(d.startByUser(CallObservation(at: 0, micActive: true, meetingCodes: nil)))
        XCTAssertEqual(d.state, .watching)
    }

    func testAWalkthroughInProgressHoldsTheCallBack() {
        var d = CallDetector()
        XCTAssertTrue(run(&d, from: 0, to: 10, otherRecording: true, mic: { _ in true }, codes: { _ in [self.code] }).isEmpty)
        XCTAssertEqual(d.observe(CallObservation(at: 11, micActive: true, meetingCodes: [code])), .start(meetingCode: code))
    }

    func testSwitchingToAnotherMeetingStopsAndTheNextTickStartsIt() {
        var d = CallDetector()
        let other = "zzz-yyyy-xxx"
        let events = run(&d, from: 0, to: 300, mic: { _ in true }, codes: { t in t < 200 ? [self.code] : [other] })
        XCTAssertEqual(events.map(\.1), [.start(meetingCode: code), .stop(reason: .leftCall, seconds: 204, short: false), .start(meetingCode: other)])
        XCTAssertEqual(events[2].0, 205)
    }

    func testAppQuittingAndCaptureFailure() {
        var d = CallDetector()
        _ = d.observe(CallObservation(at: 0, micActive: true, meetingCodes: [code]))
        XCTAssertEqual(d.appQuitting(at: 500), .stop(reason: .appQuit, seconds: 500, short: false))
        XCTAssertNil(d.appQuitting(at: 501))

        var e = CallDetector()
        _ = e.observe(CallObservation(at: 0, micActive: true, meetingCodes: [code]))
        e.captureFailed(at: 0.2)
        // A capture that could not start is not retried every second.
        XCTAssertTrue(run(&e, from: 1, to: 60, mic: { _ in true }, codes: { _ in [self.code] }).isEmpty)
        XCTAssertNil(e.stopByUser(at: 61))
    }

    func testStopReasonsAreTheContractsWords() {
        XCTAssertEqual(CallStopReason.allCases.map(\.rawValue), ["left-call", "mic-released", "user", "cap", "app-quit"])
    }
}
