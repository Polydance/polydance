// The import metadata against the contract's fixture (tests/fixtures/mac-call-meta.json, shared with
// the TypeScript side), the validation rules src/call.ts and src/import-meta.ts enforce, and the
// metadata a recording's facts produce.
import Foundation
import PolydanceCore
import PolydanceShared
import XCTest

final class RecordingMetaTests: XCTestCase {
    /// The repository's fixture, found from this file: mac/Tests/PolydanceCoreTests/ -> tests/fixtures/.
    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("tests/fixtures/mac-call-meta.json")

    static let contractExample = RecordingMeta(
        recordedAt: "2026-11-05T11:00:02.120Z", appPackage: "net.polydance.capture.mac",
        appBuild: AppBuildInfo(versionName: "0.1.0", versionCode: 1, commit: "904e7b9"), audioTracks: [.mic, .app],
        marks: [RecordingMark(atMs: 252_000), RecordingMark(atMs: 595_500, note: "flag this")],
        call: CallMeta(app: .meet, browser: .arc, meetingCode: "abc-defg-hij", startedAt: "2026-11-05T11:00:02.120Z",
                       endedAt: "2026-11-05T11:52:15.480Z", stopReason: .leftCall, video: .recorded, farEnd: .heard, short: false,
                       cut: false, told: .unknown, display: DisplaySize(width: 1920, height: 1243),
                       excludedApps: ["com.apple.MobileSMS", "com.apple.mail", "com.apple.Passwords"],
                       videoGaps: [VideoGap(fromMs: 1_111_000, toMs: 1_114_500, reason: "Stream was stopped by the system")]))

    private func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    func testEncodingTheContractsExampleMatchesTheFixture() throws {
        let fixture = try Data(contentsOf: Self.fixture)
        XCTAssertEqual(try object(try Self.contractExample.encoded()), try object(fixture))
    }

    func testTheFixtureDecodesStrictlyAndRoundTrips() throws {
        let meta = try RecordingMeta.decode(try Data(contentsOf: Self.fixture))
        XCTAssertEqual(meta, Self.contractExample)
        XCTAssertEqual(try RecordingMeta.decode(try meta.encoded()), meta)
    }

    func testAWalkthroughHasNoCall() throws {
        let meta = RecordingMeta(recordedAt: "2026-11-05T09:00:00.000Z", appBuild: AppBuildInfo(versionName: "0.1.0"), audioTracks: [.mic, .app])
        let json = try object(try meta.encoded())
        XCTAssertNil(json["call"])
        XCTAssertNil(json["marks"], "absent optionals are left out, not null")
        XCTAssertEqual(json["version"] as? Int, 1)
    }

    func testRefusesWhatTheReceiverWouldRefuse() {
        func refused(_ change: (inout RecordingMeta) -> Void, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
            var meta = Self.contractExample
            change(&meta)
            XCTAssertThrowsError(try meta.encoded(), file: file, line: line) { error in
                XCTAssertTrue("\(error)".contains(message), "\(error)", file: file, line: line)
            }
        }
        refused({ $0.version = 2 }, "version must be 1")
        refused({ $0.call?.meetingCode = "abc-defg-hi" }, "meetingCode")
        refused({ $0.marks = [RecordingMark(atMs: -1)] }, "atMs")
        refused({ $0.marks = [RecordingMark(atMs: 1, note: String(repeating: "x", count: 201))] }, "note")
        refused({ $0.marks = (0...RecordingMeta.maxMarks).map { RecordingMark(atMs: $0) } }, "at most 500 marks")
        refused({ $0.call?.endedAt = "2026-11-05T10:00:00.000Z" }, "before startedAt")
        refused({ $0.call?.startedAt = "yesterday" }, "startedAt")
        refused({ $0.call?.videoNote = "" }, "videoNote")
        refused({ $0.call?.videoNote = String(repeating: "y", count: 301) }, "videoNote")
        refused({ $0.call?.excludedApps = ["not a bundle id"] }, "bundle id")
        refused({ $0.call?.display = DisplaySize(width: 0, height: 10) }, "display")
        refused({ $0.audioTracks = [.mic, .mic] }, "twice")
        refused({ $0.audioTracks = [] }, "audioTracks")
        refused({ $0.appBuild?.commit = "unknown" }, "commit")
        refused({ $0.appPackage = "polydance-mac" }, "appPackage")
        refused({ $0.call?.videoGaps = [VideoGap(fromMs: -1, reason: "x")] }, "fromMs")
        refused({ $0.call?.videoGaps = [VideoGap(fromMs: 10, toMs: 9, reason: "x")] }, "toMs is before")
        refused({ $0.call?.videoGaps = [VideoGap(fromMs: 10, reason: "")] }, "reason")
        refused({ $0.call?.videoGaps = [VideoGap(fromMs: 10, reason: String(repeating: "z", count: 121))] }, "reason")
        refused({ $0.call?.videoGaps = (0...RecordingMeta.maxVideoGaps).map { VideoGap(fromMs: $0, reason: "x") } }, "at most 20 video gaps")
    }

