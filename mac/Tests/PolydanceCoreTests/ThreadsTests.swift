// Threads on the Mac: what `polycap thread list --json`, `thread show --json`, `thread reply --json` and
// `upload --json` print, read from output captured from polycap on 2026-11-05 against a receiver run in
// process on 127.0.0.1 (as tests/threads.test.ts does): a thread with three launches (a link, a link
// behind a version check, an app on the headset) and a walkthrough uploaded as a reply to the second
// message's first launch. Also what a launch does on a Mac, the upload ledger, and the runner's new
// commands as argument arrays through a fake node. thread-show-photos.json is `thread show --json` with two
// photos from an iPhone token, captured from polycap on 2026-11-07 against `polycap serve` on 127.0.0.1, its
// paths moved to /Users/test.
import Foundation
import PolydanceCore
import PolydanceShared
import XCTest

final class ThreadsTests: XCTestCase {
    var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("threads-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    // MARK: thread list

    func testTheInboxAndWhatIsNew() throws {
        let threads = try ThreadOutput.list(try Fixture.data("thread-list.json"))
        XCTAssertEqual(threads.count, 1)
        let thread = try XCTUnwrap(threads.first)
        XCTAssertEqual(thread.key, "MUS-1")
        XCTAssertEqual(thread.title, "Settings menu")
        XCTAssertEqual(thread.messages, 3)
        XCTAssertTrue(thread.unread)
        XCTAssertTrue(thread.isNew)
        XCTAssertEqual(thread.last.by.who, "Robin · Mac")
        XCTAssertEqual(thread.last.kind, "recording.ready")
    }

    func testAnOlderReceiversListAndABadKey() throws {
        // Before 2026-10-04 there was no `fresh`, before 2026-10-12 no `report`.
        let old = "[{\"key\": \"CAP-3\", \"project\": \"CAP\", \"title\": \"Upload retry\", \"state\": \"open\", \"updatedAt\": \"2026-10-01T10:00:00Z\", \"messages\": 1, \"unread\": false, \"waiting\": true, \"last\": {\"kind\": \"message\", \"by\": {\"id\": \"r\", \"name\": \"Robin\"}, \"at\": \"2026-10-01T10:00:00Z\", \"text\": \"hi\"}}]"
        let threads = try ThreadOutput.list(Data(old.utf8))
        XCTAssertEqual(threads.first?.fresh, 0)
        XCTAssertEqual(threads.first?.report, false)
        XCTAssertFalse(threads.first?.isNew ?? true)
        XCTAssertEqual(threads.first?.last.by.who, "Robin", "no display name: the name")
        XCTAssertThrowsError(try ThreadOutput.list(Data(old.replacingOccurrences(of: "CAP-3", with: "../CAP-3").utf8))) { XCTAssertTrue("\($0)".contains("not a thread key")) }
        XCTAssertThrowsError(try ThreadOutput.list(Data("Set POLYCAP_REMOTE_URL".utf8))) { XCTAssertTrue("\($0)".contains("printed no JSON")) }
        XCTAssertEqual(try ThreadOutput.list(Data("[]\n".utf8)), [])
    }

    func testThreadKeys() {
        for good in ["MUS-12", "PD-4", "CAP-999999", "A1-1"] { XCTAssertTrue(ThreadKey.isValid(good), good) }
        for bad in ["mus-12", "MUS-0", "MUS-012", "M-1", "MUS12", "MUS-1-2", "../MUS-1", "MUS-1234567", "ABCDEFGHIJK-1", "MUS-", ""] {
            XCTAssertFalse(ThreadKey.isValid(bad), bad)
        }
    }

    // MARK: thread show

    func testAThreadWithLaunchesAndARecordedReply() throws {
        let thread = try ThreadOutput.thread(try Fixture.data("thread-show.json"))
        XCTAssertEqual(thread.key, "MUS-1")
        XCTAssertEqual(thread.project.name, "Marimba")
        XCTAssertEqual(thread.ordered.map(\.id), [1, 2, 3])
        let first = thread.ordered[0]
        XCTAssertEqual(first.oneLine, "posted: Settings is buried under Profile. Two versions to compare.")
        XCTAssertEqual(first.by.who, "Opus 5.5 on Robin's Mac")

        let asked = thread.ordered[1]
        let launches = try XCTUnwrap(asked.launches)
        XCTAssertEqual(launches.count, 3)
        XCTAssertEqual(launches.enumerated().map { $0.element.title(index: $0.offset, of: launches.count) },
                       ["Option 1: gear in the top bar", "Option 2: Settings as a tab", "Option 3: On the headset"])
        XCTAssertEqual(launches[0].macLinks.map(\.absoluteString), ["https://marimba-web-k2m7q9x4t-yourteam.vercel.app/?variant=a"])
        XCTAssertFalse(launches[0].isHeadsetOnly)
        XCTAssertEqual(launches[1].steps.first, .require(package: "com.example.marimba", versionName: nil, versionCode: 231, minVersionCode: nil))
        XCTAssertEqual(launches[1].headsetSteps.map(\.macText), ["Headset only: needs com.example.marimba (231)"])
        XCTAssertEqual(launches[1].macLinks.count, 1, "a version check does not stop the link opening on the Mac")
        XCTAssertTrue(launches[2].isHeadsetOnly)
        XCTAssertEqual(launches[2].steps.map(\.macText), ["Headset only: opens the app com.example.marimba"])
        XCTAssertEqual(launches[0].steps.first?.macText, "Opens marimba-web-k2m7q9x4t-yourteam.vercel.app")

        let reply = thread.ordered[2]
        let recording = try XCTUnwrap(reply.recording)
        XCTAssertEqual(recording.status, "ready")
        XCTAssertEqual(recording.replyTo?.message, 2)
        XCTAssertEqual(recording.replyTo?.launch, 0)
        XCTAssertEqual(recording.sessionId, "2026-11-05T14-02-10_mac")
        XCTAssertEqual(reply.oneLine, "sent a recording: Settings easier to find")
        XCTAssertEqual(reply.by.who, "Robin · Mac")
        // A receiver before 2026-11-16 says nothing of content: every recording was a video.
        XCTAssertEqual(recording.kindWord, "Recording")
        XCTAssertNil(recording.logsWord)
    }

    func testATakeOfLogsAloneOrSoundAloneSaysSo() throws {
        func recording(_ extra: String) throws -> ThreadMessage.Recording {
            try JSONDecoder().decode(ThreadMessage.Recording.self, from: Data("{\"uploadId\": \"up_0123456789abcdef\", \"status\": \"ready\"\(extra)}".utf8))
        }
        let alone = try recording(", \"content\": \"none\", \"logs\": true")
        XCTAssertEqual([alone.kindWord, alone.logsWord], ["Logs only", nil])
        let sound = try recording(", \"content\": \"sound\", \"logs\": true")
        XCTAssertEqual([sound.kindWord, sound.logsWord], ["Sound only", "with logs"])
        let video = try recording(", \"content\": \"video\"")
        XCTAssertEqual([video.kindWord, video.logsWord], ["Recording", nil])
    }

    func testOneLaunchIsStartAndAStepFromANewerReceiverIsNotOnTheMac() throws {
        let one = try JSONDecoder().decode(Launch.self, from: Data("{\"steps\": [{\"do\": \"open\", \"url\": \"https://example.com/a\"}, {\"do\": \"hologram\", \"x\": 1}]}".utf8))
        XCTAssertEqual(one.title(index: 0, of: 1), "Start")
        XCTAssertEqual(one.steps.last, .unknown(kind: "hologram"))
        XCTAssertEqual(one.steps.last?.macText, "Not on the Mac: a hologram step")
        let model = try JSONDecoder().decode(LaunchStep.self, from: Data("{\"do\": \"model\", \"sha256\": \"\(String(repeating: "a", count: 64))\", \"name\": \"drum.glb\", \"bytes\": 4200000}".utf8))
        XCTAssertEqual(model.macText, "Headset only: shows the 3D model drum.glb (4.2 MB)")
    }

    func testOnlyHttpsLinksOpen() {
        XCTAssertNotNil(LaunchLink.https("https://marimba.vercel.app/?v=a"))
        for bad in ["http://example.com", "javascript:alert(1)", "file:///etc/hosts", "https://user:pw@example.com/", "https://", "arc://settings", "not a url"] {
            XCTAssertNil(LaunchLink.https(bad), bad)
        }
        let launch = Launch(label: nil, steps: [.open(url: "http://plain.example.com")])
        XCTAssertTrue(launch.isHeadsetOnly, "a link that is not https opens nothing")
        XCTAssertEqual(launch.steps.first?.macText, "Not opened: http://plain.example.com is not an https link")
        XCTAssertEqual(LaunchLink.megabytes(640_000), "640 kB")
    }

    // MARK: Photos

    func testAMessagesPhotosAndWhereTheirCopiesAre() throws {
        let thread = try ThreadOutput.thread(try Fixture.data("thread-show-photos.json"))
        let sent = thread.ordered[1]
        XCTAssertEqual(sent.photos.map(\.type), ["image/png", "image/jpeg"])
        XCTAssertEqual(sent.photos.map { "\($0.width)×\($0.height)" }, ["1170×2532", "1600×1200"])
        XCTAssertTrue(sent.canView)
        XCTAssertEqual(sent.oneLine, "sent 2 photos: Still under Profile, here it is.")
        XCTAssertEqual(thread.ordered[0].photos, [], "a message without photos has none")

        let layout = LibraryLayout(root: URL(fileURLWithPath: "/Users/test/PolydanceCapture"))
        let png = sent.photos[0]
        XCTAssertEqual(png.file(in: layout, thread: "MUS-1")?.path, "/Users/test/PolydanceCapture/photos/MUS-1/\(png.sha256).png")
        XCTAssertNil(png.file(in: LibraryLayout(root: URL(fileURLWithPath: "/Users/other")), thread: "MUS-1"), "outside this library")
        XCTAssertNil(png.file(in: layout, thread: "MUS-2"), "another thread's folder")
        var elsewhere = png
        elsewhere.path = "/Users/test/PolydanceCapture/photos/MUS-1/../../sessions/\(png.sha256).png"
        XCTAssertNil(elsewhere.file(in: layout, thread: "MUS-1"))
        elsewhere.path = nil
        XCTAssertNil(elsewhere.file(in: layout, thread: "MUS-1"), "not saved")
        var renamed = png
        renamed.type = "image/gif"
        XCTAssertNil(renamed.file(in: layout, thread: "MUS-1"))

        let json = #"{"id": 3, "at": "2026-11-07T18:00:00Z", "by": {"id": "q", "name": "Quest"}, "photos": [{"sha256": "\#(String(repeating: "a", count: 64))", "type": "image/jpeg", "width": 4, "height": 3, "bytes": 900}], "canView": false}"#
        let hidden = try JSONDecoder().decode(ThreadMessage.self, from: Data(json.utf8))
        XCTAssertFalse(hidden.canView)
        XCTAssertEqual(hidden.oneLine, "sent a photo")
    }

    func testPhotosChosenDroppedAndPastedForAReply() throws {
        XCTAssertEqual(PolycapCommand.threadReply(key: "MUS-1", text: "", photos: [URL(fileURLWithPath: "/tmp/-a.png")]), ["thread", "reply", "MUS-1", "--photo=/tmp/-a.png", "--json"])
        XCTAssertEqual(PolycapCommand.threadReply(key: "MUS-1", text: "both", photos: [URL(fileURLWithPath: "/tmp/a.heic")]), ["thread", "reply", "MUS-1", "--text=both", "--photo=/tmp/a.heic", "--json"])

        let a = URL(fileURLWithPath: "/tmp/a.png"), b = URL(fileURLWithPath: "/tmp/b.HEIC"), notes = URL(fileURLWithPath: "/tmp/notes.txt")
        var added = ThreadPhotos.adding([a, b, a, notes], to: [])
        XCTAssertEqual(added.photos, [a, b])
        XCTAssertEqual(added.refused, 1, "the text file; the second a.png is already there")
        let many = (0..<12).map { URL(fileURLWithPath: "/tmp/\($0).jpg") }
        added = ThreadPhotos.adding(many, to: [])
        XCTAssertEqual(added.photos.count, 10)
        XCTAssertEqual(added.refused, 2)

        let layout = LibraryLayout(root: temp)
        let pasted = try ThreadPhotos.savePasted(Data([0x89, 0x50, 0x4e, 0x47]), in: layout)
        XCTAssertTrue(ThreadPhotos.isPasted(pasted, in: layout))
        XCTAssertFalse(ThreadPhotos.isPasted(a, in: layout))
        func mode(_ url: URL) throws -> Int? { (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue }
        XCTAssertEqual(try mode(pasted), 0o600)
        XCTAssertEqual(try mode(layout.pastedPhotos), 0o700)
        let kept = layout.pastedPhotos.appendingPathComponent("mine.png")
        try Data("x".utf8).write(to: kept)
        ThreadPhotos.clearPasted(in: layout)
        XCTAssertFalse(FileManager.default.fileExists(atPath: pasted.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path), "only the app's own pasted copies go")
    }

    // MARK: Replies and uploads

    func testAReplyIsOneArgumentEvenWhenItStartsWithADash() throws {
        XCTAssertEqual(PolycapCommand.threadReply(key: "MUS-1", text: "-dash first"), ["thread", "reply", "MUS-1", "--text=-dash first", "--json"])
        let posted = try ThreadOutput.reply(try Fixture.data("thread-reply.json"))
        XCTAssertEqual(posted.key, "MUS-1")
        XCTAssertEqual(posted.message, 4)
        XCTAssertThrowsError(try ThreadOutput.reply(Data("{\"key\": \"MUS-1\", \"message\": 0}".utf8)))
    }

    func testWhatUploadPrints() throws {
        let sent = try PolycapOutput.uploaded(from: try Fixture.data("upload.json"))
        XCTAssertEqual(sent.uploadId, "up_7e1e4b342f9bce95")
        XCTAssertEqual(sent.thread, "MUS-1")
        XCTAssertEqual(sent.status, "received")
        XCTAssertEqual(sent.narration, "sent")
        let withWarning = Data(("1 mark is left out: the receiver does not take marks yet\n" + (try Fixture.text("upload.json"))).utf8)
        XCTAssertEqual(try PolycapOutput.uploaded(from: withWarning).uploadId, "up_7e1e4b342f9bce95", "a stray line before the JSON")
        XCTAssertThrowsError(try PolycapOutput.uploaded(from: Data("{\"uploadId\": \"up_x\", \"thread\": \"MUS-1\", \"status\": \"received\"}".utf8)))
        XCTAssertThrowsError(try PolycapOutput.uploaded(from: Data("{\"uploadId\": \"up_7e1e4b342f9bce95\", \"thread\": \"mus 1\", \"status\": \"received\"}".utf8)))
    }

    func testAReplyTargetIsCheckedBeforeAnythingIsRecorded() throws {
        XCTAssertNoThrow(try WalkthroughTarget(thread: "MUS-1", replyTo: 2, launch: 0).validate())
        XCTAssertNil(WalkthroughTarget(thread: "MUS-1", launch: 1).launch, "a launch means nothing without the message it is in")
        XCTAssertThrowsError(try WalkthroughTarget(thread: "MUS 1").validate())
        XCTAssertThrowsError(try WalkthroughTarget(thread: "MUS-1", replyTo: 0).validate())
        XCTAssertThrowsError(try WalkthroughTarget(thread: "MUS-1", replyTo: 2, launch: 6).validate())
    }

    /// New thread and the bug key (Robin's pick D, 2026-11-16): a walkthrough that opens a thread in a project,
    /// or a report; each says what it is in the app's lines, and a ledger from before them reads as replies.
    func testANewThreadOrAReportIsATargetToo() throws {
        let kitchen = ThreadProject(key: "KITC", name: "Kitchen Timer", mine: true)
        let opening = WalkthroughTarget.newThread(in: kitchen)
        XCTAssertEqual(opening.kind, .newThread)
        XCTAssertNoThrow(try opening.validate())
        XCTAssertEqual(opening.what, "a new thread in Kitchen Timer")
        XCTAssertEqual(opening.title, "New thread in Kitchen Timer")
        XCTAssertEqual(opening.whenStopped, "opens a thread in Kitchen Timer")
        XCTAssertEqual(WalkthroughTarget.report.kind, .report)
        XCTAssertNoThrow(try WalkthroughTarget.report.validate())
        XCTAssertEqual(WalkthroughTarget.report.whenStopped, "sent to the Polydance team")
        XCTAssertEqual(WalkthroughTarget(thread: "MUS-1").what, "a reply to MUS-1")
        XCTAssertThrowsError(try WalkthroughTarget.newThread(in: ThreadProject(key: "kitchen", name: "Kitchen", mine: true)).validate())
        var both = WalkthroughTarget.report
        both.project = "KITC"
        XCTAssertThrowsError(try both.validate()) { XCTAssertTrue("\($0)".contains("not both")) }
        var answering = opening
        answering.replyTo = 1
        XCTAssertThrowsError(try answering.validate()) { XCTAssertTrue("\($0)".contains("answers no message")) }
        // Once sent, a new thread knows the thread it opened.
        var opened = opening
        opened.thread = "KITC-3"
        XCTAssertEqual(opened.kind, .newThread)
        XCTAssertNoThrow(try opened.validate())

        // In the ledger: the new kinds survive a round trip, and an entry written before them is a reply.
        let url = temp.appendingPathComponent("uploads.json")
        var ledger = UploadLedger()
        ledger.recordings["a.mp4"] = .init(status: .saved, target: opening, at: "2026-11-16T10:00:00.000Z")
        ledger.recordings["b.mp4"] = .init(status: .failed, target: .report, at: "2026-11-16T10:05:00.000Z", error: "409")
        try ledger.save(to: url)
        XCTAssertEqual(try UploadLedger.load(from: url), ledger)
        let before = #"{"version": 1, "recordings": {"c.mp4": {"status": "uploaded", "target": {"thread": "MUS-1", "replyTo": 2}, "at": "2026-11-05T13:10:00.000Z"}}}"#
        try Data(before.utf8).write(to: url)
        XCTAssertEqual(try UploadLedger.load(from: url).recordings["c.mp4"]?.target, WalkthroughTarget(thread: "MUS-1", replyTo: 2))
    }

    /// `project list --capabilities --json`, `project new --json` and `thread new --json`, as polycap prints them.
    func testProjectsAndANewThreadAsPolycapPrintsThem() throws {
        let listing = try ThreadOutput.projects(Data(#"{"projects":[{"key":"MUS","name":"Marimba"},{"key":"KITC","name":"Kitchen Timer","mine":true}],"capabilities":["idempotent-replies-v1","reports-v1","projects-new-v1"]}"#.utf8))
        XCTAssertEqual(listing.projects, [ThreadProject(key: "MUS", name: "Marimba", mine: false), ThreadProject(key: "KITC", name: "Kitchen Timer", mine: true)])
        XCTAssertTrue(listing.takesReports)
        XCTAssertTrue(listing.makesProjects)
        let older = try ThreadOutput.projects(Data(#"{"projects":[{"key":"MUS","name":"Marimba"}],"capabilities":["idempotent-replies-v1"]}"#.utf8))
        XCTAssertFalse(older.takesReports, "a receiver without POLYCAP_REPORTS")
        XCTAssertFalse(older.makesProjects, "a receiver from before 2026-11-13")
        XCTAssertThrowsError(try ThreadOutput.projects(Data(#"{"projects":[{"key":"../MUS","name":"x"}],"capabilities":[]}"#.utf8))) { XCTAssertTrue("\($0)".contains("not a project key")) }
        XCTAssertThrowsError(try ThreadOutput.projects(Data(#"[{"key":"MUS","name":"Marimba"}]"#.utf8)), "the list without --capabilities")

        let made = try ThreadOutput.madeProject(Data(#"{"key":"KITC","name":"Kitchen Timer","hosts":[],"packages":[]}"#.utf8))
        XCTAssertEqual(made, ThreadProject(key: "KITC", name: "Kitchen Timer", mine: true))
        XCTAssertThrowsError(try ThreadOutput.madeProject(Data(#"{"key":"kitc","name":"Kitchen Timer"}"#.utf8)))

        let opened = try ThreadOutput.opened(Data(#"{"key":"KITC-4","message":1}"#.utf8))
        XCTAssertEqual(opened.key, "KITC-4")
        XCTAssertThrowsError(try ThreadOutput.opened(Data(#"{"key":"KITC","message":1}"#.utf8)))

        let report = try PolycapOutput.uploaded(from: Data(#"{"uploadId":"up_7e1e4b342f9bce95","thread":"CAP-31","as":"report","status":"received"}"#.utf8))
        XCTAssertEqual(report.kind, "report")
        XCTAssertEqual(report.thread, "CAP-31")
    }

    /// seam-4: no reply for a thread is recorded while a Meet call is live, and one that catches a call
    /// is stopped and kept unsent.
    func testAReplyNeverHoldsACall() {
        XCTAssertNil(ThreadReplyGuard.problem(arcMicActive: false, meetingCode: nil, detectorWatching: true))
        XCTAssertNil(ThreadReplyGuard.problem(arcMicActive: true, meetingCode: nil, detectorWatching: true), "Arc using the mic elsewhere")
        XCTAssertNil(ThreadReplyGuard.problem(arcMicActive: false, meetingCode: "abc-defg-hij", detectorWatching: true), "a Meet tab, not in a call")
        XCTAssertNotNil(ThreadReplyGuard.problem(arcMicActive: true, meetingCode: "abc-defg-hij", detectorWatching: true))
        XCTAssertNotNil(ThreadReplyGuard.problem(arcMicActive: false, meetingCode: nil, detectorWatching: false),
                        "the detector still follows a call the user stopped or discarded")
        XCTAssertTrue(ThreadReplyGuard.problem(arcMicActive: true, meetingCode: "abc-defg-hij", detectorWatching: true)?.contains("Calls never leave this Mac") ?? false)
        XCTAssertTrue(ThreadReplyGuard.callStarted(CallObservation(at: 1, micActive: true, meetingCodes: ["abc-defg-hij"])))
        XCTAssertFalse(ThreadReplyGuard.callStarted(CallObservation(at: 1, micActive: true, meetingCodes: nil)), "tabs not read")
        XCTAssertFalse(ThreadReplyGuard.callStarted(CallObservation(at: 1, micActive: false, meetingCodes: ["abc-defg-hij"])))
    }

    func testTheUploadLedger() throws {
        let url = temp.appendingPathComponent("uploads.json")
        XCTAssertEqual(try UploadLedger.load(from: url), UploadLedger(), "missing is empty")
        var ledger = UploadLedger()
        let target = WalkthroughTarget(thread: "MUS-1", replyTo: 2, launch: 0, label: "Option 1: gear in the top bar")
        ledger.recordings["polydance-mac-20261105-140210.mp4"] = .init(status: .uploading, target: target, at: "2026-11-05T14:10:00.000Z")
        ledger.recordings["polydance-mac-20261105-140500.mp4"] = .init(status: .recording, target: target, at: "2026-11-05T14:05:00.000Z")
        ledger.recordings["polydance-mac-20261105-130000.mp4"] = .init(status: .uploaded, target: target, at: "2026-11-05T13:10:00.000Z", uploadId: "up_7e1e4b342f9bce95")
        try ledger.save(to: url)
        XCTAssertEqual(PrivateFiles.permissions(of: url), 0o600)
        XCTAssertEqual(try UploadLedger.load(from: url), ledger)

        let restarted = ledger.afterRestart(at: "2026-11-05T15:00:00.000Z")
        XCTAssertEqual(restarted.recordings["polydance-mac-20261105-140210.mp4"]?.status, .failed)
        XCTAssertTrue(restarted.recordings["polydance-mac-20261105-140210.mp4"]?.error?.contains("cut off") ?? false)
        XCTAssertEqual(restarted.recordings["polydance-mac-20261105-140500.mp4"]?.status, .saved, "a recording cut off by quitting is offered to send")
        XCTAssertEqual(restarted.recordings["polydance-mac-20261105-130000.mp4"], ledger.recordings["polydance-mac-20261105-130000.mp4"])
        XCTAssertEqual(restarted.afterRestart(at: "later"), restarted, "nothing more changes")

        // ui-9: a polycap upload the app left running is still uploading; once it stops, nobody knows how it ended.
        var orphaned = ledger
        orphaned.recordings["polydance-mac-20261105-140210.mp4"]?.pid = 4242
        let watching = orphaned.afterRestart(at: "2026-11-05T15:00:00.000Z") { name, entry in name == "polydance-mac-20261105-140210.mp4" && entry.pid == 4242 }
        XCTAssertEqual(watching.recordings["polydance-mac-20261105-140210.mp4"]?.status, .uploading, "still sending, not cut off")
        XCTAssertEqual(watching.recordings["polydance-mac-20261105-140210.mp4"]?.pid, 4242)
        let stopped = UploadLedger.cutOff(try XCTUnwrap(watching.recordings["polydance-mac-20261105-140210.mp4"]), at: "later")
        XCTAssertEqual(stopped.status, .failed)
        XCTAssertNil(stopped.pid)
        XCTAssertTrue(stopped.error?.contains("Send again asks the receiver") ?? false)

        try Data("{\"version\": 2, \"recordings\": {}}".utf8).write(to: url)
        XCTAssertThrowsError(try UploadLedger.load(from: url))
    }

    // MARK: The runner

    /// thread show, reply and upload as `node polycap.js …` argument arrays, and polycap's own words
    /// when one fails: the upload token message is shown whole, with its fix.
    func testTheRunnersThreadCommands() async throws {
        let args = temp.appendingPathComponent("args")
        let showFixture = Fixture.dir.appendingPathComponent("thread-show.json")
        let uploadFixture = Fixture.dir.appendingPathComponent("upload.json")
        let tokenError = "polycap upload needs a receiver token with the upload scope; POLYCAP_REMOTE_TOKEN is not used for uploads. Make one with `polycap token new --id mac-capture --scope upload --scope read --user robin --label Mac --save mac-capture`, add the line it prints to the receiver's POLYCAP_SERVER_TOKENS (the receiver must list it, then restart), and pass --token mac-capture or set POLYCAP_UPLOAD_TOKEN=mac-capture in ~/.config/polycap/env (the Mac app uses that)."
        // In a file, so the shell never reads its backticks.
        let errorFile = temp.appendingPathComponent("token-error.txt")
        try Data((tokenError + "\n").utf8).write(to: errorFile)
        let node = try makeExecutable(temp.appendingPathComponent("bin/node"), """
        #!/bin/sh
        printf '%s\\n' "$@" > "\(args.path)"
        case "$2 $3" in
          "thread show") cat "\(showFixture.path)" ;;
          "thread reply") printf '{"key":"MUS-1","message":4}\\n' ;;
          "thread new") printf '{"key":"KITC-4","message":1}\\n' ;;
          "project list") printf '{"projects":[{"key":"KITC","name":"Kitchen Timer","mine":true}],"capabilities":["reports-v1"]}\\n' ;;
          "project new") printf '{"key":"GARD","name":"Garden Shed","hosts":[],"packages":[]}\\n' ;;
          "thread list") echo "Set POLYCAP_REMOTE_URL and POLYCAP_REMOTE_TOKEN in ~/.config/polycap/env to use threads" >&2; exit 1 ;;
          "hooks list") printf '{"file":"/Users/t/.config/polycap/hooks.json","found":false,"hooks":[]}\\n' ;;
          upload*) if [ "$5" = "CAP-9" ]; then cat "\(errorFile.path)" >&2; exit 1; fi; cat "\(uploadFixture.path)" ;;
        esac
        """)
        let script = temp.appendingPathComponent("polycap.js")
        try Data("// fake".utf8).write(to: script)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "polydance-tests-\(UUID().uuidString)"))
        let settings = SettingsStore(defaults: defaults)
        settings.nodePath = node.path
        settings.polycapPath = script.path
        let runner = PolycapRunner(settings: settings, home: "/Users/test", inherited: ["USER": "test"])
        func recorded() throws -> [String] { try String(contentsOf: args, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false).dropLast().map(String.init) }

        let thread = try await runner.threadShow(key: "MUS-1")
        XCTAssertEqual(thread.messages.count, 3, "thread show pretty-prints; the whole output is the JSON")
        XCTAssertEqual(try recorded(), [script.path, "thread", "show", "MUS-1", "--json"])
        do { _ = try await runner.threadShow(key: "MUS-1; rm"); XCTFail("not a key") } catch {}

        let posted = try await runner.threadReply(key: "MUS-1", text: "  -yes, much easier\n")
        XCTAssertEqual(posted.message, 4)
        XCTAssertEqual(try recorded(), [script.path, "thread", "reply", "MUS-1", "--text=-yes, much easier", "--json"])
        do { _ = try await runner.threadReply(key: "MUS-1", text: "   "); XCTFail("no words") } catch {}
        let photo = temp.appendingPathComponent("shot.png")
        try Data([0x89, 0x50, 0x4e, 0x47]).write(to: photo)
        _ = try await runner.threadReply(key: "MUS-1", text: " ", photos: [photo])
        XCTAssertEqual(try recorded(), [script.path, "thread", "reply", "MUS-1", "--photo=\(photo.path)", "--json"])
        do { _ = try await runner.threadReply(key: "MUS-1", text: "", photos: [temp.appendingPathComponent("gone.png")]); XCTFail("no such file") } catch {
            XCTAssertEqual("\(error)", "gone.png is not a file on this Mac any more")
        }

        do {
            _ = try await runner.threadList()
            XCTFail("a failing list is an error")
        } catch {
            XCTAssertEqual("\(error)", "polycap thread list exited 1: Set POLYCAP_REMOTE_URL and POLYCAP_REMOTE_TOKEN in ~/.config/polycap/env to use threads")
        }
        let hooks = try await runner.hooksList()
        XCTAssertFalse(hooks.found)

        let files = RecordingFiles(directory: temp.appendingPathComponent("rec dir"), baseName: "polydance-mac-20261105-140210")
        try FileManager.default.createDirectory(at: files.directory, withIntermediateDirectories: true)
        // hook-1: no metadata, or a call's, and polycap is never started.
        try? FileManager.default.removeItem(at: args)
        do { _ = try await runner.upload(files, to: WalkthroughTarget(thread: "MUS-1")); XCTFail("no metadata") } catch {
            XCTAssertTrue("\(error)".contains("could not be read, so the walkthrough was not sent"), "\(error)")
        }
        let call = RecordingFacts(mode: .call(meetingCode: "abc-defg-hij"), startedAt: Date(), endedAt: Date().addingTimeInterval(600)).meta()
        try call.encoded().write(to: files.meta)
        do { _ = try await runner.upload(files, to: WalkthroughTarget(thread: "MUS-1")); XCTFail("a call") } catch {
            XCTAssertTrue("\(error)".contains("Calls never leave this Mac"), "\(error)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: args.path), "polycap was not run for either")
        try RecordingFacts(mode: .walkthrough, startedAt: Date()).meta().encoded().write(to: files.meta)
        let sent = try await runner.upload(files, to: WalkthroughTarget(thread: "MUS-1", replyTo: 2, launch: 0))
        XCTAssertEqual(sent.uploadId, "up_7e1e4b342f9bce95")
        XCTAssertEqual(try recorded(), [script.path, "upload", files.video.path, "--thread", "MUS-1", "--reply-to", "2", "--launch", "0", "--meta", files.meta.path, "--json"])

        do {
            _ = try await runner.upload(files, to: WalkthroughTarget(thread: "CAP-9"))
            XCTFail("a refused upload is an error")
        } catch {
            XCTAssertEqual("\(error)", "polycap upload exited 1: \(tokenError)", "polycap's words whole, with the fix")
        }
        XCTAssertEqual(try recorded(), [script.path, "upload", files.video.path, "--thread", "CAP-9", "--meta", files.meta.path, "--json"])

        // New thread, New project and the bug key (2026-11-16).
        _ = try await runner.upload(files, to: .report)
        XCTAssertEqual(try recorded(), [script.path, "upload", files.video.path, "--report", "--meta", files.meta.path, "--json"])
        let listing = try await runner.projectList()
        XCTAssertEqual(listing.projects.map(\.key), ["KITC"])
        XCTAssertTrue(listing.takesReports)
        XCTAssertFalse(listing.makesProjects)
        let made = try await runner.projectNew(name: "  Garden Shed ")
        XCTAssertEqual(made, ThreadProject(key: "GARD", name: "Garden Shed", mine: true))
        XCTAssertEqual(try recorded(), [script.path, "project", "new", "--json", "--", "Garden Shed"])
        let opened = try await runner.threadNew(project: "KITC", title: " Alarm ", text: "Too loud\n")
        XCTAssertEqual(opened.key, "KITC-4")
        XCTAssertEqual(try recorded(), [script.path, "thread", "new", "--project", "KITC", "--title=Alarm", "--text=Too loud", "--json"])
        try? FileManager.default.removeItem(at: args)
        do { _ = try await runner.threadNew(project: "KITC", title: "  ", text: "words"); XCTFail("no title") } catch { XCTAssertEqual("\(error)", "a new thread needs a title") }
        do { _ = try await runner.threadNew(project: "KITC", title: "Alarm", text: " "); XCTFail("nothing to say") } catch { XCTAssertEqual("\(error)", "a new thread needs some words or a photo") }
        do { _ = try await runner.threadNew(project: "kitc", title: "Alarm", text: "x"); XCTFail("not a key") } catch {}
        do { _ = try await runner.projectNew(name: " "); XCTFail("no name") } catch { XCTAssertEqual("\(error)", "a project needs a name") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: args.path), "polycap was not run for any of them")
    }

    private func makeExecutable(_ url: URL, _ text: String) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }
}
