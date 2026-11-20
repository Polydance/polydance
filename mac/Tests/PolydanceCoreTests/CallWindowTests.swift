// Which window a call records (2026-11-17): Arc's windows by the tab each shows and its title, matched to
// macOS's window list by title, and every case where it cannot be told and the display is recorded instead.
// Titles, codes and addresses are made up.
import CoreGraphics
import Foundation
import XCTest
@testable import PolydanceCore

final class CallWindowTests: XCTestCase {
    let code = "abc-defg-hij"
    let arcPIDs: Set<Int32> = [77]
    let call = "https://meet.google.com/meet/abc-defg-hij?authuser=0"

    func window(_ id: UInt32, _ title: String, pid: Int32 = 77, layer: Int = 0, width: CGFloat = 1512, height: CGFloat = 944) -> ScreenPick.Window {
        ScreenPick.Window(id: id, frame: CGRect(x: 0, y: 0, width: width, height: height), pid: pid, app: pid == 77 ? "Arc" : "Mail", title: title, layer: layer)
    }

    func testArcsAnswerIsParsedWithTheTitleLastAndOddLinesPassedOver() {
        let output = "1\t\(call)\tMeet - abc-defg-hij\n2\thttps://example.com/\tKitchen\tTimer\nnot a window\n\n3\tmissing value\t\n"
        XCTAssertEqual(CallWindow.parse(output), .windows([
            .init(index: 1, activeURL: call, title: "Meet - abc-defg-hij"),
            .init(index: 2, activeURL: "https://example.com/", title: "Kitchen\tTimer"),
            .init(index: 3, activeURL: "missing value", title: ""),
        ]))
        XCTAssertEqual(CallWindow.parse(CallWindow.notRunningMarker), .windows([]), "Arc not running has no windows")
        XCTAssertEqual(CallWindow.parse(""), .windows([]))
    }

    func testTheScriptNeverLaunchesArcAndReadsEachWindowAlone() {
        XCTAssertTrue(CallWindow.source.hasPrefix("if application id \"\(ArcBrowser.bundleID)\" is running then"))
        XCTAssertTrue(CallWindow.source.contains("with timeout of 3 seconds"))
        XCTAssertTrue(CallWindow.source.contains("active tab of w"))
        // `tab` is Arc's class inside its tell: the separator is made outside it.
        let sep = CallWindow.source.range(of: "set sep to character id 9")!
        XCTAssertLessThan(sep.lowerBound, CallWindow.source.range(of: "tell application")!.lowerBound)
    }

    func testTheWindowShowingTheCallIsFoundByItsTitle() {
        let reading = CallWindow.Reading.windows([
            .init(index: 1, activeURL: "https://example.com/inbox", title: "Inbox"),
            .init(index: 2, activeURL: call, title: "Meet - abc-defg-hij"),
        ])
        let windows = [window(900, "", layer: 24, width: 64, height: 19), window(10, "Inbox"), window(11, "Inbox", pid: 78),
                       window(12, "Meet - abc-defg-hij"), window(13, "", width: 1512, height: 37)]
        XCTAssertEqual(CallWindow.find(code: code, reading: reading, windows: windows, arcPIDs: arcPIDs),
                       .window(.window(id: 12, title: "Meet - abc-defg-hij", app: "Arc")))
    }

    func testTheFrontmostOfTwoArcWindowsOnTheCallIsTaken() {
        let reading = CallWindow.Reading.windows([
            .init(index: 2, activeURL: call, title: "Meet - second"),
            .init(index: 1, activeURL: "https://meet.google.com/abc-defg-hij", title: "Meet - first"),
        ])
        let windows = [window(20, "Meet - first"), window(21, "Meet - second")]
        XCTAssertEqual(CallWindow.find(code: code, reading: reading, windows: windows, arcPIDs: arcPIDs),
                       .window(.window(id: 20, title: "Meet - first", app: "Arc")))
    }

