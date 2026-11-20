// The probe's camera and microphone (docs/IPHONE.md I0, R1 to R8): one AVCaptureSession at 1920 x 1080
// into PolydancePhoneCore's MovieWriter, which writes video.mp4 and narration.m4a into a run folder.
// What I0 must learn is written to the event log as it happens: the frame and flip timings, why a take
// stopped, how the writer kept up.
//
// Three places, three threads. CaptureRecorder lives on the main actor and is what the screen sees.
// CaptureGraph owns the session's inputs and outputs and changes them only on its session queue (never
// the main thread: startRunning blocks). CaptureSink is the sample-buffer delegate for both outputs on
// one serial capture queue, and the only caller of the writer's appends.
//
// Orientation is read once, at REC, for both cameras (R6): each camera's angle for horizon-level capture
// from its rotation coordinator, kept for the whole take, so a flip uses the angle that matches the phone
// as it was at REC rather than as it is now. The angle goes on the video data output's connection, which
// rotates the buffers themselves, so the file is upright with no rotation in its metadata (R4); the
// front camera's buffers are not mirrored. While idle the connection follows the phone, so REC rarely
// has to reconfigure the pipeline.
//
// Leaving ends the take (R7): stop on willResignActive or entering the background, on the session's
// interruption, or on a runtime error, with the reason in run.json (written as the stop begins, so it is
// there even if the finish never completes) and the log. The reason names its trigger, so a deactivation
// that is not a departure (Control Center, an alert) reads differently from leaving the screen. Background
// time is held from the stop, including one that waits for the take to start, because iOS fails a writer
// that is still open when the app goes to the background (AVAssetWriter.h, startWriting). The flip's gap
// is measured by PolydancePhoneCore's FlipClock, one flip at a time. The microphone is named by its port
// type (MicrophoneBuiltIn), never its port name, which can carry a person's name ("Robin's AirPods"), and
// the session opts in to AirPods as a capture microphone (iOS 26).
//
// Photos (Robin's pick of 2026-11-13, "the camera, then choose"): the same session carries a photo output, so
// the camera New thread and Reply open takes a photo or starts a take without changing anything. A photo is
// taken at the phone's angle as it is now, never during a take, and PolydancePhoneCore's PhotoPrep makes its
// pixels upright and strips it before it goes anywhere; nothing is saved to Photos.
import AVFoundation
import Combine
import PolydancePhoneCore
import UIKit

@MainActor
final class CaptureRecorder: NSObject, ObservableObject {
    enum State: Equatable { case idle, starting, recording(since: Date), stopping, failed(String) }

    @Published private(set) var state: State = .idle
    @Published private(set) var facing: AVCaptureDevice.Position = .back
    @Published private(set) var stats = MovieWriterStats()
    @Published private(set) var orientation: String = "portrait"
    @Published private(set) var lastRun: RunFolder?
    let session: AVCaptureSession
    var onFinished: ((RunFolder) -> Void)?

    /// REC is refused with less free space than this (R8).
    static let minimumFreeBytes: Int64 = 1_000_000_000
    /// How long a flip waits for the new camera's first written frame before FLIP works again.
    static let flipWaitSeconds = 5

    private let runsRoot: URL
    private let log: EventLog
    private let appVersion: String
    private let appCommit: String
    private let graph: CaptureGraph
    private let sink: CaptureSink
    private var coordinators: [AVCaptureDevice.Position: AVCaptureDevice.RotationCoordinator] = [:]
    private var idleObservation: NSKeyValueObservation?
    private var observers: [NSObjectProtocol] = []
    private var take: Take?
    private var pendingStop: (reason: String, trigger: String)?
    private var flipping = false
    /// The failed state came from starting the preview, so a preview that starts later clears it.
    private var previewFailed = false
    private var heartbeat: Timer?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    /// What one take keeps from REC to its end.
    private struct Take {
        let run: RunFolder
        let writer: MovieWriter
        let timeline: EventLog?
        let settings: MovieWriterSettings
        /// Each camera's capture angle at REC.
        let angles: [AVCaptureDevice.Position: Int]
        let pressedUptime: TimeInterval
        var meta: RunMeta
        var flipBegan: TimeInterval?
    }

