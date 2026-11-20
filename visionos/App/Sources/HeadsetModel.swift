// What the Vision Pro's panel shows and does (docs/VISIONOS.md), the Quest's MainActivity and InboxPane in one model:
// the deck (where the next take goes, the MIC and APP switches, the red key, the lamps and the counter), the inbox
// (the receiver's threads, Archived, projects, search), the open thread (reactions, picks, Archive, Delete with Undo,
// Reply, Record and open, Just open), Recordings, and the settings behind the gear. The parts under it are shared:
// the receiver client, the background upload, the refresh, reply notices and the Keychain pairing are the iPhone's
// own files; the run folders, the upload protocol and the thread requests are PolydancePhoneCore's; the take is
// written by the broadcast extension (BroadcastLink). It follows the iPhone's DeckModel wherever the two agree,
// and the Quest wherever the headset differs from a phone: the panel's layout, both sounds, Record and open, the
// hold after Stop, the 3D viewer and the receiver read every 10 s (the open thread every 5 s).
import Combine
import PolydancePhoneCore
import PolydanceShared
import SwiftUI
import UIKit

/// The shared parts, made once at launch.
@MainActor
struct HeadsetParts {
    let log: EventLog
    let pairing: PairingStore
    let uploads: UploadProbe
    let refresh: RefreshProbe
    let notifier: ReplyNotifier
    let link: BroadcastLink
    let root: URL
    let runs: URL
    let uploadStates: URL
    let models: URL
}

@MainActor
final class HeadsetModel: ObservableObject {
    static let shared = HeadsetModel()

    /// What the inbox's right-hand column shows (InboxPane's detail).
    /// `agents` is the person's own coding agents (2026-11-20): the code to connect one, and those connected.
    enum Detail: Hashable { case thread(String), recordings, newThread, agents }
    enum Box: Equatable { case inbox, archived }
    /// Where the next take goes, said under the red key.
    enum Target: Equatable {
        case newThread
        case thread(key: String, title: String, replyTo: RunThread.ReplyTo?)
        case report
    }

    /// A launch waiting for its take to begin (Record and open), opened 0.7 s after the first frame as the headset does.
    struct PendingLaunch {
        let key: String
        let message: Int
        let index: Int?
        let label: String?
        let links: [URL]
        let asked: Date
    }

    struct Flash: Equatable {
        let text: String
        let undo: Undo?
        enum Undo: Equatable { case archive(String), delete(String) }
    }

    let parts: HeadsetParts?
    let setupError: String?
    let shortVersion: String
    let build: Int?
    let commit: String
    let modelIdentifier: String
    let systemVersion: String
    let provisioning: ProvisioningInfo.Reading
    var versionLine: String { "Polydance \(shortVersion) (\(build.map(String.init) ?? "?")) · \(commit)" }

    // MARK: The deck
    @Published var mic: Bool { didSet { UserDefaults.standard.set(mic, forKey: "rec.mic"); writeNext() } }
    @Published var appSound: Bool { didSet { UserDefaults.standard.set(appSound, forKey: "rec.app"); writeNext() } }
    /// The picture's quality behind the gear (Low, Medium, High); the extension sets its bitrate from it.
    @Published var quality: RecordingQuality { didSet { UserDefaults.standard.set(quality.rawValue, forKey: "rec.quality"); writeNext() } }
    @Published var target: Target = .newThread { didSet { writeNext() } }
    @Published var settingsShown = false
    @Published var reportAsked = false
    @Published var cancelAsked = false
    /// A press from code that visionOS would not take: the deck asks for REC itself.
    @Published var pressRec = false
    /// The line under the panel that fades after 8 s (MainActivity's notice).
    @Published private(set) var notice: String?
    private var noticeTask: Task<Void, Never>?

    // MARK: The inbox
    @Published var detail: Detail?
    @Published var box: Box = .inbox {
        didSet { if box == .archived, oldValue != .archived { Task { await loadArchived() } } }
    }
    @Published var query = ""
    @Published var projects: Set<String> = []
    @Published var drawerOpen = false
    @Published var newThreadProject: String?
    @Published private(set) var threads: [ThreadSummary] = []
    @Published private(set) var archivedThreads: [ThreadSummary] = []
    @Published private(set) var details: [String: ThreadDetail] = [:]
    @Published private(set) var projectNames: [(key: String, name: String)] = []
    /// The same projects as the receiver lists them, each saying whether it is this person's own (2026-11-13).
    @Published private(set) var projectRefs: [ProjectRef] = []
    /// Whether the receiver makes a project of your own, so the draft's list ends in New project.
    @Published private(set) var newProjects = false
    /// Connecting your own agent (2026-11-20, docs/THREADS.md; Robin's picks D and then C): whether the receiver does
    /// it, this person's agents, the code on show, why one could not be had, and whether the inbox's card was put away.
    @Published private(set) var agentsOn = false
    @Published private(set) var agentList: AgentList?
    @Published private(set) var agentCode: AgentCode?
    @Published private(set) var agentProblem: String?
    @Published private(set) var askingCode = false
    @Published private(set) var agentOfferHidden = UserDefaults.standard.bool(forKey: "agents.offerHidden")
    @Published private(set) var reportsOn: Bool?
    @Published private(set) var inboxProblem: String?
    @Published private(set) var loading = false
    @Published private(set) var account: AccountReply?
    @Published private(set) var who: String?
    @Published private(set) var threadProblems: [String: String] = [:]
    @Published var flash: Flash?

