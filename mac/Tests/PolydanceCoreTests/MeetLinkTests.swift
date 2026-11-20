// Meet meeting codes in tab addresses, Arc's answer to the tab script, and which Core Audio processes
// count as Arc.
import Foundation
import PolydanceCore
import XCTest

final class MeetLinkTests: XCTestCase {
    func testMeetingCodesFromAddresses() {
        let calls = [
            "https://meet.google.com/abc-defg-hij": "abc-defg-hij",
            "https://meet.google.com/abc-defg-hij?authuser=0": "abc-defg-hij",
            "https://meet.google.com/abc-defg-hij?pli=1&authuser=1": "abc-defg-hij",
            "https://meet.google.com/abc-defg-hij#chat": "abc-defg-hij",
            "https://meet.google.com/abc-defg-hij/": "abc-defg-hij",
            // Where Meet's redirect leaves the tab for the whole call (seen in Arc, 2026-11-06).
            "https://meet.google.com/meet/abc-defg-hij?authuser=0": "abc-defg-hij",
            "https://meet.google.com/meet/abc-defg-hij": "abc-defg-hij",
            "https://meet.google.com/meet/abc-defg-hij#chat": "abc-defg-hij",
        ]
        for (url, code) in calls { XCTAssertEqual(MeetLink.meetingCode(in: url), code, url) }

        let notCalls = [
            "https://meet.google.com/", "https://meet.google.com/landing", "https://meet.google.com/new",
            "http://meet.google.com/abc-defg-hij", "https://meet.google.com/ABC-DEFG-HIJ", "https://meet.google.com/abc-defg-hijk",
            "https://meet.google.com/abc-defg-hi", "https://meet.google.com/abcdefghij", "https://evil.meet.google.com/abc-defg-hij",
            "https://meet.google.com.evil.com/abc-defg-hij", "https://meet.google.com/abc-defg-hij.html", "https://meet.google.com/lookup/abc-defg-hij",
            "https://meet.google.com/abc_defg_hij", "https://meet.google.com/åbc-defg-hij", " https://meet.google.com/abc-defg-hij",
            "https://meet.google.com/abc-defg-hij?x=\n1", "missing value", "",
            "https://meet.google.com/meet/", "https://meet.google.com/meet", "https://meet.google.com/meet/abc-defg-hi",
            "https://meet.google.com/meet/meet/abc-defg-hij", "https://meet.google.com/meetabc-defg-hij",
            "https://meet.google.com/Meet/abc-defg-hij", "https://meet.google.com/x/abc-defg-hij", "http://meet.google.com/meet/abc-defg-hij",
        ]
        for url in notCalls { XCTAssertNil(MeetLink.meetingCode(in: url), url) }
    }