    init(runsRoot: URL, log: EventLog, appVersion: String, appCommit: String) {
        self.runsRoot = runsRoot
        self.log = log
        self.appVersion = appVersion
        self.appCommit = appCommit
        let sink = CaptureSink()
        self.sink = sink
        graph = CaptureGraph(sink: sink)
        session = graph.session
        super.init()
        sink.onEvent { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        for position in [AVCaptureDevice.Position.back, .front] {
            if let device = graph.device(position) {
                coordinators[position] = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
            }
        }
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        followIdleOrientation()
        observeInterruptions()
    }

    /// The run the take being recorded writes into, from REC until it is finished.
    var currentRunName: String? { take?.run.name }

    /// The MIC meter's needle, 0 to 1 across the meter's scale (-40 to -3 dB), as NeedleMeter reads it.
    var micLevel: Double {
        guard let db = sink.micDecibels, db.isFinite else { return 0 }
        return min(max((Double(db) + 40) / 37, 0), 1)
    }

    // MARK: Permissions and preview

    /// Camera, then microphone. True only when both are allowed.
    func requestPermissions() async -> Bool {
        for media in [AVMediaType.video, .audio] {
            switch AVCaptureDevice.authorizationStatus(for: media) {
            case .authorized: continue
            case .notDetermined:
                guard await AVCaptureDevice.requestAccess(for: media) else { return false }
            default: return false
            }
        }
        return true
    }

    /// Configures the session once and starts it, off the main thread.
    func startPreview() {
        let angle = idleAngle()
        let wanted = facing
        graph.start(facing: wanted, angle: angle) { [weak self] outcome in
            Task { @MainActor in self?.previewStarted(outcome) }
        }
    }

    /// Stops the session. A take still recording is stopped first, so it is kept.
    func stopPreview() {
        if isRecordingOrStarting { stop(reason: "the preview was stopped", trigger: "stopPreview") }
        graph.stop()
    }

    private func previewStarted(_ outcome: Result<ConnectionReport, CaptureFailure>) {
        switch outcome {
        case .success(let report):
            announceCamera(report.uniqueID)
            if previewFailed, case .failed = state, take == nil { state = .idle }
            previewFailed = false
        case .failure(let failure):
            record("rec.failed", ["during": "preview", "error": failure.message])
            if take == nil {
                state = .failed(failure.message)
                previewFailed = true
            }
        }
    }

    // MARK: REC

    private var isRecordingOrStarting: Bool {
        switch state {
        case .recording, .starting: true
        default: false
        }
    }

    /// REC: a new take, aimed at `thread` (written as the run's thread.json, so its upload knows where it
    /// goes) when the phone is paired, else kept on the phone.
    func start(thread: RunThread? = nil) {
        switch state {
        case .idle, .failed: break
        default: return
        }
        guard !flipping else { return }
        previewFailed = false
        // A stop recorded for an earlier take that never started belongs to that take, not this one.
        pendingStop = nil
        let pressed = ProcessInfo.processInfo.systemUptime

        // R8: never start a take the phone has no room for.
        let free: Int64
        do {
            try PrivateFiles.directory(runsRoot)
            Self.excludeFromBackup(runsRoot)
            let values = try runsRoot.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            guard let capacity = values.volumeAvailableCapacityForImportantUsage else {
                return refuse("the phone did not say how much space is free, so REC is refused")
            }
            free = capacity
        } catch {
            return refuse("the free space could not be read: \(error.localizedDescription)")
        }
        guard free >= Self.minimumFreeBytes else {
            return refuse("under 1 GB free (\(free / 1_000_000) MB), so REC is refused", ["freeBytes": free])
        }

        // R6: both cameras' angles now, kept for the whole take.
        var angles: [AVCaptureDevice.Position: Int] = [:]
        for (position, coordinator) in coordinators {
            angles[position] = Self.rightAngle(coordinator.videoRotationAngleForHorizonLevelCapture)
        }
        let active = facing
        guard let angle = angles[active] else { return refuse("there is no \(Self.name(active)) camera") }
        let size = Self.size(forAngle: angle)
        let named = Self.orientationName(angle: angles[.back] ?? angle)

        let take: Take
        // Kept outside the do, so a start that fails partway leaves no folder and no open writer behind.
        var madeRun: RunFolder?
        var madeWriter: MovieWriter?
        do {
            let run = try RunFolder.create(in: runsRoot, at: Date())
            madeRun = run
            Self.excludeFromBackup(run.directory)
            let settings = MovieWriterSettings(width: size.width, height: size.height)
            let writer = try MovieWriter(videoURL: run.videoURL, narrationURL: run.narrationURL, settings: settings)
            madeWriter = writer
            let meta = RunMeta(runName: run.name, recordedAt: EventLog.timestamp(Date()), device: Self.deviceInfo(),
                               appVersion: appVersion, appCommit: appCommit, orientation: named,
                               width: settings.width, height: settings.height, fps: settings.fps, audioTracks: ["mic"],
                               micName: Self.micPortType(), cameras: [CameraSpan(atMs: 0, facing: Self.name(active))],
                               flipGapsMs: [], cut: true)
            try run.writeMeta(meta)
            if let thread { try run.writeThread(thread) }
            take = Take(run: run, writer: writer, timeline: try? EventLog(url: run.timelineURL), settings: settings,
                        angles: angles, pressedUptime: pressed, meta: meta)
        } catch {
            madeWriter?.cancel()
            if let madeRun { try? FileManager.default.removeItem(at: madeRun.directory) }
            return refuse("the take could not start: \(error.localizedDescription)")
        }
        self.take = take
        orientation = named
        stats = MovieWriterStats()
        state = .starting

        let sink = sink
        let writer = take.writer
        graph.prepareTake(facing: active, angle: angle) { [weak self] outcome in
            // On the session queue: the connection is turned before the sink hands frames to the writer.
            if case .success = outcome { sink.begin(writer) }
            Task { @MainActor in self?.takeBegan(outcome, free: free) }
        }
    }

    private func takeBegan(_ outcome: Result<ConnectionReport, CaptureFailure>, free: Int64) {
        guard var take else { return }
        switch outcome {
        case .failure(let failure):
            take.writer.cancel()
            // A stop that waited for this take ends with it; the next take must not inherit it.
            let pending = pendingStop
            pendingStop = nil
            var fields: [String: any Sendable] = ["during": "start", "error": failure.message, "run": take.run.name]
            if let pending { fields["pendingStop"] = pending.reason }
            record("rec.failed", fields)
            try? FileManager.default.removeItem(at: take.run.directory)
            self.take = nil
            state = .failed(failure.message)
            // Held only when a stop was waiting; there is nothing left to finish.
            endBackgroundTask()
            idleAngleChanged(idleAngle())
            return
        case .success(let report):
            // The microphone iOS chose, read again now the session runs (R1): REC may have come before the
            // audio route was set up. By port type only, never the port's name.
            if let mic = Self.micPortType(), mic != take.meta.micName {
                take.meta.micName = mic
                self.take = take
                try? take.run.writeMeta(take.meta)
            }
            announceCamera(report.uniqueID)
            var fields: [String: any Sendable] = [
                "run": take.run.name,
                "facing": Self.name(facing),
                "orientation": take.meta.orientation,
                "deviceOrientation": Self.deviceOrientationName(UIDevice.current.orientation),
                "width": take.settings.width,
                "height": take.settings.height,
                "angle": report.angle,
                "rotationApplied": report.angleApplied,
                "rotationChanged": report.angleChanged,
                "mirrored": report.mirrored,
                "pixelFormat": report.pixelFormat,
                "freeBytes": free,
                "msFromPress": Self.ms(ProcessInfo.processInfo.systemUptime - take.pressedUptime),
            ]
            for (position, angle) in take.angles { fields["angle.\(Self.name(position))"] = angle }
            if let mic = take.meta.micName { fields["mic"] = mic }
            record("rec.start", fields)
            state = .recording(since: Date())
            UIApplication.shared.isIdleTimerDisabled = true
            startHeartbeat()
            if let pending = pendingStop {
                pendingStop = nil
                stop(reason: pending.reason, trigger: pending.trigger)
            }
        }
    }

    private func refuse(_ message: String, _ fields: [String: any Sendable] = [:]) {
        var all = fields
        all["during"] = "start"
        all["error"] = message
        record("rec.failed", all)
        state = .failed(message)
    }

    // MARK: Stop

    func stop(reason: String) {
        stop(reason: reason, trigger: "call")
    }

    private func stop(reason: String, trigger: String) {
        switch state {
        case .starting:
            // The sink is handed the writer on the session queue; stop once that has happened. The writers
            // are already open, so background time is held from now, not from when the stop is carried out.
            holdBackgroundTime()
            if pendingStop == nil {
                pendingStop = (reason, trigger)
                record("rec.stop", ["reason": reason, "trigger": trigger, "pending": true])
            }
            return
        case .recording: break
        default: return
        }
        guard var take else { return }
        holdBackgroundTime()
        state = .stopping
        stopHeartbeat()
        let s = take.writer.stats
        stats = s
        record("rec.stop", ["reason": reason, "trigger": trigger, "frames": s.videoFrames, "dropped": s.droppedVideoFrames])
        // The reason goes into run.json now, still cut, so it is with the run even if iOS ends the app
        // before the finish rewrites it (R7).
        take.meta.stoppedBecause = reason
        self.take = take
        do { try take.run.writeMeta(take.meta) } catch {
            record("rec.failed", ["during": "stop", "error": "run.json could not be rewritten: \(error.localizedDescription)", "run": take.run.name])
        }
        Task { await finishTake(reason: reason) }
    }

    /// Background time to finish the open writers, held until finishTake (or a failed start) ends it.
    private func holdBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish the take") { [weak self] in
            MainActor.assumeIsolated { self?.backgroundTimeRanOut() }
        }
    }

    private func finishTake(reason: String) async {
        defer { endBackgroundTask() }
        // Once the sink lets go, nothing else appends: the writer is the finish's alone.
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in sink.end { done.resume() } }
        guard let writer = take?.writer else { return }
        do {
            let final = try await writer.finish()
            guard var take else { return }
            let bytes = Self.fileSize(take.run.videoURL)
            let narrationBytes = Self.fileSize(take.run.narrationURL)
            take.meta.cut = false
            take.meta.stoppedBecause = reason
            take.meta.durationMs = Self.durationMs(final, fps: take.settings.fps)
            take.meta.videoFrames = final.videoFrames
            take.meta.droppedVideoFrames = final.droppedVideoFrames
            take.meta.audioBuffers = final.audioBuffers
            take.meta.bytes = bytes
            take.meta.narrationBytes = narrationBytes
            var written = true
            do { try take.run.writeMeta(take.meta) } catch {
                written = false
                record("rec.failed", ["during": "finish", "error": "run.json could not be rewritten: \(error.localizedDescription)", "run": take.run.name])
            }
            self.take = take
            stats = final
            var fields: [String: any Sendable] = [
                "run": take.run.name,
                "reason": reason,
                "frames": final.videoFrames,
                "dropped": final.droppedVideoFrames,
                "wrongSize": final.wrongSizeVideoFrames,
                "audio": final.audioBuffers,
                "droppedAudio": final.droppedAudioBuffers,
                "audioBeforeStart": final.audioBeforeStart,
                "audioGaps": final.audioGaps,
                "filledAudioMs": Self.ms(final.filledAudioSeconds),
                "bytes": bytes,
                "narrationBytes": narrationBytes,
                "flipGapsMs": take.meta.flipGapsMs,
                "cameras": take.meta.cameras.map { "\($0.facing)@\($0.atMs)" },
                "runJson": written,
            ]
            if let duration = take.meta.durationMs { fields["durationMs"] = duration }
            record("rec.finished", fields)
            self.take = nil
            lastRun = take.run
            state = .idle
            UIApplication.shared.isIdleTimerDisabled = false
            onFinished?(take.run)
        } catch {
            guard var take else { return }
            let message = (error as? MovieWriterError)?.description ?? error.localizedDescription
            record("rec.failed", ["during": "finish", "error": message, "reason": reason, "run": take.run.name])
            // Still cut: what the fragments hold is kept, with the reason it stopped.
            take.meta.stoppedBecause = reason
            try? take.run.writeMeta(take.meta)
            self.take = nil
            let fm = FileManager.default
            if fm.fileExists(atPath: take.run.videoURL.path) || fm.fileExists(atPath: take.run.narrationURL.path) {
                lastRun = take.run
            } else {
                // No frame was ever written: a folder with only run.json is not a recording.
                try? fm.removeItem(at: take.run.directory)
            }
            state = .failed("the take did not finish: \(message)")
            UIApplication.shared.isIdleTimerDisabled = false
        }
        // The phone may have turned during the take; follow it again from now.
        idleAngleChanged(idleAngle())
    }

    private func backgroundTimeRanOut() {
        record("rec.failed", ["during": "finish", "error": "iOS's background time ran out before the take was finished"])
        endBackgroundTask()
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    // MARK: Photo

    /// A photo from the camera showing, at the phone's angle now: the camera's own bytes (HEIC or JPEG, with
    /// its tags), for PhotoPrep. Refused while a take is starting, recording or stopping.
    func takePhoto() async throws -> Data {
        switch state {
        case .idle, .failed: break
        default: throw CaptureFailure("a take is recording, so no photo is taken")
        }
        guard !flipping else { throw CaptureFailure("the camera is changing") }
        let angle = idleAngle()
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            graph.capturePhoto(angle: angle) { continuation.resume(with: $0) }
        }
        record("photo.taken", ["camera": Self.name(facing), "angle": angle, "bytes": data.count])
        return data
    }

    // MARK: Flip

    func flip() {
        let to: AVCaptureDevice.Position = facing == .back ? .front : .back
        guard !flipping, graph.device(to) != nil else { return }
        let angle: Int
        let oldAngle: Int
        switch state {
        case .recording:
            guard var take else { return }
            // One flip at a time: until this camera's first frame is written (or the wait gives up), a second
            // flip would leave the first one's span and gap unmeasured.
            guard take.flipBegan == nil else {
                record("rec.flip.refused", ["to": Self.name(to), "reason": "the last flip's first frame has not been written yet"])
                return
            }
            // The angle that matches the phone as it was at REC (R6), not as it is now.
            angle = take.angles[to] ?? take.angles[facing] ?? 90
            oldAngle = take.angles[facing] ?? angle
            let s = take.writer.stats
            var fields: [String: any Sendable] = ["from": Self.name(facing), "to": Self.name(to), "angle": angle,
                                                  // The take's silence so far; the next heartbeats' minus this is the flip's.
                                                  "filledAudioMs": Self.ms(s.filledAudioSeconds), "audioGaps": s.audioGaps]
            if let last = s.lastVideoSeconds {
                fields["lastVideoSeconds"] = last
                if let start = s.startSeconds { fields["lastVideoMs"] = Self.ms(last - start) }
            }
            let began = ProcessInfo.processInfo.systemUptime
            take.flipBegan = began
            self.take = take
            record("rec.flip.begin", fields)
            sink.awaitCamera(to)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(Self.flipWaitSeconds))
                self?.flipWaitEnded(began)
            }
        case .idle, .failed:
            angle = coordinators[to].map { Self.rightAngle($0.videoRotationAngleForHorizonLevelCapture) } ?? 90
            oldAngle = idleAngle()
        default:
            return
        }
        flipping = true
        graph.switchCamera(to: to, angle: angle, oldAngle: oldAngle) { [weak self] outcome in
            Task { @MainActor in self?.switched(to: to, outcome) }
        }
    }

    private func switched(to position: AVCaptureDevice.Position, _ outcome: Result<ConnectionReport, CaptureFailure>) {
        flipping = false
        switch outcome {
        case .success(let report):
            facing = position
            followIdleOrientation()
            announceCamera(report.uniqueID)
            if take != nil, report.uniqueID != nil, !report.angleApplied || report.mirrored {
                record("rec.failed", ["during": "flip", "error": "the new camera's connection is not as the take needs it",
                                      "rotationApplied": report.angleApplied, "mirrored": report.mirrored])
            }
        case .failure(let failure):
            sink.awaitCamera(nil)
            take?.flipBegan = nil
            record("rec.failed", ["during": "flip", "error": failure.message])
        }
    }

    /// The flip that began at `began` has had no frame written from its camera for flipWaitSeconds: FLIP
    /// works again. The sink still waits for that camera, so a later first frame is still reported.
    private func flipWaitEnded(_ began: TimeInterval) {
        guard var take, take.flipBegan == began else { return }
        take.flipBegan = nil
        self.take = take
        record("rec.failed", ["during": "flip", "facing": Self.name(facing),
                              "error": "no frame was written from the new camera within \(Self.flipWaitSeconds) s of the flip"])
    }

    // MARK: The sink's events

    private func handle(_ event: SinkEvent) {
        guard var take else { return }
        switch event {
        case .firstFrame(let pts, let uptime):
            record("rec.firstFrame", ["pts": pts, "msFromPress": Self.ms(uptime - take.pressedUptime),
                                      "facing": Self.name(facing)])
        case .cameraFirstFrame(let report, let uptime):
            report.apply(cameras: &take.meta.cameras, flipGapsMs: &take.meta.flipGapsMs)
            var fields: [String: any Sendable] = ["facing": report.facing, "atMs": report.atMs]
            // No gap when nothing was written before it: the flip came before the take's first frame.
            if let gap = report.gapMs { fields["gapMs"] = gap } else { fields["firstCamera"] = true }
            if let began = take.flipBegan { fields["msFromFlip"] = Self.ms(uptime - began) }
            take.flipBegan = nil
            self.take = take
            // Still cut: a crash after the flip keeps the flip in run.json.
            try? take.run.writeMeta(take.meta)
            record("rec.flip.firstFrame", fields)
        }
    }

    // MARK: Heartbeat

    private func startHeartbeat() {
        stopHeartbeat()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.beat() }
        }
        // Common modes, so the heartbeat goes on while the screen is being scrolled.
        RunLoop.main.add(timer, forMode: .common)
        heartbeat = timer
    }

    private func stopHeartbeat() {
        heartbeat?.invalidate()
        heartbeat = nil
    }

    private func beat() {
        guard let take, case .recording = state else { return }
        let s = take.writer.stats
        stats = s
        record("rec.heartbeat", [
            "frames": s.videoFrames,
            "dropped": s.droppedVideoFrames,
            "audio": s.audioBuffers,
            "droppedAudio": s.droppedAudioBuffers,
            "lateFrames": sink.lateFrames,
            "audioGaps": s.audioGaps,
            "filledAudioMs": Self.ms(s.filledAudioSeconds),
            "bytes": Self.fileSize(take.run.videoURL),
            "thermal": Self.thermalName(ProcessInfo.processInfo.thermalState),
        ])
        if let failure = s.failure {
            stop(reason: "the writer failed: \(failure)", trigger: "heartbeat")
        }
    }

    // MARK: Interruptions (R7)

    private func observeInterruptions() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: .main) { [weak self] note in
            let raw = (note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)?.intValue
            MainActor.assumeIsolated { self?.interrupted(raw) }
        })
        observers.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.record("rec.interruptionEnded", ["recording": self?.take != nil]) }
        })
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { [weak self] note in
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
            let code = error?.code ?? 0
            let domain = error?.domain ?? "unknown"
            MainActor.assumeIsolated { self?.runtimeError(code: code, domain: domain) }
        })
        // AirPods connected or taken out mid-take: which input the take's sound now comes from, by type.
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let raw = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
            MainActor.assumeIsolated { self?.routeChanged(raw) }
        })
        // A SwiftUI app is scene based; both the app's and the scene's notifications are watched, and
        // the first one to arrive stops the take.
        let leaving: [(Notification.Name, String)] = [
            (UIApplication.willResignActiveNotification, "willResignActive"),
            (UIApplication.didEnterBackgroundNotification, "didEnterBackground"),
            (UIScene.willDeactivateNotification, "sceneWillDeactivate"),
            (UIScene.didEnterBackgroundNotification, "sceneDidEnterBackground"),
        ]
        for (name, trigger) in leaving {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.leaving(trigger) }
            })
        }
    }

    private func interrupted(_ raw: Int?) {
        let name = raw.flatMap(AVCaptureSession.InterruptionReason.init(rawValue:)).map(Self.reasonName) ?? "unknown(\(raw.map(String.init) ?? "none"))"
        record("rec.interrupted", ["reason": name, "recording": isRecordingOrStarting])
        if isRecordingOrStarting { stop(reason: "interrupted: \(name)", trigger: "interruption") }
    }

    private func runtimeError(code: Int, domain: String) {
        record("rec.interrupted", ["reason": "runtimeError", "code": code, "domain": domain, "recording": isRecordingOrStarting])
        if isRecordingOrStarting { stop(reason: "capture error \(domain) \(code)", trigger: "runtimeError") }
    }

    /// Stops on the first of the four. Resigning active also happens when Polydance stays on the screen
    /// (Control Center, an alert), so the reason says which it was rather than claiming a departure.
    private func leaving(_ trigger: String) {
        guard isRecordingOrStarting else { return }
        let reason = switch trigger {
        case "willResignActive", "sceneWillDeactivate": "Polydance stopped being active (\(trigger))"
        default: "Polydance left the screen (\(trigger))"
        }
        stop(reason: reason, trigger: trigger)
    }

    private func routeChanged(_ raw: UInt?) {
        guard take != nil else { return }
        let reason = raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)).map(Self.routeReasonName) ?? "unknown(\(raw.map(String.init) ?? "none"))"
        var fields: [String: any Sendable] = ["reason": reason]
        if let mic = Self.micPortType() { fields["mic"] = mic }
        record("rec.route", fields)
    }

    // MARK: Orientation while idle

    /// While no take is running, `orientation` and the data output's connection follow the phone.
    private func followIdleOrientation() {
        idleObservation = coordinators[facing]?.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.initial, .new]) { [weak self] coordinator, _ in
            let angle = Self.rightAngle(coordinator.videoRotationAngleForHorizonLevelCapture)
            MainActor.assumeIsolated { self?.idleAngleChanged(angle) }
        }
    }

    private func idleAngleChanged(_ angle: Int) {
        guard take == nil, !flipping else { return }
        let back = coordinators[.back].map { Self.rightAngle($0.videoRotationAngleForHorizonLevelCapture) }
        orientation = Self.orientationName(angle: back ?? angle)
        graph.orientIfRunning(angle: angle)
    }

    private func idleAngle() -> Int {
        coordinators[facing].map { Self.rightAngle($0.videoRotationAngleForHorizonLevelCapture) } ?? 90
    }

    private func announceCamera(_ uniqueID: String?) {
        guard let uniqueID else { return }
        NotificationCenter.default.post(name: .polydanceCameraChanged, object: session, userInfo: ["uniqueID": uniqueID])
    }

    // MARK: The log

    /// Writes to the app's log and to the take's own timeline, with the app's state at that moment.
    private func record(_ event: String, _ fields: [String: any Sendable] = [:]) {
        var all = fields
        all["appState"] = ProbeAppState.current()
        log.write(event, all)
        take?.timeline?.write(event, all)
    }

    // MARK: Pure helpers

    /// The angle as 0, 90, 180 or 270.
    nonisolated static func rightAngle(_ angle: CGFloat) -> Int {
        let quarter = Int((Double(angle) / 90).rounded()) * 90
        return ((quarter % 360) + 360) % 360
    }

    /// Upright pixels: a camera turned a quarter gives portrait frames.
    nonisolated static func size(forAngle angle: Int) -> (width: Int, height: Int) {
        angle == 90 || angle == 270 ? (1080, 1920) : (1920, 1080)
    }

    /// The phone's orientation, named as UIDeviceOrientation names it, from the back camera's capture
    /// angle: 0 is the sensor's own orientation, the phone on its side with the top to the left
    /// (UIDeviceOrientation.landscapeLeft). The front camera's angle for the same phone may differ, so
    /// the back camera's is the one named; rec.start logs both, and the phone's own orientation, to check.
    nonisolated static func orientationName(angle: Int) -> String {
        switch angle {
        case 0: "landscapeLeft"
        case 180: "landscapeRight"
        case 270: "portraitUpsideDown"
        default: "portrait"
        }
    }

    nonisolated static func name(_ position: AVCaptureDevice.Position) -> String {
        switch position {
        case .back: "back"
        case .front: "front"
        default: "unspecified"
        }
    }

    nonisolated static func reasonName(_ reason: AVCaptureSession.InterruptionReason) -> String {
        switch reason {
        case .videoDeviceNotAvailableInBackground: "videoDeviceNotAvailableInBackground"
        case .audioDeviceInUseByAnotherClient: "audioDeviceInUseByAnotherClient"
        case .videoDeviceInUseByAnotherClient: "videoDeviceInUseByAnotherClient"
        case .videoDeviceNotAvailableWithMultipleForegroundApps: "videoDeviceNotAvailableWithMultipleForegroundApps"
        case .videoDeviceNotAvailableDueToSystemPressure: "videoDeviceNotAvailableDueToSystemPressure"
        case .sensitiveContentMitigationActivated: "sensitiveContentMitigationActivated"
        @unknown default: "unknown(\(reason.rawValue))"
        }
    }

    nonisolated static func routeReasonName(_ reason: AVAudioSession.RouteChangeReason) -> String {
        switch reason {
        case .unknown: "unknown"
        case .newDeviceAvailable: "newDeviceAvailable"
        case .oldDeviceUnavailable: "oldDeviceUnavailable"
        case .categoryChange: "categoryChange"
        case .override: "override"
        case .wakeFromSleep: "wakeFromSleep"
        case .noSuitableRouteForCategory: "noSuitableRouteForCategory"
        case .routeConfigurationChange: "routeConfigurationChange"
        @unknown default: "unknown(\(reason.rawValue))"
        }
    }

    nonisolated static func deviceOrientationName(_ orientation: UIDeviceOrientation) -> String {
        switch orientation {
        case .portrait: "portrait"
        case .portraitUpsideDown: "portraitUpsideDown"
        case .landscapeLeft: "landscapeLeft"
        case .landscapeRight: "landscapeRight"
        case .faceUp: "faceUp"
        case .faceDown: "faceDown"
        case .unknown: "unknown"
        @unknown default: "unknown(\(orientation.rawValue))"
        }
    }

    nonisolated static func thermalName(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown(\(state.rawValue))"
        }
    }

    nonisolated static func ms(_ seconds: Double) -> Int { Int((seconds * 1000).rounded()) }

    /// From the first frame to the end of the last one.
    nonisolated static func durationMs(_ s: MovieWriterStats, fps: Int) -> Int? {
        guard let start = s.startSeconds, let last = s.lastVideoSeconds else { return nil }
        return ms(last - start + 1 / Double(max(fps, 1)))
    }

    nonisolated static func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
    }

    nonisolated static func excludeFromBackup(_ url: URL) {
        var url = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    /// `model` is the hardware identifier (iPhone14,5) and `system` the OS (iOS 26.3); never the phone's name.
    private static func deviceInfo() -> [String: String] {
        var info = utsname()
        uname(&info)
        var model = withUnsafeBytes(of: &info.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
        if model == "arm64" || model == "x86_64", let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            model = simulated
        }
        return ["model": model, "system": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"]
    }

    /// The input iOS chose, by type only (MicrophoneBuiltIn, BluetoothHFP): a port's name can be a person's.
    private static func micPortType() -> String? {
        AVAudioSession.sharedInstance().currentRoute.inputs.first?.portType.rawValue
    }
}

// MARK: - The session

/// One photo's delegate: kept by the graph until the photo is in, then it hands over the file's bytes.
nonisolated final class PhotoCatcher: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    private let done: @Sendable (Result<Data, CaptureFailure>) -> Void
    init(_ done: @escaping @Sendable (Result<Data, CaptureFailure>) -> Void) { self.done = done }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        if let error { return done(.failure(CaptureFailure("the photo was not taken: \(error.localizedDescription)"))) }
        guard let data = photo.fileDataRepresentation() else { return done(.failure(CaptureFailure("the camera gave no photo"))) }
        done(.success(data))
    }
}