    func testTwoWindowsWithOneTitleAreToldApartByOrderOnlyWhenTheListsAgree() {
        let reading = CallWindow.Reading.windows([
            .init(index: 1, activeURL: "https://meet.google.com/xyz-wxyz-uvw", title: "Meet"),
            .init(index: 2, activeURL: call, title: "Meet"),
        ])
        XCTAssertEqual(CallWindow.find(code: code, reading: reading, windows: [window(30, "Meet"), window(31, "Meet")], arcPIDs: arcPIDs),
                       .window(.window(id: 31, title: "Meet", app: "Arc")), "the second in both lists")
        XCTAssertEqual(CallWindow.find(code: code, reading: reading, windows: [window(30, "Meet"), window(31, "Meet"), window(32, "Meet")], arcPIDs: arcPIDs),
                       .notFound("3 Arc windows have the call's title"), "three listed for two of Arc's: not guessed")
    }

    func testWhenItCannotBeToldTheDisplayIsRecordedAndWhyIsSaid() {
        let shown = CallWindow.Reading.windows([.init(index: 1, activeURL: call, title: "Meet - abc-defg-hij")])
        XCTAssertEqual(CallWindow.find(code: code, reading: .failed("Automation for Arc is off"), windows: [], arcPIDs: arcPIDs),
                       .notFound("Arc did not say which window has the call (Automation for Arc is off)"))
        XCTAssertEqual(CallWindow.find(code: code, reading: .windows([]), windows: [], arcPIDs: arcPIDs), .notFound("Arc has no window"))
        XCTAssertEqual(CallWindow.find(code: code, reading: .windows([.init(index: 1, activeURL: "https://example.com/", title: "Kitchen")]),
                                       windows: [window(10, "Kitchen")], arcPIDs: arcPIDs),
                       .notFound("no Arc window shows the call's tab"), "the call's tab is in the background")
        XCTAssertEqual(CallWindow.find(code: "xyz-wxyz-uvw", reading: shown, windows: [window(10, "Meet - abc-defg-hij")], arcPIDs: arcPIDs),
                       .notFound("no Arc window shows the call's tab"), "another call's tab is not this call's")
        XCTAssertEqual(CallWindow.find(code: code, reading: .windows([.init(index: 1, activeURL: call, title: "")]), windows: [window(10, "")], arcPIDs: arcPIDs),
                       .notFound("Arc gave the call's window no title"))
        XCTAssertEqual(CallWindow.find(code: code, reading: shown, windows: [window(10, "")], arcPIDs: arcPIDs),
                       .notFound("macOS listed no Arc window with the call's title"), "titles unreadable without the screen permission")
        XCTAssertEqual(CallWindow.find(code: code, reading: shown, windows: [window(10, "Meet - abc-defg-hij", pid: 78)], arcPIDs: arcPIDs),
                       .notFound("macOS listed no Arc window with the call's title"), "another app's window with the same title")
        XCTAssertEqual(CallWindow.find(code: code, reading: shown, windows: [window(10, "Meet - abc-defg-hij", layer: 3)], arcPIDs: arcPIDs),
                       .notFound("macOS listed no Arc window with the call's title"), "a floating window is not the browser window")
    }

    func testTheCheckCountsTheWindowsItCouldMatch() {
        let reading = CallWindow.Reading.windows([
            .init(index: 1, activeURL: "https://example.com/", title: "Kitchen"),
            .init(index: 2, activeURL: "https://example.com/a", title: "Twice"),
            .init(index: 3, activeURL: "https://example.com/b", title: "Twice"),
            .init(index: 4, activeURL: "https://example.com/c", title: ""),
        ])
        let windows = [window(10, "Kitchen"), window(11, "Twice"), window(12, "Twice"), window(13, "")]
        XCTAssertEqual(CallWindow.matchedByTitle(reading, windows: windows, arcPIDs: arcPIDs), 1)
        XCTAssertNil(CallWindow.matchedByTitle(.failed("no answer"), windows: windows, arcPIDs: arcPIDs))
    }
}
