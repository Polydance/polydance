// The warning for Arc holding the microphone while nothing records (MicWithoutCallWatch), including the
// morning it was written for: 2026-11-06, Meet on meet.google.com/meet/<code>, an hour, nothing said.
import PolydanceCore
import XCTest

final class MicWithoutCallTests: XCTestCase {
    private let meetHome = "https://meet.google.com/landing"
    private let other = "https://example.com/huddle"

    /// Feeds one tick a second from `from` to `to` (inclusive) and returns the warnings given.
    private func run(_ watch: inout MicWithoutCallWatch, _ from: Int, _ to: Int, mic: Bool = true,
                     tabs: MicWithoutCallWatch.Tabs, watching: Bool = true) -> [(Int, MicWithoutCallWatch.Warning)] {
        var given: [(Int, MicWithoutCallWatch.Warning)] = []
        for at in from...to {
            if let warning = watch.observe(at: Double(at), micActive: mic, tabs: tabs, watching: watching) { given.append((at, warning)) }
        }
        return given
    }

    func testWarnsOnceAfterTwentySecondsWithNoMeetTab() {
        var watch = MicWithoutCallWatch()
        let given = run(&watch, 0, 300, tabs: MicWithoutCallWatch.Tabs(.urls([other])))
        XCTAssertEqual(given.count, 1)
        XCTAssertEqual(given.first?.0, 20)
        XCTAssertEqual(given.first?.1.reason, .noMeetTab)
        XCTAssertEqual(watch.current?.reason, .noMeetTab, "the menu keeps showing it while it holds")
        XCTAssertEqual(watch.current?.seconds, 300)
    }

    func testTheMorningOfTheSixthNovember() {
        // The tab Meet left Arc on, read by an app that only knew meet.google.com/<code>: the shape is what
        // the warning names. With today's MeetLink the same tab is a call and nothing is said.
        let shapes = ["https://meet.google.com/meet/<code>"]
        var missed = MicWithoutCallWatch()
        let given = run(&missed, 0, 60, tabs: .noCall(meetTabs: shapes))
        XCTAssertEqual(given.map(\.1.reason), [.meetTabNotACall(shapes)])
        let text = given[0].1.text(shortcut: "⌃⌥R")
        XCTAssertTrue(text.body.contains("meet.google.com/meet/<code>"), text.body)
        XCTAssertFalse(text.body.contains("https://"))

        var now = MicWithoutCallWatch()
        XCTAssertEqual(MicWithoutCallWatch.Tabs(.urls(["https://meet.google.com/meet/abc-defg-hij?authuser=0"])), .call)
        XCTAssertTrue(run(&now, 0, 60, tabs: MicWithoutCallWatch.Tabs(.urls(["https://meet.google.com/meet/abc-defg-hij?authuser=0"]))).isEmpty)
        XCTAssertNil(now.current)
    }

    func testTabsAreReadIntoWhatTheWarningNeeds() {
        XCTAssertEqual(MicWithoutCallWatch.Tabs(nil), .notRead)
        XCTAssertEqual(MicWithoutCallWatch.Tabs(.failed("no answer")), .unreadable("no answer"))
        XCTAssertEqual(MicWithoutCallWatch.Tabs(.arcNotRunning), .noCall(meetTabs: []))
        XCTAssertEqual(MicWithoutCallWatch.Tabs(.urls([other, meetHome, meetHome + "?authuser=1", "https://meet.google.com/"])),
                       .noCall(meetTabs: ["https://meet.google.com/", meetHome]), "Meet's address forms, once each, no query, no other site")
        XCTAssertEqual(MicWithoutCallWatch.Tabs(.urls([other, "https://meet.google.com/abc-defg-hij"])), .call)
    }

    func testUnreadableTabsWarnWithTheReason() {
        var watch = MicWithoutCallWatch()
        let given = run(&watch, 0, 30, tabs: .unreadable("Automation for Arc is off"))
        XCTAssertEqual(given.map(\.1.reason), [.tabsUnreadable("Automation for Arc is off")])
        XCTAssertTrue(given[0].1.text(shortcut: "⌃⌥R").body.hasSuffix("Automation for Arc is off"))
    }