struct CaptureFailure: Error, Sendable {
    let message: String
    init(_ message: String) { self.message = message }
}

/// How the video data output's connection was left: what rec.start and a flip report.
struct ConnectionReport: Sendable {
    var uniqueID: String?
    var angle: Int
    var angleApplied: Bool
    var angleChanged: Bool
    var mirrored: Bool
    var pixelFormat: String
}

/// The session's inputs and outputs, changed only on `queue`.
nonisolated final class CaptureGraph: @unchecked Sendable {
    let session = AVCaptureSession()
    let back: AVCaptureDevice?
    let front: AVCaptureDevice?
    private let queue = DispatchQueue(label: "net.polydance.capture.iphone.session", qos: .userInitiated)
    private let sink: CaptureSink
    private let videoOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()
    private let photoOutput = AVCapturePhotoOutput()
    // Session queue only.
    private var photoCatchers: [Int64: PhotoCatcher] = [:]
    private var videoInput: AVCaptureDeviceInput?
    private var configured = false

    init(sink: CaptureSink) {
        self.sink = sink
        back = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        front = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
    }

    func device(_ position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        position == .front ? front : back
    }

    /// Configures the session (once) with `facing` and starts it running.
    func start(facing: AVCaptureDevice.Position, angle: Int, completion: @escaping @Sendable (Result<ConnectionReport, CaptureFailure>) -> Void) {
        queue.async { [self] in
            if !configured, let failure = configure(facing: facing, angle: angle) { return completion(.failure(failure)) }
            if !session.isRunning { session.startRunning() }
            session.beginConfiguration()
            let report = orient(angle: angle)
            session.commitConfiguration()
            completion(.success(report))
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    /// For REC: the session configured and running, and the connection turned to `angle` with mirroring off.
    func prepareTake(facing: AVCaptureDevice.Position, angle: Int, completion: @escaping @Sendable (Result<ConnectionReport, CaptureFailure>) -> Void) {
        queue.async { [self] in
            if !configured, let failure = configure(facing: facing, angle: angle) { return completion(.failure(failure)) }
            guard videoInput?.device.position == facing else { return completion(.failure(CaptureFailure("the session's camera is not the \(facing == .front ? "front" : "back") one"))) }
            if !session.isRunning { session.startRunning() }
            guard session.isRunning else { return completion(.failure(CaptureFailure("the capture session did not start running"))) }
            session.beginConfiguration()
            let report = orient(angle: angle)
            session.commitConfiguration()
            guard report.angleApplied else { return completion(.failure(CaptureFailure("the camera's connection does not take a \(angle)° rotation"))) }
            completion(.success(report))
        }
    }

    /// While idle, keeps the connection at the phone's angle so REC rarely reconfigures the pipeline.
    func orientIfRunning(angle: Int) {
        queue.async { [self] in
            guard configured, session.isRunning else { return }
            session.beginConfiguration()
            _ = orient(angle: angle)
            session.commitConfiguration()
        }
    }

    /// Swaps the camera inside one configuration change; the outputs, the microphone and the writer go on.
    /// `angle` is for the new camera, `oldAngle` for the old one if the swap fails and it is put back.
    /// Before the session is configured there is nothing to swap: the next configuration takes the camera.
    func switchCamera(to position: AVCaptureDevice.Position, angle: Int, oldAngle: Int,
                      completion: @escaping @Sendable (Result<ConnectionReport, CaptureFailure>) -> Void) {
        queue.async { [self] in
            guard configured else {
                return completion(.success(ConnectionReport(uniqueID: nil, angle: angle, angleApplied: false, angleChanged: false, mirrored: false, pixelFormat: "none")))
            }
            guard let device = device(position) else { return completion(.failure(CaptureFailure("there is no such camera"))) }
            let input: AVCaptureDeviceInput
            do { input = try AVCaptureDeviceInput(device: device) } catch {
                return completion(.failure(CaptureFailure("the camera could not be opened: \(error.localizedDescription)")))
            }
            session.beginConfiguration()
            let old = videoInput
            if let old { session.removeInput(old) }
            var failure: CaptureFailure?
            if session.canAddInput(input) {
                session.addInput(input)
                videoInput = input
            } else {
                failure = CaptureFailure("the session would not take the other camera")
                if let old, session.canAddInput(old) { session.addInput(old) }
            }
            if session.canSetSessionPreset(.hd1920x1080) { session.sessionPreset = .hd1920x1080 }
            let report = orient(angle: failure == nil ? angle : oldAngle)
            session.commitConfiguration()
            if let failure { return completion(.failure(failure)) }
            completion(.success(report))
        }
    }

    /// One photo at `angle` (as a tag PhotoPrep applies), not mirrored, as the camera's own file bytes.
    func capturePhoto(angle: Int, completion: @escaping @Sendable (Result<Data, CaptureFailure>) -> Void) {
        queue.async { [self] in
            guard configured, session.isRunning, session.outputs.contains(photoOutput) else {
                return completion(.failure(CaptureFailure("the camera is not running")))
            }
            if let connection = photoOutput.connection(with: .video) {
                if connection.isVideoRotationAngleSupported(CGFloat(angle)) { connection.videoRotationAngle = CGFloat(angle) }
                if connection.isVideoMirroringSupported {
                    connection.automaticallyAdjustsVideoMirroring = false
                    connection.isVideoMirrored = false
                }
            }
            // The largest the camera showing gives: the front and back cameras' formats differ, and asking
            // for more than the format has is an exception, not an error.
            if let format = videoInput?.device.activeFormat,
               let largest = format.supportedMaxPhotoDimensions.max(by: { $0.width * $0.height < $1.width * $1.height }),
               photoOutput.maxPhotoDimensions.width != largest.width || photoOutput.maxPhotoDimensions.height != largest.height {
                photoOutput.maxPhotoDimensions = largest
            }
            let settings = photoOutput.availablePhotoCodecTypes.contains(.jpeg)
                ? AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg]) : AVCapturePhotoSettings()
            settings.maxPhotoDimensions = photoOutput.maxPhotoDimensions
            settings.photoQualityPrioritization = .balanced
            settings.flashMode = .off
            let id = settings.uniqueID
            photoCatchers[id] = PhotoCatcher { [self] result in
                queue.async { self.photoCatchers[id] = nil }
                completion(result)
            }
            photoOutput.capturePhoto(with: settings, delegate: photoCatchers[id]!)
        }
    }

    /// Adds the camera, the microphone and both data outputs. Session queue only; nil when it worked.
    private func configure(facing: AVCaptureDevice.Position, angle: Int) -> CaptureFailure? {
        guard let camera = device(facing) else { return CaptureFailure("there is no \(facing == .front ? "front" : "back") camera") }
        guard let microphone = AVCaptureDevice.default(for: .audio) else { return CaptureFailure("there is no microphone") }
        let cameraInput: AVCaptureDeviceInput
        let micInput: AVCaptureDeviceInput
        do {
            cameraInput = try AVCaptureDeviceInput(device: camera)
            micInput = try AVCaptureDeviceInput(device: microphone)
        } catch {
            return CaptureFailure("the camera or microphone could not be opened (are both allowed?): \(error.localizedDescription)")
        }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard session.canAddInput(cameraInput) else { return CaptureFailure("the session would not take the camera") }
        session.addInput(cameraInput)
        // R1, "AirPods when connected": without this opt-in (false by default, AVCaptureSession.h, iOS 26)
        // the session never lets AirPods be the capture microphone.
        session.configuresApplicationAudioSessionForBluetoothHighQualityRecording = true
        guard session.canAddInput(micInput) else { return CaptureFailure("the session would not take the microphone") }
        session.addInput(micInput)
        guard session.canSetSessionPreset(.hd1920x1080) else { return CaptureFailure("the camera has no 1920 x 1080") }
        session.sessionPreset = .hd1920x1080

        videoOutput.alwaysDiscardsLateVideoFrames = true
        guard session.canAddOutput(videoOutput) else { return CaptureFailure("the session would not take the video output") }
        session.addOutput(videoOutput)
        // 420v, the camera's own format, which the H.264 encoder takes without a conversion.
        let wanted = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        if videoOutput.availableVideoPixelFormatTypes.contains(wanted) {
            videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: wanted]
        }
        videoOutput.setSampleBufferDelegate(sink, queue: sink.queue)
        guard session.canAddOutput(audioOutput) else { return CaptureFailure("the session would not take the audio output") }
        session.addOutput(audioOutput)
        audioOutput.setSampleBufferDelegate(sink, queue: sink.queue)
        // Photos; a session that will not take the output still records, and a photo says why it cannot.
        if session.canAddOutput(photoOutput) { session.addOutput(photoOutput) }

        videoInput = cameraInput
        _ = orient(angle: angle)
        configured = true
        return nil
    }

    /// Turns the video data output's connection to `angle` (a data output rotates the buffers themselves)
    /// and turns its mirroring off, and says how the connection was left. Session queue only.
    private func orient(angle: Int) -> ConnectionReport {
        let format = (videoOutput.videoSettings?[kCVPixelBufferPixelFormatTypeKey as String] as? NSNumber).map { Self.fourCC($0.uint32Value) } ?? "default"
        var result = ConnectionReport(uniqueID: videoInput?.device.uniqueID, angle: angle, angleApplied: false, angleChanged: false, mirrored: false, pixelFormat: format)
        guard let connection = videoOutput.connection(with: .video) else { return result }
        let wanted = CGFloat(angle)
        if connection.isVideoRotationAngleSupported(wanted), connection.videoRotationAngle != wanted {
            connection.videoRotationAngle = wanted
            result.angleChanged = true
        }
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = false
        }
        result.angleApplied = connection.videoRotationAngle == wanted
        result.mirrored = connection.isVideoMirrored
        return result
    }

    private static func fourCC(_ code: UInt32) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8((code >> UInt32($0)) & 0xFF) }
        return String(decoding: bytes, as: UTF8.self)
    }
}

