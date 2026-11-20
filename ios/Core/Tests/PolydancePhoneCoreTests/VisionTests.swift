// What the Vision Pro's port added to the shared core (docs/VISIONOS.md): the opened.json a launch writes
// during a take and the create body's `opened` and versionCode, the model step's sha256 the viewer fetches
// by, and the movie writer's second audio track (the app's own sound) and its mic switch. Synthetic buffers
// on this Mac, as MovieWriterTests; the headset's broadcast, encoder and timing are seen only on the Vision Pro.
import AVFoundation
import CoreMedia
import Foundation
import PolydanceShared
import Testing
@testable import PolydancePhoneCore

private let videoSha = String(repeating: "a", count: 64)
private let meta = RunMeta(runName: "20261112-140501", recordedAt: "2026-11-12T14:05:01.250+00:00",
                           device: ["model": "RealityDevice14,1", "system": "visionOS 26.2"], appVersion: "0.21.0", appCommit: "a8e3c7d",
                           orientation: "landscape", width: 1920, height: 1080, fps: 30, audioTracks: ["mic", "app"])

private func object(_ data: Data) throws -> NSDictionary { try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary) }

@Suite struct OpenedTests {
    @Test func aRunKeepsWhatItOpenedAndTheUploadSendsIt() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("opened-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let run = try RunFolder.create(in: root, at: Date(timeIntervalSince1970: 1_800_000_000), timeZone: TimeZone(identifier: "UTC")!)
        #expect(try Opened.read(run) == [])
        let first = Opened(atMs: 4200, what: Opened.what(links: [URL(string: "https://example.com/menu")!]), label: "Red menu", message: 3, launch: 1)
        try Opened.append(first, to: run)
        try Opened.append(Opened(atMs: 9000, what: "open https://example.com/"), to: run)
        let read = try Opened.read(run)
        #expect(read.count == 2)
        #expect(read.first == first)
        #expect(read.first?.what == "open https://example.com/menu")
        let mode = try FileManager.default.attributesOfItem(atPath: run.openedURL.path)[.posixPermissions] as? NSNumber
        #expect(mode?.intValue == 0o600)

        var m = meta
        m.runName = run.name
        m.appBuild = 28
        let body = try CreateUploadBody(installId: "0123456789abcdef", runName: run.name, meta: m, videoBytes: 10, videoSha256: videoSha,
                                        narration: nil, thread: .replying(to: "CAP-1"), opened: read)
        let sent = try object(body.json())
        let opened = try #require(sent["opened"] as? [NSDictionary])
        #expect(opened.first == ["atMs": 4200, "what": "open https://example.com/menu", "label": "Red menu", "message": 3, "launch": 1])
        #expect(opened.last == ["atMs": 9000, "what": "open https://example.com/"])
        #expect((sent["app"] as? NSDictionary) == ["versionName": "0.21.0", "versionCode": 28, "commit": "a8e3c7d"])
        #expect(sent["audioTracks"] as? [String] == ["mic", "app"])
        #expect((sent["fileName"] as? String)?.hasPrefix(RunNames.appPackage + "-") == true)
    }

    @Test func nothingOpenedSendsNoKey() throws {
        let body = try CreateUploadBody(installId: "0123456789abcdef", runName: meta.runName, meta: meta, videoBytes: 10, videoSha256: videoSha, narration: nil)
        #expect(try object(body.json())["opened"] == nil)
        #expect((try object(body.json())["app"] as? NSDictionary)?["versionCode"] == nil, "no build number in run.json, none sent")
    }

    @Test func refusesWhatTheSchemaWould() {
        let bad = [Opened(atMs: -1, what: "open https://example.com/"), Opened(atMs: 0, what: ""),
                   Opened(atMs: 0, what: String(repeating: "x", count: 301)), Opened(atMs: 0, what: "x", label: String(repeating: "l", count: 41)),
                   Opened(atMs: 0, what: "x", message: 0), Opened(atMs: 0, what: "x", launch: 6)]
        for entry in bad {
            #expect(throws: UploadProtocolError.self) {
                try CreateUploadBody(installId: "0123456789abcdef", runName: meta.runName, meta: meta, videoBytes: 10, videoSha256: videoSha,
                                     narration: nil, opened: [entry])
            }
        }
        let many = Array(repeating: Opened(atMs: 0, what: "x"), count: Opened.maxCount + 1)
        #expect(throws: UploadProtocolError.self) {
            try CreateUploadBody(installId: "0123456789abcdef", runName: meta.runName, meta: meta, videoBytes: 10, videoSha256: videoSha, narration: nil, opened: many)
        }
    }

    @Test func runJsonKeepsTheBuildAndAppSoundAndOlderFilesStillRead() throws {
        var m = meta
        m.appBuild = 28
        m.appAudioBuffers = 12
        let encoder = JSONEncoder()
        let decoded = try JSONDecoder().decode(RunMeta.self, from: encoder.encode(m))
        #expect(decoded == m)
        // A run.json written before these keys (the iPhone's) still reads, with neither.
        let older = try JSONDecoder().decode(RunMeta.self, from: encoder.encode(meta))
        #expect(older.appBuild == nil && older.appAudioBuffers == nil)
    }
}

