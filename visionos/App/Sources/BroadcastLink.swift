// The app's side of the broadcast (docs/VISIONOS.md R1 to R4, docs/IPHONE.md I4; Shared/Broadcast.swift has the
// contract), the same file on the Vision Pro and the iPhone. REC is the system's own broadcast picker, drawn
// invisibly over a red key, so a press always reaches the system's "Start Broadcast" sheet; on the Vision Pro,
// Reply, New thread, the bug key and Record and open press the same picker from code, and when the system will not
// take a press from code the deck says to press REC. The link keeps next.json current, reads live.json when the
// extension says it changed (and four times a second while a take runs, with the meters' levels), and moves each
// finished take from the app group into the app's own Runs/, where the uploads send it. An app the system has
// suspended hears no notification, so the iPhone's model calls refresh as it comes back to the front.
import Combine
import PolydancePhoneCore
import ReplayKit
import SwiftUI
import UIKit

@MainActor
final class BroadcastLink: ObservableObject {
    enum State: Equatable {
        case idle
        /// The picker was pressed; the system's sheet is up, or its countdown is running.
        case asking(since: Date)
        /// The broadcast began; no frame yet.
        case starting(run: String)
        case recording(run: String, since: Date)
        case finishing(run: String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var micLevel = 0.0
    @Published private(set) var appLevel = 0.0
    /// The mic is on in Polydance but no sound came from it in the first seconds: it is off in the system's sheet.
    @Published private(set) var micSilent = false
    /// Why the last take did not start or could not be kept, until the next one starts.
    @Published private(set) var problem: String?
    /// The take's picture size, once its first frame is written.
    @Published private(set) var size: (width: Int, height: Int)?

    /// A take finished and was moved to `runs`: its folder there.
    var onTakeArrived: ((RunFolder) -> Void)?
    /// A take began recording (first frame written), with its folder in the group, for Record and open.
    var onRecording: ((RunFolder) -> Void)?
    /// Just before the sheet is asked for, so next.json says where this take goes.
    var beforeAsking: (() -> Void)?

    let root: URL?
    let runs: URL
    private let log: EventLog
    private weak var picker: RPSystemBroadcastPickerView?
    private var poll: Timer?
    private var observing = false
    private var lastLive: LiveTake?
    /// A take live.json still calls under way whose heartbeat stopped: the extension died, and it is taken in as cut off.
    private var deadRun: String?

    init(log: EventLog, runs: URL) {
        self.log = log
        self.runs = runs
        root = BroadcastShared.root()
        if let root {
            try? PrivateFiles.directory(root)
            try? PrivateFiles.directory(BroadcastShared.runs(in: root))
        }
        observe()
        refresh()
    }

    var isRecording: Bool { if case .recording = state { true } else { false } }
    var isBusy: Bool {
        switch state {
        case .asking, .starting, .finishing: true
        default: false
        }
    }

    /// The run being written now, in the group, for opened.json.
    var liveRun: RunFolder? {
        guard let root, let run = lastLive?.run, isRecording else { return nil }
        return RunFolder(name: run, directory: BroadcastShared.runs(in: root).appendingPathComponent(run, isDirectory: true))
    }

    // MARK: The picker

    func attach(_ picker: RPSystemBroadcastPickerView) { self.picker = picker }

    /// The picker's own button was pressed (REC): the sheet is up.
    func pickerPressed() {
        guard case .idle = state else { return }
        beforeAsking?()
        problem = nil
        state = .asking(since: Date())
        log.write("rec.asked", ["how": "rec"])
        startPolling()
    }

    /// Presses the picker from code. False when there is no picker or no button to press: the deck then asks for REC.
    @discardableResult
    func start() -> Bool {
        guard case .idle = state else { return false }
        guard let picker, let button = Self.button(in: picker) else {
            log.write("rec.asked", ["how": "code", "ok": false])
            return false
        }
        beforeAsking?()
        problem = nil
        state = .asking(since: Date())
        button.sendActions(for: .touchUpInside)
        log.write("rec.asked", ["how": "code", "ok": true])
        startPolling()
        return true
    }

    func stop() {
        guard isRecording || isStarting else { return }
        BroadcastShared.post(BroadcastShared.stopNote)
        log.write("rec.stopAsked")
    }

    func cancel() {
        BroadcastShared.post(BroadcastShared.cancelNote)
        log.write("rec.cancelAsked")
    }

    private var isStarting: Bool { if case .starting = state { true } else { false } }

    static func button(in view: UIView) -> UIButton? {
        for sub in view.subviews {
            if let button = sub as? UIButton { return button }
            if let found = button(in: sub) { return found }
        }
        return nil
    }

    // MARK: next.json

    func writeNext(_ next: NextTake) {
        guard let root else { return }
        do {
            try PrivateFiles.write(BroadcastShared.encode(next), to: BroadcastShared.next(in: root))
        } catch {
            log.write("rec.next", ["ok": false, "reason": ErrorWords.describe(error)])
        }
    }

    // MARK: live.json

    /// Reads live.json and the levels, moves the state on, and takes in any finished take.
    func refresh() {
        guard let root else { return }
        let live = try? JSONDecoder().decode(LiveTake.self, from: Data(contentsOf: BroadcastShared.live(in: root)))
        let changed = live != lastLive
        lastLive = live
        if let live { apply(live, changed: changed) }
        if case .asking(let since) = state, Date().timeIntervalSince(since) > 45 {
            // The sheet was dismissed, or the system never began: nothing to wait for.
            state = .idle
            log.write("rec.notStarted")
        }
        if isRecording || isStarting, let defaults = BroadcastShared.defaults {
            micLevel = defaults.double(forKey: BroadcastShared.micLevelKey)
            appLevel = defaults.double(forKey: BroadcastShared.appLevelKey)
        } else {
            micLevel = 0
            appLevel = 0
        }
        if !(isRecording || isBusy) { stopPolling() }
        adoptFinished()
    }

    private func apply(_ live: LiveTake, changed: Bool) {
        let active = live.state == .starting || live.state == .recording || live.state == .finishing
        if active, deadRun == live.run { return }
        if active, Date().timeIntervalSince1970 - live.beganAt > 20 {
            let beat = BroadcastShared.defaults?.double(forKey: BroadcastShared.heartbeatKey) ?? 0
            if Date().timeIntervalSince1970 - beat > 20 {
                deadRun = live.run
                // The problem before the state, so whoever watches the state sees why it went idle.
                problem = "The last recording stopped without finishing; what was written is kept, marked cut off."
                state = .idle
                micSilent = false
                log.write("rec.dead", ["run": live.run])
                return
            }
        }
        let fresh: Bool = {
            // A take the deck asked for, or one under way when the app opened (started from Control Center).
            if case .asking(let since) = state { return live.beganAt >= since.timeIntervalSince1970 - 5 }
            return true
        }()
        switch live.state {
        case .starting where fresh:
            // A new take, perhaps started from Control Center rather than the picker: the last one's problem is old.
            if !isStarting { problem = nil }
            state = .starting(run: live.run)
            startPolling()
        case .recording where fresh:
            let since = Date(timeIntervalSince1970: live.startedAt ?? live.beganAt)
            let wasRecording = isRecording
            if !wasRecording, !isStarting { problem = nil }
            state = .recording(run: live.run, since: since)
            if let w = live.width, let h = live.height { size = (w, h) }
            micSilent = !live.micHeard && Date().timeIntervalSince(since) > 4
            startPolling()
            if !wasRecording, let root {
                onRecording?(RunFolder(name: live.run, directory: BroadcastShared.runs(in: root).appendingPathComponent(live.run, isDirectory: true)))
            }
        case .finishing where fresh:
            state = .finishing(run: live.run)
        case .finished, .cancelled:
            if !active, case .asking = state { break }
            state = .idle
            micSilent = false
        case .failed:
            if case .asking = state, !fresh { break }
            if changed { problem = live.reason.map { "The recording could not be kept: \($0)" } }
            state = .idle
            micSilent = false
        default:
            break
        }
        if changed { log.write("rec.live", ["state": live.state.rawValue, "run": live.run]) }
    }

    /// Moves every take the extension finished (or left cut off) into the app's Runs/, except the one being written.
    func adoptFinished() {
        guard let root else { return }
        let group = BroadcastShared.runs(in: root)
        let busy: String? = {
            guard let live = lastLive, [.starting, .recording, .finishing].contains(live.state), live.run != deadRun else { return nil }
            return live.run
        }()
        for run in RunFolder.list(in: group) where run.name != busy {
            // A run.json the extension has not written yet is a take still starting; leave it.
            guard FileManager.default.fileExists(atPath: run.metaURL.path) else { continue }
            let target = runs.appendingPathComponent(run.name, isDirectory: true)
            do {
                try PrivateFiles.directory(runs)
                if FileManager.default.fileExists(atPath: target.path) {
                    throw CocoaError(.fileWriteFileExists, userInfo: [NSLocalizedDescriptionKey: "a take named \(run.name) is already here"])
                }
                try FileManager.default.moveItem(at: run.directory, to: target)
                log.write("rec.arrived", ["run": run.name])
                onTakeArrived?(RunFolder(name: run.name, directory: target))
            } catch {
                log.write("rec.arrived", ["run": run.name, "ok": false, "reason": ErrorWords.describe(error)])
            }
        }
    }

    // MARK: Watching

    private func observe() {
        guard !observing else { return }
        observing = true
        let me = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), me, { _, observer, _, _, _ in
            guard let observer else { return }
            let link = Unmanaged<BroadcastLink>.fromOpaque(observer).takeUnretainedValue()
            DispatchQueue.main.async { MainActor.assumeIsolated { link.refresh() } }
        }, BroadcastShared.changedNote as CFString, nil, .deliverImmediately)
    }

