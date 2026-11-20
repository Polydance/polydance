// What a recording knows about itself while it runs, and the metadata that follows from it. The
// capture layer fills these in; turning them into the contract's JSON is pure, so the rules (short
// under two minutes, cut until a clean stop, video "none" with a note, marks on the recording's clock)
// are tested without a recording.
import CoreGraphics
import Foundation
import PolydanceShared

public enum RecordingMode: Sendable, Equatable {
    case call(meetingCode: String)
    /// Recorded by hand with no call live; later uploaded to a thread (T4), never a call.
    case walkthrough

    public var meetingCode: String? {
        if case .call(let code) = self { return code }
        return nil
    }
}

/// Marks pressed during a recording, on the monotonic clock until the recording's start is known.
public struct MarkBook: Sendable, Equatable {
    public private(set) var moments: [(at: Double, note: String?)] = []

    public init() {}

    public static func == (a: MarkBook, b: MarkBook) -> Bool {
        a.moments.map(\.at) == b.moments.map(\.at) && a.moments.map(\.note) == b.moments.map(\.note)
    }

    /// Adds a mark unless the book is full; a note is cut to the contract's 200 characters.
    @discardableResult
    public mutating func add(at: Double, note: String? = nil) -> Bool {
        guard moments.count < RecordingMeta.maxMarks else { return false }
        let trimmed = note?.trimmingWhitespace()
        let kept = trimmed.flatMap { $0.isEmpty ? nil : String($0.utf16.prefix(RecordingMeta.maxNoteLength)) ?? String($0.prefix(100)) }
        moments.append((at, kept))
        return true
    }

    /// Clocks in ms from `start`; a mark pressed before the first sample counts as 0.
    public func marks(since start: Double) -> [RecordingMark] {
        moments.map { RecordingMark(atMs: max(0, Int(((($0.at - start) * 1000)).rounded())), note: $0.note) }
    }
}

public struct RecordingFacts: Sendable, Equatable {
    public var mode: RecordingMode
    public var startedAt: Date
    public var endedAt: Date?
    public var appBuild: AppBuildInfo?
    public var audioTracks: [AudioTrackRole]
    public var marks: [RecordingMark]
    public var stopReason: CallStopReason?
    public var videoRecorded: Bool
    public var videoNote: String?
    public var farEnd: FarEnd?
    public var display: DisplaySize?
    public var excludedApps: [String]
    public var told: ToldOthers
    /// Where the picture stopped and came back (ScreenRecovery), on the recording's clock.
    public var videoGaps: [VideoGap]

    public init(mode: RecordingMode, startedAt: Date, endedAt: Date? = nil, appBuild: AppBuildInfo? = nil, audioTracks: [AudioTrackRole] = [.mic, .app],
                marks: [RecordingMark] = [], stopReason: CallStopReason? = nil, videoRecorded: Bool = false, videoNote: String? = nil,
                farEnd: FarEnd? = nil, display: DisplaySize? = nil, excludedApps: [String] = [], told: ToldOthers = .unknown,
                videoGaps: [VideoGap] = []) {
        self.mode = mode
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.appBuild = appBuild
        self.audioTracks = audioTracks
        self.marks = marks
        self.stopReason = stopReason
        self.videoRecorded = videoRecorded
        self.videoNote = videoNote
        self.farEnd = farEnd
        self.display = display
        self.excludedApps = excludedApps
        self.told = told
        self.videoGaps = videoGaps
    }

    /// The metadata. With no `endedAt` the recording is still running (or was cut off): `cut` is true,
    /// which is what a crash leaves behind until the clean stop rewrites the file.
    public func meta(rules: CallRules = .standard) -> RecordingMeta {
        var meta = RecordingMeta(
            recordedAt: MetaTime.format(startedAt), appPackage: RecordingMeta.appPackageID, appBuild: appBuild,
            audioTracks: audioTracks.isEmpty ? nil : audioTracks, marks: marks.isEmpty ? nil : marks)
        guard case .call(let code) = mode else { return meta }
        let seconds = (endedAt ?? startedAt).timeIntervalSince(startedAt)
        let note = videoNote.map { String($0.utf16.prefix(RecordingMeta.maxVideoNoteLength)) ?? String($0.prefix(150)) }
        meta.call = CallMeta(
            app: .meet, browser: .arc, meetingCode: code, startedAt: MetaTime.format(startedAt),
            endedAt: endedAt.map(MetaTime.format), stopReason: stopReason, video: videoRecorded ? .recorded : VideoOutcome.none,
            videoNote: note.flatMap { $0.isEmpty ? nil : $0 }, farEnd: farEnd, short: endedAt == nil ? nil : rules.isShort(seconds: seconds),
            cut: endedAt == nil, told: told, display: display, excludedApps: excludedApps.isEmpty ? nil : excludedApps,
            videoGaps: videoGaps.isEmpty ? nil : Array(videoGaps.prefix(RecordingMeta.maxVideoGaps)))
        return meta
    }

