// The import metadata the Mac app writes beside each recording (<name>.meta.json) and hands to
// `polycap import --meta`. Version 1, strict: the shape is the contract with src/call.ts, and the
// fixture tests/fixtures/mac-call-meta.json is the example both sides test against. The app validates
// before writing, so a bad value fails here with a clear message instead of at import.
import Foundation
import PolydanceShared

public enum AudioTrackRole: String, Codable, Sendable { case mic, app }
public enum CallApp: String, Codable, Sendable { case meet }
public enum CallBrowser: String, Codable, Sendable { case arc }
public enum VideoOutcome: String, Codable, Sendable { case recorded, none }
public enum ToldOthers: String, Codable, Sendable { case yes, no, unknown }

/// The build that made the recording (`source.appBuild` in session.json).
public struct AppBuildInfo: Codable, Sendable, Equatable {
    public var versionName: String
    public var versionCode: Int?
    public var commit: String?

    public init(versionName: String, versionCode: Int? = nil, commit: String? = nil) {
        self.versionName = versionName
        self.versionCode = versionCode
        self.commit = commit
    }

    /// From the app's Info.plist: CFBundleShortVersionString, CFBundleVersion and the PolydanceCommit
    /// key build.sh writes.
    public static func from(infoDictionary info: [String: Any]?) -> AppBuildInfo {
        let name = info?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let code = (info?["CFBundleVersion"] as? String).flatMap { Int($0) }
        let commit = (info?["PolydanceCommit"] as? String).flatMap { isCommit($0) ? $0 : nil }
        return AppBuildInfo(versionName: name, versionCode: code, commit: commit)
    }

    /// src/import-meta.ts: `^[0-9a-f]{7,40}(-dirty)?$`.
    public static func isCommit(_ text: String) -> Bool {
        let hash = text.hasSuffix("-dirty") ? String(text.dropLast(6)) : text
        return (7...40).contains(hash.utf8.count) && hash.utf8.allSatisfy {
            (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0)
        }
    }
}

/// A moment marked with the shortcut, on the recording's clock.
public struct RecordingMark: Codable, Sendable, Equatable {
    public var atMs: Int
    public var note: String?

    public init(atMs: Int, note: String? = nil) {
        self.atMs = atMs
        self.note = note
    }
}

public struct DisplaySize: Codable, Sendable, Equatable {
    public var width: Int
    public var height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

/// A stretch of a call without a picture (C11, C14): the screen capture stopped at `fromMs` and came back
/// at `toMs`, on the recording's clock (from its first sample, as marks are); with no `toMs` it never came
/// back. `reason` is what stopped it, in macOS's words where it gave any. The file shows black there,
/// never the last picture, so nothing reads a stale screen as live.
public struct VideoGap: Codable, Sendable, Equatable {
    public var fromMs: Int
    public var toMs: Int?
    public var reason: String

    public init(fromMs: Int, toMs: Int? = nil, reason: String) {
        self.fromMs = fromMs
        self.toMs = toMs
        self.reason = reason
    }

    static let keys: Set<String> = ["fromMs", "toMs", "reason"]
}

/// `call` in the metadata: present for a call, absent for a walkthrough.
public struct CallMeta: Codable, Sendable, Equatable {
    public var app: CallApp
    public var browser: CallBrowser?
    public var meetingCode: String?
    public var startedAt: String
    public var endedAt: String?
    public var stopReason: CallStopReason?
    public var video: VideoOutcome?
    public var videoNote: String?
    public var farEnd: FarEnd?
    public var short: Bool?
    public var cut: Bool?
    public var told: ToldOthers?
    /// The size in points of what was captured at the start: the call's window, else the display.
    public var display: DisplaySize?
    public var excludedApps: [String]?
    /// Where the picture stopped mid-call, in order; absent when it never did.
    public var videoGaps: [VideoGap]?