    private func startPolling() {
        guard poll == nil else { return }
        poll = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    private func stopPolling() {
        poll?.invalidate()
        poll = nil
    }
}

/// The system's own broadcast button, drawn invisibly over the red key: a press opens the system's sheet with
/// Polydance's extension already chosen. Its button is found once and told to report presses to the link.
struct BroadcastPicker: UIViewRepresentable {
    let link: BroadcastLink

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 176, height: 80))
        picker.preferredExtension = BroadcastShared.extensionBundleId
        picker.showsMicrophoneButton = true
        picker.backgroundColor = .clear
        if let button = BroadcastLink.button(in: picker) {
            button.setImage(nil, for: .normal)
            button.tintColor = .clear
            button.addTarget(context.coordinator, action: #selector(Coordinator.pressed), for: .touchUpInside)
        }
        link.attach(picker)
        return picker
    }

    func updateUIView(_ picker: RPSystemBroadcastPickerView, context: Context) {
        if let button = BroadcastLink.button(in: picker) { button.frame = picker.bounds }
    }

    func makeCoordinator() -> Coordinator { Coordinator(link: link) }

    final class Coordinator: NSObject {
        let link: BroadcastLink
        init(link: BroadcastLink) { self.link = link }
        @MainActor @objc func pressed() { link.pickerPressed() }
    }
}
