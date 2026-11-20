// The library layout, recording names, private permissions, the one deletion the app does (discard),
// and the hand-off ledger. Everything happens in a temporary folder, never the real library.
import Foundation
import PolydanceCore
import PolydanceShared
import XCTest

final class FilesTests: XCTestCase {
    var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("polydance-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    func testLibraryRootComesFromTheSettingThenPOLYCAP_ROOTThenHome() {
        let home = URL(fileURLWithPath: "/Users/someone")
        XCTAssertEqual(LibraryLayout.resolve(setting: nil, environment: [:], home: home).root.path, "/Users/someone/PolydanceCapture")
        XCTAssertEqual(LibraryLayout.resolve(setting: nil, environment: ["POLYCAP_ROOT": "~/Lib"], home: home).root.path, "/Users/someone/Lib")
        XCTAssertEqual(LibraryLayout.resolve(setting: "/Volumes/X/Lib", environment: ["POLYCAP_ROOT": "/elsewhere"], home: home).root.path, "/Volumes/X/Lib")
        XCTAssertEqual(LibraryLayout.resolve(setting: "  ", environment: [:], home: home).root.path, "/Users/someone/PolydanceCapture")
        let layout = LibraryLayout(root: URL(fileURLWithPath: "/Users/someone/PolydanceCapture"))
        XCTAssertEqual(layout.recordings.path, "/Users/someone/PolydanceCapture/mac/recordings")
        XCTAssertEqual(layout.sessions.path, "/Users/someone/PolydanceCapture/sessions")
        XCTAssertEqual(layout.handoffLedger.path, "/Users/someone/PolydanceCapture/mac/handoff.json")
    }

    func testRecordingNamesAreLocalTimeLikeTheHeadsets() throws {
        let date = try XCTUnwrap(MetaTime.parse("2026-11-05T11:00:02.120Z"))
        XCTAssertEqual(RecordingFiles.baseName(for: date, timeZone: try XCTUnwrap(TimeZone(identifier: "UTC"))), "polydance-mac-20261105-110002")
        XCTAssertEqual(RecordingFiles.baseName(for: date, timeZone: try XCTUnwrap(TimeZone(identifier: "Europe/London"))), "polydance-mac-20261105-110002")
        XCTAssertEqual(RecordingFiles.baseName(for: date, timeZone: try XCTUnwrap(TimeZone(identifier: "America/New_York"))), "polydance-mac-20261105-060002")
        let files = RecordingFiles(directory: temp, baseName: "polydance-mac-20261105-110002")
        XCTAssertEqual(files.video.lastPathComponent, "polydance-mac-20261105-110002.mp4")
        XCTAssertEqual(files.meta.lastPathComponent, "polydance-mac-20261105-110002.meta.json")
        XCTAssertTrue(RecordingFiles.isRecordingBaseName("polydance-mac-20261105-110002"))
        XCTAssertFalse(RecordingFiles.isRecordingBaseName("polydance-mac-20261105-11000"))
        XCTAssertFalse(RecordingFiles.isRecordingBaseName("polydance-mac-2026110x-110002"))
        XCTAssertFalse(RecordingFiles.isRecordingBaseName("../polydance-mac-20261105-110002"))
    }

    func testTwoRecordingsInOneSecondGetTheNextSecondsName() throws {
        let date = try XCTUnwrap(MetaTime.parse("2026-11-05T11:00:02.000Z"))
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let first = RecordingFiles.next(in: temp, at: date, timeZone: utc)
        FileManager.default.createFile(atPath: first.video.path, contents: Data())
        let second = RecordingFiles.next(in: temp, at: date, timeZone: utc)
        XCTAssertEqual(first.baseName, "polydance-mac-20261105-110002")
        XCTAssertEqual(second.baseName, "polydance-mac-20261105-110003")
    }

