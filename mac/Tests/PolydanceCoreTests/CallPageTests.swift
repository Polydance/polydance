// What the main window reads from a call's bundle: session.json, frames.json, transcript.json with its
// speakers, and hook-runs.json, against files polycap really wrote (Fixtures/, captured on 2026-11-05 by
// building a 20 s call with real ffmpeg, the fake whisper-cli and the fake Messages API, as
// tests/call-pipeline.test.ts does; temporary paths replaced). Also the calls catalog, the routine's
// hooks list and resume command, and the documented hooks.json the settings can create.
import Foundation
import PolydanceCore
import XCTest

enum Fixture {
    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
    static func data(_ name: String) throws -> Data { try Data(contentsOf: dir.appendingPathComponent(name)) }
    static func text(_ name: String) throws -> String { String(decoding: try data(name), as: UTF8.self) }
}

final class CallPageTests: XCTestCase {
    var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("call-page-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    /// A session folder made of the fixtures, under sessions/<id>.
    @discardableResult
    func bundle(_ id: String = "2026-11-05T11-00-02_meet", files: [String: String] = [:], session: String? = nil) throws -> URL {
        let dir = temp.appendingPathComponent("sessions").appendingPathComponent(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data((session ?? (try Fixture.text("call-session.json"))).utf8).write(to: dir.appendingPathComponent("session.json"))
        let defaults = ["frames.json": "call-frames.json", "transcript.json": "call-transcript.json", "hook-runs.json": "call-hook-runs.json"]
        for (name, fixture) in defaults.merging(files, uniquingKeysWith: { $1 }) where !fixture.isEmpty {
            let text = fixture.hasPrefix("{") ? fixture : try Fixture.text(fixture)
            try Data(text.utf8).write(to: dir.appendingPathComponent(name))
        }
        return dir
    }

    // MARK: session.json

    func testReadsTheCallSessionPolycapWrote() throws {
        let session = try SessionInfo.load(from: try bundle())
        XCTAssertEqual(session.pageTitle, "Deck by Friday")
        XCTAssertEqual(session.summary?.text, "Agrees the deck goes out by Friday.")
        XCTAssertEqual(session.source.call?.browser, "arc")
        XCTAssertEqual(session.source.call?.told, "unknown")
        XCTAssertEqual(session.source.call?.display, DisplaySize(width: 1920, height: 1243))
        XCTAssertEqual(session.media?.voice, "both")
        XCTAssertEqual(session.media?.hasVideo, true)
        XCTAssertEqual(session.media?.video, "video.mp4")
        XCTAssertEqual(session.transcriber?.kind, "whisper-cpp")
        XCTAssertFalse(session.isBuilding)
        XCTAssertTrue(session.failedSteps.isEmpty)
        XCTAssertEqual(CallPageFacts.appLine(session.source.call), "Google Meet in Arc")
        XCTAssertEqual(CallPageFacts.stopReason(session.source.call?.stopReason), "you left the call")
    }

    func testThePageTitleIsClaudesElseTheID() throws {
        var json = try Fixture.text("call-session.json")
        json = json.replacingOccurrences(of: "\"summary\": {\n    \"title\": \"Deck by Friday\",\n    \"text\": \"Agrees the deck goes out by Friday.\",\n    \"model\": \"claude-haiku-4-5\"\n  },\n", with: "")
        let untitled = try SessionInfo.load(from: try bundle("untitled", session: json))
        XCTAssertNil(untitled.summary)
        XCTAssertEqual(untitled.pageTitle, "2026-11-05T11-00-02_meet")
        XCTAssertEqual(untitled.displayTitle, "Meet abc-defg-hij", "the menu keeps its own wording")
    }

    func testAStepStillPendingIsBuildingAndAFailedStepSaysWhy() throws {
        var json = try Fixture.text("call-session.json")
        json = json.replacingOccurrences(of: "\"storyboard\": {\n      \"status\": \"done\"", with: "\"storyboard\": {\n      \"status\": \"pending\"")
        json = json.replacingOccurrences(of: "\"frames\": {\n      \"status\": \"done\"", with: "\"frames\": {\n      \"status\": \"failed\", \"error\": \"ffmpeg exited 1\"")
        let session = try SessionInfo.load(from: try bundle("building", session: json))
        XCTAssertTrue(session.isBuilding)
        XCTAssertEqual(session.failedSteps.map(\.name), ["Frames"])
        XCTAssertEqual(session.failedSteps.first?.error, "ffmpeg exited 1")
    }

    // MARK: frames.json

    func testTheScenesGridIsSceneAndMarkFramesInClockOrder() throws {
        let frames = try FramesFile.decode(try Fixture.data("call-frames.json"))
        XCTAssertEqual(frames.frames.count, 8)
        XCTAssertEqual(frames.sceneCount, 3)
        XCTAssertEqual(frames.scenes.map(\.atMs), [5300, 7800, 10300, 12800, 15300])
        XCTAssertEqual(frames.scenes.filter(\.isMark).map(\.atMs), [7800, 12800])
        let dir = URL(fileURLWithPath: "/lib/sessions/s1")
        let mark = try XCTUnwrap(frames.scenes.first { $0.isMark })
        XCTAssertEqual(FramesFile.thumbnail(mark, in: dir).path, "/lib/sessions/s1/frames/0004_00m07s.jpg")
        XCTAssertEqual(FramesFile.largest(mark, in: dir).path, "/lib/sessions/s1/frames/full/0004_00m07s.jpg")
        let edge = try XCTUnwrap(frames.frames.last)
        XCTAssertEqual(FramesFile.largest(edge, in: dir).path, "/lib/sessions/s1/frames/0008_00m19s.jpg", "no full copy: the thumbnail")
    }

    func testAFrameFileThatCouldLeaveTheFolderIsRefused() throws {
        func frames(_ file: String, full: String? = nil) -> Data {
            Data("{\"version\": 1, \"width\": 160, \"frames\": [{\"file\": \"\(file)\", \"atMs\": 0, \"reason\": \"scene\"\(full.map { ", \"full\": \"\($0)\"" } ?? "")}]}".utf8)
        }
        XCTAssertNoThrow(try FramesFile.decode(frames("0001_00m00s.jpg", full: "full/0001_00m00s.jpg")))
        for bad in ["../session.json", "/etc/hosts", "full/0001.jpg", "", "a b.jpg", "..", "x\\\\y.jpg"] {
            XCTAssertThrowsError(try FramesFile.decode(frames(bad)), bad)
        }
        for bad in ["../../x.jpg", "full/../../x.jpg", "/full/x.jpg", "full/sub/x.jpg"] {
            XCTAssertThrowsError(try FramesFile.decode(frames("0001.jpg", full: bad)), bad)
        }
        XCTAssertThrowsError(try FramesFile.decode(Data("{\"version\": 2, \"frames\": []}".utf8))) { XCTAssertTrue("\($0)".contains("version 2")) }
    }

    func testAFrameReasonFromANewerPolycapIsKeptAndNotAScene() throws {
        let frames = try FramesFile.decode(Data("{\"version\": 1, \"width\": 160, \"later\": true, \"frames\": [{\"file\": \"0001.jpg\", \"atMs\": 10, \"reason\": \"slide\", \"extra\": 1}]}".utf8))
        XCTAssertEqual(frames.frames.first?.reason, "slide")
        XCTAssertTrue(frames.scenes.isEmpty)
    }

    // MARK: transcript.json

    func testTheTranscriptsSpeakersAndTheMarkedLines() throws {
        let transcript = try TranscriptFile.decode(try Fixture.data("call-transcript.json"))
        XCTAssertEqual(transcript.segments.count, 6)
        XCTAssertEqual(transcript.voice, "both")
        XCTAssertEqual(transcript.bleedDropped, 1)
        XCTAssertEqual(transcript.speakers, [.me, .others])
        XCTAssertEqual(transcript.segments.map { $0.speaker?.label ?? "" }, ["Me", "Others", "Me", "Others", "Me", "Others"])
        XCTAssertEqual(CallPageFacts.voices(transcript: transcript, audioTracks: ["mic", "app"]), "Me and others · 2 voices")
        // The fixture's marks: 7.8 s falls in "Action item…" (6.0 to 8.5 s), 12.8 s in "Let's flag this…" (11 to 13 s).
        let marks = try SessionInfo.load(from: try bundle()).source.marks ?? []
        XCTAssertEqual(CallPageFacts.markedLines(transcript.segments, marks: marks), [2, 3])
        // Just after a line ends it is that line; in a long silence it is none.
        XCTAssertEqual(CallPageFacts.markedLines(transcript.segments, marks: [RecordingMark(atMs: 9_000)]), [2])
        XCTAssertEqual(CallPageFacts.markedLines(transcript.segments, marks: [RecordingMark(atMs: 30_000)]), [])
    }

    func testSpeakersAreMeOthersOrOthersN() throws {
        XCTAssertEqual(try Speaker(parsing: "others:2"), .other(2))
        XCTAssertEqual(try Speaker(parsing: "others:2").label, "Others 2")
        XCTAssertEqual(try Speaker(parsing: "others:999"), .other(999))
        for bad in ["them", "Me", "others:0", "others:01", "others:1000", "others:", "others:x", "others:-1", ""] {
            XCTAssertThrowsError(try Speaker(parsing: bad), bad)
        }
        let line = { (speaker: String) in Data("{\"version\": 1, \"engine\": \"gladia\", \"segments\": [{\"startMs\": 0, \"endMs\": 10, \"text\": \"hi\", \"speaker\": \"\(speaker)\"}]}".utf8) }
        XCTAssertEqual(try TranscriptFile.decode(line("others:3")).speakers, [.other(3)])
        XCTAssertThrowsError(try TranscriptFile.decode(line("robin"))) { XCTAssertTrue("\($0)".contains("not me, others")) }
        XCTAssertNil(try TranscriptFile.decode(Data("{\"version\": 1, \"engine\": \"w\", \"segments\": [{\"startMs\": 0, \"endMs\": 1, \"text\": \"a\"}]}".utf8)).segments.first?.speaker,
                     "a walkthrough's lines have no speaker")
        XCTAssertThrowsError(try TranscriptFile.decode(Data("{\"version\": 1, \"segments\": [{\"startMs\": 5, \"endMs\": 1, \"text\": \"a\"}]}".utf8)))
        // An Others line Meet showed someone speaking carries their name (src/pipeline/speakers.ts); the page shows it.
        let named = try TranscriptFile.decode(Data("{\"version\": 1, \"segments\": [{\"startMs\": 0, \"endMs\": 10, \"text\": \"hi\", \"speaker\": \"others\", \"name\": \"Ada Lovelace\"}, {\"startMs\": 10, \"endMs\": 20, \"text\": \"yo\", \"speaker\": \"others\"}]}".utf8))
        XCTAssertEqual(named.segments.map(\.who), ["Ada Lovelace", "Others"])
    }

    func testVoicesFromTheTracksWhenThereIsNoTranscript() {
        XCTAssertEqual(CallPageFacts.voices(transcript: nil, audioTracks: ["mic", "app"]), "Me and others")
        XCTAssertEqual(CallPageFacts.voices(transcript: nil, audioTracks: ["app"]), "Others only")
        XCTAssertNil(CallPageFacts.voices(transcript: nil, audioTracks: nil))
    }

    func testClocks() {
        XCTAssertEqual(SessionClock.format(ms: 0), "00:00")
        XCTAssertEqual(SessionClock.format(ms: 751_999), "12:31")
        XCTAssertEqual(SessionClock.format(ms: 3_761_000), "1:02:41")
        XCTAssertEqual(durationText(24), "24 s")
        XCTAssertEqual(durationText(240), "4 min")
        XCTAssertEqual(durationText(4_320), "1 h 12 min")
    }

    // MARK: hook-runs.json and the routine

    func testTheRoutineCardsRuns() throws {
        let runs = try HookRuns.decode(try Fixture.data("call-hook-runs.json"))
        let done = try XCTUnwrap(runs.runs["call-routine"])
        XCTAssertEqual(done.status, .done)
        XCTAssertEqual(done.statusLabel, "Done")
        XCTAssertEqual(done.exitCode, 0)
        XCTAssertEqual(done.agentSessionId, "7c1e9a42-5b6d-4e1f-9a0b-1c2d3e4f5a6b")
        XCTAssertEqual(try XCTUnwrap(done.duration), 0.024, accuracy: 0.001)
        let skipped = try XCTUnwrap(runs.runs["long-calls"])
        XCTAssertEqual(skipped.status, .skipped)
        XCTAssertEqual(skipped.note, "00:20 long, under the hook's 2 min")
    }

    func testTheResumeCommandRunsInTheHooksFolder() throws {
        let listing = try HookListing.decode(try Fixture.data("hooks-list.json"))
        let hook = try XCTUnwrap(listing.hook(named: "call-routine"))
        let id = "7c1e9a42-5b6d-4e1f-9a0b-1c2d3e4f5a6b"
        XCTAssertEqual(ResumeCommand.make(agentSessionId: id, hookCwd: hook.cwd), "cd ~/Code/calls && claude --resume \(id)")
        XCTAssertEqual(ResumeCommand.make(agentSessionId: id, hookCwd: nil), "claude --resume \(id)", "a hook with no cwd runs in the home folder")
        XCTAssertEqual(ResumeCommand.make(agentSessionId: id, hookCwd: "~/My Calls"), "cd ~/'My Calls' && claude --resume \(id)")
        XCTAssertEqual(ResumeCommand.make(agentSessionId: id, hookCwd: "/tmp/it's"), "cd '/tmp/it'\\''s' && claude --resume \(id)")
        XCTAssertNil(ResumeCommand.make(agentSessionId: nil, hookCwd: "~/Code/calls"))
        for bad in ["x; rm -rf ~", "$(id)", "", String(repeating: "a", count: 129), "a b"] {
            XCTAssertNil(ResumeCommand.make(agentSessionId: bad, hookCwd: nil), bad)
        }
    }

    func testTheHooksPolycapLists() throws {
        let listing = try HookListing.decode(try Fixture.data("hooks-list.json"))
        XCTAssertTrue(listing.found)
        XCTAssertEqual(listing.file, "/Users/someone/PolydanceCapture/hooks.json")
        XCTAssertEqual(listing.hooks.map(\.name), ["call-routine", "long-calls"])
        XCTAssertEqual(listing.hooks[0].envNames, ["ROUTINE_TOKEN"], "names only, never values")
        XCTAssertEqual(listing.hooks[0].filterText, "Runs after calls")
        XCTAssertEqual(listing.hooks[1].filterText, "Runs after calls of 2 min or more; shorter ones are skipped")
        XCTAssertTrue(listing.hooks[0].commandText.hasPrefix("node -e "))
        XCTAssertTrue(listing.hooks[0].commandText.contains("\"Call: {title}\""))

        let none = try HookListing.decode(Data("{\"file\": \"/Users/someone/.config/polycap/hooks.json\", \"found\": false, \"hooks\": []}".utf8))
        XCTAssertFalse(none.found)
        XCTAssertThrowsError(try HookListing.decode(Data("{\"file\": \"hooks.json\", \"found\": true, \"hooks\": []}".utf8)), "a relative file")
        let badName = "{\"file\": \"/h.json\", \"found\": true, \"hooks\": [{\"name\": \"Call Routine\", \"when\": {\"mode\": \"call\"}, \"run\": [\"x\"], \"timeoutMinutes\": 30}]}"
        XCTAssertThrowsError(try HookListing.decode(Data(badName.utf8)))
        let badMode = "{\"file\": \"/h.json\", \"found\": true, \"hooks\": [{\"name\": \"r\", \"when\": {\"mode\": \"meeting\"}, \"run\": [\"x\"], \"timeoutMinutes\": 30}]}"
        XCTAssertThrowsError(try HookListing.decode(Data(badMode.utf8)))
    }

    func testWhatHooksRunReports() throws {
        let result = try HooksRunResult.decode(try PolycapOutput.json(try Fixture.data("hooks-run.json"), command: "hooks run"))
        XCTAssertEqual(result.ran, ["call-routine"])
        XCTAssertEqual(result.runs["call-routine"]?.agentSessionId, "7c1e9a42-5b6d-4e1f-9a0b-1c2d3e4f5a6b")
        XCTAssertNil(result.summary)
        let busy = try HooksRunResult.decode(Data("{\"id\": \"s\", \"dir\": \"/s\", \"ran\": [], \"notRun\": {}, \"busy\": \"another polycap is running them (pid 12)\", \"runs\": {}}".utf8))
        XCTAssertEqual(busy.summary, "Not run: another polycap is running them (pid 12)")
        let skipped = try HooksRunResult.decode(Data("{\"id\": \"s\", \"dir\": \"/s\", \"ran\": [], \"notRun\": {\"r\": \"the call is marked short\"}, \"runs\": {}}".utf8))
        XCTAssertEqual(skipped.summary, "r: the call is marked short")
        XCTAssertTrue(HookName.isValid("call-routine"))
        for bad in ["", "-x", "Call", "a_b", String(repeating: "a", count: 41)] { XCTAssertFalse(HookName.isValid(bad), bad) }
    }

    // MARK: The catalog and the page

    func testTheCatalogListsCallsNewestFirstAndRereadsOnlyWhatChanged() throws {
        try bundle()
        // A walkthrough (no call), and a folder that is not a session.
        let walkthrough = try Fixture.text("call-session.json").replacingOccurrences(of: "\"call\": {", with: "\"notACall\": {")
        try bundle("2026-11-05T09-00-00_mac", session: walkthrough)
        let broken = temp.appendingPathComponent("sessions/2026-11-04T08-00-00_meet")
        try FileManager.default.createDirectory(at: broken, withIntermediateDirectories: true)
        try Data("{".utf8).write(to: broken.appendingPathComponent("session.json"))
        var older = try Fixture.text("call-session.json").replacingOccurrences(of: "\"recordedAt\": \"2026-11-05T11:00:02.120Z\"", with: "\"recordedAt\": \"2026-11-04T10:00:00.000Z\"")
        older = older.replacingOccurrences(of: "\"id\": \"2026-11-05T11-00-02_meet\"", with: "\"id\": \"2026-11-04T10-00-00_meet\"")
        try bundle("2026-11-04T10-00-00_meet", files: ["hook-runs.json": ""], session: older)

        let catalog = CallCatalog()
        let calls = catalog.scan(sessions: temp.appendingPathComponent("sessions"))
        XCTAssertEqual(calls.map(\.id), ["2026-11-05T11-00-02_meet", "2026-11-04T10-00-00_meet"], "calls only, newest first, the broken one left out")
        XCTAssertEqual(calls.first?.title, "Deck by Friday")
        XCTAssertEqual(calls.first?.chip, .routineDone)
        XCTAssertEqual(calls.first?.farEnd, "heard")
        XCTAssertFalse(calls.first?.building ?? true)

        // hook-runs.json changes (a later mtime): the entry is read again.
        let runs = temp.appendingPathComponent("sessions/2026-11-05T11-00-02_meet/hook-runs.json")
        let failed = try Fixture.text("call-hook-runs.json").replacingOccurrences(of: "\"status\": \"done\"", with: "\"status\": \"failed\"")
        try Data(failed.utf8).write(to: runs)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(5)], ofItemAtPath: runs.path)
        XCTAssertEqual(catalog.scan(sessions: temp.appendingPathComponent("sessions")).first?.chip, .routineFailed)
        XCTAssertTrue(catalog.scan(sessions: temp.appendingPathComponent("missing")).isEmpty)
    }

    func testThePageReadsEachFileOnItsOwn() throws {
        let dir = try bundle(files: ["frames.json": "{\"version\": 1, \"frames\": [{\"file\": \"../x.jpg\", \"atMs\": 0, \"reason\": \"scene\"}]}"])
        try Data("# Storyboard\n".utf8).write(to: dir.appendingPathComponent("storyboard.md"))
        try Data("line one\nline two\n\nline three\n".utf8).write(to: dir.appendingPathComponent("transcript.md"))
        try Data(repeating: 0, count: 1234).write(to: dir.appendingPathComponent("video.mp4"))
        let page = try CallPageData.load(from: dir)
        XCTAssertNil(page.frames)
        XCTAssertTrue(page.framesProblem?.contains("outside frames/") ?? false, page.framesProblem ?? "")
        XCTAssertEqual(page.transcript?.segments.count, 6, "a broken frames.json leaves the transcript")
        XCTAssertEqual(page.hookRuns?.runs.count, 2)
        XCTAssertEqual(page.storyboard?.lastPathComponent, "storyboard.md")
        XCTAssertEqual(page.transcriptLines, 3)
        XCTAssertEqual(page.videoBytes, 1234)
        XCTAssertEqual(page.marks.count, 2)
        XCTAssertFalse(page.building)
        XCTAssertEqual(Set(page.stamp.keys), ["session.json", "frames.json", "transcript.json", "hook-runs.json", "storyboard.md", "transcript.md"])

        try Data("{\"version\": 1, \"runs\": {\"r\": {\"status\": \"done\", \"startedAt\": \"2026-11-05T11:00:00Z\", \"secret\": 1}}}".utf8)
            .write(to: dir.appendingPathComponent("hook-runs.json"))
        XCTAssertTrue(try CallPageData.load(from: dir).hookRunsProblem?.contains("unknown key") ?? false, "hook-runs.json is read strictly")
        XCTAssertThrowsError(try CallPageData.load(from: temp.appendingPathComponent("nowhere")))
    }

    // MARK: hooks.json

    func testTheDocumentedHooksFileIsCreatedPrivatelyAndNeverReplaced() throws {
        let home = temp.appendingPathComponent("home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let file = HooksFileExample.defaultPath(home: home)
        XCTAssertEqual(file.path, home.path + "/.config/polycap/hooks.json")
        try HooksFileExample.create(at: file, home: home)
        XCTAssertEqual(PrivateFiles.permissions(of: file), 0o600)
        XCTAssertEqual(PrivateFiles.permissions(of: file.deletingLastPathComponent()), 0o700)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), HooksFileExample.text)
        try Data("{\"version\": 1, \"hooks\": []}".utf8).write(to: file)
        XCTAssertThrowsError(try HooksFileExample.create(at: file, home: home)) { XCTAssertTrue("\($0)".contains("already exists")) }
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "{\"version\": 1, \"hooks\": []}", "an existing file is left as it is")
        XCTAssertThrowsError(try HooksFileExample.create(at: URL(fileURLWithPath: "/somewhere-else/hooks.json"), home: home), "outside the home folder")
    }

    /// The example the settings write is the one docs/MAC.md documents, so the two cannot drift apart.
    func testTheHooksExampleIsTheOneInTheDocs() throws {
        let docs = Fixture.dir.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("docs/MAC.md")
        let text = try String(contentsOf: docs, encoding: .utf8)
        let blocks = text.components(separatedBy: "```json").dropFirst().compactMap { $0.components(separatedBy: "```").first }
        let block = try XCTUnwrap(blocks.first { $0.contains("\"call-routine\"") }, "docs/MAC.md has the routine's hooks.json")
        let documented = try JSONSerialization.jsonObject(with: Data(block.utf8)) as? NSDictionary
        let ours = try JSONSerialization.jsonObject(with: Data(HooksFileExample.text.utf8)) as? NSDictionary
        XCTAssertEqual(documented, ours)
    }

    // MARK: Permissions

    func testThePanesAndWhatAppleEventsSay() {
        for pane in SystemSettingsPane.allCases {
            XCTAssertEqual(pane.url.scheme, "x-apple.systempreferences", pane.rawValue)
        }
        XCTAssertTrue(SystemSettingsPane.microphone.address.hasSuffix("Privacy_Microphone"))
        XCTAssertTrue(SystemSettingsPane.screenAndSystemAudio.address.hasSuffix("Privacy_ScreenCapture"))
        XCTAssertTrue(SystemSettingsPane.automation.address.hasSuffix("Privacy_Automation"))
        XCTAssertEqual(AutomationGrant(status: 0), .allowed)
        XCTAssertEqual(AutomationGrant(status: -1743), .denied)
        XCTAssertEqual(AutomationGrant(status: -1744), .notAsked)
        XCTAssertEqual(AutomationGrant(status: -600), .arcNotRunning)
        XCTAssertEqual(AutomationGrant(status: -50), .unknown(-50))
    }
}