    func testDecodingRefusesUnknownKeysAndWrongValues() {
        let base = String(decoding: try! Data(contentsOf: Self.fixture), as: UTF8.self)
        let cases = [
            base.replacingOccurrences(of: "\"version\": 1,", with: "\"version\": 1, \"extra\": true,"),
            base.replacingOccurrences(of: "\"app\": \"meet\",", with: "\"app\": \"meet\", \"invitees\": [],"),
            base.replacingOccurrences(of: "\"left-call\"", with: "\"hung-up\""),
            base.replacingOccurrences(of: "\"farEnd\": \"heard\"", with: "\"farEnd\": \"loud\""),
            base.replacingOccurrences(of: "\"fromMs\": 1111000,", with: "\"fromMs\": 1111000, \"cause\": \"purge\","),
            base.replacingOccurrences(of: "\"toMs\": 1114500", with: "\"toMs\": 1110000"),
            "[]", "not json",
        ]
        for text in cases { XCTAssertThrowsError(try RecordingMeta.decode(Data(text.utf8)), text) }
    }

    func testMetaTimes() throws {
        let date = try XCTUnwrap(MetaTime.parse("2026-11-05T11:00:02.120Z"))
        XCTAssertEqual(MetaTime.format(date), "2026-11-05T11:00:02.120Z")
        XCTAssertNotNil(MetaTime.parse("2026-11-05T11:00:02Z"))
        XCTAssertNotNil(MetaTime.parse("2026-11-05T12:00:02.120+01:00"))
        XCTAssertNil(MetaTime.parse("5 Nov 2026"))
    }

