// The session folder is the interface the app reads for its UI (the contract's point 4): session.json
// for the steps, the title and the call, hook-runs.json for the routine. session.json belongs to
// polycap and is validated there; the app reads only the fields it shows and tolerates the rest, so a
// newer polycap does not blank the menu. hook-runs.json is read strictly, since its shape is the
// contract and a wrong one means the routine's outcome cannot be trusted.
import Foundation
import PolydanceShared

public struct SessionInfo: Decodable, Sendable, Equatable {
    public struct Step: Decodable, Sendable, Equatable {
        public var status: String
        public var note: String?
        public var error: String?
    }

    public struct Call: Decodable, Sendable, Equatable {
        public var app: String?
        public var browser: String?
        public var meetingCode: String?
        public var startedAt: String?
        public var endedAt: String?
        public var stopReason: String?
        public var video: String?
        public var videoNote: String?
        public var farEnd: String?
        public var short: Bool?
        public var cut: Bool?
        public var told: String?
        public var display: DisplaySize?
        public var excludedApps: [String]?
    }

    public struct Source: Decodable, Sendable, Equatable {
        public var kind: String?
        /// The file `polycap import` was given, as it resolved it (src/commands/import.ts).
        public var originalPath: String?
        public var originalName: String?
        public var appPackage: String?
        public var bytes: Int?
        public var audioTracks: [String]?
        public var call: Call?
        public var marks: [RecordingMark]?
    }

    public struct Media: Decodable, Sendable, Equatable {
        public var video: String?
        public var durationMs: Int?
        public var width: Int?
        public var height: Int?
        public var hasVideo: Bool?
        /// Whose voice the transcript is: mic, app, unknown, or both for a call (src/session.ts VOICES).
        public var voice: String?
    }

    public struct Summary: Decodable, Sendable, Equatable {
        public var title: String
        public var text: String?
    }

    public struct TranscriberInfo: Decodable, Sendable, Equatable {
        public var kind: String
        public var model: String?
    }

    public var id: String
    public var title: String
    public var createdAt: String?
    public var recordedAt: String
    public var source: Source
    public var media: Media?
    public var steps: [String: Step]
    public var summary: Summary?
    public var transcriber: TranscriberInfo?
    public var frameCount: Int?
    public var markerCount: Int?

    public static func load(from dir: URL) throws -> SessionInfo {
        let data = try Data(contentsOf: dir.appendingPathComponent("session.json"))
        do { return try JSONDecoder().decode(SessionInfo.self, from: data) } catch {
            throw FileRuleError("\(dir.lastPathComponent)/session.json is not a session: \(error)")
        }
    }

    /// The title a person reads: Claude's, else "Meet abc-defg-hij" for a call, else the id.
    public var displayTitle: String {
        if let title = summary?.title, !title.isEmpty { return title }
        if let code = source.call?.meetingCode { return "Meet \(code)" }
        return title
    }

    /// The main window's title for a session: Claude's few words, else the id (`polycap show <id>`).
    public var pageTitle: String {
        if let title = summary?.title.trimmingWhitespace(), !title.isEmpty { return title }
        return id
    }

    /// True while any pipeline step is still pending: the bundle is being built (or was cut off).
    public var isBuilding: Bool {
        BuildProgress.steps.contains { steps[$0.name]?.status == "pending" }
    }

    /// Steps that failed, in pipeline order, with what polycap said.
    public var failedSteps: [(name: String, error: String?)] {
        BuildProgress.steps.compactMap { step in
            guard let found = steps[step.name], found.status == "failed" else { return nil }
            return (step.label, found.error ?? found.note)
        }
    }
}