// MARK: - The capture queue

enum SinkEvent: Sendable {
    /// The take's first frame written: its presentation time and when it arrived (system uptime).
    case firstFrame(pts: Double, uptime: TimeInterval)
    /// The first frame written from the camera a flip asked for, as FlipClock measured it.
    case cameraFirstFrame(FlipClock.Report, uptime: TimeInterval)
}

/// The delegate for both data outputs, on one serial queue. Its take state is touched only on `queue`.
nonisolated final class CaptureSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "net.polydance.capture.iphone.capture", qos: .userInitiated)
    private let counterLock = NSLock()
    private var late = 0
    // Set once, before the session starts.
    private var emit: (@Sendable (SinkEvent) -> Void)?
    // Capture queue only.
    private var writer: MovieWriter?
    private var sawFirstFrame = false
    private var clock = FlipClock()

    func onEvent(_ handler: @escaping @Sendable (SinkEvent) -> Void) { emit = handler }

    /// Frames the camera dropped because the queue was late (alwaysDiscardsLateVideoFrames).
    var lateFrames: Int { counterLock.withLock { late } }

    /// The microphone's average power in dB as the last buffer's connection reported it (AVCaptureAudioChannel),
    /// for the MIC meter, whether or not a take is being written; nil before the first buffer.
    var micDecibels: Float? { counterLock.withLock { decibels } }
    private var decibels: Float?

    func begin(_ writer: MovieWriter) {
        queue.async { [self] in
            self.writer = writer
            sawFirstFrame = false
            clock = FlipClock()
            counterLock.withLock { late = 0 }
        }
    }

    /// Lets go of the writer; `done` runs on the capture queue once no more buffers will reach it.
    func end(_ done: @escaping @Sendable () -> Void) {
        queue.async { [self] in
            writer = nil
            clock = FlipClock()
            done()
        }
    }

    /// The flip's camera: its first written frame is reported with the gap before it (nil stops waiting).
    func awaitCamera(_ position: AVCaptureDevice.Position?) {
        queue.async { [self] in clock.expect(position.map(CaptureRecorder.name)) }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output is AVCaptureAudioDataOutput, let channel = connection.audioChannels.first {
            let level = channel.averagePowerLevel
            counterLock.withLock { decibels = level }
        }
        guard let writer else { return }
        if output is AVCaptureAudioDataOutput {
            writer.appendAudio(sampleBuffer)
            return
        }
        let before = writer.stats.videoFrames
        writer.appendVideo(sampleBuffer)
        let after = writer.stats
        let written = after.videoFrames > before
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        let now = ProcessInfo.processInfo.systemUptime
        if written, !sawFirstFrame {
            sawFirstFrame = true
            emit?(.firstFrame(pts: pts, uptime: now))
        }
        // Every frame goes to the clock with whether it was written and which camera's connection gave it,
        // so the old camera's late frames and the new camera's dropped ones are counted as they were.
        let facing = Self.position(of: connection).map(CaptureRecorder.name)
        if let report = clock.frame(pts: pts, written: written, facing: facing, sessionStart: after.startSeconds) {
            emit?(.cameraFirstFrame(report, uptime: now))
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard writer != nil, output is AVCaptureVideoDataOutput else { return }
        counterLock.withLock { late += 1 }
    }

    private static func position(of connection: AVCaptureConnection) -> AVCaptureDevice.Position? {
        (connection.inputPorts.first?.input as? AVCaptureDeviceInput)?.device.position
    }
}