    func testAppBuildFromInfoPlist() {
        XCTAssertEqual(AppBuildInfo.from(infoDictionary: ["CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "1", "PolydanceCommit": "904e7b9-dirty"]),
                       AppBuildInfo(versionName: "0.1.0", versionCode: 1, commit: "904e7b9-dirty"))
        // build.sh leaves the placeholder only if it failed; it is never passed on as a commit.
        XCTAssertNil(AppBuildInfo.from(infoDictionary: ["CFBundleShortVersionString": "0.1.0", "PolydanceCommit": "__POLYDANCE_COMMIT__"]).commit)
        XCTAssertEqual(AppBuildInfo.from(infoDictionary: nil).versionName, "0.0.0")
        XCTAssertTrue(BundleIDRule.isPackageName("net.polydance.capture.mac"))
        XCTAssertFalse(BundleIDRule.isPackageName("net"))
        XCTAssertFalse(BundleIDRule.isPackageName("net..x"))
        XCTAssertTrue(BundleIDRule.isValid("com.apple.MobileSMS"))
        XCTAssertFalse(BundleIDRule.isValid(".com.apple"))
    }

    // MARK: Facts to metadata

    func testACallsFactsGiveTheContractsShape() throws {
        let start = try XCTUnwrap(MetaTime.parse("2026-11-05T11:00:02.120Z"))
        let facts = RecordingFacts(
            mode: .call(meetingCode: "abc-defg-hij"), startedAt: start, endedAt: try XCTUnwrap(MetaTime.parse("2026-11-05T11:52:15.480Z")),
            appBuild: AppBuildInfo(versionName: "0.1.0", versionCode: 1, commit: "904e7b9"), audioTracks: [.mic, .app],
            marks: [RecordingMark(atMs: 252_000), RecordingMark(atMs: 595_500, note: "flag this")], stopReason: .leftCall,
            videoRecorded: true, farEnd: .heard, display: DisplaySize(width: 1920, height: 1243), excludedApps: SettingsStore.defaultExcludedApps,
            videoGaps: [VideoGap(fromMs: 1_111_000, toMs: 1_114_500, reason: "Stream was stopped by the system")])
        XCTAssertEqual(facts.meta(), Self.contractExample)
        // A call whose picture never stopped says nothing about gaps.
        var steady = facts
        steady.videoGaps = []
        XCTAssertNil(steady.meta().call?.videoGaps)
    }

    func testARunningRecordingIsCutUntilItStopsCleanly() throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let running = RecordingFacts(mode: .call(meetingCode: "abc-defg-hij"), startedAt: start, videoRecorded: false,
                                     videoNote: "screen recording is not allowed for Polydance", farEnd: .silent)
        let meta = running.meta()
        XCTAssertEqual(meta.call?.cut, true)
        XCTAssertNil(meta.call?.endedAt)
        XCTAssertNil(meta.call?.short)
        XCTAssertEqual(meta.call?.video, VideoOutcome.none)
        XCTAssertEqual(meta.call?.videoNote, "screen recording is not allowed for Polydance")
        XCTAssertNoThrow(try meta.encoded())

        // Found after a crash: ended when the file was last written, by the app going away.
        let recovered = RecordingFacts.recovered(meta, lastWrite: start.addingTimeInterval(95))
        XCTAssertEqual(recovered.call?.endedAt, MetaTime.format(start.addingTimeInterval(95)))
        XCTAssertEqual(recovered.call?.stopReason, .appQuit)
        XCTAssertEqual(recovered.call?.cut, true)
        XCTAssertEqual(recovered.call?.short, true)
        XCTAssertNoThrow(try recovered.encoded())
        // A clean stop is left as it is.
        XCTAssertEqual(RecordingFacts.recovered(Self.contractExample, lastWrite: Date()), Self.contractExample)
    }

    /// seam-3: what a crash leaves says the far end was heard only once it was, and nothing before;
    /// silent is the clean stop's verdict, or certain from the start only with no call sound track.
    func testTheFarEndIsOnlyClaimedWhenItIsKnown() throws {
        XCTAssertNil(RecordingFacts.farEnd(appTrack: .declared, everHeard: false, final: false))
        XCTAssertNil(RecordingFacts.farEnd(appTrack: .present, everHeard: false, final: false))
        XCTAssertEqual(RecordingFacts.farEnd(appTrack: .present, everHeard: true, final: false), .heard)
        XCTAssertEqual(RecordingFacts.farEnd(appTrack: .none, everHeard: false, final: false), .silent)
        XCTAssertEqual(RecordingFacts.farEnd(appTrack: .present, everHeard: false, final: true), .silent)
        XCTAssertEqual(RecordingFacts.farEnd(appTrack: .present, everHeard: true, final: true), .heard)
        XCTAssertEqual(RecordingFacts.farEnd(appTrack: .declared, everHeard: false, final: true), .silent, "no sound reached the file")

        // A crash after the others were heard, and after the user said they were told: both survive recovery.
        let start = Date(timeIntervalSince1970: 1_793_000_000)
        let provisional = RecordingFacts(mode: .call(meetingCode: "abc-defg-hij"), startedAt: start, farEnd: .heard, told: .yes).meta()
        let recovered = RecordingFacts.recovered(try RecordingMeta.decode(try provisional.encoded()), lastWrite: start.addingTimeInterval(2400))
        XCTAssertEqual(recovered.call?.farEnd, .heard)
        XCTAssertEqual(recovered.call?.told, .yes)
        let early = RecordingFacts(mode: .call(meetingCode: "abc-defg-hij"), startedAt: start, farEnd: nil).meta()
        XCTAssertNil(RecordingFacts.recovered(early, lastWrite: start.addingTimeInterval(2400)).call?.farEnd, "not known, so not claimed")
    }

    /// cap-3: only the apps that were really in the capture filter are named as left out.
    func testOnlyAppsThatWereLeftOutAreNamed() {
        var record = ExclusionRecord(requested: ["com.apple.MobileSMS", "com.apple.mail", "com.apple.Passwords"])
        XCTAssertEqual(record.filter(running: ["company.thebrowser.Browser", "com.apple.mail", "com.apple.MobileSMS"]), ["com.apple.mail", "com.apple.MobileSMS"])
        XCTAssertEqual(record.excludedApps, ["com.apple.MobileSMS", "com.apple.mail"], "Passwords was not running, so it was not left out")
        XCTAssertEqual(record.filter(running: ["com.apple.Passwords", "com.apple.mail"]), ["com.apple.Passwords", "com.apple.mail"], "opened mid-call: added")
        XCTAssertEqual(record.excludedApps, ["com.apple.MobileSMS", "com.apple.mail", "com.apple.Passwords"])
        XCTAssertEqual(ExclusionRecord(requested: []).excludedApps, [])
    }

    func testShortIsUnderTwoMinutes() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        func short(_ seconds: Double) -> Bool? {
            RecordingFacts(mode: .call(meetingCode: "abc-defg-hij"), startedAt: start, endedAt: start.addingTimeInterval(seconds)).meta().call?.short
        }
        XCTAssertEqual(short(119), true)
        XCTAssertEqual(short(120), false)
    }