    // MARK: Takes
    @Published private(set) var runs: [RunFolder] = []
    @Published private(set) var metas: [String: RunMeta] = [:]
    /// Takes waiting out the hold after Stop, with when they go (the headset's 5 s, or 30 s for a take under 20 s).
    @Published private(set) var holds: [String: Date] = [:]
    /// The receiver's status of each sent take, read again while it processes (ServerSync).
    @Published private(set) var serverStatus: [String: String] = [:]
    private var pendingLaunch: PendingLaunch?

    private var cancellables: Set<AnyCancellable> = []
    private var poll: Task<Void, Never>?
    private var threadPoll: Task<Void, Never>?
    private var sweptFor: Pairing?
    private var lastRecording = false

    private init() {
        let info = Bundle.main.infoDictionary ?? [:]
        shortVersion = info["CFBundleShortVersionString"] as? String ?? "?"
        build = (info["CFBundleVersion"] as? String).flatMap(Int.init)
        commit = (info["PolydanceCommit"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "unknown"
        modelIdentifier = Self.hardwareModel()
        let v = ProcessInfo.processInfo.operatingSystemVersion
        systemVersion = "visionOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        provisioning = ProvisioningInfo.read()
        mic = UserDefaults.standard.object(forKey: "rec.mic") as? Bool ?? true
        appSound = UserDefaults.standard.object(forKey: "rec.app") as? Bool ?? true
        quality = (UserDefaults.standard.string(forKey: "rec.quality")).flatMap(RecordingQuality.init(rawValue:)) ?? .default
        do {
            guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
                throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "visionOS gave no Application Support folder"])
            }
            if let owner = (try? FileManager.default.attributesOfItem(atPath: support.path))?[.ownerAccountID] as? NSNumber, owner.uint32Value != getuid() {
                throw CocoaError(.fileWriteNoPermission, userInfo: [NSLocalizedDescriptionKey:
                    "Library/Application Support belongs to uid \(owner), not Polydance: devicectl made it before the app's first launch. Uninstall, install, launch once, then configure (visionos/README.md)."])
            }
            let runs = support.appendingPathComponent("Runs", isDirectory: true)
            let uploads = support.appendingPathComponent("uploads", isDirectory: true)
            let models = support.appendingPathComponent("models", isDirectory: true)
            for folder in [support, runs, uploads, models] { try PrivateFiles.directory(folder) }
            for folder in [support] {
                var url = folder
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try url.setResourceValues(values)
            }
            let log = try EventLog(url: support.appendingPathComponent("events.jsonl"))
            let pairing = PairingStore(log: log, root: support)
            parts = HeadsetParts(log: log, pairing: pairing,
                                 uploads: UploadProbe(log: log, pairing: { [weak pairing] in pairing?.current() }, stateDirectory: uploads),
                                 refresh: RefreshProbe(log: log), notifier: ReplyNotifier(log: log, root: support),
                                 link: BroadcastLink(log: log, runs: runs), root: support, runs: runs, uploadStates: uploads, models: models)
            setupError = nil
        } catch {
            parts = nil
            setupError = ErrorWords.describe(error)
        }
        if let parts { wire(parts) }
    }

    private func wire(_ parts: HeadsetParts) {
        // Every part's change redraws the panel: the reels turn with the take, the lamps with the uploads.
        for publisher in [parts.link.objectWillChange.eraseToAnyPublisher(), parts.uploads.objectWillChange.eraseToAnyPublisher(),
                          parts.pairing.objectWillChange.eraseToAnyPublisher(), parts.notifier.objectWillChange.eraseToAnyPublisher()] {
            publisher.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        }
        let uploads = parts.uploads
        parts.pairing.$pairing.removeDuplicates().sink { [weak uploads] _ in
            DispatchQueue.main.async { uploads?.pairingChanged() }
        }.store(in: &cancellables)
        uploads.onFinished = { [weak self] name in self?.uploadFinished(name) }
        parts.refresh.work = { [weak pairing = parts.pairing, weak notifier = parts.notifier] in
            guard let notifier, let found = pairing?.current() else { return true }
            return await notifier.check(ReceiverClient(pairing: found), why: "refresh")
        }
        parts.notifier.onOpen = { [weak self] key in self?.open(key) }
        parts.link.onTakeArrived = { [weak self] run in self?.takeArrived(run) }
        parts.link.onRecording = { [weak self] run in self?.recordingBegan(run) }
        parts.link.$state.removeDuplicates().sink { [weak self] state in self?.linkChanged(state) }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in self?.cameToFront() }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .sink { [weak self] _ in self?.stopPolling() }.store(in: &cancellables)
        writeNext()
        reloadRuns()
    }

    // MARK: Launch and the app's life

    func launched(optionKeys: [String], refreshRegistered: Bool) {
        guard let parts else { return }
        parts.log.write("launch", ["appStateInDidFinishLaunching": ProbeAppState.current(), "version": shortVersion, "build": build ?? -1,
                                   "commit": commit, "model": modelIdentifier, "system": systemVersion, "launchOptions": optionKeys,
                                   "refreshRegistered": refreshRegistered])
        switch provisioning {
        case .present(let info): parts.log.write("profile", info.logFields())
        case .absent(let why): parts.log.write("profile", ["absent": why])
        case .unreadable(let why): parts.log.write("profile", ["error": why])
        }
        parts.uploads.reattach()
        sweepReports()
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        guard let parts else { return }
        let name = switch phase { case .active: "active"; case .inactive: "inactive"; case .background: "background"; @unknown default: "unknown" }
        parts.log.write("scene", ["phase": name, "appState": ProbeAppState.current()])
        if phase == .background { parts.refresh.schedule() }
    }

    private func cameToFront() {
        guard let parts else { return }
        parts.pairing.load()
        parts.link.refresh()
        reloadRuns()
        Task { await refresh() }
        poll?.cancel()
        poll = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self else { return }
                tick += 1
                if case .thread(let key) = self.detail { await self.loadThread(key, markRead: true) }
                // Who is connected is asked while it can change under the person's eyes: on its page, and while a code shows.
                if self.detail == .agents || self.liveCode() != nil { await self.refreshAgents() }
                if tick % 2 == 0 { await self.refresh() }
                await self.syncServer()
            }
        }
    }

    private func stopPolling() {
        poll?.cancel()
        poll = nil
    }

    // MARK: The deck: recording

    private var link: BroadcastLink? { parts?.link }
    private var pairing: Pairing? { parts?.pairing.pairing }
    var paired: Bool { pairing != nil }
    private var client: ReceiverClient? { pairing.map(ReceiverClient.init(pairing:)) }

    var isRecording: Bool { link?.isRecording ?? false }
    var isBusy: Bool { link?.isBusy ?? false }
    var tapeFull: Bool { account?.full == true }

    /// Whether REC may start a take now: the picker over the red key is there only then.
    var mayRecord: Bool {
        guard parts != nil, !isRecording, !isBusy else { return false }
        return !(tapeFull && target != .report)
    }

    /// next.json, the take the extension writes next, kept as the deck says.
    private func writeNext() {
        guard let link else { return }
        link.writeNext(NextTake(thread: runThread(), mic: mic, app: appSound, quality: quality, appVersion: shortVersion, appBuild: build, appCommit: commit))
    }

    /// What the take's thread.json says, or nil to keep it on the headset.
    private func runThread() -> RunThread? {
        guard pairing != nil else { return target == .report ? .report : nil }
        switch target {
        case .report: return .report
        case .thread(let key, _, let replyTo): return try? RunThread.replying(to: key, replyTo: replyTo)
        case .newThread: return currentProject.flatMap { try? RunThread.opening(in: $0) }
        }
    }

    /// STOP while a take runs; otherwise REC, pressed from code (the red key itself is the system's picker).
    func pressRecord() {
        guard let link else { return }
        if isRecording { link.stop(); return }
        guard mayRecord else { return }
        writeNext()
        if !link.start() { pressRec = true }
    }

    func cancelTake() {
        cancelAsked = false
        link?.cancel()
        pendingLaunch = nil
    }

    private func linkChanged(_ state: BroadcastLink.State) {
        switch state {
        case .asking, .starting:
            pressRec = false
        case .recording:
            pressRec = false
            lastRecording = true
        case .idle:
            if lastRecording {
                lastRecording = false
                if target == .report { show(paired ? "Thank you. Your report is on its way to the Polydance team." : "Your report is kept on this headset and goes once it is paired.") }
                target = .newThread
                pendingLaunch = nil
                Task { try? await Task.sleep(for: .seconds(3)); await self.refresh() }
            } else if pendingLaunch.map({ Date().timeIntervalSince($0.asked) > 45 }) == true {
                pendingLaunch = nil
            }
        case .finishing:
            break
        }
    }

    /// Reply: aimed at the thread, and the take begins (the headset's REPLY).
    func reply(to key: String) {
        target = .thread(key: key, title: title(of: key), replyTo: nil)
        pressRecord()
    }

    /// The bug key's Start recording: the take is aimed at a report.
    func startReport() {
        reportAsked = false
        target = .report
        pressRecord()
    }

    /// New thread: the draft in the inbox's column, with the project to open it in.
    func newThread() {
        newThreadProject = currentProject
        detail = .newThread
    }

    /// The draft's "Record the first message".
    func recordNewThread() {
        guard let project = newThreadProject ?? currentProject else { return }
        chosenProject = project
        target = .newThread
        detail = nil
        pressRecord()
    }

    private var chosenProject: String?

    /// New project from the draft's list: made on the receiver, then the draft's project. Nil when made, else why not.
    func makeProject(_ name: String) async -> String? {
        guard let client else { return "This headset is not paired, so there is no receiver to make a project on." }
        do {
            let made = try await client.newProject(name)
            guard client.pairing == pairing else { return nil }
            projectRefs = made.projects
            projectNames = made.projects.map { (key: $0.key, name: $0.name) }
            newThreadProject = made.project.key
            return nil
        } catch {
            return Self.words(error)
        }
    }

    var currentProject: String? {
        if projects.count == 1, let only = projects.first { return only }
        if let chosenProject, projectNames.contains(where: { $0.key == chosenProject }) { return chosenProject }
        return projectNames.first?.key
    }

    func projectName(_ key: String) -> String { projectNames.first { $0.key == key }?.name ?? key }

    var reportRefused: Bool { pairing != nil && reportsOn == false }

    /// The line under the red key: where the take goes.
    var targetLine: String {
        switch target {
        case .report: return paired ? "→ Report · Polydance team" : "→ Report · kept here until the headset is paired"
        case .thread(let key, let title, _): return "→ \(key) · \(title)"
        case .newThread:
            guard pairing != nil else { return "→ Kept on this headset · pair it behind the gear" }
            guard let project = currentProject else { return "→ Kept on this headset · the receiver lists no projects" }
            return "→ New thread · \(projectName(project))"
        }
    }

    /// Only when something needs doing (MainActivity's hint line).
    var hint: String? {
        if let setupError { return "Polydance could not set up its files: \(setupError)" }
        if pressRec { return "visionOS needs REC itself to start a recording: press the red key." }
        if case .asking? = link?.state { return "Starting recording… press Start Broadcast in visionOS's sheet." }
        if link?.micSilent == true, mic { return "No sound from the microphone: stop, then turn the microphone on in the Start Broadcast sheet." }
        if let problem = link?.problem { return problem }
        if tapeFull, target != .report { return "Tape full: delete recordings on the receiver before recording more." }
        return nil
    }

    func show(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    /// The control panel at a moment; the counter moves, so the deck asks on a timer.
    func readout(at now: Date) -> DeckReadout {
        let uploads = parts?.uploads
        let uploading = !(uploads?.preparing.isEmpty ?? true)
            || (uploads?.states.values.contains { $0.phase == .narration || $0.phase == .content } ?? false)
        let processing = serverStatus.values.contains { $0 == "received" || $0 == "processing" }
        var seconds = 0
        var key: RecordKey.Mode = mayRecord ? .ready : .disabled
        var word: String?
        switch link?.state {
        case .recording(_, let since)?:
            seconds = max(0, Int(now.timeIntervalSince(since)))
            key = .recording
        case .asking?, .starting?, .finishing?:
            key = .starting
        default:
            if tapeFull, target != .report { word = "Full" }
        }
        let recording = key == .recording
        return DeckReadout(recording: recording, ready: key == .ready, uploading: uploading, processing: processing, seconds: seconds,
                           mic: recording && mic ? link?.micLevel ?? 0 : 0, app: recording && appSound ? link?.appLevel ?? 0 : 0,
                           key: key, keyWord: word, target: targetLine, hint: hint)
    }

    // MARK: Takes

    func reloadRuns() {
        guard let parts else { return }
        runs = RunFolder.list(in: parts.runs)
        var found: [String: RunMeta] = [:]
        for run in runs { if let meta = try? run.readMeta() { found[run.name] = meta } }
        metas = found
    }

    /// A finished take arrived from the extension: a report goes at once, a take after the hold, and nothing goes
    /// unpaired (it waits in Recordings for Send now).
    private func takeArrived(_ run: RunFolder) {
        reloadRuns()
        guard let parts, pairing != nil, let meta = metas[run.name], !meta.cut else { return }
        let report = (try? run.readThread())?.isReport == true
        let hold: TimeInterval = report ? 0 : (meta.durationMs ?? 0) < 20_000 ? 30 : 5
        let until = Date().addingTimeInterval(hold)
        holds[run.name] = until
        parts.log.write("upload.hold", ["run": run.name, "seconds": Int(hold)])
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(hold))
            guard let self, self.holds[run.name] == until else { return }
            self.holds[run.name] = nil
            guard self.runs.contains(where: { $0.name == run.name }) else { return }
            parts.uploads.upload(run, sendNow: true)
        }
    }

    func sendNow(_ run: RunFolder) {
        holds[run.name] = nil
        parts?.uploads.upload(run, sendNow: true)
    }

    /// Delete from this headset, refused while the take uploads; the receiver's copy is not touched.
    func deleteRun(_ run: RunFolder) -> String? {
        guard let parts else { return nil }
        if let why = parts.uploads.forget(run.name) { return "It cannot be deleted now: \(why)." }
        holds[run.name] = nil
        do { try FileManager.default.removeItem(at: run.directory) } catch { return "It could not be deleted: \(ErrorWords.describe(error))" }
        parts.log.write("rec.delete", ["run": run.name])
        reloadRuns()
        return nil
    }

    // MARK: A take on its way (Robin, 2026-11-14: "no idea how much is left or if it's stuck")

    /// The take of this headset's that the receiver knows as `uploadId`, while it is still being sent: its run's name,
    /// so the thread's message shows its share and pace (UploadProbe.progress) as the Quest's does.
    func sending(uploadId: String) -> String? {
        parts?.uploads.states.first { $0.value.uploadId == uploadId && ($0.value.phase == .narration || $0.value.phase == .content) }?.key
    }

    /// A reply of this headset's to a thread that has no message for it yet (InboxPane's pendingCard): held after
    /// Stop, or being prepared or sent before the thread is read again.
    struct TakeOnItsWay: Identifiable {
        let run: RunFolder
        var id: String { run.name }
        /// Seconds left of the hold after Stop.
        let held: Int?
        let progress: UploadProgress?
    }

    func takesOnTheirWay(to key: String, at now: Date) -> [TakeOnItsWay] {
        guard let parts else { return [] }
        let known = Set(details[key]?.messages.compactMap { $0.recording?.uploadId } ?? [])
        return runs.compactMap { run -> TakeOnItsWay? in
            // Memory first, so only a take on its way reads its thread.json each second.
            let held = holds[run.name].map { max(0, Int($0.timeIntervalSince(now).rounded(.up))) }
            let progress = held == nil ? parts.uploads.progress(run.name, at: now) : nil
            guard held != nil || progress != nil else { return nil }
            guard case .reply(let to, _)? = try? run.readThread(), to == key else { return nil }
            if let state = parts.uploads.states[run.name], known.contains(state.uploadId) { return nil }
            return TakeOnItsWay(run: run, held: held, progress: progress)
        }
        .sorted { $0.run.name < $1.run.name }
    }

    private func uploadFinished(_ name: String) {
        guard let parts, let run = runs.first(where: { $0.name == name }) else { return }
        if let status = parts.uploads.states[name]?.serverStatus { serverStatus[name] = status }
        // A report leaves the headset once the receiver has it all (the headset's ReportPolicy).
        if (try? run.readThread())?.isReport == true {
            _ = parts.uploads.forget(name)
            try? FileManager.default.removeItem(at: run.directory)
            parts.log.write("report.removed", ["deleted": true])
            reloadRuns()
        }
        Task { await refresh() }
    }

    /// Reports kept while unpaired go once there is somewhere to send them; sent ones that are still here go.
    private func sweepReports() {
        guard let parts else { return }
        for run in runs where (try? run.readThread())?.isReport == true {
            let state = parts.uploads.states[run.name]
            switch ReportPolicy.decide(phase: state?.phase, recording: false, recordedAt: metas[run.name].flatMap { ReportPolicy.date($0.recordedAt) }, now: Date()) {
            case .delete(let why):
                _ = parts.uploads.forget(run.name)
                try? FileManager.default.removeItem(at: run.directory)
                parts.log.write("report.removed", ["deleted": true, "why": why])
            case .send: if pairing != nil { parts.uploads.upload(run, sendNow: true) }
            case .keep: break
            }
        }
        reloadRuns()
    }

    /// The receiver's status for each sent take still being built: PROCESSING stays lit until it is ready (ServerSync).
    private func syncServer() async {
        guard let parts, let config = pairing else { return }
        for (name, state) in parts.uploads.states where state.phase == .done {
            let known = serverStatus[name] ?? state.serverStatus ?? "received"
            guard known == "received" || known == "processing" else { serverStatus[name] = known; continue }
            guard let request = try? UploadRequests.status(config, uploadId: state.uploadId),
                  let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200, let view = try? UploadView.decode(data) else { continue }
            serverStatus[name] = view.status.rawValue
        }
    }

    // MARK: Record and open

    /// Record and open on a launch: the take aimed at its message and option, the links opened once it records. While
    /// a take already runs, the links open into it (refused while recording a report), as the headset does.
    func recordAndOpen(_ key: String, message: ThreadMessage, index: Int?, launch: Launch) {
        let links = launch.macLinks
        if isRecording {
            if target == .report { show("A report is recording: stop it before opening a launch."); return }
            open(links: links, key: key, message: message.id, index: index, label: launch.label)
            return
        }
        target = .thread(key: key, title: title(of: key), replyTo: .init(message: message.id, launch: index))
        pendingLaunch = PendingLaunch(key: key, message: message.id, index: index, label: launch.label, links: links, asked: Date())
        pressRecord()
    }

    /// Just open: the links, with no recording (and logged into the take when one runs).
    func justOpen(_ key: String, message: ThreadMessage, index: Int?, launch: Launch) {
        open(links: launch.macLinks, key: key, message: message.id, index: index, label: launch.label)
    }

    private func recordingBegan(_ run: RunFolder) {
        guard let pending = pendingLaunch else { return }
        pendingLaunch = nil
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            self?.open(links: pending.links, key: pending.key, message: pending.message, index: pending.index, label: pending.label)
        }
    }

    private func open(links: [URL], key: String, message: Int, index: Int?, label: String?) {
        guard !links.isEmpty else { return }
        for link in links { UIApplication.shared.open(link) }
        parts?.log.write("launch.open", ["links": links.count, "recording": isRecording])
        guard let run = link?.liveRun, case .recording(_, let since)? = link?.state else { return }
        let entry = Opened(atMs: max(0, Int(Date().timeIntervalSince(since) * 1000)), what: Opened.what(links: links),
                           label: label.map { String($0.prefix(40)) }, message: message, launch: index)
        do { try Opened.append(entry, to: run) } catch {
            parts?.log.write("launch.opened", ["ok": false, "reason": ErrorWords.describe(error)])
        }
        show("Opened \(links.first.map { LaunchLink.short($0) } ?? "") into the recording.")
    }

    // MARK: The receiver

    func refresh() async {
        guard let client else { return }
        loading = true
        defer { loading = false }
        do {
            let listing = try await client.listing()
            guard client.pairing == pairing else { return }
            threads = listing.threads
            projectNames = listing.projects.map { (key: $0.key, name: $0.name) }
            projectRefs = listing.projects
            newProjects = listing.newProjects
            agentsOn = listing.agents
            reportsOn = listing.reports
            projects = projects.filter { key in listing.projects.contains { $0.key == key } }
            inboxProblem = nil
            parts?.notifier.shown(listing)
            if box == .archived { await loadArchived() }
            writeNext()
        } catch {
            inboxProblem = Self.words(error)
        }
        if let account = try? await client.account(), client.pairing == pairing { self.account = account }
        if who == nil, let me = try? await client.me(), client.pairing == pairing { who = me.who }
        // Whether this person has an agent decides the inbox's card, so it is asked once.
        if agentsOn, agentList == nil { await refreshAgents() }
        if sweptFor != client.pairing, client.pairing == pairing {
            sweptFor = client.pairing
            sweepReports()
        }
    }

    // MARK: Agents

    /// The code on show, while it still works.
    func liveCode(at now: Date = Date()) -> AgentCode? { agentCode.flatMap { $0.expiresAt > now ? $0 : nil } }

    /// Whether the inbox shows the card that offers to connect one.
    var offersAgent: Bool {
        box == .inbox && query.isEmpty && detail != .agents && AgentWords.offer(supported: agentsOn, list: agentList, dismissed: agentOfferHidden)
    }

    func hideAgentOffer() {
        agentOfferHidden = true
        UserDefaults.standard.set(true, forKey: "agents.offerHidden")
        show("Put away. Agents is in the menu when you want it.")
    }

    /// Agents, from the menu or the inbox's card; `withCode` asks for a code at once, as pressing the card's key means.
    func openAgents(withCode: Bool) {
        drawerOpen = false
        agentProblem = nil
        detail = .agents
        Task {
            await refreshAgents()
            if withCode, liveCode() == nil { await askCode() }
        }
    }

    func refreshAgents() async {
        guard agentsOn, let client else { return }
        guard let list = try? await client.agents(), client.pairing == pairing else { return }
        // A code that has been used shows no longer: the list has someone new in it.
        if let before = agentList, list.agents.contains(where: { agent in !before.agents.contains { $0.id == agent.id } }) { agentCode = nil }
        agentList = list
    }

    /// Asks the receiver for a code. Never while recording: the code would be in the recording. It is never logged.
    func askCode() async {
        guard let client else { agentProblem = "Pair this headset first."; return }
        if isRecording { agentProblem = "Stop the recording first: a code on screen would be in it."; return }
        if let list = agentList, list.full { agentProblem = AgentWords.full(list); return }
        guard !askingCode else { return }
        askingCode = true
        agentProblem = nil
        defer { askingCode = false }
        do {
            let code = try await client.agentCode()
            guard client.pairing == pairing else { return }
            agentCode = code
        } catch {
            agentProblem = AgentWords.problem(error, list: agentList)
        }
    }

    func disconnectAgent(_ agent: ConnectedAgent) {
        guard let client else { return }
        Task {
            do {
                try await client.disconnectAgent(agent.id)
                agentProblem = nil
                await refreshAgents()
                show("\(agent.label) is disconnected.")
            } catch {
                show("Not disconnected: \(Self.words(error))")
            }
        }
    }

    private func loadArchived() async {
        guard let client else { return }
        do {
            archivedThreads = try await client.listing(archived: true).threads
            inboxProblem = nil
        } catch {
            inboxProblem = Self.words(error)
        }
    }

    func unpair() {
        parts?.pairing.forget()
        threads = []
        archivedThreads = []
        details = [:]
        projectNames = []
        projectRefs = []
        newProjects = false
        agentsOn = false
        agentList = nil
        agentCode = nil
        agentProblem = nil
        reportsOn = nil
        account = nil
        who = nil
        inboxProblem = nil
        target = .newThread
        detail = nil
    }

    // MARK: The inbox

    var unread: Int { threads.filter(\.unread).count }

    var visibleThreads: [ThreadSummary] {
        let source = box == .archived ? archivedThreads : threads
        let words = query.lowercased().split(separator: " ").map(String.init)
        return source.filter { thread in
            guard projects.isEmpty || projects.contains(thread.project) else { return false }
            // Every word must match somewhere, as the headset's search: title, key, project, snippet, sender, people.
            let haystack = ([thread.title, thread.key, projectName(thread.project), thread.snippet ?? "", thread.last.by.who, thread.last.text]
                            + thread.people.map(\.name) + thread.people.compactMap(\.email)).joined(separator: " ").lowercased()
            return words.allSatisfy { haystack.contains($0) }
        }
    }

    var sectionLine: String {
        let where_ = projects.isEmpty ? "All projects" : projects.sorted().map(projectName).joined(separator: " · ")
        let unreadPart = box == .inbox && unread > 0 ? " · \(unread) unread" : ""
        return "\(box == .archived ? "Archived" : "Inbox")\(unreadPart) · \(where_)"
    }

    var emptyLine: String {
        guard pairing != nil else {
            return "No threads yet. Pair this headset with the receiver (the gear says how) and its threads show here."
        }
        if loading && threads.isEmpty { return "Asking the receiver…" }
        if !query.isEmpty || !projects.isEmpty { return "No threads match." }
        return box == .archived ? "Nothing archived." : "No threads yet. Record with REC or New thread to start one."
    }

    /// Takes on this headset the receiver does not have yet, for the line over the list.
    var waitingTakes: Int {
        runs.filter { run in
            guard let state = parts?.uploads.states[run.name] else { return true }
            return state.phase != .done
        }.count
    }

    func open(_ key: String) {
        drawerOpen = false
        detail = .thread(key)
        Task { await loadThread(key, markRead: true) }
    }

    func loadThread(_ key: String, markRead: Bool) async {
        guard let client else { return }
        do {
            var detail = try await client.thread(key)
            if markRead, detail.unread == true || detail.hasUnseen {
                detail = try await client.markRead(key, seq: detail.seq)
                if let i = threads.firstIndex(where: { $0.key == key }) { threads[i].unread = false; threads[i].fresh = 0 }
                if let i = archivedThreads.firstIndex(where: { $0.key == key }) { archivedThreads[i].unread = false; archivedThreads[i].fresh = 0 }
            }
            if details[key] != detail { details[key] = detail }
            threadProblems[key] = nil
            parts?.notifier.seen(key)
        } catch {
            threadProblems[key] = Self.words(error)
        }
    }

    func title(of key: String) -> String {
        details[key]?.title ?? threads.first { $0.key == key }?.title ?? archivedThreads.first { $0.key == key }?.title ?? key
    }

    func isArchived(_ key: String) -> Bool { details[key]?.state == "closed" || archivedThreads.contains { $0.key == key } }

    func archive(_ key: String) {
        if detail == .thread(key) { detail = nil }
        let reopen = isArchived(key)
        change(key) { client in
            self.details[key] = try await client.archive(key, archived: !reopen)
            self.flash = Flash(text: reopen ? "\(key) is back in the inbox." : "Archived \(key): it is closed for everyone in it.", undo: reopen ? nil : .archive(key))
        }
    }

    func delete(_ key: String) {
        if detail == .thread(key) { detail = nil }
        change(key) { client in
            try await client.hide(key, hidden: true)
            self.flash = Flash(text: "Deleted \(key) from this inbox: it comes back when someone adds to it.", undo: .delete(key))
        }
    }

    func undo(_ undo: Flash.Undo) {
        flash = nil
        switch undo {
        case .archive(let key): change(key) { client in self.details[key] = try await client.archive(key, archived: false) }
        case .delete(let key): change(key) { client in try await client.hide(key, hidden: false) }
        }
    }

    func togglePick(_ key: String, message: Int, launch: Int) {
        change(key) { client in self.details[key] = try await client.pick(key, message: message, launch: launch) }
    }

    func isPicked(_ key: String, message: ThreadMessage, launch: Int) -> Bool { details[key]?.myPick(on: message) == launch }

    func react(_ key: String, message: Int, reaction: String) {
        change(key) { client in self.details[key] = try await client.react(key, message: message, reaction: reaction) }
    }

    func myReaction(_ key: String, on message: ThreadMessage) -> String? { details[key]?.myReaction(on: message) }

    private func change(_ key: String, _ work: @escaping (ReceiverClient) async throws -> Void) {
        guard let client else { return }
        Task {
            do {
                try await work(client)
                self.threadProblems[key] = nil
            } catch {
                let words = Self.words(error)
                self.threadProblems[key] = words
                self.flash = Flash(text: "\(key): \(words)", undo: nil)
            }
            await self.refresh()
        }
    }

    // MARK: Models

    /// A model a launch names, fetched through its thread and checked against its sha256 before the viewer shows
    /// it, kept by its sha256 (the headset's Models.kt). At most eight are kept.
    func model(key: String, sha256: String, bytes: Int) async throws -> URL {
        guard let parts, let pairing else { throw ReceiverError(status: 0, reason: "the headset is not paired") }
        let file = parts.models.appendingPathComponent("\(sha256).glb")
        if Self.matches(file, sha256: sha256, bytes: bytes) {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
            return file
        }
        let request = try ThreadRequests.model(pairing, key: key, sha256: sha256)
        let (download, response) = try await URLSession.shared.download(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            try? FileManager.default.removeItem(at: download)
            throw ReceiverError(status: status, reason: status == 404 ? "the receiver no longer has this model" : "the model could not be fetched")
        }
        guard Self.matches(download, sha256: sha256, bytes: bytes) else {
            try? FileManager.default.removeItem(at: download)
            throw ReceiverError(status: 0, reason: "the model that arrived is not the one the message names")
        }
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: download, to: file)
        try? PrivateFiles.seal(file)
        pruneModels(keeping: file)
        return file
    }

    nonisolated static func matches(_ file: URL, sha256: String, bytes: Int) -> Bool {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue, size == bytes,
              let handle = try? FileHandle(forReadingFrom: file) else { return false }
        let magic = handle.readData(ofLength: 4)
        try? handle.close()
        guard magic == Data("glTF".utf8) else { return false }
        return (try? UploadProtocol.sha256Hex(of: file)) == sha256
    }

    private func pruneModels(keeping: URL) {
        guard let parts else { return }
        let files = (try? FileManager.default.contentsOfDirectory(at: parts.models, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let sorted = files.filter { $0.pathExtension == "glb" }.sorted {
            let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return a > b
        }
        for old in sorted.dropFirst(8) where old != keeping { try? FileManager.default.removeItem(at: old) }
    }

    // MARK: The tape

    var storage: (used: Double?, full: Bool, label: String) {
        if let account { return (account.used, account.full, account.label) }
        let bytes = runs.compactMap { metas[$0.name]?.bytes }.reduce(0, +)
        return (nil, false, runs.isEmpty ? "No takes" : String(format: "%.1f GB here", Double(bytes) / 1_000_000_000))
    }

    // MARK: Helpers

    static func words(_ error: Error) -> String {
        if let error = error as? ReceiverError { return error.description }
        if let error = error as? UploadProtocolError { return error.description }
        return ErrorWords.describe(error)
    }

    static func hardwareModel() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
    }

    /// The events log's last lines, the app's and the extension's, for the settings.
    func recentEvents(_ count: Int) -> [String] {
        var lines = parts?.log.tail(count) ?? []
        if let root = link?.root, let ext = try? EventLog(url: BroadcastShared.events(in: root)) { lines += ext.tail(count / 2).map { "ext " + $0 } }
        return lines
    }
}

/// The deck's control panel at a moment, as plain values (the iPhone's PhonePanel.Readout, with both sounds).
struct DeckReadout: Equatable {
    var recording: Bool
    var ready: Bool
    var uploading: Bool
    var processing: Bool
    var seconds: Int
    var mic: Double
    var app: Double
    var key: RecordKey.Mode
    var keyWord: String?
    var target: String
    var hint: String?
}
