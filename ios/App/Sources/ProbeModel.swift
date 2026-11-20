// The probe's one model (docs/IPHONE.md I0): where its files live, the event log, the parts that gather
// the evidence (CaptureRecorder, UploadProbe, RefreshProbe), and what the one screen shows about them: the
// provisioning profile, the runs on the phone and the log's last lines. It also runs the auto mode, so a
// take with a flip and an upload can be started from the Mac over devicectl without touching the phone
// (ios/README.md). Its files are in the container's Library/Application Support, all 0700 and 0600 and
// kept out of iCloud backup (V1, D8): events.jsonl, Runs/, uploads/ and notices.json; the token is in the
// Keychain (PairingStore), and a pairing file copied there over USB is taken in and deleted at launch.
// Since I3 a take aimed at a thread (or a report) is sent as soon as it finishes, once the phone is
// paired, and a report leaves the phone once the receiver has it (docs/IPHONE.md B1). Since I4 a take can be
// the screen and the microphone instead of the camera: the broadcast extension writes it into the app group and
// the link (BroadcastLink, shared with the Vision Pro) moves it into Runs/, where it is sent the same way. If the
// files cannot be set up nothing records or uploads, and the screen says why.
import AVFoundation
import Combine
import PolydancePhoneCore
import SwiftUI
import UIKit

struct ProbePaths {
    /// Library/Application Support in the app's container.
    let root: URL
    var events: URL { root.appendingPathComponent("events.jsonl") }
    var runs: URL { root.appendingPathComponent("Runs", isDirectory: true) }
    var uploads: URL { root.appendingPathComponent("uploads", isDirectory: true) }
}

/// The auto mode from launch arguments (`npm run ios -- launch -- -autoRecordSeconds 60 ...`). Strict: an
/// argument starting -auto that is not one of these, a bad number or a flip after the stop refuses the
/// whole plan, and the launch event says why. Leaving the app cannot be done from inside it, so it is done
/// from the Mac (`npm run ios -- leave`).
struct AutoPlan: Equatable {
    /// Start recording 2 s after the camera is running, and stop after this many seconds.
    var recordSeconds: Int?
    /// Flip this many seconds after the take starts.
    var flipAtSeconds: Int?
    /// Upload each take as soon as it finishes.
    var upload = false
    /// Hold the video's first chunk this many seconds on the background session (earliestBeginDate), so
    /// iOS has to start it, and the chunks after it, with Polydance suspended. Needs -autoUpload. Added
    /// 2026-11-07: on the phone's Wi-Fi a 100 MB take uploaded in 3.6 s, inside the app's own time.
    var holdVideoSeconds: Int?

    static let off = AutoPlan()
    static let secondsRange = 1...3600

    static func parse(_ arguments: [String]) -> Result<AutoPlan, AutoPlanError> {
        var plan = AutoPlan()
        var seen: Set<String> = []
        var i = arguments.startIndex
        while i < arguments.endIndex {
            let name = arguments[i]
            guard name.hasPrefix("-auto") else {
                i += 1
                continue
            }
            guard seen.insert(name).inserted else { return .failure(AutoPlanError("\(name) is given twice")) }
            switch name {
            case "-autoUpload":
                plan.upload = true
                i += 1
            case "-autoRecordSeconds", "-autoFlipAtSeconds", "-autoHoldVideoSeconds":
                guard i + 1 < arguments.endIndex, let n = Int(arguments[i + 1]), secondsRange.contains(n) else {
                    return .failure(AutoPlanError("\(name) needs a whole number of seconds from 1 to 3600"))
                }
                switch name {
                case "-autoRecordSeconds": plan.recordSeconds = n
                case "-autoFlipAtSeconds": plan.flipAtSeconds = n
                default: plan.holdVideoSeconds = n
                }
                i += 2
            default:
                return .failure(AutoPlanError("\(name) is not an auto argument (-autoRecordSeconds N, -autoFlipAtSeconds M, -autoUpload, -autoHoldVideoSeconds H)"))
            }
        }
        if let flip = plan.flipAtSeconds, flip >= plan.recordSeconds ?? 0 {
            return .failure(AutoPlanError("-autoFlipAtSeconds needs -autoRecordSeconds longer than it"))
        }
        if plan.holdVideoSeconds != nil, !plan.upload {
            return .failure(AutoPlanError("-autoHoldVideoSeconds needs -autoUpload"))
        }
        return .success(plan)
    }