/// hook-runs.json, version 1: each configured hook's run for this session.
public struct HookRuns: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable { case running, done, failed, timeout, skipped }

    public struct Run: Codable, Sendable, Equatable {
        public var status: Status
        public var startedAt: String
        public var finishedAt: String?
        public var exitCode: Int?
        public var signal: String?
        public var pid: Int?
        public var agentSessionId: String?
        public var note: String?
        public var log: String?

        static let keys: Set<String> = ["status", "startedAt", "finishedAt", "exitCode", "signal", "pid", "agentSessionId", "note", "log"]
    }

    public var version: Int
    public var runs: [String: Run]

    /// Nil when the session has no hook runs yet; an error when the file is not version 1's shape.
    public static func load(from dir: URL) throws -> HookRuns? {
        let url = dir.appendingPathComponent("hook-runs.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decode(try Data(contentsOf: url))
    }

    public static func decode(_ data: Data) throws -> HookRuns {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw FileRuleError("hook-runs.json is not a JSON object") }
        if let extra = Set(object.keys).subtracting(["version", "runs"]).sorted().first { throw FileRuleError("hook-runs.json: unknown key \(extra)") }
        if let runs = object["runs"] as? [String: Any] {
            for (name, run) in runs {
                guard let fields = run as? [String: Any] else { throw FileRuleError("hook-runs.json: run \(name) is not an object") }
                if let extra = Set(fields.keys).subtracting(Run.keys).sorted().first { throw FileRuleError("hook-runs.json: unknown key runs.\(name).\(extra)") }
            }
        }
        let value: HookRuns
        do { value = try JSONDecoder().decode(HookRuns.self, from: data) } catch { throw FileRuleError("hook-runs.json does not match version 1: \(error)") }
        guard value.version == 1 else { throw FileRuleError("hook-runs.json has version \(value.version); this app reads version 1") }
        return value
    }
}

/// One line of the building view.
public struct StepRow: Sendable, Equatable, Identifiable {
    public enum State: String, Sendable { case done, running, pending, failed, skipped }
    public var id: String
    public var label: String
    public var state: State
    public var detail: String?

    public init(id: String, label: String, state: State, detail: String? = nil) {
        self.id = id
        self.label = label
        self.state = state
        self.detail = detail
    }
}

public enum BuildProgress {
    /// polycap's steps in pipeline order (src/session.ts STEP_NAMES) and how the menu names them.
    public static let steps: [(name: String, label: String)] = [
        ("probe", "Probe"), ("logs", "Logs"), ("audio", "Audio"), ("transcribe", "Transcribe"), ("speakers", "Speakers"), ("frames", "Frames"), ("pointing", "Pointing"),
        ("markers", "Markers"), ("summary", "Title and summary"), ("storyboard", "Storyboard"),
    ]

    /// The pipeline's steps as rows. While `processing`, the first pending step is the one running.
    /// The probe is shown only while it runs or when it failed, and pointing only when it is not
    /// skipped (it is off unless POLYCAP_POINTING=claude). Speakers (who of the Others spoke, from Meet's
    /// speaking ring, 2026-11-11) is shown for a call, skipped or not, so its reason is seen; never for a
    /// session made before polycap had the step, whose session.json does not name it. Logs (a headset take's
    /// log, docs/LOGS.md, 2026-11-16) only when the take sent some: a Mac recording never does.
    public static func rows(session: SessionInfo?, processing: Bool) -> [StepRow] {
        var runningMarked = false
        var rows: [StepRow] = []
        for (name, label) in steps {
            let step = session?.steps[name]
            // Before the running mark: a session with no logs to read must not take it from the step that is running.
            if name == "logs", step == nil || step?.status == "skipped" { continue }
            var state: StepRow.State
            switch step?.status {
            case "done": state = .done
            case "failed": state = .failed
            case "skipped": state = .skipped
            default: state = .pending
            }
            if state == .pending, processing, !runningMarked {
                state = .running
                runningMarked = true
            }
            if name == "probe", state != .failed, state != .running { continue }
            if name == "pointing", state == .skipped { continue }
            if name == "speakers", step == nil || (state == .skipped && session?.source.call == nil) { continue }
            rows.append(StepRow(id: name, label: label, state: state, detail: step?.error ?? step?.note))
        }
        return rows
    }