    public init(app: CallApp = .meet, browser: CallBrowser? = .arc, meetingCode: String? = nil, startedAt: String,
                endedAt: String? = nil, stopReason: CallStopReason? = nil, video: VideoOutcome? = nil, videoNote: String? = nil,
                farEnd: FarEnd? = nil, short: Bool? = nil, cut: Bool? = nil, told: ToldOthers? = nil,
                display: DisplaySize? = nil, excludedApps: [String]? = nil, videoGaps: [VideoGap]? = nil) {
        self.app = app
        self.browser = browser
        self.meetingCode = meetingCode
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.stopReason = stopReason
        self.video = video
        self.videoNote = videoNote
        self.farEnd = farEnd
        self.short = short
        self.cut = cut
        self.told = told
        self.display = display
        self.excludedApps = excludedApps
        self.videoGaps = videoGaps
    }

    static let keys: Set<String> = ["app", "browser", "meetingCode", "startedAt", "endedAt", "stopReason", "video", "videoNote",
                                    "farEnd", "short", "cut", "told", "display", "excludedApps", "videoGaps"]
}

public struct MetaError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { "recording metadata: \(message)" }
}

public struct RecordingMeta: Codable, Sendable, Equatable {
    public static let currentVersion = 1
    public static let appPackageID = "net.polydance.capture.mac"
    /// src/call.ts MAX_MARKS: a stuck key must not flood the bundle.
    public static let maxMarks = 500
    public static let maxNoteLength = 200
    public static let maxVideoNoteLength = 300
    /// src/call.ts MAX_VIDEO_GAPS and a gap's reason, at most 120 characters.
    public static let maxVideoGaps = 20
    public static let maxGapReasonLength = 120

    public var version: Int
    public var recordedAt: String?
    public var appPackage: String?
    public var appBuild: AppBuildInfo?
    public var audioTracks: [AudioTrackRole]?
    public var marks: [RecordingMark]?
    public var call: CallMeta?

    public init(version: Int = RecordingMeta.currentVersion, recordedAt: String? = nil, appPackage: String? = RecordingMeta.appPackageID,
                appBuild: AppBuildInfo? = nil, audioTracks: [AudioTrackRole]? = nil, marks: [RecordingMark]? = nil, call: CallMeta? = nil) {
        self.version = version
        self.recordedAt = recordedAt
        self.appPackage = appPackage
        self.appBuild = appBuild
        self.audioTracks = audioTracks
        self.marks = marks
        self.call = call
    }

    static let keys: Set<String> = ["version", "recordedAt", "appPackage", "appBuild", "audioTracks", "marks", "call"]

