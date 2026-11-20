// What the call page reads from a bundle besides session.json and hook-runs.json: frames.json (the
// keyframes and why each was taken) and transcript.json (the lines and whose voice each is). Both are
// polycap's files (src/pipeline/frames.ts, transcribe.ts), validated there. The app reads them strictly
// on what it relies on and tolerates keys it does not know, so a newer polycap that adds a field does not
// blank the page: a version other than 1, a frame file that could name something outside frames/, or a
// speaker other than me, others or others:N is an error naming the file, never a guess. A frame reason
// this app does not know is kept as written and simply not shown as a scene.
import Foundation

/// Whose voice a transcript line is (src/pipeline/voices.ts): the mic, the call's sound, or one of the far
/// end's speakers when the transcriber tells them apart.
public enum Speaker: Sendable, Equatable, Hashable, Decodable, CustomStringConvertible {
    case me
    case others
    case other(Int)

    public init(parsing text: String) throws {
        switch text {
        case "me": self = .me
        case "others": self = .others
        default:
            let prefix = "others:"
            let digits = text.hasPrefix(prefix) ? String(text.dropFirst(prefix.count)) : ""
            // src/pipeline/voices.ts: others:1 to others:999, no leading zero.
            guard (1...3).contains(digits.utf8.count), digits.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
                  !digits.hasPrefix("0"), let n = Int(digits) else {
                throw FileRuleError("speaker \"\(text)\" is not me, others or others:1 to others:999")
            }
            self = .other(n)
        }
    }

    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        do { try self.init(parsing: text) } catch let error as FileRuleError {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: error.message))
        }
    }

    /// "Me", "Others", "Others 2", as transcript.md writes them.
    public var label: String {
        switch self {
        case .me: "Me"
        case .others: "Others"
        case .other(let n): "Others \(n)"
        }
    }

    public var isMe: Bool { self == .me }
    public var description: String { label }
}

/// Paths inside a bundle that the app opens: one or two plain components, never absolute, never `..`.
public enum BundlePath {
    public static func isSafe(_ path: String, maxComponents: Int = 1) -> Bool {
        guard !path.isEmpty, path.utf8.count <= 300, !path.hasPrefix("/") else { return false }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard (1...maxComponents).contains(parts.count) else { return false }
        return parts.allSatisfy { part in
            !part.isEmpty && part != "." && part != ".." && part.utf8.allSatisfy { b in
                (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(b) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(b)
                    || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b) || b == UInt8(ascii: ".") || b == UInt8(ascii: "_") || b == UInt8(ascii: "-")
            }
        }
    }
}

/// frames.json, version 1: the keyframes in frames/, each with its clock and why it was taken.
public struct FramesFile: Decodable, Sendable, Equatable {
    public struct Frame: Decodable, Sendable, Equatable, Identifiable {
        /// The thumbnail, relative to frames/ (0001_00m03s.jpg).
        public var file: String
        public var atMs: Int
        /// mark, scene, pointing, segment, interval or edge (src/pipeline/frames.ts FRAME_REASONS).
        public var reason: String
        public var word: String?
        /// A full-resolution copy, relative to frames/ (full/0001_00m03s.jpg).
        public var full: String?

        public var id: String { file }
        public var isMark: Bool { reason == "mark" }
        public var isScene: Bool { reason == "scene" }
    }

    public var version: Int
    public var width: Int?
    public var frames: [Frame]

    public static func decode(_ data: Data) throws -> FramesFile {
        let value: FramesFile
        do { value = try JSONDecoder().decode(FramesFile.self, from: data) } catch { throw FileRuleError("frames.json does not match version 1: \(error)") }
        guard value.version == 1 else { throw FileRuleError("frames.json has version \(value.version); this app reads version 1") }
        for frame in value.frames {
            guard BundlePath.isSafe(frame.file) else { throw FileRuleError("frames.json names a frame file \"\(frame.file)\" outside frames/") }
            if let full = frame.full, !BundlePath.isSafe(full, maxComponents: 2) { throw FileRuleError("frames.json names a full frame \"\(full)\" outside frames/") }
            guard frame.atMs >= 0 else { throw FileRuleError("frames.json: frame \(frame.file) has a negative clock") }
        }
        return value
    }