    /// "Your routine": what the hooks did, from hook-runs.json.
    public static func routine(_ runs: HookRuns?, processing: Bool) -> StepRow {
        let detail: String
        let state: StepRow.State
        let all = (runs?.runs ?? [:]).sorted { $0.key < $1.key }
        if all.isEmpty {
            state = .pending
            detail = processing ? "when the bundle is ready" : "no routine ran"
        } else if let running = all.first(where: { $0.value.status == .running }) {
            state = .running
            detail = running.key
        } else if let failed = all.first(where: { $0.value.status == .failed || $0.value.status == .timeout }) {
            state = .failed
            detail = failed.value.status == .timeout ? "\(failed.key) timed out" : "\(failed.key) failed" + (failed.value.exitCode.map { " (exit \($0))" } ?? "")
        } else if all.allSatisfy({ $0.value.status == .skipped }) {
            state = .skipped
            detail = all.first?.value.note ?? "skipped"
        } else {
            state = .done
            detail = all.first(where: { $0.value.agentSessionId != nil })?.value.agentSessionId.map { "claude --resume \($0)" } ?? "done"
        }
        return StepRow(id: "routine", label: "Your routine", state: state, detail: detail)
    }
}

/// One recording this app made, for the menu's list.
public struct RecentRecording: Sendable, Equatable, Identifiable {
    public enum Chip: String, Sendable, Equatable {
        case none, notBuilt, routineRunning, routineDone, routineFailed, routineSkipped, short
    }

    public var id: String
    public var dir: URL
    public var title: String
    public var recordedAt: Date?
    public var durationMs: Int?
    public var frameCount: Int?
    public var marks: Int
    public var isCall: Bool
    public var short: Bool
    public var videoNone: Bool
    public var stopReason: String?
    public var chip: Chip
    /// `call.farEnd`: whether the tap heard the other side (C12).
    public var farEnd: String? = nil
    /// Still being built: a pipeline step is pending.
    public var building: Bool = false
}

public enum LibraryIndex {
    /// The newest recordings this app made, newest first. Session folders are named by local time, so
    /// the newest names are read first and the scan stops early; an unreadable folder is skipped.
    public static func recent(sessions: URL, appPackage: String = RecordingMeta.appPackageID, limit: Int = 12, scanLimit: Int = 400,
                              fileManager: FileManager = .default) -> [RecentRecording] {
        let names = ((try? fileManager.contentsOfDirectory(atPath: sessions.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted(by: >)
        var found: [RecentRecording] = []
        for name in names.prefix(scanLimit) {
            let dir = sessions.appendingPathComponent(name)
            guard let session = try? SessionInfo.load(from: dir), session.source.appPackage == appPackage else { continue }
            found.append(recording(session, dir: dir, hookRuns: try? HookRuns.load(from: dir)))
            if found.count >= limit { break }
        }
        return found.sorted { ($0.recordedAt ?? .distantPast) > ($1.recordedAt ?? .distantPast) }
    }

    public static func recording(_ session: SessionInfo, dir: URL, hookRuns: HookRuns?) -> RecentRecording {
        let call = session.source.call
        let unfinished = BuildProgress.steps.contains { session.steps[$0.name]?.status == "pending" }
        let chip: RecentRecording.Chip
        let runs = hookRuns?.runs.values.map(\.status) ?? []
        if call?.short == true { chip = .short }
        else if unfinished { chip = .notBuilt }
        else if runs.contains(.running) { chip = .routineRunning }
        else if runs.contains(.failed) || runs.contains(.timeout) { chip = .routineFailed }
        else if !runs.isEmpty, runs.allSatisfy({ $0 == .skipped }) { chip = .routineSkipped }
        else if runs.contains(.done) { chip = .routineDone }
        else { chip = .none }
        return RecentRecording(
            id: session.id, dir: dir, title: session.displayTitle, recordedAt: MetaTime.parse(session.recordedAt),
            durationMs: session.media?.durationMs, frameCount: session.frameCount, marks: session.source.marks?.count ?? 0,
            isCall: call != nil, short: call?.short ?? false, videoNone: call?.video == "none", stopReason: call?.stopReason, chip: chip,
            farEnd: call?.farEnd, building: unfinished)
    }
}