    func testShortUsesOfTheMicSayNothing() {
        var watch = MicWithoutCallWatch()
        XCTAssertTrue(run(&watch, 0, 15, tabs: .noCall(meetTabs: [])).isEmpty, "dictation for 15 s")
        XCTAssertTrue(run(&watch, 16, 60, mic: false, tabs: .notRead).isEmpty)
        XCTAssertTrue(run(&watch, 61, 75, tabs: .noCall(meetTabs: [])).isEmpty, "the clock started again after the release")
        XCTAssertNil(watch.current)
    }

    func testAQuestionInFlightNeitherStartsNorStopsTheClock() {
        var watch = MicWithoutCallWatch()
        XCTAssertTrue(run(&watch, 0, 30, tabs: .notRead).isEmpty, "nothing known yet: no warning")
        XCTAssertTrue(run(&watch, 31, 40, tabs: .noCall(meetTabs: [])).isEmpty)
        XCTAssertTrue(run(&watch, 41, 50, tabs: .notRead).isEmpty)
        XCTAssertEqual(run(&watch, 51, 51, tabs: .notRead).map(\.0), [51], "20 s after the first answer with no call")
    }

    func testABriefReleaseIsOneStretchAndALongOneIsTwo() {
        var watch = MicWithoutCallWatch()
        XCTAssertEqual(run(&watch, 0, 30, tabs: .noCall(meetTabs: [])).count, 1)
        XCTAssertTrue(run(&watch, 31, 40, mic: false, tabs: .notRead).isEmpty)
        XCTAssertNil(watch.current, "the menu shows nothing while Arc has let go")
        XCTAssertTrue(run(&watch, 41, 100, tabs: .noCall(meetTabs: [])).isEmpty, "10 s off is the same stretch: no second warning")
        XCTAssertNotNil(watch.current)
        XCTAssertTrue(run(&watch, 101, 121, mic: false, tabs: .notRead).isEmpty)
        XCTAssertEqual(run(&watch, 122, 150, tabs: .noCall(meetTabs: [])).map(\.0), [142], "20 s off ended it: a new stretch warns again")
    }

    func testACallInTheTabsSaysNothingAndResetsTheClock() {
        var watch = MicWithoutCallWatch()
        XCTAssertTrue(run(&watch, 0, 15, tabs: .noCall(meetTabs: [meetHome])).isEmpty)
        XCTAssertTrue(run(&watch, 16, 200, tabs: .call).isEmpty)
        XCTAssertEqual(run(&watch, 201, 230, tabs: .noCall(meetTabs: [])).map(\.0), [221])
    }

    func testNothingWhileRecordingOrWithAutomaticRecordingOff() {
        var watch = MicWithoutCallWatch()
        XCTAssertTrue(run(&watch, 0, 120, tabs: .noCall(meetTabs: []), watching: false).isEmpty)
        XCTAssertNil(watch.current)
        XCTAssertEqual(run(&watch, 121, 141, tabs: .noCall(meetTabs: [])).map(\.0), [141], "watching again: the clock starts from then")
    }

    func testAWarningIsNotRepeatedAfterARecordingInTheSameStretch() {
        var watch = MicWithoutCallWatch()
        XCTAssertEqual(run(&watch, 0, 25, tabs: .noCall(meetTabs: [])).count, 1)
        XCTAssertTrue(run(&watch, 26, 100, tabs: .noCall(meetTabs: []), watching: false).isEmpty, "recorded with ⌃⌥R")
        XCTAssertNil(watch.current)
        XCTAssertTrue(run(&watch, 101, 200, tabs: .noCall(meetTabs: [])).isEmpty, "stopped mid-use: no second notification")
        XCTAssertNotNil(watch.current, "but the menu still says so")
    }

    func testTheTextNamesNoOtherSite() {
        var watch = MicWithoutCallWatch()
        let warning = run(&watch, 0, 20, tabs: MicWithoutCallWatch.Tabs(.urls([other, "https://meet.google.com/new?hs=1"]))).first?.1
        let text = warning?.text(shortcut: "⌃⌥R")
        XCTAssertEqual(warning?.reason, .meetTabNotACall(["https://meet.google.com/new"]))
        for part in [text?.title, text?.body, text?.line].compactMap({ $0 }) {
            XCTAssertFalse(part.contains("example.com"), part)
            XCTAssertFalse(part.contains("hs=1"), part)
        }
        XCTAssertEqual(text?.body, "Arc has been using the microphone for 20 s and Meet is open at meet.google.com/new, which Polydance doesn't read as a call. ⌃⌥R records it as a walkthrough.")
    }
}