    func testAWalkthroughsFactsHaveNoCallBlock() {
        let meta = RecordingFacts(mode: .walkthrough, startedAt: Date(), endedAt: Date(), audioTracks: [.mic, .app], stopReason: nil).meta()
        XCTAssertNil(meta.call)
        XCTAssertEqual(meta.audioTracks, [.mic, .app])
    }

    func testMarksAreOnTheRecordingsClock() {
        var book = MarkBook()
        book.add(at: 99.5)
        book.add(at: 352.25, note: "  flag this  ")
        book.add(at: 400, note: "   ")
        book.add(at: 500, note: String(repeating: "é", count: 300))
        let marks = book.marks(since: 100)
        XCTAssertEqual(marks.map(\.atMs), [0, 252_250, 300_000, 400_000])
        XCTAssertEqual(marks[1].note, "flag this")
        XCTAssertNil(marks[2].note, "a blank note is no note")
        XCTAssertEqual(marks[3].note?.utf16.count, 200)
        var full = MarkBook()
        for i in 0..<RecordingMeta.maxMarks { full.add(at: Double(i)) }
        XCTAssertFalse(full.add(at: 9999), "a stuck key cannot flood the bundle")
    }

    func testDisplayChoiceAndVideoSize() {
        let displays = [DisplayChoice.Display(id: 1, frame: CGRect(x: 0, y: 0, width: 1512, height: 982)),
                        DisplayChoice.Display(id: 2, frame: CGRect(x: 1512, y: 0, width: 2560, height: 1440))]
        XCTAssertEqual(DisplayChoice.choose(windowBounds: CGRect(x: 1700, y: 100, width: 1200, height: 800), displays: displays, mainDisplay: 1), 2)
        XCTAssertEqual(DisplayChoice.choose(windowBounds: CGRect(x: 100, y: 100, width: 800, height: 600), displays: displays, mainDisplay: 2), 1)
        XCTAssertEqual(DisplayChoice.choose(windowBounds: nil, displays: displays, mainDisplay: 2), 2)
        XCTAssertEqual(DisplayChoice.choose(windowBounds: CGRect(x: 9000, y: 9000, width: 10, height: 10), displays: displays, mainDisplay: 1), 1)

        let retina = DisplayChoice.videoSize(pointWidth: 1512, pointHeight: 982, scale: 2)
        XCTAssertEqual(retina.width, 1920)
        XCTAssertEqual(retina.height, 1246)
        let small = DisplayChoice.videoSize(pointWidth: 1280, pointHeight: 801, scale: 1)
        XCTAssertEqual(small.width, 1280)
        XCTAssertEqual(small.height, 800, "even, for H.264")
    }
}
