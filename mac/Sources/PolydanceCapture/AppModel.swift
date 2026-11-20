// The app's state and every action the UI can take, on the main actor. Once a second it reads Core
// Audio's process list, asks Arc for its tabs only while Arc holds the microphone (or a call is being
// recorded), and feeds the call detector; the detector's decisions start and stop the Recorder. A saved
// recording goes to the hand-off queue (polycap import, then process), whose progress the menu shows by
// reading the session folder. The main window, the settings and the threads bind to this model and its
// three parts: `calls` (the library's calls and the open call's page), `threads` (the inbox, replies and
// walkthrough uploads) and `permissions`. A walkthrough started from a thread is never imported here: it
// is sent to the thread when it stops (calls never are), and stays in the recordings folder. One cannot
// start while a Meet call is live, and one that catches a call is stopped and kept unsent.
//
// The library is resolved once (the setting, POLYCAP_ROOT, polycap's env file, ~/PolydanceCapture) and
// every polycap the app runs is given it, so the two never use different ones. Hand-offs an earlier run
// did not finish are shown at launch from the ledger (`attention`), with Retry or Finish building; one
// whose polycap the app left running when it quit is shown as still running until that polycap ends.
import AppKit
import CoreAudio
import Foundation
import Observation
import PolydanceCore
import PolydanceShared

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case watching, recording, building }

    struct ArcState: Equatable {
        var running = false
        var micActive = false
        var playing = false
        var meetingCode: String?
        /// Why Arc's tabs could not be read, when they could not (Automation off, no answer).
        var tabsProblem: String?
        /// Arc has held the microphone for 20 s and no call was found, so nothing is recording.
        var withoutCall: MicWithoutCallWatch.Warning?
    }

    struct LiveRecording: Equatable {
        var mode: RecordingMode
        var automatic: Bool
        var startedAt: Date
        var elapsed: TimeInterval = 0
        var micBars = 0
        var appBars = 0
        var status = Recorder.Status()
        var marks: [Int] = []
        var farEndSilent = false
        /// The microphone has given only silence since the start (a virtual or muted input), with its name.
        var micSilent = false
        var micDevice: String?
        /// C15: little free space, with what to do; nil while there is room.
        var diskWarning: String?
        var told: ToldOthers = .unknown
        var stopping = false
        /// Set when this walkthrough is a reply in a thread: it is uploaded when it stops.
        var thread: WalkthroughTarget?
    }

    /// What the building view shows for the recording being handed over.
    struct Building: Equatable {
        var job: HandoffJobState
        var saved: Saved?
        var session: SessionInfo?
        var hookRuns: HookRuns?
        var readProblem: String?
    }

    struct Saved: Equatable {
        var mode: RecordingMode
        var startedAt: Date
        var seconds: Double
        var bytes: Int64
        var tracks: Int
        var stopReason: CallStopReason?
    }

    // Dependencies, for the views and the next part.
    let settings: SettingsStore
    let runner: PolycapRunner
    let appBuild: AppBuildInfo
    private(set) var layout: LibraryLayout
    @ObservationIgnored let notifier = Notifier()

    // State the views read.
    private(set) var arc = ArcState()
    private(set) var live: LiveRecording?
    private(set) var handoff = HandoffSnapshot()
    private(set) var building: Building?
    private(set) var recent: [RecentRecording] = []
    private(set) var install: PolycapInstall?
    private(set) var installProblem: String?
    private(set) var hotkeyProblems: [String] = []
    /// Hand-offs from an earlier run that did not finish, from the ledger, until a job for each starts.
    private(set) var attention: [Attention] = []
    /// Why polycap's env file could not be read, when it could not (the library was resolved without it).
    private(set) var libraryProblem: String?
    /// macOS is not drawing the menu-bar icon because the menu bar is full (C5): the window says so.
    private(set) var menuBarIconHidden = false
    /// The hooks file polycap reads (POLYCAP_HOOKS in its env file, else the default), for the settings.
    private(set) var hooksFile: URL

    struct Attention: Identifiable, Equatable {
        var item: HandoffAttention
        /// The polycap working on it when the app last quit is still running.
        var running: Bool
        var id: String { item.id }
    }
    /// The last thing that went wrong, until dismissed.
    var lastError: String?
    /// Mirror the settings so views update when they change; each write goes through the store's checks.
    var autoRecordMeet: Bool { didSet { settings.autoRecordMeet = autoRecordMeet } }
    var notifyOnStart: Bool { didSet { settings.notifyOnStart = notifyOnStart } }
    var warnWithoutCall: Bool { didSet { settings.warnWithoutCall = warnWithoutCall } }
    /// Read by the next recording, not the one in progress.
    var excludedApps: [String] { didSet { settings.excludedApps = excludedApps; if settings.excludedApps != excludedApps { excludedApps = settings.excludedApps } } }
    var fps: Int { didSet { settings.fps = fps; if settings.fps != fps { fps = settings.fps } } }
    var transcriber: Transcriber { didSet { settings.transcriber = transcriber } }
    /// A launch's Mic and Mac sound switches, read by the next walkthrough (a call records both).
    var walkthroughMic: Bool { didSet { settings.walkthroughMic = walkthroughMic } }
    var walkthroughMacSound: Bool { didSet { settings.walkthroughMacSound = walkthroughMacSound } }
    var walkthroughSounds: WalkthroughSounds { WalkthroughSounds(mic: walkthroughMic, macSound: walkthroughMacSound) }

    // The main window's parts and what it shows.
    let calls = CallsModel()
    let threads = ThreadsModel()
    let permissions = PermissionsModel()
    var selection: MainSelection?
    /// The main window's column: its calls, or its threads (folder tabs, 2026-11-16).
    var windowTab: MenuTab = .calls
    /// New thread or the report, over the main window.
    var plate: WindowPlate?
    /// The menu's tab: the recent calls or the threads.
    var menuTab: MenuTab = .calls

    /// Set by the views, which hold SwiftUI's openWindow and openSettings actions.
    @ObservationIgnored var openMainWindow: (() -> Void)?
    @ObservationIgnored var openSettings: (() -> Void)?

    var phase: Phase { live != nil ? .recording : handoff.current != nil ? .building : .watching }

    @ObservationIgnored private var detector = CallDetector()
    @ObservationIgnored private var micWithoutCall = MicWithoutCallWatch()
    @ObservationIgnored private var recorder: Recorder?
    /// The thread the recording in progress answers, if it was started from one.
    @ObservationIgnored private var recorderThread: WalkthroughTarget?
    /// Choosing what a walkthrough records by pointing at it, and the red frame round it while it records.
    @ObservationIgnored private let picker = ScreenPicker()
    @ObservationIgnored private let recordingFrame = RecordingFrame()
    @ObservationIgnored private var queue: HandoffQueue!
    @ObservationIgnored private let tabs = ArcTabReader()
    @ObservationIgnored private let hotkeys = Hotkeys()
    @ObservationIgnored private var tick: Timer?
    @ObservationIgnored private var meters: Timer?
    /// C15: free space while recording, looked at every 30 s.
    @ObservationIgnored private var diskCheck: Timer?
    @ObservationIgnored private var disk = DiskSpaceWatch()
    @ObservationIgnored private var buildingPoll: Timer?
    @ObservationIgnored private var processes: [AudioProcessInfo] = []
    @ObservationIgnored private var lastObservation: CallObservation?
    @ObservationIgnored private var saved: [String: Saved] = [:]
    @ObservationIgnored private var quitting = false
    /// Who else is waiting for the stop already in flight (quitting while a stop runs).
    @ObservationIgnored private var stopWaiters: [() -> Void] = []
    @ObservationIgnored private var orphanPoll: Timer?
    @ObservationIgnored private var menuBarCheck: Timer?
    @ObservationIgnored private var menuBarWatch = MenuBarWatch()
    @ObservationIgnored private var readingMenuBar = false
    /// A call the detector started while the previous recording was still being saved: it starts as soon
    /// as that one is done, so a quick rejoin is not missed.
    @ObservationIgnored private var pendingCallStart: Bool?

    init(settings: SettingsStore = SettingsStore(), environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.settings = settings
        runner = PolycapRunner(settings: settings)
        appBuild = AppBuildInfo.from(infoDictionary: Bundle.main.infoDictionary)
        let home = FileManager.default.homeDirectoryForCurrentUser
        let resolved = LibraryLayout.resolveForApp(setting: settings.libraryRoot, environment: environment, home: home)
        layout = resolved.layout
        libraryProblem = resolved.problem.map { "polycap's env file could not be read, so the library is \(resolved.layout.root.path): \($0)" }
        let envFile = (try? PolycapEnvFile.read(PolycapEnvFile.path(environment: environment, home: home), keys: ["POLYCAP_HOOKS"])) ?? [:]
        hooksFile = HooksFileExample.path(envFile: envFile, home: home)
        runner.libraryRoot = resolved.layout.root.path
        autoRecordMeet = settings.autoRecordMeet
        notifyOnStart = settings.notifyOnStart
        warnWithoutCall = settings.warnWithoutCall
        excludedApps = settings.excludedApps
        fps = settings.fps
        walkthroughMic = settings.walkthroughMic
        walkthroughMacSound = settings.walkthroughMacSound
        transcriber = settings.transcriber
        queue = makeQueue()
        calls.app = self
        threads.app = self
        permissions.app = self
    }

    private func makeQueue() -> HandoffQueue {
        HandoffQueue(worker: PolycapHandoffWorker(runner: runner, layout: layout), ledgerURL: layout.handoffLedger) { [weak self] snapshot in
            Task { @MainActor in self?.handoffChanged(snapshot) }
        }
    }

    // MARK: Lifecycle

    func start() {
        notifier.configure()
        notifier.onAction = { [weak self] action in
            MainActor.assumeIsolated {
                switch action {
                case .stop: self?.stopAndSave()
                case .discard: self?.stopAndDiscard()
                case .open: self?.openMainWindow?()
                }
            }
        }
        hotkeys.register([
            .recordOrStop: { [weak self] in MainActor.assumeIsolated { self?.recordNowOrStop() } },
            .mark: { [weak self] in MainActor.assumeIsolated { _ = self?.mark() } },
        ])
        hotkeyProblems = hotkeys.problems
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.watch() }
        }
        tick?.tolerance = 0.2
        menuBarCheck = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkMenuBar() }
        }
        menuBarCheck?.tolerance = 1
        locatePolycap()
        threads.start()
        recoverRecordings()
        refreshRecent()
    }

    /// Whether macOS draws the menu-bar icon. A full menu bar hides it with no word to the app, and then
    /// nothing shows that a call is recording but the start notification, so this says so, once a run.
    private func checkMenuBar() {
        guard !readingMenuBar else { return }
        readingMenuBar = true
        Task.detached(priority: .utility) {
            let state = MenuBarReader.iconState()
            await MainActor.run { self.menuBarRead(state) }
        }
    }

    /// Internal so the window tests can say the icon is hidden.
    func menuBarRead(_ state: MenuBarIconState) {
        readingMenuBar = false
        switch menuBarWatch.observe(state) {
        case .becameHidden(let notify):
            menuBarIconHidden = true
            if notify {
                notifier.notice(id: "menu-bar-hidden", title: "Polydance's icon is hidden",
                                body: "The menu bar is full, so macOS isn't showing it, and you won't see when a call is recording. "
                                    + "Click here, or open the app again, to see its window.")
            }
        case .becameShown:
            menuBarIconHidden = false
            notifier.clear(id: "menu-bar-hidden")
        case nil:
            break
        }
    }

    /// Called when the settings change the library folder.
    func reloadLayout() {
        let resolved = LibraryLayout.resolveForApp(setting: settings.libraryRoot, environment: ProcessInfo.processInfo.environment,
                                                   home: FileManager.default.homeDirectoryForCurrentUser)
        guard resolved.layout != layout, recorder == nil, !handoff.isBusy else { return }
        layout = resolved.layout
        runner.libraryRoot = layout.root.path
        queue = makeQueue()
        refreshRecent()
    }

    func locatePolycap(refresh: Bool = false) {
        let runner = self.runner
        locating(Task.detached(priority: .utility) { Result { try runner.install(refresh: refresh) } })
    }

    /// The settings' "Detect again": forget the stored paths and ask the login shell afresh.
    func redetectPolycap() {
        let runner = self.runner
        locating(Task.detached(priority: .utility) { Result { try runner.rediscover() } })
    }

    /// Paths chosen by hand in the settings.
    func usePolycap(node: String, polycap: String) {
        let runner = self.runner
        locating(Task.detached(priority: .utility) { Result { try runner.use(node: node, polycap: polycap) } })
    }

    private(set) var locatingPolycap = false

    private func locating(_ task: Task<Result<PolycapInstall, Error>, Never>) {
        locatingPolycap = true
        Task {
            switch await task.value {
            case .success(let found): install = found; installProblem = nil
            case .failure(let error): install = nil; installProblem = "\(error)"
            }
            locatingPolycap = false
        }
    }

    /// The app is quitting: a recording in progress is finished and saved, and handed over at the next
    /// launch (its ledger entry is missing, which is how a recording not handed over is found).
    func prepareToQuit(_ done: @escaping () -> Void) {
        quitting = true
        tick?.invalidate()
        guard let recorder else {
            Task { @MainActor in done() }
            return
        }
        let reason: CallStopReason?
        if case .call = recorder.request.mode {
            if case .stop(let why, _, _)? = detector.appQuitting(at: now) { reason = why } else { reason = .appQuit }
        } else {
            reason = nil
        }
        finishRecording(reason: reason, discard: false, then: done)
    }

    // MARK: Watching (once a second)

    private var now: Double { ProcessInfo.processInfo.systemUptime }

    private func watch() {
        let at = now
        processes = (try? CoreAudioProcesses.read()) ?? []
        let mic = ArcBrowser.usingMicrophone(processes)
        arc.micActive = mic
        arc.playing = ArcBrowser.playingSound(processes)
        arc.running = ArcTabReader.arcIsRunning
        let needTabs = mic || detector.currentCall != nil
        if needTabs {
            let asked = tabs.read { [weak self] reading in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    // Stamped when Arc answered, with the latest mic reading, so the detector's clock only runs forward.
                    self.observe(CallObservation(at: max(self.now, self.lastObservation?.at ?? 0), micActive: self.arc.micActive,
                                                 meetingCodes: reading.meetingCodes), reading)
                }
            }
            // A question still waiting (Arc busy, or the Automation prompt up) must not stop the clock: the
            // mic rule keeps working, and unknown tabs count as unchanged.
            if !asked { observe(CallObservation(at: at, micActive: mic, meetingCodes: nil), nil) }
        } else {
            arc.meetingCode = nil
            observe(CallObservation(at: at, micActive: mic, meetingCodes: nil), nil)
        }
    }

    private func observe(_ observation: CallObservation, _ reading: TabReading?) {
        guard !quitting else { return }
        if let last = lastObservation, observation.at < last.at { return }
        lastObservation = observation
        if let reading {
            if case .failed(let why) = reading { arc.tabsProblem = why } else { arc.tabsProblem = nil }
            if let codes = reading.meetingCodes { arc.meetingCode = codes.first }
        }
        let walkthrough = recorder.map { $0.request.mode == .walkthrough } ?? false
        // A reply for a thread that catches a call stops there and is not sent; a local walkthrough goes on.
        if recorderThread != nil, live?.stopping != true, ThreadReplyGuard.callStarted(observation) {
            finishRecording(reason: nil, discard: false, callDuringReply: true)
        }
        if let event = detector.observe(observation, autoRecord: autoRecordMeet, otherRecording: walkthrough) {
            handle(event, automatic: true)
        }
        watchMicWithoutCall(observation, reading)
        if let recorder, recorder.micTick() {
            live?.micSilent = true
            let device = recorder.micDeviceName ?? "The default input"
            notifier.notice(id: "mic-silent", title: "Polydance hears nothing from the microphone",
                            body: "\(device) has given only silence for 10 s. If it is not your microphone, stop, choose yours in System Settings → Sound → Input, and record again.")
        }
        if let recorder, case .call = recorder.request.mode, recorder.farEndTick(appPlaying: arc.playing) {
            live?.farEndSilent = true
            notifier.notice(id: "far-end-silent", title: "Polydance hears nothing from Arc",
                            body: "Arc has been playing for 30 s but the recording has only silence. Check System Settings, Privacy & Security, Screen & System Audio Recording.")
        }
    }

    /// Arc holding the microphone while nothing records: a notification once per stretch, and the menu's
    /// line while it lasts. Only while automatic recording is on and nothing is recording or starting.
    private func watchMicWithoutCall(_ observation: CallObservation, _ reading: TabReading?) {
        let watching = autoRecordMeet && recorder == nil && live == nil && pendingCallStart == nil && detector.currentCall == nil
        let warning = micWithoutCall.observe(at: observation.at, micActive: observation.micActive,
                                             tabs: MicWithoutCallWatch.Tabs(reading), watching: watching)
        let before = arc.withoutCall
        arc.withoutCall = micWithoutCall.current
        if let warning, warnWithoutCall {
            let text = warning.text(shortcut: Hotkeys.Shortcut.recordOrStop.label)
            notifier.notice(id: "mic-without-call", title: text.title, body: text.body)
        }
        // Once something records, the notice is out of date; otherwise it stays in Notification Center as
        // the record that this stretch was not recorded.
        if before != nil, !watching { notifier.clear(id: "mic-without-call") }
    }

    private func handle(_ event: DetectorEvent, automatic: Bool) {
        switch event {
        case .start(let code):
            beginRecording(.call(meetingCode: code), automatic: automatic)
        case .stop(let reason, _, _):
            finishRecording(reason: reason, discard: false)
        }
    }

    // MARK: Actions

    /// ⌃⌥R and "Record now": stops a recording, or records the live call (even with automatic recording
    /// off), or records a walkthrough when there is no call.
    func recordNowOrStop() {
        if live != nil { stopAndSave(); return }
        // Pressed again while choosing the screen: record what is lit.
        if picker.isShowing { picker.confirm(); return }
        let codes = lastObservation?.meetingCodes ?? arc.meetingCode.map { [$0] }
        let observation = CallObservation(at: max(now, lastObservation?.at ?? 0), micActive: arc.micActive, meetingCodes: codes)
        if let event = detector.startByUser(observation) { handle(event, automatic: false) }
        else { chooseScreen(for: "a walkthrough") { [weak self] screen in self?.beginRecording(.walkthrough, automatic: false, screen: screen) } }
    }

    /// Before a walkthrough: the layer that asks which display or window to record (ScreenPicker), the last
    /// choice lit first. Without the screen permission there is no picture to choose, so it starts at once.
    private func chooseScreen(for purpose: String, then start: @escaping (ScreenTarget?) -> Void) {
        guard !picker.isShowing else { return }
        guard ScreenSource.allowed else { start(nil); return }
        picker.show(purpose: purpose, remembered: settings.walkthroughScreen) { [weak self] chosen in
            guard let self, let chosen else { return }
            self.settings.walkthroughScreen = chosen
            start(chosen)
        }
    }

    func stopAndSave() { stop(discard: false) }

    /// Stops and removes what this recording wrote (its video and metadata), and never imports it.
    func stopAndDiscard() { stop(discard: true) }

    private func stop(discard: Bool) {
        guard let recorder else { return }
        if case .call = recorder.request.mode {
            let reason: CallStopReason
            if case .stop(let why, _, _)? = detector.stopByUser(at: now) { reason = why } else { reason = .user }
            finishRecording(reason: reason, discard: discard)
        } else {
            finishRecording(reason: nil, discard: discard)
        }
    }

    /// ⌃⌥M and "Mark this moment".
    @discardableResult
    func mark(note: String? = nil) -> Bool {
        guard let recorder, recorder.mark(note: note) else { return false }
        refreshLive()
        return true
    }

    /// PV2: whether the others were told.
    func setTold(_ told: ToldOthers) {
        recorder?.told = told
        live?.told = told
    }

    func dismissError() { lastError = nil }

    func openLibrary() {
        if let openMainWindow { openMainWindow(); return }
        NSWorkspace.shared.open(layout.root)
    }

    /// Opens the main window on a call's page.
    func showCall(_ id: String) {
        selection = .call(id)
        windowTab = .calls
        openLibrary()
    }

    /// Opens the main window on a thread.
    func showThread(_ key: String) {
        selection = .thread(key)
        windowTab = .threads
        openLibrary()
    }

    /// Opens the main window on its threads, where new threads and reports wait until they are sent.
    func showThreads() {
        windowTab = .threads
        openLibrary()
    }

    /// "Record and open" and "Record a reply": a walkthrough that is sent to the thread when it
    /// stops, then the launch's links, in Arc when it is installed, else the default browser. New thread's
    /// and the bug key's recordings start here too, opening nothing. Returns why it could not start.
    func startThreadReply(_ target: WalkthroughTarget, opening links: [URL]) -> String? {
        if let problem = threadReplyProblem(target) { return problem }
        chooseScreen(for: target.what) { [weak self] screen in
            guard let self else { return }
            // Asked again: a call may have started, or a recording, while the screen was being chosen.
            if let problem = self.threadReplyProblem(target) { self.report("\(target.title) did not start: \(problem)"); return }
            let before = self.lastError
            self.beginRecording(.walkthrough, automatic: false, thread: target, screen: screen)
            guard self.live != nil else {
                if self.lastError == before { self.report("\(target.title) did not start.") }
                return
            }
            guard !links.isEmpty else { return }
            // A moment for the capture to start, so the page is on the recording as it loads.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.open(links) }
        }
        return nil
    }

    /// Why a walkthrough for a thread cannot start now, or nil.
    private func threadReplyProblem(_ target: WalkthroughTarget) -> String? {
        guard live == nil, recorder == nil else { return "Something is being recorded already; stop it first." }
        let watching: Bool
        if case .watching = detector.state { watching = true } else { watching = false }
        if let problem = ThreadReplyGuard.problem(arcMicActive: arc.micActive, meetingCode: arc.meetingCode, detectorWatching: watching) { return problem }
        do { try target.validate() } catch { return "\(error)" }
        return nil
    }

    /// The launch's links, in Arc when it is installed, else the default browser: after Record and open
    /// starts recording, or at once for Just open.
    func open(_ links: [URL]) {
        guard !links.isEmpty else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        if let arc = NSWorkspace.shared.urlForApplication(withBundleIdentifier: ArcBrowser.bundleID) {
            NSWorkspace.shared.open(links, withApplicationAt: arc, configuration: configuration) { [weak self] _, error in
                guard let error else { return }
                Task { @MainActor in self?.report("Arc did not open the link: \(error.localizedDescription)") }
            }
        } else {
            for link in links { NSWorkspace.shared.open(link) }
        }
    }

    func reveal(_ dir: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([dir])
    }

    /// Retry, or Finish building: hands a recording over again (the user asked: nothing retries by
    /// itself). What it does is decided from an explicit read of the ledger and the library, and fails
    /// closed: an unreadable ledger retries nothing, a processed recording is not imported again, an
    /// import that finished after the app quit is processed rather than imported twice, and a polycap the
    /// app left running is not raced.
    func retryHandoff(_ files: RecordingFiles) {
        if let running = attention.first(where: { $0.item.files == files }), running.running {
            report("polycap is still working on \(files.baseName) (it was started before the app last quit); wait for it to finish.")
            return
        }
        let decision: HandoffRetry.Decision
        do { decision = try HandoffRetry.decide(for: files, ledgerURL: layout.handoffLedger, sessions: layout.sessions) } catch {
            report("The hand-off ledger could not be read, so nothing was retried: \(error)")
            return
        }
        switch decision {
        case .run(let kind):
            attention.removeAll { $0.item.files == files }
            enqueue(HandoffJob(files: files, kind: kind))
        case .alreadyProcessed(let id):
            attention.removeAll { $0.item.files == files }
            let queue = self.queue!
            Task { await queue.dismiss(id: files.videoName) }
            lastError = "\(files.baseName) was already processed\(id.map { " as \($0)" } ?? ""), so nothing was retried."
        case .ambiguous(let ids):
            report("\(files.baseName) was imported more than once (\(ids.joined(separator: ", "))), so nothing was retried. Process the one you keep with polycap process <id>.")
        }
    }

    /// The call page's Finish building: the recording that became this session, from the ledger.
    func recording(forSession id: String) -> RecordingFiles? {
        guard let ledger = try? HandoffLedger.load(from: layout.handoffLedger) else { return nil }
        return ledger.recordings.first { $0.value.sessionId == id }.flatMap {
            RecordingFiles.forVideo(layout.recordings.appendingPathComponent($0.key), in: layout.recordings)
        }
    }

    /// Whether polycap from an earlier run is still working on this session.
    func isStillRunning(session id: String) -> Bool {
        attention.contains { $0.running && $0.item.entry.sessionId == id }
    }

    func setLaunchAtLogin(_ on: Bool) {
        do { try LoginItem.setEnabled(on) } catch { lastError = "Open at login could not be changed: \(error.localizedDescription)" }
    }

    // MARK: Recording

    private func beginRecording(_ mode: RecordingMode, automatic: Bool, thread: WalkthroughTarget? = nil, screen: ScreenTarget? = nil) {
        guard !quitting else { return }
        guard recorder == nil else {
            if case .call = mode { pendingCallStart = automatic }
            return
        }
        let target: ProcessTapSource.Target?
        let micChoice: MicSource.Choice?
        var callWindow: (@Sendable () async -> CallWindow.Finding)?
        switch mode {
        case .call(let code):
            target = .processes(ArcBrowser.tapTargets(processes))
            micChoice = .arcInput
            // Only the Arc window showing the call is recorded (Robin, 2026-11-17), found as it starts.
            let tabs = self.tabs
            callWindow = {
                let reading = await tabs.readWindows()
                let arc = Set(NSRunningApplication.runningApplications(withBundleIdentifier: ArcBrowser.bundleID).map(\.processIdentifier))
                return CallWindow.find(code: code, reading: reading, windows: ScreenSource.windowList(), arcPIDs: arc)
            }
        case .walkthrough:
            // The launch's Mic and Mac sound switches, as on the headset; a call never reads them.
            let sounds = settings.walkthroughSounds
            target = sounds.macSound ? .allExcept(CoreAudioProcesses.objectID(forPID: getpid()).map { [$0] } ?? []) : nil
            micChoice = sounds.mic ? .systemDefault : nil
        }
        let request = Recorder.Request(mode: mode, files: RecordingFiles.next(in: layout.recordings, at: Date()), layout: layout,
                                       excludedApps: settings.excludedApps, fps: settings.fps, appBuild: appBuild, tapTarget: target,
                                       micChoice: micChoice, screen: screen, callWindow: callWindow)
        if let thread, let problem = threads.recordingStarting(request.files, thread) {
            report("\(thread.title) did not start: \(problem)")
            return
        }
        let recorder = Recorder(request)
        recorder.onStatus = { [weak self] _ in MainActor.assumeIsolated { self?.refreshLive() } }
        recorder.onFailure = { [weak self] message in MainActor.assumeIsolated { self?.recordingFailed(message) } }
        do { try recorder.start() } catch {
            detector.captureFailed(at: now)
            if thread != nil { threads.recordingGone(request.files) }
            report("The recording could not start: \(error)")
            return
        }
        self.recorder = recorder
        recorderThread = thread
        live = LiveRecording(mode: mode, automatic: automatic, startedAt: recorder.startedAt, thread: thread)
        if let screen { recordingFrame.show(screen, startedAt: recorder.startedAt) }
        if automatic, settings.notifyOnStart, case .call(let code) = mode { notifier.callStarted(meetingCode: code) }
        meters = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshLive() }
        }
        disk = DiskSpaceWatch()
        checkDisk()
        diskCheck = Timer.scheduledTimer(withTimeInterval: DiskSpaceWatch.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkDisk() }
        }
    }

    /// C15: free space on the library's disk, at the start and while recording. Once a recording, when it
    /// is low enough that macOS may clear space (which stopped the screen on 2026-11-11), a notification;
    /// the menu says it while it lasts.
    private func checkDisk() {
        guard live != nil, let free = DiskSpaceWatch.freeBytes(atPath: layout.root.path) else { return }
        if disk.observe(freeBytes: free), let warning = disk.warning {
            notifier.notice(id: "disk-low", title: "Little space left on this Mac", body: warning)
        }
        if live?.diskWarning != disk.warning { live?.diskWarning = disk.warning }
    }

    /// The writer failed mid-recording (a full disk): keep what was written, hand it over marked cut.
    private func recordingFailed(_ message: String) {
        report("The recording stopped: \(message)")
        detector.captureFailed(at: now)
        finishRecording(reason: nil, discard: false)
    }

    /// `callDuringReply`: a thread's reply caught a Meet call, so it is saved and not sent.
    private func finishRecording(reason: CallStopReason?, discard: Bool, callDuringReply: Bool = false, then done: (() -> Void)? = nil) {
        guard let recorder else { done?(); return }
        // A stop is already running: wait for it, so quitting never exits before the file is finished
        // (or a discard has removed it).
        guard live?.stopping != true else {
            if let done { stopWaiters.append(done) }
            return
        }
        live?.stopping = true
        recordingFrame.hide()
        let mode = recorder.request.mode
        let thread = recorderThread
        recorder.stop(reason: reason, discard: discard) { [weak self] result in
            MainActor.assumeIsolated {
                guard let self else { done?(); return }
                self.recorder = nil
                self.recorderThread = nil
                self.live = nil
                self.meters?.invalidate()
                self.meters = nil
                self.diskCheck?.invalidate()
                self.diskCheck = nil
                self.notifier.clear(id: "call-started")
                switch result {
                case .success(let outcome?):
                    self.saved[outcome.files.videoName] = Saved(mode: mode, startedAt: recorder.startedAt, seconds: outcome.seconds, bytes: outcome.bytes,
                                                                tracks: outcome.trackCount,
                                                                stopReason: reason)
                    if let thread {
                        // A thread's walkthrough is sent, never imported; while quitting, the next launch offers
                        // to send it; one that caught a call waits, with why, for the user.
                        self.threads.recordingSaved(outcome.files, thread, send: !self.quitting && !callDuringReply,
                                                    note: callDuringReply ? ThreadReplyGuard.stoppedNote : nil)
                        if callDuringReply {
                            self.notifier.notice(id: "reply-\(outcome.files.baseName)", title: "\(thread.title) was not sent",
                                                 body: "A Meet call started while it was recording. It is kept on this Mac; open \(thread.kind == .reply ? "the thread" : "Threads in Polydance") to decide.")
                        }
                    } else if !self.quitting {
                        // While quitting, the next launch hands it over (an import cut off by quitting could run twice).
                        self.enqueue(HandoffJob(files: outcome.files))
                    }
                case .success(nil):
                    if thread != nil { self.threads.recordingGone(recorder.request.files) }
                case .failure(let error):
                    if thread != nil, !FileManager.default.fileExists(atPath: recorder.request.files.video.path) { self.threads.recordingGone(recorder.request.files) }
                    self.report("The recording could not be saved: \(error)")
                }
                self.refreshRecent()
                if let automatic = self.pendingCallStart, !self.quitting {
                    self.pendingCallStart = nil
                    if let call = self.detector.currentCall { self.beginRecording(.call(meetingCode: call.meetingCode), automatic: automatic) }
                }
                done?()
                let waiters = self.stopWaiters
                self.stopWaiters = []
                waiters.forEach { $0() }
            }
        }
    }

    private func refreshLive() {
        guard let recorder, var next = live else { return }
        next.elapsed = Date().timeIntervalSince(recorder.startedAt)
        next.micBars = AudioLevel.bars(rms: recorder.micMeter.current)
        next.appBars = AudioLevel.bars(rms: recorder.appMeter.current)
        next.status = recorder.status
        next.marks = recorder.markClocks
        next.farEndSilent = recorder.farEndWarning
        next.micSilent = recorder.micSilentWarning
        next.micDevice = recorder.micDeviceName
        // C14: the screen stopped and will not be started again; said once, as the sound goes on.
        if let gone = next.status.screenGone, live?.status.screenGone == nil {
            notifier.notice(id: "screen-gone", title: "The screen is no longer being recorded", body: gone)
        }
        // The far end was heard after all: the warning and its notice go.
        if live?.farEndSilent == true, !next.farEndSilent { notifier.clear(id: "far-end-silent") }
        if live?.micSilent == true, !next.micSilent { notifier.clear(id: "mic-silent") }
        if next != live { live = next }
    }

    /// The menu-bar clock while recording: 12:41 or 1:02:41.
    var menuBarClock: String? {
        live.map { Recorder.clock($0.elapsed) }
    }

    // MARK: Hand-off

    private func enqueue(_ job: HandoffJob) {
        let queue = self.queue!
        Task { await queue.enqueue(job) }
    }

    /// Recordings saved but never handed over (the app quit or crashed first) go to the queue at launch;
    /// metadata that never got its clean stop is finished as cut first. Nothing is deleted.
    private func recoverRecordings() {
        let ledger: HandoffLedger
        let uploads: UploadLedger
        do {
            ledger = try HandoffLedger.load(from: layout.handoffLedger)
            uploads = try UploadLedger.load(from: layout.uploadLedger)
        } catch {
            report("A ledger could not be read, so no recording was handed over: \(error)")
            return
        }
        attention = ledger.needingAttention(in: layout.recordings).map { Attention(item: $0, running: Self.stillRunning($0)) }
        settleAttention()
        if attention.contains(where: \.running) { watchOrphans() }
        // Walkthroughs for threads are in the upload ledger: they are sent from the thread, never imported.
        for files in ledger.notHandedOver(in: layout.recordings) where uploads.recordings[files.videoName] == nil {
            do {
                let meta = try RecordingMeta.decode(try Data(contentsOf: files.meta))
                if meta.call != nil, meta.call?.endedAt == nil {
                    let written = (try? FileManager.default.attributesOfItem(atPath: files.video.path)[.modificationDate] as? Date) ?? Date()
                    try PrivateFiles.write(try RecordingFacts.recovered(meta, lastWrite: written).encoded(), to: files.meta)
                }
                enqueue(HandoffJob(files: files))
            } catch {
                report("\(files.videoName) was not handed over: its metadata could not be read (\(error)). It was left as it is.")
            }
        }
    }

    /// The polycap an earlier run left working on this hand-off, if it is still running: recognised by its
    /// arguments (the recording's file for an import, the session for a process), never by pid alone.
    private static func stillRunning(_ item: HandoffAttention) -> Bool {
        guard let pid = item.entry.pid else { return false }
        switch item.entry.status {
        case .importing: return PolycapProcess.isRunning(pid: pid, mentioning: item.files.video.path)
        case .imported: return item.entry.sessionId.map { PolycapProcess.isRunning(pid: pid, mentioning: $0) } ?? false
        case .importFailed, .processFailed, .processed: return false
        }
    }

    /// Hand-offs whose outcome can be read from the library now: an import that was cut off but made its
    /// session is processed (seam-6: never imported twice), and a process left running that has finished
    /// building is recorded processed. The rest wait for the user.
    private func settleAttention() {
        for entry in attention where !entry.running {
            let item = entry.item
            switch item.entry.status {
            case .importing:
                if case .run(let kind)? = try? HandoffRetry.decide(for: item.files, ledgerURL: layout.handoffLedger, sessions: layout.sessions),
                   case .processOnly = kind {
                    attention.removeAll { $0.id == item.id }
                    enqueue(HandoffJob(files: item.files, kind: kind))
                }
            case .imported where item.entry.pid != nil:
                // Its polycap ended by itself after the app quit: built, or cut off part way.
                guard let dir = item.entry.sessionDir, let session = try? SessionInfo.load(from: URL(fileURLWithPath: dir)), !session.isBuilding else { continue }
                let queue = self.queue!
                let settled = HandoffLedger.Entry(status: .processed, sessionId: item.entry.sessionId, sessionDir: dir, at: MetaTime.format(Date()))
                attention.removeAll { $0.id == item.id }
                Task { try? await queue.settle(item.files, as: settled) }
            default:
                continue
            }
        }
    }

    /// Every 5 s while a polycap from an earlier run is still working on a hand-off.
    private func watchOrphans() {
        guard orphanPoll == nil else { return }
        orphanPoll = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                var changed = false
                for index in self.attention.indices where self.attention[index].running && !Self.stillRunning(self.attention[index].item) {
                    self.attention[index].running = false
                    changed = true
                }
                if changed { self.settleAttention(); self.refreshRecent() }
                if !self.attention.contains(where: \.running) { self.orphanPoll?.invalidate(); self.orphanPoll = nil }
            }
        }
    }

    private func handoffChanged(_ snapshot: HandoffSnapshot) {
        let finishedBefore = handoff.finished.first?.id
        handoff = snapshot
        // A recording being handed over now is no longer waiting from an earlier run.
        let active = Set(([snapshot.current?.id].compactMap { $0 }) + snapshot.queued.map(\.id))
        if attention.contains(where: { active.contains($0.id) }) { attention.removeAll { active.contains($0.id) } }
        if let error = snapshot.ledgerError { lastError = "The hand-off ledger could not be written: \(error)" }
        if let latest = snapshot.finished.first, latest.id != finishedBefore, case .failed(let message, _, _) = latest.stage {
            notifier.notice(id: "handoff-\(latest.id)", title: "A recording was not processed", body: message)
        }
        if let current = snapshot.current {
            if building?.job.id != current.id { building = Building(job: current, saved: saved[current.id]) } else { building?.job = current }
            pollBuilding()
            if buildingPoll == nil {
                buildingPoll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.pollBuilding() }
                }
            }
        } else {
            buildingPoll?.invalidate()
            buildingPoll = nil
            building = nil
            refreshRecent()
        }
    }

    /// Reads the session folder of the recording being processed: its steps and the routine's runs.
    private func pollBuilding() {
        guard let job = building?.job, case .processing(_, let dir) = job.stage else { return }
        let folder = URL(fileURLWithPath: dir)
        Task.detached(priority: .utility) {
            let session = Result { try SessionInfo.load(from: folder) }
            let runs = Result { try HookRuns.load(from: folder) }
            await MainActor.run {
                guard self.building?.job.id == job.id else { return }
                self.building?.session = try? session.get()
                self.building?.hookRuns = (try? runs.get()) ?? nil
                var problems: [String] = []
                if case .failure(let error) = session { problems.append("\(error)") }
                if case .failure(let error) = runs { problems.append("\(error)") }
                self.building?.readProblem = problems.isEmpty ? nil : problems.joined(separator: "; ")
            }
        }
    }

    func refreshRecent() {
        let sessions = layout.sessions
        Task.detached(priority: .utility) {
            let found = LibraryIndex.recent(sessions: sessions)
            await MainActor.run { self.recent = found }
        }
    }

    private func report(_ message: String) {
        lastError = message
        notifier.notice(id: "error", title: "Polydance", body: message)
    }
}
