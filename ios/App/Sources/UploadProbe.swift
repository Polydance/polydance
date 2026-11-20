// The background upload (docs/IPHONE.md U1, U2), built for I0 and used since I3 for every take: one take
// to the receiver the phone is paired with, with the thread it goes to (thread.json, RunThread), and the
// evidence of what iOS did in the event log. The
// create runs on an ordinary session, because background sessions take no data tasks, under background
// time of its own, so a take that stopped because Polydance left the screen is still handed over; the
// narration and the video's 8 MB chunks then go as upload tasks from files on a background session, and
// each finished task starts the next from its delegate callback, so the chain goes on while the app is
// suspended or relaunched. A task that ends with no reply (Wi-Fi dropped, the receiver restarted, a force
// quit) sends the same range again later instead of giving up. Each task's metrics are logged with their
// own times, so iOS's wait before a task, the transfer and the wake afterwards can be told apart. The
// protocol itself (bodies, ranges, replies, what comes next) is PolydancePhoneCore's UploadProtocol,
// tested on the Mac; this file is the I/O around it. The token comes from the phone's pairing (the Keychain,
// PairingStore) each time a request is built, and is never logged, kept or published; nor is a response
// body, beyond the receiver's own short reason. How far each upload has got, at what rate and whether it has
// stopped moving is kept in memory only (UploadMeter), from each task's didSendBodyData, for the screens.
import Foundation
import Network
import PolydancePhoneCore
import UIKit

@MainActor
final class UploadProbe: NSObject, ObservableObject {
    /// "net.polydance.capture.iphone.uploads" on the iPhone; the Vision Pro's app, which shares this file
    /// (docs/VISIONOS.md), gets its own from its bundle id.
    static let sessionIdentifier = (Bundle.main.bundleIdentifier ?? "net.polydance.capture.iphone") + ".uploads"

    /// Run name -> a few words for the screen.
    @Published private(set) var statuses: [String: String] = [:]
    /// Whether the phone is paired. Nothing uploads while it is not.
    @Published private(set) var configured: Bool
    /// A run's upload finished (the receiver holds it all); a report then leaves the phone (B1).
    var onFinished: ((String) -> Void)?

    private let log: EventLog
    private let pairing: () -> Pairing?
    private let stateDirectory: URL
    /// Each chunk's own copy, under Caches: the system may clear it, and it is never backed up.
    private let chunkDirectory: URL
    private let delegate = SessionDelegate()
    private var background: URLSession?
    /// The create and a lost task's status check. Ephemeral: no cookies, cache or credentials on disk.
    private let foreground: URLSession
    /// Each run's upload, mirrored in `<stateDirectory>/<run>.json`; published for the Recordings page.
    @Published private(set) var states: [String: UploadRunState] = [:]
    /// Runs whose hash and create are under way, for the Recordings page.
    var preparing: Set<String> { creating }
    /// Response bodies so far by task, at most `maxBody` bytes each, for the 409's offset and the reason.
    private var bodies: [Int: Data] = [:]
    private static let maxBody = 64 * 1024
    /// Runs whose hash and create are under way, so a second press does not race the first.
    private var creating: Set<String> = []
    /// Background time held from a press (or a take's finish) until the first task is on the background
    /// session, by run.
    private var handOffTime: [String: UIBackgroundTaskIdentifier] = [:]
    private var backgroundCompletion: (() -> Void)?
    /// The auto mode's -autoHoldVideoSeconds: the video's first chunk waits this long on the background
    /// session, so the rest of the upload happens with the app suspended.
    var holdVideoSeconds: Int?
    /// Each sending run's bytes so far, confirmed or in flight, with its meter: memory only, for the screens.
    private var live: [String: Live] = [:]
    /// Whether the network iOS has now is one the video waits out (mobile data, a hotspot, Low Data Mode).
    private var onCostlyNetwork = false
    private let pathMonitor = NWPathMonitor()

    private struct Live {
        let stage: UploadProgress.Stage
        var sent: Int64
        var meter = UploadMeter()
    }