    /// A recording found after a crash, with metadata that never got its clean stop: ended when the
    /// file was last written, stopped by the app going away, and cut.
    public static func recovered(_ meta: RecordingMeta, lastWrite: Date, rules: CallRules = .standard) -> RecordingMeta {
        guard var call = meta.call, call.endedAt == nil, let started = MetaTime.parse(call.startedAt) else { return meta }
        let ended = max(lastWrite, started)
        var fixed = meta
        call.endedAt = MetaTime.format(ended)
        call.stopReason = call.stopReason ?? .appQuit
        call.cut = true
        call.short = rules.isShort(seconds: ended.timeIntervalSince(started))
        fixed.call = call
        return fixed
    }
}

/// The call's sound track as far as the metadata is concerned.
public enum AppTrackState: Sendable, Equatable {
    /// No tap: the recording has no call sound track at all.
    case none
    /// The writer has the track but no buffer has reached it yet (AVAssetWriter leaves such a track out).
    case declared
    /// Buffers were written to it.
    case present
}

extension RecordingFacts {
    /// `call.farEnd`. The clean stop gives the verdict, silent when no call sound was recorded. The
    /// metadata written while recording (what a crash leaves behind) says heard once anything was heard
    /// and nothing until then: in the first seconds of a call nobody has spoken yet, so silent would be a
    /// guess, and polycap would tell the summary that the others' side is missing. Only with no tap at all
    /// is silent known from the start.
    public static func farEnd(appTrack: AppTrackState, everHeard: Bool, final: Bool) -> FarEnd? {
        switch appTrack {
        case .none: return .silent
        case .declared: return final ? .silent : (everHeard ? .heard : nil)
        case .present: return everHeard ? .heard : (final ? .silent : nil)
        }
    }
}

/// Which of the apps to leave out of the screen (C3) were really in the capture filter. The filter holds
/// running applications, so it is rebuilt when one of them launches or comes back during a recording;
/// the metadata names only the apps that were in it, never the ones merely asked for.
public struct ExclusionRecord: Sendable, Equatable {
    public let requested: [String]
    public private(set) var excluded: Set<String> = []

    public init(requested: [String]) {
        self.requested = requested
    }

    /// The bundle ids among `running` to leave out now, noted as excluded.
    public mutating func filter(running: [String]) -> [String] {
        let wanted = Set(requested)
        let now = running.filter { wanted.contains($0) }
        excluded.formUnion(now)
        return now
    }

    /// For `call.excludedApps`, in the order they were asked for.
    public var excludedApps: [String] { requested.filter { excluded.contains($0) } }
}

/// Which display to record: the one holding the centre of Arc's front window, else the main display.
public enum DisplayChoice {
    public struct Display: Sendable, Equatable {
        public var id: UInt32
        public var frame: CGRect

        public init(id: UInt32, frame: CGRect) {
            self.id = id
            self.frame = frame
        }
    }

    public static func choose(windowBounds: CGRect?, displays: [Display], mainDisplay: UInt32) -> UInt32 {
        guard let bounds = windowBounds, !bounds.isEmpty else { return mainDisplay }
        let centre = CGPoint(x: bounds.midX, y: bounds.midY)
        if let holding = displays.first(where: { $0.frame.contains(centre) }) { return holding.id }
        // A window mostly off every display: the one it overlaps most.
        let best = displays.max { $0.frame.intersection(bounds).area < $1.frame.intersection(bounds).area }
        if let best, best.frame.intersection(bounds).area > 0 { return best.id }
        return mainDisplay
    }

    /// The video size: the display's pixels, scaled down to at most `maxWidth` wide, both even (H.264).
    public static func videoSize(pointWidth: Double, pointHeight: Double, scale: Double, maxWidth: Int = 1920) -> (width: Int, height: Int) {
        let pixelWidth = max(2, pointWidth * max(scale, 1))
        let pixelHeight = max(2, pointHeight * max(scale, 1))
        let factor = min(1, Double(maxWidth) / pixelWidth)
        func even(_ v: Double) -> Int { max(2, Int((v / 2).rounded(.down)) * 2) }
        return (even(pixelWidth * factor), even(pixelHeight * factor))
    }
}

extension CGRect {
    var area: CGFloat { isNull || isEmpty ? 0 : width * height }
}