    /// Nil when the bundle has no frames.json (frames not extracted yet, or an audio-only call).
    public static func load(from dir: URL) throws -> FramesFile? {
        let url = dir.appendingPathComponent("frames.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decode(try Data(contentsOf: url))
    }

    public static func thumbnail(_ frame: Frame, in dir: URL) -> URL {
        dir.appendingPathComponent("frames").appendingPathComponent(frame.file)
    }

    /// The full-resolution copy when there is one, else the thumbnail.
    public static func largest(_ frame: Frame, in dir: URL) -> URL {
        guard let full = frame.full else { return thumbnail(frame, in: dir) }
        return full.split(separator: "/").reduce(dir.appendingPathComponent("frames")) { $0.appendingPathComponent(String($1)) }
    }

    /// The scenes grid: where the screen changed and what the user marked, in clock order.
    public var scenes: [Frame] { frames.filter { $0.isScene || $0.isMark }.sorted { $0.atMs < $1.atMs } }
    public var sceneCount: Int { frames.filter(\.isScene).count }
}

/// transcript.json, version 1: the lines on the recording's clock, each with its speaker in a call.
public struct TranscriptFile: Decodable, Sendable, Equatable {
    public struct Segment: Decodable, Sendable, Equatable {
        public var startMs: Int
        public var endMs: Int
        public var text: String
        public var speaker: Speaker?
        /// The person Meet's speaking ring was on, on an Others line (src/pipeline/speakers.ts, 2026-11-11).
        public var name: String?

        /// Who said it, as the page shows it: the name Meet showed, else "Me" or "Others".
        public var who: String { name ?? speaker?.label ?? "" }
    }

    public var version: Int
    public var engine: String?
    public var model: String?
    public var voice: String?
    /// Mic lines dropped as the far end heard through the speakers (P2).
    public var bleedDropped: Int?
    public var segments: [Segment]

    public static func decode(_ data: Data) throws -> TranscriptFile {
        let value: TranscriptFile
        do { value = try JSONDecoder().decode(TranscriptFile.self, from: data) } catch { throw FileRuleError("transcript.json does not match version 1: \(error)") }
        guard value.version == 1 else { throw FileRuleError("transcript.json has version \(value.version); this app reads version 1") }
        if let bad = value.segments.first(where: { $0.startMs < 0 || $0.endMs < $0.startMs }) {
            throw FileRuleError("transcript.json has a line with a clock that runs backwards (\(bad.startMs) to \(bad.endMs) ms)")
        }
        return value
    }

    public static func load(from dir: URL) throws -> TranscriptFile? {
        let url = dir.appendingPathComponent("transcript.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decode(try Data(contentsOf: url))
    }

    /// Each speaker once, in the order they first speak.
    public var speakers: [Speaker] {
        var seen = Set<Speaker>()
        return segments.compactMap { $0.speaker }.filter { seen.insert($0).inserted }
    }
}

/// A clock on the recording: 12:31, or 1:02:41 past an hour (src/time.ts formatClock).
public enum SessionClock {
    public static func format(ms: Int) -> String {
        let total = max(0, ms / 1000)
        let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60)
        func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
        return h > 0 ? "\(h):\(two(m)):\(two(s))" : "\(two(m)):\(two(s))"
    }
}

/// The facts the call page derives from the bundle's files, so the rules are tested without a window.
public enum CallPageFacts {
    /// Which transcript lines a mark falls on: the line whose span holds it, else the last line that
    /// started before it and ended at most `slackMs` earlier (a mark pressed just after speaking).
    public static func markedLines(_ segments: [TranscriptFile.Segment], marks: [RecordingMark], slackMs: Int = 10_000) -> Set<Int> {
        var marked = Set<Int>()
        for mark in marks {
            if let holding = segments.firstIndex(where: { $0.startMs <= mark.atMs && mark.atMs <= $0.endMs }) {
                marked.insert(holding)
            } else if let before = segments.lastIndex(where: { $0.startMs <= mark.atMs }), mark.atMs - segments[before].endMs <= slackMs {
                marked.insert(before)
            }
        }
        return marked
    }

    /// "Me and others · 2 voices", from the transcript's speakers, else from the recorded tracks.
    public static func voices(transcript: TranscriptFile?, audioTracks: [String]?) -> String? {
        if let speakers = transcript?.speakers, !speakers.isEmpty {
            let me = speakers.contains(.me)
            let others = speakers.contains { !$0.isMe }
            let who = me && others ? "Me and others" : me ? "Me only" : "Others only"
            return "\(who) · \(speakers.count) voice\(speakers.count == 1 ? "" : "s")"
        }
        guard let tracks = audioTracks, !tracks.isEmpty else { return nil }
        if tracks.contains("mic") && tracks.contains("app") { return "Me and others" }
        return tracks.contains("mic") ? "Me only" : "Others only"
    }

    /// "Google Meet in Arc".
    public static func appLine(_ call: SessionInfo.Call?) -> String? {
        guard let call else { return nil }
        let app = call.app == "meet" ? "Google Meet" : call.app.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "A call"
        let browser = call.browser == "arc" ? "Arc" : call.browser
        return browser.map { "\(app) in \($0)" } ?? app
    }

    /// Why the call stopped, in words (src/call.ts STOP_WORDS).
    public static func stopReason(_ reason: String?) -> String? {
        switch reason {
        case "left-call": "you left the call"
        case "mic-released": "Arc released the microphone"
        case "user": "stopped by hand"
        case "cap": "reached the 4-hour cap"
        case "app-quit": "the app quit"
        default: nil
        }
    }
}