    /// The hand-written parser says what the contract's regular expression says.
    func testAgreesWithTheContractsRegularExpression() throws {
        let regex = try NSRegularExpression(pattern: #"^https://meet\.google\.com/(?:meet/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$"#)
        let samples = [
            "https://meet.google.com/abc-defg-hij", "https://meet.google.com/abc-defg-hij?a=b", "https://meet.google.com/abc-defg-hijx",
            "https://meet.google.com/abc-defg-hij/x/y", "https://meet.google.com/zzz-zzzz-zzz#", "https://meet.google.com/aaa-aaaa-aa",
            "https://meet.google.com/aaa-aaaa-aaa?", "https://meet.google.comm/aaa-aaaa-aaa", "https://meet.google.com/a1a-aaaa-aaa",
            "https://meet.google.com/meet/abc-defg-hij?authuser=0", "https://meet.google.com/meet/abc-defg-hijx", "https://meet.google.com/meet/",
            "https://meet.google.com/meet/meet/abc-defg-hij", "https://meet.google.com/meet/abc-defg-hij/", "https://meet.google.com/meetx/abc-defg-hij",
            // "meet" is itself four letters: meet.google.com/mee-tabc-def is a code, not the redirect's path.
            "https://meet.google.com/mee-tabc-def", "https://meet.google.com/meet-abc-defg",
        ]
        for url in samples {
            let range = NSRange(url.startIndex..., in: url)
            let expected = regex.firstMatch(in: url, range: range).flatMap { Range($0.range(at: 1), in: url).map { String(url[$0]) } }
            XCTAssertEqual(MeetLink.meetingCode(in: url), expected, url)
        }
    }

    func testCodesAcrossTabsAreDistinctInOrder() {
        let urls = ["https://example.com", "https://meet.google.com/aaa-bbbb-ccc", "https://meet.google.com/ddd-eeee-fff?x",
                    "https://meet.google.com/aaa-bbbb-ccc#again"]
        XCTAssertEqual(MeetLink.meetingCodes(in: urls), ["aaa-bbbb-ccc", "ddd-eeee-fff"])
        XCTAssertTrue(MeetLink.isMeetingCode("abc-defg-hij"))
        XCTAssertFalse(MeetLink.isMeetingCode("abc-defg-hi"))
        XCTAssertFalse(MeetLink.isMeetingCode("abc-dEfg-hij"))
    }

    /// What `--arc-tabs` may print of a tab: Meet's form, never a code, a query or another site.
    func testShapesKeepOnlyMeetsForm() {
        XCTAssertEqual(MeetLink.shape(of: "https://meet.google.com/meet/abc-defg-hij?authuser=0"), "https://meet.google.com/meet/<code>")
        XCTAssertEqual(MeetLink.shape(of: "https://meet.google.com/abc-defg-hij#chat"), "https://meet.google.com/<code>")
        XCTAssertEqual(MeetLink.shape(of: "https://meet.google.com/?authuser=robin@example.com"), "https://meet.google.com/")
        XCTAssertEqual(MeetLink.shape(of: "https://meet.google.com/landing"), "https://meet.google.com/landing")
        XCTAssertNil(MeetLink.shape(of: "https://mail.google.com/mail/u/0/#inbox"))
        XCTAssertNil(MeetLink.shape(of: "http://meet.google.com/abc-defg-hij"))
        XCTAssertNil(MeetLink.shape(of: "https://meet.google.com.evil.com/abc-defg-hij"))
    }

    func testParsesArcsAnswer() {
        let output = "https://meet.google.com/abc-defg-hij\nmissing value\n\n  https://github.com  \r\nhttps://meet.google.com/abc-defg-hij\r\n"
        XCTAssertEqual(ArcTabsScript.parse(output), .urls(["https://meet.google.com/abc-defg-hij", "https://github.com"]))
        XCTAssertEqual(ArcTabsScript.parse(""), .urls([]))
        XCTAssertEqual(ArcTabsScript.parse("\(ArcTabsScript.notRunningMarker)\n"), .arcNotRunning)
        XCTAssertEqual(ArcTabsScript.parse(output).meetingCodes, ["abc-defg-hij"])
        XCTAssertNil(TabReading.failed("Automation is off").meetingCodes)
    }

    func testTheScriptNeverLaunchesArcAndReadsWindowsAndSpaces() {
        let script = ArcTabsScript.source
        XCTAssertTrue(script.hasPrefix("if application id \"company.thebrowser.Browser\" is running then"))
        XCTAssertTrue(script.contains("URL of every tab of w"))
        XCTAssertTrue(script.contains("repeat with s in spaces of w"))
        XCTAssertTrue(script.contains("URL of every tab of s"))
        XCTAssertTrue(script.contains("with timeout of 3 seconds"))
        XCTAssertTrue(script.contains("return \"\(ArcTabsScript.notRunningMarker)\""))
        XCTAssertFalse(script.contains("activate"), "never brings Arc forward")
    }

    func testArcProcesses() {
        let list = [
            AudioProcessInfo(objectID: 10, pid: 100, bundleID: "company.thebrowser.Browser", isRunningInput: false, isRunningOutput: false),
            AudioProcessInfo(objectID: 11, pid: 101, bundleID: "company.thebrowser.browser.helper", isRunningInput: true, isRunningOutput: true),
            AudioProcessInfo(objectID: 12, pid: 102, bundleID: "com.google.Chrome.helper", isRunningInput: true, isRunningOutput: true),
            AudioProcessInfo(objectID: 13, pid: 103, bundleID: nil, isRunningInput: true, isRunningOutput: false),
        ]
        XCTAssertEqual(ArcBrowser.processes(in: list).map(\.objectID), [10, 11])
        XCTAssertEqual(ArcBrowser.tapTargets(list), [10, 11])
        XCTAssertTrue(ArcBrowser.usingMicrophone(list))
        XCTAssertTrue(ArcBrowser.playingSound(list))
        XCTAssertFalse(ArcBrowser.usingMicrophone(Array(list.dropFirst(2))), "another browser holding the mic is not Arc")
        XCTAssertFalse(ArcBrowser.usingMicrophone([list[0]]))
    }
}
