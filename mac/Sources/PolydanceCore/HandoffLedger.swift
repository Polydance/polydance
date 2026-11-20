// What happened to each recording after it was saved: imported as which session, processed or not,
// or failed and why. Kept in <library>/mac/handoff.json (0600) so a recording is imported once, a
// failure is shown rather than retried silently (also after a relaunch: needingAttention), and a
// recording the app never handed over (it quit or crashed first) is found at the next launch. While
// polycap runs, its pid is kept in the entry, so the next launch can tell a polycap the app left running
// (quitting does not stop it) from one that was cut off. Retry is decided here (HandoffRetry), from an
// explicit read of the ledger and of the library, so it never imports a recording a second time.
import Foundation

public struct HandoffLedger: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        /// Written just before `polycap import` runs. Left behind only if the app went away during the
        /// import, when whether a session was made is not known until the library is looked at.
        case importing
        case importFailed = "import-failed"
        /// Imported; `polycap process` has not finished (it is running, it was cut off, or it never started).
        case imported
        case processed
        case processFailed = "process-failed"
    }

    public struct Entry: Codable, Sendable, Equatable {
        public var status: Status
        public var sessionId: String?
        public var sessionDir: String?
        public var at: String
        public var error: String?
        /// The polycap running for this status (import while importing, process while imported).
        public var pid: Int32?

        public init(status: Status, sessionId: String? = nil, sessionDir: String? = nil, at: String, error: String? = nil, pid: Int32? = nil) {
            self.status = status
            self.sessionId = sessionId
            self.sessionDir = sessionDir
            self.at = at
            self.error = error
            self.pid = pid
        }
    }

    public var version: Int = 1
    /// Keyed by the recording's video file name.
    public var recordings: [String: Entry] = [:]

    public init() {}

    /// A missing file is an empty ledger; anything unreadable is an error, never a silent reset.
    public static func load(from url: URL) throws -> HandoffLedger {
        guard FileManager.default.fileExists(atPath: url.path) else { return HandoffLedger() }
        let data = try Data(contentsOf: url)
        let ledger: HandoffLedger
        do { ledger = try JSONDecoder().decode(HandoffLedger.self, from: data) } catch {
            throw FileRuleError("\(url.path) is not a hand-off ledger: \(error)")
        }
        guard ledger.version == 1 else { throw FileRuleError("\(url.path) has version \(ledger.version); this app reads version 1") }
        return ledger
    }

    public func save(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try PrivateFiles.write(try encoder.encode(self), to: url)
    }

    /// Recordings in the folder that were never handed over: they have metadata (so this app wrote them)
    /// and no ledger entry. The one being recorded now is left out by the caller.
    public func notHandedOver(in directory: URL, fileManager: FileManager = .default) -> [RecordingFiles] {
        let names = (try? fileManager.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.sorted().compactMap { name in
            guard let files = RecordingFiles.forVideo(directory.appendingPathComponent(name), in: directory) else { return nil }
            guard recordings[files.videoName] == nil, fileManager.fileExists(atPath: files.meta.path) else { return nil }
            return files
        }
    }

    /// Hand-offs that did not finish, from any earlier run of the app: an import cut off or failed, a
    /// process failed, or one imported and never processed (the app quit or the Mac restarted while
    /// polycap was building). Shown at launch with what the ledger says, oldest first.
    public func needingAttention(in directory: URL) -> [HandoffAttention] {
        recordings.sorted { $0.key < $1.key }.compactMap { name, entry in
            guard entry.status != .processed, let files = RecordingFiles.forVideo(directory.appendingPathComponent(name), in: directory) else { return nil }
            return HandoffAttention(files: files, entry: entry)
        }
    }
}

/// One hand-off from an earlier run that needs the user, as the menu shows it.
public struct HandoffAttention: Sendable, Equatable, Identifiable {
    public var files: RecordingFiles
    public var entry: HandoffLedger.Entry
    public var id: String { files.videoName }

    public init(files: RecordingFiles, entry: HandoffLedger.Entry) {
        self.files = files
        self.entry = entry
    }

    /// The row's title.
    public var title: String {
        switch entry.status {
        case .importing: "\(files.baseName) was being imported when the app quit"
        case .importFailed: "\(files.baseName) was not imported"
        case .imported: "\(files.baseName) was imported but not built"
        case .processFailed, .processed: "\(files.baseName) was not processed"
        }
    }

    /// The row's button: building an imported recording is finishing it, anything else is a retry.
    public var actionTitle: String { entry.status == .imported ? "Finish building" : "Retry" }
}

/// What Retry (or Finish building) does for a recording, decided from the ledger and the library.
public enum HandoffRetry {
    public enum Decision: Sendable, Equatable {
        /// Hand it over: import and process, or process the session it already is.
        case run(HandoffJob.Kind)
        /// The ledger says it was processed: nothing to do.
        case alreadyProcessed(sessionId: String?)
        /// More than one session was imported from this recording; which to keep is the user's call.
        case ambiguous(sessionIds: [String])
    }

    /// Reads the ledger and fails on any error: a ledger that cannot be read means nothing is known, so
    /// nothing is retried. A recording whose import may have run (cut off, failed, or never recorded) is
    /// looked for in the library first, so an import that finished after the app quit is processed, not
    /// imported again.
    public static func decide(for files: RecordingFiles, ledgerURL: URL, sessions: URL) throws -> Decision {
        let ledger = try HandoffLedger.load(from: ledgerURL)
        let entry = ledger.recordings[files.videoName]
        switch entry?.status {
        case .processed?:
            return .alreadyProcessed(sessionId: entry?.sessionId)
        case .processFailed?, .imported?:
            if let id = entry?.sessionId, let dir = entry?.sessionDir, PolycapOutput.isSessionID(id) { return .run(.processOnly(sessionId: id, dir: dir)) }
            return fromLibrary(files, sessions: sessions)
        case .importing?, .importFailed?, nil:
            return fromLibrary(files, sessions: sessions)
        }
    }

    private static func fromLibrary(_ files: RecordingFiles, sessions: URL) -> Decision {
        let found = sessionsImported(from: files.video, in: sessions)
        switch found.count {
        case 0: return .run(.importAndProcess)
        case 1: return .run(.processOnly(sessionId: found[0].id, dir: found[0].dir))
        default: return .ambiguous(sessionIds: found.map(\.id))
        }
    }

    /// Sessions whose session.json says they were imported from this very file (source.originalPath,
    /// both sides with symlinks resolved). An unreadable session.json is not a match.
    public static func sessionsImported(from video: URL, in sessions: URL, fileManager: FileManager = .default) -> [(id: String, dir: String)] {
        let target = video.resolvingSymlinksInPath().standardizedFileURL.path
        let names = ((try? fileManager.contentsOfDirectory(atPath: sessions.path)) ?? []).filter { PolycapOutput.isSessionID($0) }.sorted()
        return names.compactMap { name in
            let dir = sessions.appendingPathComponent(name)
            guard let session = try? SessionInfo.load(from: dir), session.source.kind == "import",
                  let original = session.source.originalPath,
                  URL(fileURLWithPath: original).resolvingSymlinksInPath().standardizedFileURL.path == target else { return nil }
            return (name, dir.path)
        }
    }
}