    func testDiscardRemovesOnlyThatRecordingsTwoFiles() throws {
        let recordings = temp.appendingPathComponent("mac/recordings")
        try PrivateFiles.makeDirectory(recordings, within: temp)
        let mine = RecordingFiles(directory: recordings, baseName: "polydance-mac-20261105-110002")
        let other = RecordingFiles(directory: recordings, baseName: "polydance-mac-20261105-100000")
        for url in [mine.video, mine.meta, other.video, other.meta, recordings.appendingPathComponent("notes.txt"),
                    recordings.appendingPathComponent("polydance-mac-20261105-110002.mp4.bak")] {
            XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data("x".utf8)))
        }
        let removed = try mine.discard(recordingsDirectory: recordings)
        XCTAssertEqual(Set(removed.map(\.lastPathComponent)), [mine.videoName, "polydance-mac-20261105-110002.meta.json"])
        let left = Set(try FileManager.default.contentsOfDirectory(atPath: recordings.path))
        XCTAssertEqual(left, [other.videoName, "polydance-mac-20261105-100000.meta.json", "notes.txt", "polydance-mac-20261105-110002.mp4.bak"])
        // Discarding again finds nothing and removes nothing.
        XCTAssertEqual(try mine.discard(recordingsDirectory: recordings), [])
    }

    /// ui-3: Discard takes the metadata away at once, so a quit or crash before the stop finishes can never
    /// hand over a call the user threw away: a video without metadata is not found at the next launch.
    func testDiscardTakesTheMetadataFirstSoTheRecordingIsNeverHandedOver() throws {
        let recordings = temp.appendingPathComponent("mac/recordings")
        try PrivateFiles.makeDirectory(recordings, within: temp)
        let mine = RecordingFiles(directory: recordings, baseName: "polydance-mac-20261105-110002")
        for url in [mine.video, mine.meta] { XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data("x".utf8))) }
        XCTAssertEqual(HandoffLedger().notHandedOver(in: recordings), [mine])
        XCTAssertEqual(try mine.discardMetadata(recordingsDirectory: recordings).map(\.lastPathComponent), ["polydance-mac-20261105-110002.meta.json"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: mine.video.path), "the video goes with the rest of the discard")
        XCTAssertEqual(HandoffLedger().notHandedOver(in: recordings), [], "and until then it is not handed over")
        XCTAssertThrowsError(try RecordingFiles(directory: temp, baseName: "polydance-mac-20261105-110002").discardMetadata(recordingsDirectory: recordings))
    }

    func testDiscardRefusesAnywhereButTheRecordingsFolder() throws {
        let recordings = temp.appendingPathComponent("mac/recordings")
        try PrivateFiles.makeDirectory(recordings, within: temp)
        let elsewhere = RecordingFiles(directory: temp, baseName: "polydance-mac-20261105-110002")
        FileManager.default.createFile(atPath: elsewhere.video.path, contents: Data("keep".utf8))
        XCTAssertThrowsError(try elsewhere.discard(recordingsDirectory: recordings))
        XCTAssertTrue(FileManager.default.fileExists(atPath: elsewhere.video.path))

        let badName = RecordingFiles(directory: recordings, baseName: "session")
        FileManager.default.createFile(atPath: badName.video.path, contents: Data("keep".utf8))
        XCTAssertThrowsError(try badName.discard(recordingsDirectory: recordings))
        XCTAssertTrue(FileManager.default.fileExists(atPath: badName.video.path))

        let folder = RecordingFiles(directory: recordings, baseName: "polydance-mac-20261105-120000")
        try FileManager.default.createDirectory(at: folder.video, withIntermediateDirectories: false)
        XCTAssertThrowsError(try folder.discard(recordingsDirectory: recordings), "a folder with a recording's name is not removed")
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.video.path))
    }

    func testFoldersAre0700AndFiles0600() throws {
        let root = temp.appendingPathComponent("Library")
        let recordings = root.appendingPathComponent("mac/recordings")
        try PrivateFiles.makeDirectory(recordings, within: root)
        XCTAssertEqual(PrivateFiles.permissions(of: root), 0o700)
        XCTAssertEqual(PrivateFiles.permissions(of: root.appendingPathComponent("mac")), 0o700)
        XCTAssertEqual(PrivateFiles.permissions(of: recordings), 0o700)

        let file = recordings.appendingPathComponent("x.meta.json")
        try PrivateFiles.write(Data("{}".utf8), to: file)
        XCTAssertEqual(PrivateFiles.permissions(of: file), 0o600)
        try PrivateFiles.write(Data("{\"a\":1}".utf8), to: file)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "{\"a\":1}")
        XCTAssertEqual(PrivateFiles.permissions(of: file), 0o600)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: recordings.path), ["x.meta.json"], "no temporary file is left")

        // A folder above the library root is never touched.
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: temp.path)
        try PrivateFiles.makeDirectory(root.appendingPathComponent("mac/logs"), within: root)
        XCTAssertEqual(PrivateFiles.permissions(of: temp), 0o755)
        XCTAssertThrowsError(try PrivateFiles.makeDirectory(temp.appendingPathComponent("outside"), within: root))
    }

    func testTheLedgerFindsRecordingsThatWereNeverHandedOver() throws {
        let recordings = temp.appendingPathComponent("mac/recordings")
        try PrivateFiles.makeDirectory(recordings, within: temp)
        let done = RecordingFiles(directory: recordings, baseName: "polydance-mac-20261105-090000")
        let waiting = RecordingFiles(directory: recordings, baseName: "polydance-mac-20261105-100000")
        let noMeta = RecordingFiles(directory: recordings, baseName: "polydance-mac-20261105-110000")
        for url in [done.video, done.meta, waiting.video, waiting.meta, noMeta.video] {
            FileManager.default.createFile(atPath: url.path, contents: Data())
        }
        FileManager.default.createFile(atPath: recordings.appendingPathComponent("other.mp4").path, contents: Data())

        let url = temp.appendingPathComponent("mac/handoff.json")
        var ledger = try HandoffLedger.load(from: url)
        XCTAssertEqual(ledger, HandoffLedger())
        ledger.recordings[done.videoName] = .init(status: .processed, sessionId: "2026-11-05T09-00-00_mac", sessionDir: "/x", at: "2026-11-05T10:00:00.000Z")
        try ledger.save(to: url)
        XCTAssertEqual(PrivateFiles.permissions(of: url), 0o600)
        let loaded = try HandoffLedger.load(from: url)
        XCTAssertEqual(loaded, ledger)
        XCTAssertEqual(loaded.notHandedOver(in: recordings), [waiting])

        try Data("{\"version\": 2, \"recordings\": {}}".utf8).write(to: url)
        XCTAssertThrowsError(try HandoffLedger.load(from: url))
        try Data("garbage".utf8).write(to: url)
        XCTAssertThrowsError(try HandoffLedger.load(from: url), "an unreadable ledger is an error, never a silent reset")
    }
}
