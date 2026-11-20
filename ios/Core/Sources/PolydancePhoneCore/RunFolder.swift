// One recording on the phone: a folder named by its run name holding video.mp4, narration.m4a, run.json
// and timeline.jsonl, like the headset's runs. run.json says what the recording is (orientation, size,
// cameras, why it stopped) and is rewritten when the take finishes; until then `cut` is true, so a take
// the app never finished says so (docs/IPHONE.md R2). Strict: an unknown or missing key is an error.
import Foundation

public struct CameraSpan: Codable, Sendable, Equatable {
    /// Milliseconds from the start of the file when this camera's frames begin.
    public var atMs: Int
    /// "back" or "front".
    public var facing: String
    public init(atMs: Int, facing: String) { self.atMs = atMs; self.facing = facing }
}

public struct RunMeta: Codable, Sendable, Equatable {
    public static let currentVersion = 1
    public var version: Int
    public var runName: String
    /// When REC was pressed, ISO 8601 with the phone's offset.
    public var recordedAt: String
    /// `model` (the hardware identifier, such as iPhone17,3) and `system` (such as iOS 26.3); never the phone's own name.
    public var device: [String: String]
    public var appVersion: String
    public var appCommit: String
    /// The build number (CFBundleVersion), which on the Vision Pro is the headset's versionCode; nil when not recorded.
    public var appBuild: Int?
    /// portrait, portraitUpsideDown, landscapeLeft or landscapeRight, read at REC.
    public var orientation: String
    /// The file's picture size, already upright (no rotation in its metadata).
    public var width: Int
    public var height: Int
    public var fps: Int
    public var audioTracks: [String]
    public var micName: String?
    public var cameras: [CameraSpan]
    /// Each flip's gap: milliseconds between the last frame of one camera and the first of the next.
    public var flipGapsMs: [Int]
    /// True until the take finished cleanly and this file was rewritten.
    public var cut: Bool
    public var stoppedBecause: String?
    public var durationMs: Int?
    public var videoFrames: Int?
    public var droppedVideoFrames: Int?
    public var audioBuffers: Int?
    /// The app's own sound buffers written, when the take has an app track (the Vision Pro's).
    public var appAudioBuffers: Int?
    public var bytes: Int64?
    public var narrationBytes: Int64?

    public init(runName: String, recordedAt: String, device: [String: String], appVersion: String, appCommit: String,
                orientation: String, width: Int, height: Int, fps: Int, audioTracks: [String] = ["mic"], micName: String? = nil,
                cameras: [CameraSpan] = [], flipGapsMs: [Int] = [], cut: Bool = true) {
        version = Self.currentVersion
        self.runName = runName; self.recordedAt = recordedAt; self.device = device
        self.appVersion = appVersion; self.appCommit = appCommit
        self.orientation = orientation; self.width = width; self.height = height; self.fps = fps
        self.audioTracks = audioTracks; self.micName = micName; self.cameras = cameras; self.flipGapsMs = flipGapsMs; self.cut = cut
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case version, runName, recordedAt, device, appVersion, appCommit, appBuild, orientation, width, height, fps, audioTracks, micName
        case cameras, flipGapsMs, cut, stoppedBecause, durationMs, videoFrames, droppedVideoFrames, audioBuffers, appAudioBuffers, bytes, narrationBytes
    }

    public init(from decoder: Decoder) throws {
        let keys = try decoder.container(keyedBy: AnyKey.self)
        let known = Set(CodingKeys.allCases.map(\.rawValue))
        if let extra = keys.allKeys.first(where: { !known.contains($0.stringValue) }) {
            throw DecodingError.dataCorrupted(.init(codingPath: [extra], debugDescription: "run.json has an unknown key \(extra.stringValue)"))
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        guard version == Self.currentVersion else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: c, debugDescription: "run.json version \(version) is not \(Self.currentVersion)")
        }
        runName = try c.decode(String.self, forKey: .runName)
        recordedAt = try c.decode(String.self, forKey: .recordedAt)
        device = try c.decode([String: String].self, forKey: .device)
        appVersion = try c.decode(String.self, forKey: .appVersion)
        appCommit = try c.decode(String.self, forKey: .appCommit)
        appBuild = try c.decodeIfPresent(Int.self, forKey: .appBuild)
        orientation = try c.decode(String.self, forKey: .orientation)
        width = try c.decode(Int.self, forKey: .width)
        height = try c.decode(Int.self, forKey: .height)
        fps = try c.decode(Int.self, forKey: .fps)
        audioTracks = try c.decode([String].self, forKey: .audioTracks)
        micName = try c.decodeIfPresent(String.self, forKey: .micName)
        cameras = try c.decode([CameraSpan].self, forKey: .cameras)
        flipGapsMs = try c.decode([Int].self, forKey: .flipGapsMs)
        cut = try c.decode(Bool.self, forKey: .cut)
        stoppedBecause = try c.decodeIfPresent(String.self, forKey: .stoppedBecause)
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
        videoFrames = try c.decodeIfPresent(Int.self, forKey: .videoFrames)
        droppedVideoFrames = try c.decodeIfPresent(Int.self, forKey: .droppedVideoFrames)
        audioBuffers = try c.decodeIfPresent(Int.self, forKey: .audioBuffers)
        appAudioBuffers = try c.decodeIfPresent(Int.self, forKey: .appAudioBuffers)
        bytes = try c.decodeIfPresent(Int64.self, forKey: .bytes)
        narrationBytes = try c.decodeIfPresent(Int64.self, forKey: .narrationBytes)
    }

    struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }
}

public struct RunFolder: Sendable, Hashable, Identifiable {
    public let name: String
    public let directory: URL
    public var id: String { name }

    public var videoURL: URL { directory.appendingPathComponent(RunNames.videoFile) }
    public var narrationURL: URL { directory.appendingPathComponent(RunNames.narrationFile) }
    public var metaURL: URL { directory.appendingPathComponent(RunNames.metaFile) }
    public var timelineURL: URL { directory.appendingPathComponent(RunNames.timelineFile) }
    public var openedURL: URL { directory.appendingPathComponent(RunNames.openedFile) }
    public var uploadFileName: String { RunNames.uploadFileName(runName: name) }

    public init(name: String, directory: URL) {
        self.name = name
        self.directory = directory
    }

    /// Makes `<root>/<run name>` (0700) for a take started at `date`. A second take in the same second
    /// is refused rather than written into the first one's folder.
    public static func create(in root: URL, at date: Date, timeZone: TimeZone = .current) throws -> RunFolder {
        try PrivateFiles.directory(root)
        let name = RunNames.runName(for: date, timeZone: timeZone)
        let dir = root.appendingPathComponent(name, isDirectory: true)
        guard !FileManager.default.fileExists(atPath: dir.path) else {
            throw CocoaError(.fileWriteFileExists, userInfo: [NSFilePathErrorKey: dir.path, NSLocalizedDescriptionKey: "a run named \(name) already exists"])
        }
        try PrivateFiles.directory(dir)
        return RunFolder(name: name, directory: dir)
    }

    /// Every run under `root`, newest first; folders that are not run names are left out.
    public static func list(in root: URL) -> [RunFolder] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return names.filter(RunNames.isRunName).sorted(by: >).map { RunFolder(name: $0, directory: root.appendingPathComponent($0, isDirectory: true)) }
    }

    public func readMeta() throws -> RunMeta {
        try JSONDecoder().decode(RunMeta.self, from: Data(contentsOf: metaURL))
    }

    public func writeMeta(_ meta: RunMeta) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try PrivateFiles.write(encoder.encode(meta), to: metaURL)
    }
}