    init(log: EventLog, pairing: @escaping () -> Pairing?, stateDirectory: URL) {
        self.log = log
        self.pairing = pairing
        self.stateDirectory = stateDirectory
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        chunkDirectory = caches.appendingPathComponent("upload-chunks", isDirectory: true)
        configured = pairing() != nil
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 60
        foreground = URLSession(configuration: c)
        super.init()
        delegate.probe = self
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let costly = path.status == .satisfied && (path.isExpensive || path.isConstrained)
            Task { @MainActor in self?.onCostlyNetwork = costly }
        }
        pathMonitor.start(queue: .main)
    }

    /// How this run's upload is going at `now`, for the screens; nil when it is not being prepared or sent.
    func progress(_ runName: String, at now: Date = Date()) -> UploadProgress? {
        if creating.contains(runName) { return UploadProgress(stage: .preparing) }
        guard let state = states[runName], let (stage, confirmed, total) = Self.part(state) else { return nil }
        let t = now.timeIntervalSince1970
        var waiting: String?
        if state.inFlight != nil, let started = state.taskStartedAt, state.retryDelaySeconds > 0 {
            let left = Int((started + Double(state.retryDelaySeconds) - t).rounded(.up))
            if left > 0 { waiting = "sending again in \(UploadProgress.duration(left))" }
        }
        // U3: a take sent as it finished keeps its video off mobile data and hotspots unless Send now.
        if waiting == nil, stage == .video, !state.allowExpensive, onCostlyNetwork { waiting = "waiting for Wi-Fi" }
        guard let entry = live[runName], entry.stage == stage else {
            return UploadProgress(stage: stage, sent: confirmed, total: total, waiting: waiting)
        }
        return UploadProgress(stage: stage, meter: entry.meter, sent: max(entry.sent, confirmed), total: total, at: t, waiting: waiting)
    }

    /// The part a run is sending, what the receiver has of it and its size; nil once done or failed.
    private static func part(_ state: UploadRunState) -> (UploadProgress.Stage, Int64, Int64)? {
        switch state.phase {
        case .narration: return (.words, 0, state.narrationBytes ?? 0)
        case .content: return (.video, state.nextOffset, state.bytes)
        case .done, .failed: return nil
        }
    }

    /// Moves a run's meter to `sent` bytes of its current part (a new part starts a new meter).
    private func measure(_ runName: String, stage: UploadProgress.Stage, sent: Int64, at now: Double = Date().timeIntervalSince1970) {
        var entry = live[runName].flatMap { $0.stage == stage ? $0 : nil } ?? Live(stage: stage, sent: sent)
        entry.sent = sent
        entry.meter.record(sent, at: now)
        live[runName] = entry
    }

    /// The meter after the state moved on (a task started, finished, or was lost): what the receiver has.
    private func measureConfirmed(_ state: UploadRunState) {
        guard let (stage, confirmed, _) = Self.part(state) else {
            live[state.runName] = nil
            return
        }
        measure(state.runName, stage: stage, sent: confirmed)
    }

    // MARK: The contract

    /// At launch, including a launch in the background for this session's events: recreates the
    /// background session so iOS can deliver what finished while the app was not running, and carries
    /// on any upload that stopped between two tasks.
    func reattach() {
        _ = readConfig(logIt: true)
        let session = backgroundSession()
        for state in loadStates() {
            states[state.runName] = state
            // The stall clock starts again at a launch: what happened while the app was not running is unknown.
            measureConfirmed(state)
            publish(state)
        }
        // The task each run was waiting for before asking the session for its own, by tag and start time (a
        // range sent again has the same tag). Delegate events can arrive while the question is out and
        // start the next task, which the answer cannot contain.
        let waitingFor = states.compactMapValues { state in state.inFlight.map { Attempt(tag: $0, startedAt: state.taskStartedAt) } }
        Task { @MainActor in
            let tasks = await session.allTasks
            let live = Set(tasks.compactMap(\.taskDescription))
            self.removeStaleChunks(keeping: live.union(self.states.values.compactMap(\.inFlight)))
            for state in self.states.values where state.phase == .narration || state.phase == .content {
                if let tag = state.inFlight {
                    // Running, or finished with its event still to come; if no event comes, ask the receiver.
                    // A task started since the question was asked is not lost, only newer than the answer.
                    let attempt = Attempt(tag: tag, startedAt: state.taskStartedAt)
                    if waitingFor[state.runName] == attempt, !live.contains(tag) {
                        Task { @MainActor in await self.recoverLostTask(run: state.runName, attempt: attempt) }
                    }
                } else {
                    self.sendNext(state, resumed: true)
                }
            }
        }
    }

    /// GET /v1/health on the ordinary session, without the token: whether the phone reaches the receiver,
    /// and why not. The first time, this is also when iOS asks about the local network, so the question
    /// is answered before a take's upload needs it.
    func checkReach() {
        guard let config = readConfig() else { return }
        let started = Date().timeIntervalSince1970
        let request = UploadRequests.health(config)
        Task { @MainActor in
            do {
                let (_, response) = try await self.foreground.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                self.log.write("upload.reach", ["ok": status == 200, "status": status, "ms": Self.ms(since: started), "appState": ProbeAppState.current()])
            } catch {
                var fields = Self.errorFields(error)
                fields["ok"] = false
                fields["status"] = 0
                fields["ms"] = Self.ms(since: started)
                fields["reason"] = Self.describe(error)
                fields["appState"] = ProbeAppState.current()
                self.log.write("upload.reach", fields)
            }
        }
    }

    /// Send now (true), or a take sent as it finishes (false): create (or find) the upload, then send it.
    /// docs/IPHONE.md U3: the video waits for an inexpensive network unless Send now was pressed.
    func upload(_ run: RunFolder, sendNow: Bool = true) {
        enqueue(run, sendNow: sendNow)
    }

    /// The pairing changed (paired, unpaired, paired with another receiver).
    func pairingChanged() {
        let now = pairing() != nil
        if configured != now { configured = now }
    }

    /// Whether this run's upload is being prepared or sent, so nothing deletes it under the upload.
    func isBusy(_ runName: String) -> Bool {
        creating.contains(runName) || states[runName].map { $0.phase == .narration || $0.phase == .content } == true
    }

    /// Forgets a run's upload before its folder is deleted from the phone: its state file and what the screen
    /// shows. Refused, with the reason, while the upload is being prepared or is sending; the receiver's copy
    /// is not touched (deleting it there is docs/IPHONE.md U5, for I2).
    func forget(_ runName: String) -> String? {
        if creating.contains(runName) { return "its upload is being prepared" }
        if let state = states[runName], state.phase == .narration || state.phase == .content { return "it is uploading" }
        states[runName] = nil
        statuses[runName] = nil
        live[runName] = nil
        let url = UploadRunState.url(in: stateDirectory, runName: runName)
        if FileManager.default.fileExists(atPath: url.path) {
            do { try FileManager.default.removeItem(at: url) } catch { return "its upload state could not be removed: \(Self.describe(error))" }
        }
        log.write("upload.forget", ["run": runName, "appState": ProbeAppState.current()])
        return nil
    }

    func handleBackgroundEvents(identifier: String, completion: @escaping () -> Void) {
        guard identifier == Self.sessionIdentifier else {
            log.write("bg.urlsession.events", ["phase": "unknown identifier", "identifier": identifier, "appState": ProbeAppState.current()])
            completion()
            return
        }
        log.write("bg.urlsession.events", ["phase": "handle", "identifier": identifier, "appState": ProbeAppState.current()])
        backgroundCompletion = completion
        _ = backgroundSession()
    }

    // MARK: Create, on the ordinary session

    private func enqueue(_ run: RunFolder, sendNow: Bool) {
        guard !creating.contains(run.name) else { return }
        if let state = states[run.name] {
            switch state.phase {
            case .done:
                publish(state)
                return
            case .narration, .content:
                if state.inFlight == nil { sendNext(state, resumed: true) }
                return
            case .failed:
                break   // from the create again: the receiver returns the same upload for the same client id
            }
        }
        guard readConfig() != nil else {
            statuses[run.name] = "not paired"
            log.write("upload.failed", ["run": run.name, "step": "config", "status": 0, "reason": "the phone is not paired", "appState": ProbeAppState.current()])
            return
        }
        creating.insert(run.name)
        statuses[run.name] = "hashing"
        // The recorder lets go of its own background time once the take is finished, which is when this
        // runs for a take stopped by leaving: without time of its own the app is suspended mid-hash or
        // mid-create, and nothing ever reaches the background session.
        holdHandOffTime(run.name)
        Task { @MainActor in
            await self.create(run, sendNow: sendNow)
            self.creating.remove(run.name)
            self.releaseHandOffTime(run.name)
        }
    }

    private func holdHandOffTime(_ run: String) {
        guard handOffTime[run] == nil else { return }
        let id = UIApplication.shared.beginBackgroundTask(withName: "Hand the upload to iOS") { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                // Not the upload's end: the create may still finish or fail when Polydance runs again.
                self.log.write("upload.failed", ["run": run, "step": "background time", "status": 0, "appState": ProbeAppState.current(),
                                                 "reason": "iOS's background time ran out before the upload was on the background session"])
                self.releaseHandOffTime(run)
            }
        }
        if id != .invalid { handOffTime[run] = id }
    }

    private func releaseHandOffTime(_ run: String) {
        guard let id = handOffTime.removeValue(forKey: run) else { return }
        UIApplication.shared.endBackgroundTask(id)
    }

    private func create(_ run: RunFolder, sendNow: Bool) async {
        let started = Date()
        do {
            let meta = try run.readMeta()
            // Where it goes; a thread.json that does not decode stops the upload rather than guess.
            let thread = try run.readThread()
            let installId = try installID()
            guard let runPath = Self.relativeToHome(run.directory) else {
                throw UploadProtocolError("run", "is not inside the app's container")
            }
            let videoURL = run.videoURL
            let narrationURL = run.narrationURL
            // Hashing a long take takes seconds: off the main thread, at the priority of work the person
            // is waiting for, since a take stopped by leaving has only the hand-off's background time. The
            // first take on the phone (2026-11-07) spent 11 s between here and the reply, where the same
            // hash takes 0.07 s on the Mac, so the hash and the request are timed apart (hashMs, requestMs).
            let (bytes, sha, narration) = try await Task.detached(priority: .userInitiated) { () throws -> (Int64, String, CreateUploadBody.Narration?) in
                let bytes = try Self.size(of: videoURL)
                let sha = try UploadProtocol.sha256Hex(of: videoURL)
                var narration: CreateUploadBody.Narration?
                // The video holds the same sound, so a narration that is missing or too long is just not sent first.
                if let n = try? Self.size(of: narrationURL), n > 0, n <= CreateUploadBody.maxNarrationBytes {
                    narration = .init(bytes: n, sha256: try UploadProtocol.sha256Hex(of: narrationURL))
                }
                return (bytes, sha, narration)
            }.value
            let hashed = Date()
            let body = try CreateUploadBody(installId: installId, runName: run.name, meta: meta, videoBytes: bytes, videoSha256: sha,
                                            narration: narration, thread: thread)
            guard let config = readConfig() else { throw UploadProtocolError("pairing", "is missing: the phone is not paired") }
            var request = try UploadRequests.create(config, body: body)
            request.allowsExpensiveNetworkAccess = true
            statuses[run.name] = "creating"
            let (data, response) = try await foreground.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let ms = Self.ms(since: started.timeIntervalSince1970)
            let hashMs = Self.ms(seconds: hashed.timeIntervalSince(started))
            let requestMs = Self.ms(since: hashed.timeIntervalSince1970)
            guard status == 200 || status == 201 else {
                let reason = UploadProtocol.shortReason(status: status, body: data.prefix(Self.maxBody))
                log.write("upload.create", ["run": run.name, "status": status, "ms": ms, "appState": ProbeAppState.current()])
                failed(run: run.name, step: "create", status: status, reason: reason)
                return
            }
            let view = try UploadView.decode(data)
            let state = UploadRunState(created: view, runName: run.name, runPath: runPath, clientId: body.clientId,
                                       narrationBytes: body.narration?.bytes, allowExpensive: sendNow, now: started)
            log.write("upload.create", [
                "run": run.name, "status": status, "created": status == 201, "uploadId": view.id, "bytes": bytes,
                "received": view.received, "server": view.status.rawValue, "narration": view.narration ?? "none",
                // Whether the build (versionName, commit) went with it; the schema refuses some, and they are left out.
                "app": body.app != nil,
                // Where it went, by kind only: a thread's key is not logged.
                "thread": thread.map { switch $0 { case .reply: "reply"; case .newThread: "new"; case .report: "report" } } ?? "none",
                "ms": ms, "hashMs": hashMs, "requestMs": requestMs, "appState": ProbeAppState.current(),
            ])
            save(state)
            if state.phase == .done { finished(state) } else { sendNext(state) }
        } catch {
            failed(run: run.name, step: "create", status: 0, reason: Self.describe(error))
        }
    }

    // MARK: Tasks, on the background session

    /// Starts the task for what comes next. Called from the delegate when the last one finished, which
    /// may be with the app in the background: the copy and the start happen before iOS is told the
    /// session's events are handled.
    private func sendNext(_ state: UploadRunState, resumed: Bool = false) {
        var state = state
        guard let config = readConfig() else {
            fail(&state, step: "config", status: 0, reason: "the phone is not paired")
            return
        }
        do {
            switch try state.next() {
            case .finished:
                state.phase = .done
                save(state)
                finished(state)
            case .narration:
                let run = runFolder(state)
                guard let declared = state.narrationBytes, (try? Self.size(of: run.narrationURL)) == declared else {
                    // Changed or gone since the create: the receiver will build the session from the video alone.
                    state.phase = .content
                    save(state)
                    sendNext(state, resumed: resumed)
                    return
                }
                var request = try UploadRequests.narration(config, uploadId: state.uploadId, bytes: declared)
                // U3: the words go on any network, so the title and transcript arrive first.
                request.allowsExpensiveNetworkAccess = true
                request.allowsConstrainedNetworkAccess = true
                let task = backgroundSession().uploadTask(with: request, fromFile: run.narrationURL)
                var fields: [String: any Sendable] = ["bytes": declared, "expensive": true]
                Self.delay(task, state, &fields)
                start(task, tag: .narration(state.runName), state: &state, resumed: resumed, fields: fields)
            case .content(let range):
                let tag = UploadTaskTag.content(state.runName, range)
                let chunk = tag.chunkFile(in: chunkDirectory)!
                // About 8 MB read and written on the main thread: tens of milliseconds, within a background wake.
                try UploadProtocol.writeChunk(of: runFolder(state).videoURL, range: range, to: chunk)
                var request = try UploadRequests.content(config, uploadId: state.uploadId, range: range)
                // U3: the video stays off mobile data and hotspots unless Send now (allowExpensive).
                request.allowsExpensiveNetworkAccess = state.allowExpensive
                request.allowsConstrainedNetworkAccess = state.allowExpensive
                let task = backgroundSession().uploadTask(with: request, fromFile: chunk)
                var fields: [String: any Sendable] = ["range": range.text, "bytes": range.length, "expensive": state.allowExpensive]
                Self.delay(task, state, &fields)
                if range.start == 0, let hold = holdVideoSeconds, !resumed {
                    let until = Date().addingTimeInterval(TimeInterval(hold))
                    if task.earliestBeginDate.map({ $0 < until }) ?? true { task.earliestBeginDate = until }
                    fields["heldSeconds"] = hold
                }
                start(task, tag: tag, state: &state, resumed: resumed, fields: fields)
            }
        } catch {
            fail(&state, step: "start", status: 0, reason: Self.describe(error))
        }
    }

    /// A task after a network failure, or after a 409 at the same offset, waits before it begins
    /// (UploadRunState.retryDelaySeconds); the wait is logged, and is part of the task's deliveredMs.
    private static func delay(_ task: URLSessionTask, _ state: UploadRunState, _ fields: inout [String: any Sendable]) {
        let delay = state.retryDelaySeconds
        guard delay > 0 else { return }
        task.earliestBeginDate = Date().addingTimeInterval(TimeInterval(delay))
        fields["delaySeconds"] = delay
        if state.retries > 0 { fields["retry"] = state.retries }
    }

    private func start(_ task: URLSessionUploadTask, tag: UploadTaskTag, state: inout UploadRunState, resumed: Bool, fields: [String: any Sendable]) {
        task.taskDescription = tag.text
        state.inFlight = tag.text
        state.taskStartedAt = Date().timeIntervalSince1970
        save(state)
        measureConfirmed(state)
        task.resume()
        var line = fields
        line["run"] = state.runName
        line["kind"] = tag.kind.rawValue
        line["resumed"] = resumed
        line["appState"] = ProbeAppState.current()
        log.write("upload.task.start", line)
    }

    /// The delegate's didCompleteWithError, on the main queue.
    fileprivate func completed(_ task: URLSessionTask, error: Error?) {
        let body = bodies.removeValue(forKey: task.taskIdentifier) ?? Data()
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        guard let text = task.taskDescription, let tag = UploadTaskTag(text: text) else {
            log.write("upload.task.done", ["kind": "unknown", "status": status, "appState": ProbeAppState.current()])
            return
        }
        var fields: [String: any Sendable] = [
            "run": tag.runName, "kind": tag.kind.rawValue, "status": status, "sent": task.countOfBytesSent, "appState": ProbeAppState.current(),
        ]
        if let range = tag.range { fields["range"] = range.text }
        let chunk = tag.chunkFile(in: chunkDirectory)
        guard var state = states[tag.runName], state.inFlight == text else {
            // A task this run no longer waits for (resynced after it was thought lost). Its chunk goes only
            // when no running task sends the same file.
            if let chunk, !chunkInUse(chunk) { try? FileManager.default.removeItem(at: chunk) }
            fields["stale"] = true
            log.write("upload.task.done", fields)
            return
        }
        if let chunk { try? FileManager.default.removeItem(at: chunk) }
        // From resume() until this callback reached the app: iOS's wait before the task, the transfer,
        // and the wait to wake the app. upload.task.metrics says which was which.
        fields["deliveredMs"] = state.taskStartedAt.map(Self.ms(since:)) ?? -1
        if let error {
            // No reply at all: the same range again later, the receiver's 409 correcting the offset if part
            // of it arrived. A refused token is a reply (401), so it never comes here.
            fields.merge(Self.errorFields(error)) { $1 }
            let outcome = state.applyTransportError(Self.describe(error))
            if case .next(let note?) = outcome { fields["note"] = note }
            log.write("upload.task.done", fields)
            save(state)
            switch outcome {
            case .next: sendNext(state)
            case .done: finished(state)
            case .failed(let reason): failed(run: state.runName, step: tag.kind.rawValue, status: status, reason: reason)
            }
            return
        }
        let outcome = tag.kind == .narration ? state.applyNarration(status: status, body: body) : state.applyContent(status: status, body: body)
        if case .next(let note?) = outcome { fields["note"] = note }
        if status == 409 { fields["offset"] = state.nextOffset }
        log.write("upload.task.done", fields)
        save(state)
        switch outcome {
        case .next: sendNext(state)
        case .done: finished(state)
        case .failed(let reason): failed(run: state.runName, step: tag.kind.rawValue, status: status, reason: reason)
        }
    }

    /// The delegate's didSendBodyData, on the main queue: the bytes of this task's body iOS has sent so far.
    fileprivate func sending(_ task: URLSessionTask, totalBytesSent: Int64) {
        guard let text = task.taskDescription, let tag = UploadTaskTag(text: text), let state = states[tag.runName],
              state.inFlight == text, let (stage, _, _) = Self.part(state) else { return }
        let start = tag.range?.start ?? 0
        measure(tag.runName, stage: stage, sent: start + totalBytesSent)
    }

    /// The delegate's didReceive data, on the main queue: kept up to 64 KB, the rest dropped.
    fileprivate func received(_ data: Data, task: URLSessionTask) {
        var body = bodies[task.taskIdentifier] ?? Data()
        let room = Self.maxBody - body.count
        if room > 0 { body.append(data.prefix(room)) }
        bodies[task.taskIdentifier] = body
    }

    /// The delegate's didFinishCollecting metrics, on the main queue, in its own line because iOS does not
    /// promise it comes before the task's completion. Clock times, not durations from resume(), so they
    /// read against upload.task.start's `t`: fetchStart is when iOS began the task, requestStart to
    /// responseEnd the transfer, and the gap to upload.task.done's `t` the wait to wake the app.
    fileprivate func collected(_ metrics: URLSessionTaskMetrics, task: URLSessionTask) {
        guard let text = task.taskDescription, let tag = UploadTaskTag(text: text) else { return }
        var fields: [String: any Sendable] = [
            "run": tag.runName, "kind": tag.kind.rawValue, "appState": ProbeAppState.current(),
            "taskStart": EventLog.timestamp(metrics.taskInterval.start), "taskMs": Self.ms(seconds: metrics.taskInterval.duration),
            "transactions": metrics.transactionMetrics.count,
        ]
        if let range = tag.range { fields["range"] = range.text }
        if let t = metrics.transactionMetrics.last {
            let times: [(String, Date?)] = [("fetchStart", t.fetchStartDate), ("requestStart", t.requestStartDate),
                                            ("requestEnd", t.requestEndDate), ("responseEnd", t.responseEndDate)]
            for (name, date) in times { if let date { fields[name] = EventLog.timestamp(date) } }
            fields["bodyBytesSent"] = t.countOfRequestBodyBytesSent
            fields["reusedConnection"] = t.isReusedConnection
        }
        log.write("upload.task.metrics", fields)
    }

    fileprivate func finishedEvents() {
        log.write("bg.urlsession.events", ["phase": "finished", "identifier": Self.sessionIdentifier, "appState": ProbeAppState.current()])
        let completion = backgroundCompletion
        backgroundCompletion = nil
        completion?()
    }

    /// One task as the state records it: its tag, and when it was started, which tells two sends of the
    /// same range apart.
    private struct Attempt: Equatable {
        let tag: String
        let startedAt: Double?
    }

    /// A task the state says is running that the session does not have, and whose event did not come
    /// within 10 s of reattaching: the receiver's own count says where to go on from. Nothing is done if
    /// the run has moved on since, including to a new send of the same range.
    private func recoverLostTask(run: String, attempt: Attempt) async {
        try? await Task.sleep(for: .seconds(10))
        let tag = attempt.tag
        guard var state = states[run], state.inFlight == tag, state.taskStartedAt == attempt.startedAt else { return }
        if let chunk = UploadTaskTag(text: tag)?.chunkFile(in: chunkDirectory) { try? FileManager.default.removeItem(at: chunk) }
        guard let config = readConfig() else { return }
        do {
            let (data, response) = try await foreground.data(for: UploadRequests.status(config, uploadId: state.uploadId))
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            log.write("upload.task.done", ["run": run, "kind": UploadTaskTag(text: tag)?.kind.rawValue ?? "unknown", "lost": true, "status": status, "appState": ProbeAppState.current()])
            guard status == 200 else {
                fail(&state, step: "status", status: status, reason: UploadProtocol.shortReason(status: status, body: data.prefix(Self.maxBody)))
                return
            }
            let outcome = state.resync(from: try UploadView.decode(data))
            save(state)
            switch outcome {
            case .next: sendNext(state, resumed: true)
            case .done: finished(state)
            case .failed(let reason): failed(run: run, step: "status", status: status, reason: reason)
            }
        } catch {
            // The status could not be asked for (no network now): send the same range again later on the
            // background session, whose 409 then says where the receiver is.
            var fields = Self.errorFields(error)
            fields.merge(["run": run, "lost": true, "status": 0, "appState": ProbeAppState.current()]) { $1 }
            let outcome = state.applyTransportError(Self.describe(error))
            if case .next(let note?) = outcome { fields["note"] = note }
            log.write("upload.task.done", fields)
            save(state)
            switch outcome {
            case .next: sendNext(state, resumed: true)
            case .done: finished(state)
            case .failed(let reason): failed(run: run, step: "status", status: 0, reason: reason)
            }
        }
    }

    // MARK: Outcomes

    private func finished(_ state: UploadRunState) {
        publish(state)
        log.write("upload.done", [
            "run": state.runName, "uploadId": state.uploadId, "server": state.serverStatus ?? "unknown", "bytes": state.bytes,
            "ms": Self.ms(since: state.startedAt), "appState": ProbeAppState.current(),
        ])
        onFinished?(state.runName)
    }

    private func fail(_ state: inout UploadRunState, step: String, status: Int, reason: String) {
        _ = state.fail(reason)
        save(state)
        failed(run: state.runName, step: step, status: status, reason: reason)
    }

    private func failed(run: String, step: String, status: Int, reason: String) {
        statuses[run] = "failed: \(reason)"
        log.write("upload.failed", ["run": run, "step": step, "status": status, "reason": reason, "appState": ProbeAppState.current()])
    }

    // MARK: State on disk

    private func save(_ state: UploadRunState) {
        states[state.runName] = state
        if state.inFlight == nil || state.phase == .done || state.phase == .failed { measureConfirmed(state) }
        publish(state)
        do {
            try state.save(UploadRunState.url(in: stateDirectory, runName: state.runName))
        } catch {
            log.write("upload.failed", ["run": state.runName, "step": "save", "status": 0, "reason": Self.describe(error), "appState": ProbeAppState.current()])
        }
    }

    private func publish(_ state: UploadRunState) { statuses[state.runName] = state.summary }

    /// Every saved state; one that does not decode is logged and left alone, never guessed at.
    private func loadStates() -> [UploadRunState] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: stateDirectory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") && RunNames.isRunName(String($0.dropLast(5))) }.sorted().compactMap { name -> UploadRunState? in
            do { return try UploadRunState.load(stateDirectory.appendingPathComponent(name)) } catch {
                log.write("upload.failed", ["run": String(name.dropLast(5)), "step": "load", "status": 0, "reason": Self.describe(error), "appState": ProbeAppState.current()])
                return nil
            }
        }
    }

    /// This install's id, made once: client ids are `<install id>-<run name>`.
    private func installID() throws -> String {
        let url = stateDirectory.appendingPathComponent("install-id")
        if FileManager.default.fileExists(atPath: url.path) {
            let id = try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            guard UploadProtocol.isInstallId(id) else { throw UploadProtocolError("install-id", "is not 16 lowercase hex digits") }
            return id
        }
        let id = UploadProtocol.newInstallId()
        try PrivateFiles.directory(stateDirectory)
        try PrivateFiles.write(Data((id + "\n").utf8), to: url)
        return id
    }

    /// Whether a running task (by the states' in-flight tags) sends this chunk file.
    private func chunkInUse(_ chunk: URL) -> Bool {
        states.values.contains { $0.inFlight.flatMap(UploadTaskTag.init(text:))?.chunkFile(in: chunkDirectory) == chunk }
    }

    private func removeStaleChunks(keeping live: Set<String>) {
        let keep = Set(live.compactMap { UploadTaskTag(text: $0)?.chunkFile(in: chunkDirectory)?.lastPathComponent })
        for name in (try? FileManager.default.contentsOfDirectory(atPath: chunkDirectory.path)) ?? [] where name.hasSuffix(".part") && !keep.contains(name) {
            try? FileManager.default.removeItem(at: chunkDirectory.appendingPathComponent(name))
        }
    }

    // MARK: Helpers

    private func backgroundSession() -> URLSession {
        if let background { return background }
        let c = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        c.sessionSendsLaunchEvents = true
        c.isDiscretionary = false
        // Each request says whether it may use an expensive or constrained network (U3); the session allows both.
        c.allowsExpensiveNetworkAccess = true
        c.allowsConstrainedNetworkAccess = true
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.urlCache = nil
        // The main queue, so callbacks read the app's state directly and need no hop.
        let session = URLSession(configuration: c, delegate: delegate, delegateQueue: .main)
        background = session
        return session
    }

    /// The pairing, read fresh each time; logs only whether there is one and whether it is local, never the
    /// receiver's name or the token.
    private func readConfig(logIt: Bool = false) -> Pairing? {
        let found = pairing()
        if configured != (found != nil) { configured = found != nil }
        if logIt {
            var fields: [String: any Sendable] = ["ok": found != nil, "appState": ProbeAppState.current()]
            if let found { fields["scheme"] = found.server.scheme ?? ""; fields["local"] = found.isLocal; fields["port"] = found.server.port ?? 0 }
            log.write("upload.config", fields)
        }
        return found
    }

    private func runFolder(_ state: UploadRunState) -> RunFolder {
        RunFolder(name: state.runName, directory: URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(state.runPath, isDirectory: true))
    }

    nonisolated private static func relativeToHome(_ url: URL) -> String? {
        let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path + "/"
        let path = url.resolvingSymlinksInPath().path
        guard path.hasPrefix(home) else { return nil }
        let relative = String(path.dropFirst(home.count))
        return UploadRunState.isRelativePath(relative) ? relative : nil
    }

    nonisolated private static func size(of url: URL) throws -> Int64 {
        guard let n = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber else {
            throw UploadProtocolError(url.lastPathComponent, "has no size")
        }
        return n.int64Value
    }

    nonisolated private static func ms(since seconds: Double) -> Int { ms(seconds: Date().timeIntervalSince1970 - seconds) }

    nonisolated private static func ms(seconds: Double) -> Int { Int((seconds * 1000).rounded()) }

    /// A few words for an error: the protocol's own message, or the domain and code with iOS's short text.
    nonisolated private static func describe(_ error: Error) -> String {
        if let e = error as? UploadProtocolError { return e.description }
        let ns = error as NSError
        let text = ns.localizedDescription.split(whereSeparator: \.isNewline).joined(separator: " ")
        return "\(ns.domain) \(ns.code): \(text.prefix(100))"
    }

    /// What the system says about a failed task: its error code, and why a background task was cancelled
    /// (force quit, background updates off, low resources).
    nonisolated private static func errorFields(_ error: Error) -> [String: any Sendable] {
        let ns = error as NSError
        var fields: [String: any Sendable] = ["errorDomain": ns.domain, "errorCode": ns.code]
        // Why the network was unavailable when a request's own limits ruled it out (expensive, constrained).
        if let why = ns.userInfo[NSURLErrorNetworkUnavailableReasonKey] as? Int {
            fields["unavailableReason"] = switch URLError.NetworkUnavailableReason(rawValue: why) {
            case .cellular: "cellular"
            case .expensive: "expensive"
            case .constrained: "constrained"
            default: "code \(why)"
            }
        }
        // The network path iOS had, such as "unsatisfied (Local network prohibited)": the reason a refused
        // local network is told apart from a dropped one. Cut short; it names interfaces, not people.
        if let path = ns.userInfo["_NSURLErrorNWPathKey"] {
            fields["path"] = String(String(describing: path).prefix(200))
        }
        if let why = ns.userInfo[NSURLErrorBackgroundTaskCancelledReasonKey] as? Int {
            fields["cancelledReason"] = switch why {
            case NSURLErrorCancelledReasonUserForceQuitApplication: "user force quit"
            case NSURLErrorCancelledReasonBackgroundUpdatesDisabled: "background updates disabled"
            case NSURLErrorCancelledReasonInsufficientSystemResources: "insufficient system resources"
            default: "code \(why)"
            }
        }
        return fields
    }
}

/// The background session's delegate. Its queue is the main queue (backgroundSession()), so each call is
/// already on the main actor; it holds the probe weakly so the session, which keeps its delegate, does not
/// keep the probe.
private final class SessionDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    weak var probe: UploadProbe?

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        MainActor.assumeIsolated { probe?.sending(task, totalBytesSent: totalBytesSent) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated { probe?.received(data, task: dataTask) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated { probe?.completed(task, error: error) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        MainActor.assumeIsolated { probe?.collected(metrics, task: task) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        MainActor.assumeIsolated { probe?.finishedEvents() }
    }
}