@Suite struct ModelStepTests {
    @Test func aModelStepKeepsItsSha256OnlyWhenItIsOne() throws {
        let sha = String(repeating: "0123456789abcdef", count: 4)
        let good = try JSONDecoder().decode(LaunchStep.self, from: Data(#"{"do":"model","sha256":"\#(sha)","name":"chair.glb","bytes":4200}"#.utf8))
        #expect(good == .model(name: "chair.glb", bytes: 4200, sha256: sha))
        let upper = try JSONDecoder().decode(LaunchStep.self, from: Data(#"{"do":"model","sha256":"\#(sha.uppercased())","name":"chair.glb","bytes":4200}"#.utf8))
        #expect(upper == .model(name: "chair.glb", bytes: 4200, sha256: nil), "never fetched by a name the receiver would not give")
        let none = try JSONDecoder().decode(LaunchStep.self, from: Data(#"{"do":"model","name":"chair.glb","bytes":4200}"#.utf8))
        #expect(none == .model(name: "chair.glb", bytes: 4200, sha256: nil))
    }
}

/// The Vision Pro's take: video, the mic and the app's sound, in that order, the app's sound quiet for a
/// stretch in the middle and starting late; and a take with the mic switched off.
@Suite(.serialized) struct AppSoundTests {
    static let size = (width: 1920, height: 1080)

    func temp() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("app-sound-\(UUID().uuidString)", isDirectory: true)
        try PrivateFiles.directory(url)
        return url
    }

    @Test func writesTheAppsSoundAsTheThirdTrackWithItsQuietStretch() async throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent(RunNames.videoFile)
        let narration = dir.appendingPathComponent(RunNames.narrationFile)
        var settings = MovieWriterSettings(width: Self.size.width, height: Self.size.height)
        settings.appAudio = true
        let writer = try MovieWriter(videoURL: video, narrationURL: narration, settings: settings)
        let mic = try MovieWriterTests.pcmFormat(rate: 48_000, channels: 1, float: true)
        let app = try MovieWriterTests.pcmFormat(rate: 44_100, channels: 2, float: false)
        // Frames for 3 s; the mic throughout; the app's sound from 0.5 s, quiet from 1.2 s to 2.2 s.
        var t = 0.0
        var micAt = 0.0, appAt = 0.5
        let micFrames = 1024, appFrames = 1024
        while t < 3.0 {
            writer.appendVideo(try MovieWriterTests.frame(width: Self.size.width, height: Self.size.height, at: t))
            while micAt < t + 1 / 30.0 {
                writer.appendAudio(try MovieWriterTests.tone(mic, frames: micFrames, at: micAt))
                micAt += Double(micFrames) / 48_000
            }
            while appAt < t + 1 / 30.0 {
                if appAt < 1.2 || appAt >= 2.2 { writer.appendAppAudio(try MovieWriterTests.tone(app, frames: appFrames, at: appAt)) }
                appAt += Double(appFrames) / 44_100
            }
            try await MovieWriterTests.waitUntilReady(writer)
            t += 1 / 30.0
        }
        let stats = try await writer.finish()
        #expect(stats.failure == nil)
        #expect(stats.appAudioBuffers > 0)
        #expect(stats.droppedAppAudioBuffers == 0)
        #expect(stats.appAudioGaps == 2, "the late start and the quiet stretch: \(stats.appAudioGaps)")
        #expect(abs(stats.filledAppAudioSeconds - 1.5) < 0.05, "0.5 s before it starts and 1 s quiet: \(stats.filledAppAudioSeconds)")
        #expect(stats.audioGaps == 0)

        let asset = AVURLAsset(url: video)
        let tracks = try await MovieWriterTests.audioTracks(asset)
        #expect(tracks.count == 2, "mic, then app")
        #expect(tracks.first?.channels == 1)
        #expect(tracks.last?.channels == 2)
        #expect(tracks.allSatisfy { $0.rate == 48_000 })
        for track in tracks { #expect(abs(track.seconds - 3.0) < 0.15, "each sound lasts as long as the take: \(track.seconds) s") }
        #expect(try await MovieWriterTests.audioTracks(AVURLAsset(url: narration)).count == 1, "the narration is the mic alone")
    }

    @Test func micOffWritesNoMicTrackAndNoNarrationAndAQuietAppTrackIsStillThere() async throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent(RunNames.videoFile)
        let narration = dir.appendingPathComponent(RunNames.narrationFile)
        var settings = MovieWriterSettings(width: Self.size.width, height: Self.size.height)
        settings.mic = false
        settings.appAudio = true
        let writer = try MovieWriter(videoURL: video, narrationURL: narration, settings: settings)
        let mic = try MovieWriterTests.pcmFormat(rate: 48_000, channels: 1, float: true)
        var t = 0.0
        while t < 2.0 {
            writer.appendVideo(try MovieWriterTests.frame(width: Self.size.width, height: Self.size.height, at: t))
            writer.appendAudio(try MovieWriterTests.tone(mic, frames: 1600, at: t))
            try await MovieWriterTests.waitUntilReady(writer)
            t += 1 / 30.0
        }
        let stats = try await writer.finish()
        #expect(stats.failure == nil)
        #expect(stats.audioBuffers == 0, "the mic is off, so its sound is ignored")
        #expect(stats.appAudioBuffers == 0)
        #expect(stats.filledAppAudioSeconds > 1.9, "an app track that heard nothing is silence to the end")
        #expect(!FileManager.default.fileExists(atPath: narration.path))
        let tracks = try await MovieWriterTests.audioTracks(AVURLAsset(url: video))
        #expect(tracks.count == 1)
        #expect(tracks.first?.channels == 2)
        #expect(abs((tracks.first?.seconds ?? 0) - 2.0) < 0.15)
    }
}
