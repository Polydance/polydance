// Run names and the run folder (docs/IPHONE.md U6, R2).
import Foundation
import Testing
@testable import PolydancePhoneCore

@Suite struct RunNamesTests {
    @Test func namesAreThePhonesLocalWallClock() {
        let london = TimeZone(identifier: "Europe/London")!
        // 2026-11-06 14:05:01 UTC is 14:05:01 in London (GMT in November).
        let date = Date(timeIntervalSince1970: 1_793_973_901)
        #expect(RunNames.runName(for: date, timeZone: london) == "20261106-140501")
        #expect(RunNames.runName(for: date, timeZone: TimeZone(identifier: "America/New_York")!) == "20261106-090501")
    }

    @Test func uploadFileNameGivesAnIphoneSlug() {
        // src/filename.ts appSlug takes the package's last part: "iphone".
        #expect(RunNames.uploadFileName(runName: "20261106-140501") == "net.polydance.capture.iphone-20261106-140501.mp4")
    }

    @Test func onlyRunNamesAreRuns() {
        #expect(RunNames.isRunName("20261106-140501"))
        #expect(!RunNames.isRunName("20261106-14050"))
        #expect(!RunNames.isRunName("../20261106-140501"))
        #expect(!RunNames.isRunName(".DS_Store"))
    }
}

@Suite struct RunFolderTests {
    func temp() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("runs-\(UUID().uuidString)", isDirectory: true)
        try PrivateFiles.directory(url)
        return url
    }

    @Test func createsPrivateFoldersAndRefusesASecondInTheSameSecond() throws {
        let root = try temp()
        let date = Date(timeIntervalSince1970: 1_793_973_901)
        let run = try RunFolder.create(in: root, at: date, timeZone: TimeZone(identifier: "UTC")!)
        let mode = try FileManager.default.attributesOfItem(atPath: run.directory.path)[.posixPermissions] as? Int
        #expect(mode == 0o700)
        #expect(throws: (any Error).self) { try RunFolder.create(in: root, at: date, timeZone: TimeZone(identifier: "UTC")!) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("not-a-run"), withIntermediateDirectories: true)
        #expect(RunFolder.list(in: root).map(\.name) == ["20261106-140501"])
    }

    @Test func metaRoundTripsAndIsStrict() throws {
        let root = try temp()
        let run = try RunFolder.create(in: root, at: Date(), timeZone: .current)
        var meta = RunMeta(runName: run.name, recordedAt: "2026-11-06T14:05:01.000Z", device: ["model": "iPhone14,5", "system": "iOS 26.3"],
                           appVersion: "0.1.0 (1)", appCommit: "abc1234", orientation: "portrait", width: 1080, height: 1920, fps: 30,
                           cameras: [CameraSpan(atMs: 0, facing: "back")])
        meta.stoppedBecause = "stop"
        try run.writeMeta(meta)
        #expect(try run.readMeta() == meta)
        let mode = try FileManager.default.attributesOfItem(atPath: run.metaURL.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)

        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: run.metaURL)) as! [String: Any]
        json["surprise"] = 1
        try JSONSerialization.data(withJSONObject: json).write(to: run.metaURL)
        #expect(throws: (any Error).self) { try run.readMeta() }
    }
}

@Suite struct EventLogTests {
    @Test func writesOneJSONLinePerEvent() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("log-\(UUID().uuidString)/events.jsonl")
        let log = try EventLog(url: url, clock: { Date(timeIntervalSince1970: 1_793_973_901) })
        log.write("flip", ["facing": "front", "gapMs": 412])
        log.write("stop")
        let lines = log.tail(10)
        #expect(lines.count == 2)
        let first = try JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as! [String: Any]
        #expect(first["event"] as? String == "flip")
        #expect(first["gapMs"] as? Int == 412)
        #expect((first["t"] as? String)?.hasPrefix("2026-11-06T") == true)
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }
}