    var summary: String {
        var parts: [String] = []
        if let recordSeconds { parts.append("record \(recordSeconds) s") }
        if let flipAtSeconds { parts.append("flip at \(flipAtSeconds) s") }
        if upload { parts.append("upload when finished") }
        if let holdVideoSeconds { parts.append("hold the video \(holdVideoSeconds) s") }
        return parts.isEmpty ? "off" : parts.joined(separator: ", ")
    }
}

struct AutoPlanError: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}

@MainActor
final class ProbeModel: ObservableObject {
    static let shared = ProbeModel()

    /// What exists only when the files could be set up.
    struct Parts {
        let log: EventLog
        let recorder: CaptureRecorder
        let uploads: UploadProbe
        let refresh: RefreshProbe
        let pairing: PairingStore
        let notifier: ReplyNotifier
        /// The screen's takes (I4), written by the broadcast extension.
        let link: BroadcastLink
    }

    struct RunRow: Identifiable, Equatable {
        let run: RunFolder
        let bytes: Int64
        /// "cut", "finished", or why run.json could not be read (shown, never hidden).
        let state: String
        let cut: Bool
        /// Where it goes (thread.json), nil for a take made unpaired.
        let thread: RunThread?
        /// When REC was pressed, from run.json.
        let recordedAt: Date?
        var id: String { run.name }
        var isReport: Bool { thread?.isReport == true }
    }

    enum CameraAccess: Equatable {
        case notAsked
        case noCamera
        case denied(String)
        case ready
    }

    let paths: ProbePaths?
    let parts: Parts?
    let setupError: String?
    /// "0.1.0 (1)" from the bundle, for the screen.
    let appVersion: String
    /// "0.1.0", CFBundleShortVersionString alone: what run.json records and the upload sends as the
    /// build's versionName (the receiver's schema refuses the screen's form).
    let shortVersion: String
    /// The commit the app was built from (PolydanceCommit), "unknown" when not set.
    let appCommit: String
    let modelIdentifier: String
    let systemVersion: String
    let auto: AutoPlan
    let autoError: String?
    let provisioning: ProvisioningInfo.Reading

    @Published private(set) var runs: [RunRow] = []
    @Published private(set) var camera: CameraAccess = .notAsked
    @Published private(set) var uploadNote = ""

    private let argumentNames: [String]
    private var cancellables: Set<AnyCancellable> = []
    private var screenPrepared = false
    private var autoTask: Task<Void, Never>?
    /// When didFinishLaunching ran, as system uptime, so a scene's connection says how long after it came.
    private var launchedUptime: TimeInterval?
    private var reachChecked = false
    /// Takes ended with Cancel: deleted from the phone as soon as their files are finished, never uploaded.
    private var discarding: Set<String> = []
    private var sceneObserver: NSObjectProtocol?

