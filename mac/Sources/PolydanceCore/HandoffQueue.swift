// The hand-off after a recording is saved: `polycap import`, then `polycap process` (which runs the
// pipeline and then the routine hooks), one recording at a time, in the order they were saved. Each
// outcome goes into the hand-off ledger as it happens, and polycap's pid while it runs. Fail closed: an
// import never starts unless the ledger said `importing` first, since that entry is what stops the same
// recording being imported twice. A failure is recorded and shown; nothing is retried unless the user
// asks. The menu keeps one outcome per recording, the latest.
import Foundation
import PolydanceShared

public protocol HandoffWorker: Sendable {
    /// `started` gets polycap's pid as soon as it runs.
    func importRecording(_ files: RecordingFiles, started: @escaping @Sendable (Int32) -> Void) async throws -> PolycapOutput.Imported
    func process(id: String, files: RecordingFiles, started: @escaping @Sendable (Int32) -> Void) async throws
}

public struct HandoffJob: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable {
        case importAndProcess
        /// Already imported; run the pipeline (and hooks) again for that session.
        case processOnly(sessionId: String, dir: String)
    }

    public var files: RecordingFiles
    public var kind: Kind
    public var id: String { files.videoName }

    public init(files: RecordingFiles, kind: Kind = .importAndProcess) {
        self.files = files
        self.kind = kind
    }
}

public enum HandoffStage: Sendable, Equatable {
    case queued
    case importing
    case processing(sessionId: String, dir: String)
    case done(sessionId: String, dir: String)
    case failed(message: String, sessionId: String?, dir: String?)
}

public struct HandoffJobState: Sendable, Equatable, Identifiable {
    public var job: HandoffJob
    public var stage: HandoffStage
    public var id: String { job.id }

    public var isFailure: Bool { if case .failed = stage { return true } else { return false } }
    public var message: String { if case .failed(let message, _, _) = stage { return message } else { return "" } }
}

public struct HandoffSnapshot: Sendable, Equatable {
    public var current: HandoffJobState?
    public var queued: [HandoffJob] = []
    /// The most recent outcomes, newest first, one per recording.
    public var finished: [HandoffJobState] = []
    /// The ledger could not be written: shown. An import is not started while it cannot be.
    public var ledgerError: String?

    public init() {}
    public var isBusy: Bool { current != nil || !queued.isEmpty }
}