    /// Throws the first rule the value breaks, in the words src/call.ts uses where it has them.
    public func validate() throws {
        guard version == Self.currentVersion else { throw MetaError("version must be 1, not \(version)") }
        if let recordedAt, MetaTime.parse(recordedAt) == nil { throw MetaError("recordedAt must be an ISO 8601 time") }
        if let appPackage, !BundleIDRule.isPackageName(appPackage) { throw MetaError("appPackage \(appPackage) is not a package name") }
        if let appBuild {
            if appBuild.versionName.isEmpty || appBuild.versionName.utf16.count > 80 { throw MetaError("appBuild.versionName must be 1 to 80 characters") }
            if let code = appBuild.versionCode, code < 0 { throw MetaError("appBuild.versionCode must not be negative") }
            if let commit = appBuild.commit, !AppBuildInfo.isCommit(commit) { throw MetaError("appBuild.commit must be a git commit hash") }
        }
        if let audioTracks {
            if audioTracks.isEmpty || audioTracks.count > 2 { throw MetaError("audioTracks must name one or two tracks") }
            if Set(audioTracks).count != audioTracks.count { throw MetaError("audioTracks names a track role twice") }
        }
        if let marks {
            if marks.count > Self.maxMarks { throw MetaError("at most \(Self.maxMarks) marks") }
            for mark in marks {
                if mark.atMs < 0 { throw MetaError("a mark's atMs must not be negative") }
                if let note = mark.note, note.utf16.count > Self.maxNoteLength { throw MetaError("a mark's note is at most \(Self.maxNoteLength) characters") }
            }
        }
        guard let call else { return }
        if let code = call.meetingCode, !MeetLink.isMeetingCode(code) { throw MetaError("call.meetingCode must look like abc-defg-hij") }
        guard let started = MetaTime.parse(call.startedAt) else { throw MetaError("call.startedAt must be an ISO 8601 time") }
        if let endedAt = call.endedAt {
            guard let ended = MetaTime.parse(endedAt) else { throw MetaError("call.endedAt must be an ISO 8601 time") }
            if ended < started { throw MetaError("call.endedAt is before startedAt") }
        }
        if let note = call.videoNote, note.isEmpty || note.utf16.count > Self.maxVideoNoteLength {
            throw MetaError("call.videoNote must be 1 to \(Self.maxVideoNoteLength) characters")
        }
        if let display = call.display, display.width <= 0 || display.height <= 0 { throw MetaError("call.display must be positive") }
        if let apps = call.excludedApps {
            if apps.count > 200 { throw MetaError("at most 200 excluded apps") }
            if let bad = apps.first(where: { !BundleIDRule.isValid($0) }) { throw MetaError("excluded app \(bad) is not a bundle id") }
        }
        if let gaps = call.videoGaps {
            if gaps.count > Self.maxVideoGaps { throw MetaError("at most \(Self.maxVideoGaps) video gaps") }
            for gap in gaps {
                if gap.fromMs < 0 { throw MetaError("a video gap's fromMs must not be negative") }
                if let to = gap.toMs, to < gap.fromMs { throw MetaError("a video gap's toMs is before its fromMs") }
                if gap.reason.isEmpty || gap.reason.utf16.count > Self.maxGapReasonLength {
                    throw MetaError("a video gap's reason must be 1 to \(Self.maxGapReasonLength) characters")
                }
            }
        }
    }

    /// Validated, pretty-printed JSON with sorted keys and a final line break.
    public func encoded() throws -> Data {
        try validate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(self)
        data.append(0x0A)
        return data
    }

    /// Reads metadata strictly: unknown keys, wrong types and broken rules are errors.
    public static func decode(_ data: Data) throws -> RecordingMeta {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MetaError("not a JSON object") }
        if let extra = Set(object.keys).subtracting(keys).sorted().first { throw MetaError("unknown key \(extra)") }
        if let call = object["call"] as? [String: Any], let extra = Set(call.keys).subtracting(CallMeta.keys).sorted().first {
            throw MetaError("unknown key call.\(extra)")
        }
        if let gaps = (object["call"] as? [String: Any])?["videoGaps"] as? [[String: Any]],
           let extra = gaps.lazy.compactMap({ Set($0.keys).subtracting(VideoGap.keys).sorted().first }).first {
            throw MetaError("unknown key call.videoGaps.\(extra)")
        }
        let meta: RecordingMeta
        do { meta = try JSONDecoder().decode(RecordingMeta.self, from: data) } catch { throw MetaError("does not match version 1: \(error)") }
        try meta.validate()
        return meta
    }
}

/// Bundle ids (src/call.ts: `^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$`) and package names (src/import-meta.ts:
/// `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$`, at most 200).
public enum BundleIDRule {
    public static func isPackageName(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard text.utf8.count <= 200, parts.count >= 2, let first = parts.first?.utf8.first,
              (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(first | 0x20) else { return false }
        return parts.allSatisfy { part in
            !part.isEmpty && part.utf8.allSatisfy { b in
                (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(b) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(b)
                    || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b) || b == UInt8(ascii: "_")
            }
        }
    }

    public static func isValid(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard (1...200).contains(bytes.count) else { return false }
        func alnum(_ b: UInt8) -> Bool {
            (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(b) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(b)
                || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b)
        }
        guard alnum(bytes[0]) else { return false }
        return bytes.dropFirst().allSatisfy { alnum($0) || $0 == UInt8(ascii: ".") || $0 == UInt8(ascii: "-") }
    }
}