    private init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let version = "\(short) (\(info["CFBundleVersion"] as? String ?? "?"))"
        let commit = (info["PolydanceCommit"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "unknown"
        appVersion = version
        shortVersion = short
        appCommit = commit
        modelIdentifier = Self.hardwareModel()
        systemVersion = "iOS \(UIDevice.current.systemVersion)"
        provisioning = ProvisioningInfo.read()

        let arguments = Array(ProcessInfo.processInfo.arguments.dropFirst())
        argumentNames = arguments.filter { $0.hasPrefix("-") }
        switch AutoPlan.parse(arguments) {
        case .success(let plan):
            auto = plan
            autoError = nil
        case .failure(let error):
            auto = .off
            autoError = error.message
        }

        do {
            let paths = try Self.preparePaths()
            let log = try EventLog(url: paths.events)
            self.paths = paths
            let pairing = PairingStore(log: log, root: paths.root)
            parts = Parts(
                log: log,
                recorder: CaptureRecorder(runsRoot: paths.runs, log: log, appVersion: short, appCommit: commit),
                uploads: UploadProbe(log: log, pairing: { [weak pairing] in pairing?.current() }, stateDirectory: paths.uploads),
                refresh: RefreshProbe(log: log),
                pairing: pairing,
                notifier: ReplyNotifier(log: log, root: paths.root),
                link: BroadcastLink(log: log, runs: paths.runs)
            )
            setupError = nil
        } catch {
            paths = nil
            parts = nil
            setupError = Self.describe(error)
        }
        if let parts { wire(parts) }
    }

    /// Application Support and its folders, private and out of iCloud backup. The whole of Application
    /// Support is excluded, not only Runs/, because a pairing file copied there over USB holds a token until
    /// it is taken into the Keychain (P3: a backup never carries it).
    private static func preparePaths() throws -> ProbePaths {
        guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "iOS gave no Application Support folder"])
        }
        let paths = ProbePaths(root: root)
        // A folder devicectl copied into before the first launch is root's (seen 2026-11-07), and every
        // step below would then fail with a bare "permission" error; say what happened instead.
        if let owner = (try? FileManager.default.attributesOfItem(atPath: root.path))?[.ownerAccountID] as? NSNumber,
           owner.uint32Value != getuid() {
            throw CocoaError(.fileWriteNoPermission, userInfo: [NSLocalizedDescriptionKey:
                "Library/Application Support belongs to uid \(owner), not Polydance: devicectl made it before the app's first launch. Uninstall, install, launch once, then configure (ios/README.md)."])
        }
        try PrivateFiles.directory(paths.root)
        try PrivateFiles.directory(paths.runs)
        try PrivateFiles.directory(paths.uploads)
        for folder in [paths.root, paths.runs] {
            var url = folder
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
        }
        return paths
    }

    private func wire(_ parts: Parts) {
        parts.recorder.onFinished = { [weak self] run in
            self?.takeFinished(run)
        }
        parts.recorder.$state
            .removeDuplicates()
            .sink { [weak self] state in self?.recorderStateChanged(state) }
            .store(in: &cancellables)
        parts.uploads.$configured
            .removeDuplicates()
            .sink { [weak self] configured in self?.refreshUploadNote(configured: configured) }
            .store(in: &cancellables)
        let uploads = parts.uploads, pairing = parts.pairing, notifier = parts.notifier
        pairing.$pairing
            .removeDuplicates()
            .sink { [weak uploads] _ in
                // After the store has set it, so the uploads read the new value.
                DispatchQueue.main.async { uploads?.pairingChanged() }
            }
            .store(in: &cancellables)
        uploads.onFinished = { [weak self] name in self?.uploadFinished(name) }
        // I4: a screen take the extension finished, now in Runs/, goes as a camera take does.
        parts.link.onTakeArrived = { [weak self] run in self?.takeFinished(run) }
        // U7: the refresh asks the receiver for replies when notifications are on and the phone is paired.
        parts.refresh.work = { [weak pairing, weak notifier] in
            guard let notifier, let found = pairing?.current() else { return true }
            return await notifier.check(ReceiverClient(pairing: found), why: "refresh")
        }
    }

    // MARK: Launch and the app's life

    /// From application(_:didFinishLaunchingWithOptions:), which may be a launch in the background for a
    /// refresh or an upload's events: logs it, logs the profile, and reattaches the upload session.
    ///
    /// The app's state here is "background" for every launch of a scene-based app, a tap included, since
    /// no scene has connected yet, so it is logged under its own name and never as the kind of launch. The
    /// kind shows in what follows: a `scene.connect` for a launch onto the screen, or a `refresh.run` or
    /// `bg.urlsession.events` with no scene for a launch in the background.
    func launched(optionKeys: [String], refreshRegistered: Bool) {
        guard let parts else { return }
        let uptime = ProcessInfo.processInfo.systemUptime
        launchedUptime = uptime
        sceneObserver = NotificationCenter.default.addObserver(forName: UIScene.willConnectNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.sceneConnecting() }
        }
        var fields: [String: any Sendable] = [
            "appStateInDidFinishLaunching": ProbeAppState.current(),
            "version": appVersion,
            "commit": appCommit,
            "model": modelIdentifier,
            "system": systemVersion,
            "args": argumentNames,
            "launchOptions": optionKeys,
            "protectedData": UIApplication.shared.isProtectedDataAvailable,
            "refreshRegistered": refreshRegistered,
            "auto": auto.summary,
        ]
        if let autoError { fields["autoError"] = autoError }
        // What lets iOS run a background refresh at all (question 5): a day with few runs reads against these.
        fields.merge(RefreshProbe.conditions()) { $1 }
        parts.log.write("launch", fields)

        switch provisioning {
        case .present(let info): parts.log.write("profile", info.logFields())
        case .absent(let why): parts.log.write("profile", ["absent": why])
        case .unreadable(let why): parts.log.write("profile", ["error": why])
        }

        parts.uploads.reattach()
        refreshRuns()
        refreshUploadNote(configured: parts.uploads.configured)
        sweepReports()
    }

    /// A scene connecting: this launch is onto the screen (or a scene came back after being discarded).
    private func sceneConnecting() {
        guard let parts else { return }
        var fields: [String: any Sendable] = ["appState": ProbeAppState.current()]
        if let launchedUptime { fields["msFromLaunch"] = Int(((ProcessInfo.processInfo.systemUptime - launchedUptime) * 1000).rounded()) }
        parts.log.write("scene.connect", fields)
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        guard let parts else { return }
        let name = switch phase {
        case .active: "active"
        case .inactive: "inactive"
        case .background: "background"
        @unknown default: "unknown"
        }
        parts.log.write("scene", ["phase": name, "appState": ProbeAppState.current()])
        switch phase {
        case .background:
            parts.refresh.schedule()
            // R7: leaving ends the take. The recorder stops it on willResignActive, before this, and keeps
            // background time to finish the files; this is only a safety net and does nothing then.
            if case .recording = parts.recorder.state {
                parts.recorder.stop(reason: "Polydance left the screen (scene phase background)")
            }
        case .active:
            parts.refresh.reload()
            // A screen take that ended while Polydance was suspended told nobody: take it in now.
            parts.link.refresh()
            refreshRuns()
            refreshUploadNote(configured: parts.uploads.configured)
            // Once a launch, on the screen: reach the receiver, so iOS asks about the local network now,
            // with Robin there to answer, rather than during a take's upload in the background.
            if !reachChecked, parts.uploads.configured {
                reachChecked = true
                parts.uploads.checkReach()
            }
        default:
            break
        }
    }

    private func recorderStateChanged(_ state: CaptureRecorder.State) {
        switch state {
        case .recording:
            // R7: the screen does not dim or lock while recording.
            UIApplication.shared.isIdleTimerDisabled = true
            refreshRuns()
        case .idle, .failed:
            UIApplication.shared.isIdleTimerDisabled = false
            refreshRuns()
        case .starting, .stopping:
            break
        }
    }

    private func takeFinished(_ run: RunFolder) {
        if discarding.remove(run.name) != nil {
            discard(run, reason: "Cancel was pressed")
            return
        }
        refreshRuns()
        guard let parts else { return }
        if auto.upload {
            parts.uploads.holdVideoSeconds = auto.holdVideoSeconds
            parts.uploads.upload(run)
            return
        }
        // I3: a take aimed at a thread, a new thread or a report goes as soon as it finishes; its video
        // waits for Wi-Fi (U3), its words do not. The hold after Stop (U4) is I2's, not built yet.
        if parts.uploads.configured, runs.first(where: { $0.run.name == run.name })?.thread != nil {
            parts.uploads.upload(run, sendNow: false)
        }
    }

    // MARK: Reports (docs/IPHONE.md B1)

    /// A report's upload finished: the receiver has every byte, so the phone's copy goes.
    private func uploadFinished(_ name: String) {
        guard let row = runs.first(where: { $0.run.name == name }) ?? rowFor(name), row.isReport else { return }
        removeReport(row, reason: "the receiver has it")
    }

    /// At each launch: a report sent but not removed goes, one unsent (or refused) is sent again once the
    /// phone is paired, and one unsent after a week goes (PolydancePhoneCore's ReportPolicy).
    func sweepReports() {
        guard let parts else { return }
        for row in runs where row.isReport {
            let phase = parts.uploads.states[row.run.name]?.phase
            let busy = parts.uploads.isBusy(row.run.name)
            switch ReportPolicy.decide(phase: busy ? .content : phase, recording: row.run.name == parts.recorder.currentRunName,
                                       recordedAt: row.recordedAt, now: Date()) {
            case .keep: break
            case .send: if parts.uploads.configured { parts.uploads.upload(row.run, sendNow: false) }
            case .delete(let why): removeReport(row, reason: why)
            }
        }
    }

    private func removeReport(_ row: RunRow, reason: String) {
        guard let parts else { return }
        _ = parts.uploads.forget(row.run.name)
        var fields: [String: any Sendable] = ["run": row.run.name, "reason": reason, "appState": ProbeAppState.current()]
        do {
            try FileManager.default.removeItem(at: row.run.directory)
            fields["deleted"] = true
        } catch {
            fields["deleted"] = false
            fields["error"] = Self.describe(error)
        }
        parts.log.write("report.removed", fields)
        refreshRuns()
    }

    private func rowFor(_ name: String) -> RunRow? {
        guard let paths else { return nil }
        return Self.row(RunFolder(name: name, directory: paths.runs.appendingPathComponent(name, isDirectory: true)))
    }

    // MARK: Cancel and delete (the deck's REC screen and Recordings, docs/IPHONE.md S2 and S5)

    /// Cancel on the recording screen, after its one confirmation: stops the take and deletes it once its
    /// files are finished. Nothing of it is uploaded.
    func cancelTake() {
        guard let parts, case .recording = parts.recorder.state, let name = parts.recorder.currentRunName else { return }
        discarding.insert(name)
        parts.log.write("rec.cancel", ["run": name, "appState": ProbeAppState.current()])
        parts.recorder.stop(reason: "Cancel was pressed: the take is thrown away")
    }

    /// Delete on the Recordings page, after its confirmation: this phone's copy only. Refused, with the reason,
    /// for the take being recorded and for one whose upload is under way.
    func delete(_ row: RunRow) -> String? {
        guard let parts else { return "Polydance could not set up its files" }
        if row.run.name == parts.recorder.currentRunName { return "It is being recorded." }
        if let why = parts.uploads.forget(row.run.name) { return "It cannot be deleted while \(why)." }
        do {
            try FileManager.default.removeItem(at: row.run.directory)
        } catch {
            return "It could not be deleted: \(Self.describe(error))"
        }
        parts.log.write("run.delete", ["run": row.run.name, "bytes": row.bytes, "appState": ProbeAppState.current()])
        refreshRuns()
        return nil
    }

    private func discard(_ run: RunFolder, reason: String) {
        var fields: [String: any Sendable] = ["run": run.name, "reason": reason, "appState": ProbeAppState.current()]
        do {
            try FileManager.default.removeItem(at: run.directory)
            fields["deleted"] = true
        } catch {
            fields["deleted"] = false
            fields["error"] = Self.describe(error)
        }
        parts?.log.write("rec.discard", fields)
        refreshRuns()
    }

    // MARK: The camera and the auto mode

    /// On the screen's first appearance: asks for the camera and the microphone, starts the preview, and
    /// starts the auto mode if it was asked for. A phone without a camera (the simulator) is told so and
    /// nothing is asked.
    func screenAppeared() async {
        guard let parts, !screenPrepared else { return }
        screenPrepared = true
        guard Self.hasCamera() else {
            camera = .noCamera
            return
        }
        let granted = await parts.recorder.requestPermissions()
        camera = granted ? .ready : Self.deniedAccess()
        guard granted else { return }
        parts.recorder.startPreview()
        if auto.recordSeconds != nil, autoTask == nil {
            autoTask = Task { [weak self] in await self?.runAuto() }
        }
    }

    private func runAuto() async {
        guard let parts, let seconds = auto.recordSeconds else { return }
        let recorder = parts.recorder
        let log = parts.log

        let cameraDeadline = Date().addingTimeInterval(30)
        while !recorder.session.isRunning {
            guard Date() < cameraDeadline else {
                log.write("rec.failed", ["appState": ProbeAppState.current(), "reason": "auto: the camera was not running 30 s after it was started"])
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        try? await Task.sleep(for: .seconds(2))
        guard recorder.state == .idle else {
            log.write("rec.failed", ["appState": ProbeAppState.current(), "reason": "auto: the recorder was not idle when the take was due"])
            return
        }
        recorder.start()

        var since: Date?
        let startDeadline = Date().addingTimeInterval(15)
        while since == nil {
            switch recorder.state {
            case .recording(let date): since = date
            case .failed: return // the recorder logged why
            default:
                guard Date() < startDeadline else {
                    log.write("rec.failed", ["appState": ProbeAppState.current(), "reason": "auto: the take had not started 15 s after REC"])
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        guard let since else { return }

        if let flip = auto.flipAtSeconds {
            await Self.sleep(until: since.addingTimeInterval(TimeInterval(flip)))
            guard recorder.state == .recording(since: since) else { return }
            recorder.flip()
        }
        await Self.sleep(until: since.addingTimeInterval(TimeInterval(seconds)))
        guard recorder.state == .recording(since: since) else { return }
        recorder.stop(reason: "auto mode, after \(seconds) s")
    }

    private static func sleep(until date: Date) async {
        let delay = date.timeIntervalSinceNow
        if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
    }

    private static func hasCamera() -> Bool {
        !AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .unspecified).devices.isEmpty
    }

    private static func deniedAccess() -> CameraAccess {
        var missing: [String] = []
        if AVCaptureDevice.authorizationStatus(for: .video) != .authorized { missing.append("the camera") }
        if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized { missing.append("the microphone") }
        let what = missing.isEmpty ? "the camera and the microphone" : missing.joined(separator: " or ")
        return .denied("Polydance may not use \(what). Allow it in Settings, Apps, Polydance, then open Polydance again.")
    }

    // MARK: What the screen shows

    func refreshRuns() {
        guard let paths else { return }
        runs = RunFolder.list(in: paths.runs).map(Self.row)
    }

    nonisolated static func row(_ run: RunFolder) -> RunRow {
        let bytes = folderBytes(run.directory)
        // A thread.json that does not decode reads as none: the take stays on the phone, and its upload says why.
        let thread = (try? run.readThread()) ?? nil
        do {
            let meta = try run.readMeta()
            return RunRow(run: run, bytes: bytes, state: meta.cut ? "cut" : "finished", cut: meta.cut, thread: thread,
                          recordedAt: ReportPolicy.date(meta.recordedAt))
        } catch {
            return RunRow(run: run, bytes: bytes, state: "run.json unreadable: \(describe(error))", cut: true, thread: thread, recordedAt: nil)
        }
    }

    private func refreshUploadNote(configured: Bool) {
        guard parts != nil else { return }
        if configured {
            uploadNote = "paired"
        } else if let problem = parts?.pairing.problem {
            uploadNote = "not paired: \(problem)"
        } else {
            uploadNote = "not paired (Settings, Pair with the Mac, or npm run ios -- configure)"
        }
    }

    var profileLine: String {
        switch provisioning {
        case .present(let info):
            // The earlier of the profile's end and its certificate's: the day the app stops launching.
            let days = info.expiry.daysLeft()
            let date = Self.day(info.expiry.first)
            let what = info.expiry.cause == .certificate ? "certificate" : "profile"
            if days < 0 { return "Signing: the \(what) expired \(date)" }
            return "Signing: stops \(date) (the \(what)), \(days) \(days == 1 ? "day" : "days")"
        case .absent(let why):
            return why == "simulator" ? "No profile (simulator)" : "No profile: \(why)"
        case .unreadable(let why):
            return "Profile unreadable: \(why)"
        }
    }

    var profileDetail: String? {
        guard case .present(let info) = provisioning else { return nil }
        // The team's id, never its name: a personal team is named after the person.
        return "Team \(info.teamIdentifier) · profile made \(Self.day(info.creationDate)), ends \(Self.day(info.expiry.profile))"
            + " · certificate ends \(Self.day(info.expiry.certificate))"
            + (info.hasProvisionedDevices ? " · lists devices" : " · lists no devices")
    }

    /// The log's last lines, newest last, read from its end so a long log costs no more than a short one.
    func logTail(_ count: Int) -> [String] {
        guard let parts else { return [] }
        return Self.tail(of: parts.log.url, lines: count, bytes: 24 * 1024)
    }

    // MARK: Helpers

    nonisolated static func tail(of url: URL, lines count: Int, bytes: Int) -> [String] {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return [] }
        let start = end > UInt64(bytes) ? end - UInt64(bytes) : 0
        guard (try? handle.seek(toOffset: start)) != nil, let data = try? handle.readToEnd() else { return [] }
        var lines = String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
        // Reading from the middle of the file starts inside a line; that partial line is dropped.
        if start > 0, !lines.isEmpty { lines.removeFirst() }
        return Array(lines.suffix(count))
    }

    nonisolated static func folderBytes(_ directory: URL) -> Int64 {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        guard let walker = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: keys) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in walker {
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
            total += Int64(values.fileSize ?? 0)
        }
        return total
    }

    /// The hardware identifier (iPhone14,5), never the phone's own name.
    nonisolated static func hardwareModel() -> String {
        #if targetEnvironment(simulator)
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"].map { "\($0) (simulator)" } ?? "simulator"
        #else
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        #endif
    }

    nonisolated static func describe(_ error: Error) -> String { ErrorWords.describe(error) }

    static func day(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "d MMM yyyy"
        return f.string(from: date)
    }
}