public actor HandoffQueue {
    private let worker: HandoffWorker
    private let ledgerURL: URL
    private let onChange: @Sendable (HandoffSnapshot) -> Void
    private var snapshot = HandoffSnapshot()
    private var draining = false

    public init(worker: HandoffWorker, ledgerURL: URL, onChange: @escaping @Sendable (HandoffSnapshot) -> Void) {
        self.worker = worker
        self.ledgerURL = ledgerURL
        self.onChange = onChange
    }

    public var state: HandoffSnapshot { snapshot }

    /// Queues a recording unless it is already queued or being handed over. Its last failure leaves the
    /// menu at once: it is being tried again.
    public func enqueue(_ job: HandoffJob) {
        guard snapshot.current?.job.id != job.id, !snapshot.queued.contains(where: { $0.id == job.id }) else { return }
        snapshot.finished.removeAll { $0.id == job.id && $0.isFailure }
        snapshot.queued.append(job)
        publish()
        guard !draining else { return }
        draining = true
        Task { await self.drain() }
    }

    /// Records what became of a hand-off the app did not see finish (a polycap left running when it last
    /// quit, which has since ended), through the queue so it never races a job's own writes.
    public func settle(_ files: RecordingFiles, as entry: HandoffLedger.Entry) throws {
        guard snapshot.current?.id != files.videoName, !snapshot.queued.contains(where: { $0.id == files.videoName }) else { return }
        var ledger = try HandoffLedger.load(from: ledgerURL)
        ledger.recordings[files.videoName] = entry
        try ledger.save(to: ledgerURL)
    }

    /// Drops a recording's outcome from the menu (a Retry that found nothing left to do).
    public func dismiss(id: String) {
        snapshot.finished.removeAll { $0.id == id }
        publish()
    }

    /// Waits until everything queued so far has been handed over (tests, and quitting cleanly).
    public func waitUntilIdle() async {
        while draining { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    private func drain() async {
        while !snapshot.queued.isEmpty {
            let job = snapshot.queued.removeFirst()
            await run(job)
        }
        draining = false
    }

    private func run(_ job: HandoffJob) async {
        let sessionId: String
        let dir: String
        switch job.kind {
        case .importAndProcess:
            set(job, .importing)
            do { try record(job, .init(status: .importing, at: MetaTime.format(Date()))) } catch {
                snapshot.ledgerError = "\(error)"
                finish(job, .failed(message: "the hand-off ledger could not be written, so it was not imported: \(error)", sessionId: nil, dir: nil))
                return
            }
            do {
                let imported = try await worker.importRecording(job.files) { pid in Task { await self.note(pid, for: job, while: .importing) } }
                sessionId = imported.id
                dir = imported.dir
                recordAfter(job, .init(status: .imported, sessionId: sessionId, sessionDir: dir, at: MetaTime.format(Date())))
            } catch {
                recordAfter(job, .init(status: .importFailed, at: MetaTime.format(Date()), error: "\(error)"))
                finish(job, .failed(message: "\(error)", sessionId: nil, dir: nil))
                return
            }
        case .processOnly(let id, let folder):
            sessionId = id
            dir = folder
            // The session exists, so a ledger that cannot be written does not stop it being processed.
            recordAfter(job, .init(status: .imported, sessionId: sessionId, sessionDir: dir, at: MetaTime.format(Date())))
        }
        set(job, .processing(sessionId: sessionId, dir: dir))
        do {
            try await worker.process(id: sessionId, files: job.files) { pid in Task { await self.note(pid, for: job, while: .imported) } }
            recordAfter(job, .init(status: .processed, sessionId: sessionId, sessionDir: dir, at: MetaTime.format(Date())))
            finish(job, .done(sessionId: sessionId, dir: dir))
        } catch {
            recordAfter(job, .init(status: .processFailed, sessionId: sessionId, sessionDir: dir, at: MetaTime.format(Date()), error: "\(error)"))
            finish(job, .failed(message: "\(error)", sessionId: sessionId, dir: dir))
        }
    }

    private func set(_ job: HandoffJob, _ stage: HandoffStage) {
        snapshot.current = HandoffJobState(job: job, stage: stage)
        publish()
    }

    private func finish(_ job: HandoffJob, _ stage: HandoffStage) {
        snapshot.current = nil
        snapshot.finished.removeAll { $0.id == job.id }
        snapshot.finished.insert(HandoffJobState(job: job, stage: stage), at: 0)
        if snapshot.finished.count > 20 { snapshot.finished.removeLast(snapshot.finished.count - 20) }
        publish()
    }

    private func record(_ job: HandoffJob, _ entry: HandoffLedger.Entry) throws {
        var ledger = try HandoffLedger.load(from: ledgerURL)
        ledger.recordings[job.files.videoName] = entry
        try ledger.save(to: ledgerURL)
        snapshot.ledgerError = nil
    }

    /// After polycap has run, the outcome is recorded if it can be; when it cannot, the error is shown and
    /// the hand-off goes on, since the session exists either way.
    private func recordAfter(_ job: HandoffJob, _ entry: HandoffLedger.Entry) {
        do { try record(job, entry) } catch { snapshot.ledgerError = "\(error)"; publish() }
    }

    /// polycap's pid, kept while the entry still has the status it was started under (a late note never
    /// lands on a later outcome).
    private func note(_ pid: Int32, for job: HandoffJob, while status: HandoffLedger.Status) {
        guard var ledger = try? HandoffLedger.load(from: ledgerURL), var entry = ledger.recordings[job.files.videoName], entry.status == status else { return }
        entry.pid = pid
        ledger.recordings[job.files.videoName] = entry
        try? ledger.save(to: ledgerURL)
    }

    private func publish() {
        onChange(snapshot)
    }
}

/// The real worker: PolycapRunner, with each command's output, whole whether it succeeded or failed, kept
/// in <library>/mac/logs/<name>.log (0600) for when a hand-off fails.
public struct PolycapHandoffWorker: HandoffWorker {
    let runner: PolycapRunner
    let logs: URL
    let library: URL

    public init(runner: PolycapRunner, layout: LibraryLayout) {
        self.runner = runner
        self.logs = layout.logs
        self.library = layout.root
    }

    public func importRecording(_ files: RecordingFiles, started: @escaping @Sendable (Int32) -> Void) async throws -> PolycapOutput.Imported {
        do {
            let (imported, result) = try await runner.importRecording(files, onStart: started)
            log(files, "import", result)
            return imported
        } catch {
            // A failed run's output goes into the log whole; the error keeps only its end.
            log(files, "import", (error as? PolycapCommandFailure)?.result, error: error)
            throw error
        }
    }

    public func process(id: String, files: RecordingFiles, started: @escaping @Sendable (Int32) -> Void) async throws {
        do {
            log(files, "process", try await runner.process(id: id, onStart: started))
        } catch {
            log(files, "process", (error as? PolycapCommandFailure)?.result, error: error)
            throw error
        }
    }

    func log(_ files: RecordingFiles, _ command: String, _ result: ProcessResult? = nil, error: Error? = nil) {
        var text = "== polycap \(command) \(MetaTime.format(Date()))\n"
        if let result {
            text += "exit \(result.exitCode)\(result.timedOut ? " (timed out)" : "")\n"
            text += String(decoding: result.stdout, as: UTF8.self)
            text += String(decoding: result.stderr, as: UTF8.self)
        }
        if let error { text += "error: \(error)\n" }
        let url = logs.appendingPathComponent(files.baseName + ".log")
        do {
            try PrivateFiles.makeDirectory(logs, within: library)
            let old = (try? Data(contentsOf: url)) ?? Data()
            try PrivateFiles.write(old + Data(text.utf8), to: url)
        } catch {
            // A log that cannot be written must not fail the hand-off; the ledger still records the outcome.
        }
    }
}
