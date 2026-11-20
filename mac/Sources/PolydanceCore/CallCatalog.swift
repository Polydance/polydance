// The main window's Calls: every session in the library whose session.json has `source.call`, newest
// first, and everything one call's page shows. The window refreshes every few seconds and whenever the
// sessions folder changes, so the catalog remembers each session.json's and hook-runs.json's
// modification time and reads again only what changed; a session that is not a call is remembered as
// such and costs two stats per refresh. An unreadable session is left out of the list, never guessed at.
import Foundation

public final class CallCatalog: @unchecked Sendable {
    private struct Cached {
        var session: Date?
        var hookRuns: Date?
        var entry: RecentRecording?
    }

    private let lock = NSLock()
    private var cache: [String: Cached] = [:]
    private let fileManager: FileManager

    public init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    /// The calls in `sessions`, newest first. Blocks on the file system: call it off the main thread.
    public func scan(sessions: URL, scanLimit: Int = 2000) -> [RecentRecording] {
        let names = ((try? fileManager.contentsOfDirectory(atPath: sessions.path)) ?? [])
            .filter { !$0.hasPrefix(".") && PolycapOutput.isSessionID($0) }.sorted(by: >).prefix(scanLimit)
        lock.lock(); defer { lock.unlock() }
        var next: [String: Cached] = [:]
        var calls: [RecentRecording] = []
        for name in names {
            let dir = sessions.appendingPathComponent(name)
            let sessionTime = modified(dir.appendingPathComponent("session.json"))
            guard sessionTime != nil else { continue }
            let runsTime = modified(dir.appendingPathComponent("hook-runs.json"))
            var item = cache[name] ?? Cached()
            if item.session != sessionTime || item.hookRuns != runsTime {
                item.session = sessionTime
                item.hookRuns = runsTime
                if let session = try? SessionInfo.load(from: dir), session.source.call != nil {
                    var entry = LibraryIndex.recording(session, dir: dir, hookRuns: try? HookRuns.load(from: dir))
                    entry.title = session.pageTitle
                    item.entry = entry
                } else {
                    item.entry = nil
                }
            }
            next[name] = item
            if let entry = item.entry { calls.append(entry) }
        }
        cache = next
        return calls.sorted { ($0.recordedAt ?? .distantPast, $0.id) > ($1.recordedAt ?? .distantPast, $1.id) }
    }

    private func modified(_ url: URL) -> Date? {
        (try? fileManager.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }
}

/// Everything a call's page shows, read from its session folder at once. Each file is read on its own,
/// so a broken frames.json leaves the transcript and the routine on the page, with the problem said.
public struct CallPageData: Sendable, Equatable {
    public var dir: URL
    public var session: SessionInfo
    public var frames: FramesFile?
    public var framesProblem: String?
    public var transcript: TranscriptFile?
    public var transcriptProblem: String?
    public var hookRuns: HookRuns?
    public var hookRunsProblem: String?
    public var storyboard: URL?
    public var transcriptLines: Int?
    public var videoBytes: Int64?
    /// When each file was last written, so a refresh reads again only when something changed.
    public var stamp: [String: Date]

    public static let files = ["session.json", "frames.json", "transcript.json", "hook-runs.json", "storyboard.md", "transcript.md"]

    /// The modification times that decide whether the page is out of date.
    public static func stamp(of dir: URL, fileManager: FileManager = .default) -> [String: Date] {
        var stamp: [String: Date] = [:]
        for name in files {
            if let date = (try? fileManager.attributesOfItem(atPath: dir.appendingPathComponent(name).path))?[.modificationDate] as? Date { stamp[name] = date }
        }
        return stamp
    }

    /// Reads the page; throws only when session.json itself cannot be read.
    public static func load(from dir: URL, fileManager: FileManager = .default) throws -> CallPageData {
        let stamp = stamp(of: dir, fileManager: fileManager)
        let session = try SessionInfo.load(from: dir)
        var page = CallPageData(dir: dir, session: session, stamp: stamp)
        do { page.frames = try FramesFile.load(from: dir) } catch { page.framesProblem = "\(error)" }
        do { page.transcript = try TranscriptFile.load(from: dir) } catch { page.transcriptProblem = "\(error)" }
        do { page.hookRuns = try HookRuns.load(from: dir) } catch { page.hookRunsProblem = "\(error)" }
        let storyboard = dir.appendingPathComponent("storyboard.md")
        page.storyboard = fileManager.fileExists(atPath: storyboard.path) ? storyboard : nil
        if let text = try? String(contentsOf: dir.appendingPathComponent("transcript.md"), encoding: .utf8) {
            page.transcriptLines = text.split(whereSeparator: \.isNewline).count
        }
        if let video = session.media?.video, BundlePath.isSafe(video) {
            page.videoBytes = ((try? fileManager.attributesOfItem(atPath: dir.appendingPathComponent(video).path))?[.size] as? NSNumber)?.int64Value
        }
        return page
    }

    public init(dir: URL, session: SessionInfo, stamp: [String: Date]) {
        self.dir = dir
        self.session = session
        self.stamp = stamp
    }

    public var call: SessionInfo.Call? { session.source.call }
    public var marks: [RecordingMark] { session.source.marks ?? [] }
    /// True while polycap is still building the bundle.
    public var building: Bool { session.isBuilding }
    /// Mark clocks that have a frame of their own (frames.json reason `mark`).
    public var markedFrameClocks: Set<Int> { Set((frames?.frames ?? []).filter(\.isMark).map(\.atMs)) }
}
