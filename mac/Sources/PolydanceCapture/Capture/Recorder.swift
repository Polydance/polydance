// One recording: three independent sources into one file, so audio never depends on the screen
// permission (C11). The sound tap and the microphone start at once and their buffers are held while the
// screen is given up to 5 s to start. Then the writer is made with the tracks that started, the held
// buffers go in (the writer queues audio rather than drop it), and everything after streams straight
// through. A screen that is allowed but still starting at 5 s (macOS asking again, about monthly, whether
// Polydance may record it) gets its track anyway, black from the start in a gap its first frame ends:
// before 2026-11-13 it was dropped, and a call whose stream started 5.9 s in was audio only for 1 h 40.
// A microphone macOS is still asking about does not hold the writer: its track is added and starts late,
// keeping its offset, or gets nothing and is left out. A recording is never lost to a slow
// permission, only delayed in being written. A walkthrough can be asked for with the mic or the Mac's
// sound switched off (WalkthroughSounds): that source is never started and its track never declared.
//
// The metadata names only what the file holds: the audio tracks that got samples, the excluded apps that
// were really in the screen filter, and farEnd only once it is known (heard as soon as it is, silent at
// the clean stop). It is rewritten on disk as those facts change (a track's first sample, the far end
// first heard, a mark, who was told, a source that stopped by itself), so a crash keeps them.
//
// When the screen capture stops by itself mid-recording (C14), the picture goes black from that moment,
// repeated each second as a still screen's last picture is, so audio and video stay on one clock and
// nothing reads the last picture as live (Meet's speaking ring would name the wrong person). The gap is
// noted on the recording's clock; when macOS rather than the user stopped it, the capture is started
// again (ScreenRecovery decides when and how often) and the first frame back ends the gap.
//
// Threading: public methods are called on the main queue. Sources deliver on their own queues and hop
// to `writerQueue`, which alone touches the writer and the held buffers.
import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import PolydanceCore

/// Unchecked Sendable: its state is confined by hand, main-queue state to the main queue and writer
/// state to `writerQueue`, as the header says.
final class Recorder: @unchecked Sendable {
    struct Request {
        var mode: RecordingMode
        var files: RecordingFiles
        var layout: LibraryLayout
        var excludedApps: [String]
        var fps: Int
        var appBuild: AppBuildInfo
        /// For a call: every Arc process's Core Audio object. For a walkthrough: the processes to leave out,
        /// or nil with the Mac's sound switched off.
        var tapTarget: ProcessTapSource.Target?
        /// For a call, the input Arc is using; for a walkthrough, the system default, or nil with the mic
        /// switched off.
        var micChoice: MicSource.Choice?
        /// For a walkthrough, the display or window the person pointed at; nil records the display Arc is on.
        var screen: ScreenTarget? = nil
        /// For a call, finds the window showing it, asked as the recording starts; a window not found
        /// records the display Arc is on, and the metadata says why.
        var callWindow: (@Sendable () async -> CallWindow.Finding)? = nil
    }

    struct Outcome {
        var files: RecordingFiles
        var meta: RecordingMeta
        var seconds: Double
        var bytes: Int64
        /// Tracks in the file: video (when recorded), mic, app (each only if it got samples).
        var trackCount: Int
        /// Seconds of sound dropped because a minute was already waiting for the encoder (silence took its place).
        var soundDropped: Double
    }

    /// What the menu shows while recording.
    struct Status: Equatable {
        var micNote: String?
        var appNote: String?
        /// Switched off before recording, as chosen: not a problem, so no note.
        var micOff = false
        var appOff = false
        var screenLine = "Starting…"
        var screenDetail: String?
        /// Set once the picture has stopped for good this recording, with why: told once in a notification.
        var screenGone: String?
        var writing = false
    }

    static let screenDeadline: TimeInterval = 5
    static let micDeadline: TimeInterval = 60

    let request: Request
    let micMeter: LevelMeter
    let appMeter: LevelMeter
    private(set) var startedAt = Date()
    private(set) var status = Status()
    private(set) var marks = MarkBook()
    private var farEnd = FarEndMonitor()
    private var silentMic = SilentMicMonitor()
    /// Whether the others were told they are being recorded (PV2); the user can set it while recording,
    /// and it goes to disk at once.
    var told: ToldOthers = .unknown { didSet { if told != oldValue { writeProvisionalMeta() } } }
    /// C12's warning, while it stands: once the far end is heard it goes.
    var farEndWarning: Bool { farEnd.warning }
    /// The microphone has given only silence since the recording began (SilentMicMonitor), while it stands.
    var micSilentWarning: Bool { silentMic.warning }
    /// The input being recorded, once the microphone has started.
    var micDeviceName: String? { mic.deviceName }
    /// Main queue: set as stop begins, after which nothing but the clean stop writes the metadata (a
    /// discarded recording's is removed at once and must not come back).
    private var stopRequested = false
    /// Main queue: a source that stopped or started again by itself, with the recording's clock.
    private var soundNotes: [String] = []
    /// Called on the main queue: the status changed, or the recording failed and has stopped itself.
    var onStatus: ((Status) -> Void)?
    var onFailure: ((String) -> Void)?

    private let mic = MicSource()
    private let tap = ProcessTapSource()
    private let screen = ScreenSource()
    private let writerQueue = DispatchQueue(label: "net.polydance.capture.writer", qos: .userInitiated)

    // Writer-queue state.
    private var sink: AssetWriterSink?
    private var held: [(AssetWriterSink.Track, CMSampleBuffer)] = []
    private var heldVideo: CMSampleBuffer?
    private var decided = false
    private var stopping = false
    private var micResolved = false
    private var micProblem: String?
    private var tapResolved = false
    private var tapProblem: String?
    private var screenResolved = false
    /// The screen the picture track is made for: the stream that started in time, or at the deadline the
    /// one still starting.
    private var screenPlan: ScreenSource.Plan?
    /// What the screen's first start was planned for, once the call's window has been looked for.
    private var plannedScreen: ScreenSource.Plan?
    /// Why a call records its display rather than its window.
    private var screenNote: String?
    /// From the deadline until the late first start returns: the track is black and waits for its frames.
    private var waitingForScreen = false
    private var screenProblem: String?
    private var lastFrame: CMSampleBuffer?
    private var lastFrameAt: CMTime?
    private var repeatTimer: DispatchSourceTimer?
    private var hostAtStart = AudioBuffers.nowHostTime()
    private var failed = false
    /// The picture's stops and restarts (C14).
    private var recovery = ScreenRecovery()
    /// A restart is under way, or its stream is running: real frames now come from it. Off from a stop
    /// until the restart begins, so a frame of the stopped stream still on its way is not taken for one.
    private var restarting = false
    /// Whether the microphone could still start (allowed, or macOS is asking): the writer does not wait for it.
    private var micMayStart = false

    init(_ request: Request) {
        self.request = request
        micMeter = mic.meter
        appMeter = tap.meter
        status.micOff = request.micChoice == nil
        status.appOff = request.tapTarget == nil
    }

    // MARK: Starting

    func start() throws {
        try PrivateFiles.makeDirectory(request.layout.recordings, within: request.layout.root)
        startedAt = Date()
        hostAtStart = AudioBuffers.nowHostTime()

        tap.onSample = { [weak self] buffer in self?.writerQueue.async { self?.ingest(buffer, .app) } }
        mic.onSample = { [weak self] buffer in self?.writerQueue.async { self?.ingest(buffer, .mic) } }
        screen.onFrame = { [weak self] buffer in self?.writerQueue.async { self?.ingest(buffer, .video) } }
        screen.onStop = { [weak self] error in self?.writerQueue.async { self?.screenStopped(error) } }
        tap.onEvent = { [weak self] line in DispatchQueue.main.async { self?.soundEvent(line) } }
        mic.onEvent = { [weak self] line in DispatchQueue.main.async { self?.soundEvent(line) } }
        let authorization = MicSource.authorization
        let mayStart = request.micChoice != nil && (authorization == .authorized || authorization == .notDetermined)
        writerQueue.async { self.micMayStart = mayStart }

        // A source switched off is resolved at once with no problem: it is simply not in the file.
        let tapProblem: String?
        if let target = request.tapTarget {
            do { try tap.start(target); tapProblem = nil } catch { tapProblem = "\(error)" }
        } else {
            tapProblem = nil
        }
        writerQueue.async { self.tapResolved = true; self.tapProblem = tapProblem; self.decideIfReady() }

        if let choice = request.micChoice {
            mic.start(choice) { [weak self] problem in
                self?.writerQueue.async {
                    guard let self else { return }
                    self.micResolved = true
                    self.micProblem = problem
                    self.decideIfReady()
                    if self.decided { self.publishStatus() }
                }
            }
            // Only says why there is no microphone track if macOS is still asking; the writer does not wait.
            writerQueue.asyncAfter(deadline: .now() + Self.micDeadline) { [weak self] in
                guard let self, !self.micResolved else { return }
                self.micResolved = true
                self.micProblem = "the microphone was not allowed in time"
                self.decideIfReady()
            }
        } else {
            writerQueue.async { self.micResolved = true; self.decideIfReady() }
        }

        if ScreenSource.allowed {
            let (excluded, fps, chosen, callWindow) = (request.excludedApps, request.fps, request.screen, request.callWindow)
            Task { [weak self] in
                // A call's window is looked for first (one Apple Event to Arc, at most 3 s): the deadline
                // below still holds, and a window not found is the display, as before.
                var target = chosen
                var note: String?
                switch await callWindow?() {
                case .window(let window)?: target = window
                case .notFound(let why)?: note = "the whole display was recorded, not the call's window: \(why)"
                case nil: break
                }
                guard let self else { return }
                guard let plan = ScreenSource.plan(fps: fps, target: target) else {
                    self.writerQueue.async { self.screenFailed("no display to record") }
                    return
                }
                self.writerQueue.async { self.plannedScreen = plan; self.screenNote = note }
                do {
                    try await self.screen.start(plan, excludedBundleIDs: excluded)
                    self.writerQueue.async { self.screenReady(plan) }
                } catch {
                    self.writerQueue.async { self.screenStartFailed(error) }
                }
            }
            writerQueue.asyncAfter(deadline: .now() + Self.screenDeadline) { [weak self] in self?.screenLate() }
        } else {
            writerQueue.async { self.screenFailed("screen recording is not allowed for Polydance") }
        }
    }

    private func screenReady(_ plan: ScreenSource.Plan) {
        if waitingForScreen {
            // Late: the track was made for this plan at the deadline, and its frames are already let in.
            waitingForScreen = false
            if stopping { Task { await screen.stop() } }
            publishStatus()
            return
        }
        guard !screenResolved, !stopping else {
            // The recording stopped, or went ahead without video, before the stream was up.
            Task { await screen.stop() }
            return
        }
        screenResolved = true
        screenPlan = plan
        decideIfReady()
    }

    /// The deadline passed with the first start still under way, as when macOS is asking again whether
    /// Polydance may record the screen: the writer is made now with a picture track for the plan, black
    /// from the recording's start, and the stream's first frame, whenever it comes, ends that gap. Its
    /// frames are let in as a restarted stream's are; a start that fails is a failed try (ScreenRecovery).
    private func screenLate() {
        guard !screenResolved, !decided, !stopping else { return }
        // Not even planned: the call's window was still being looked for. Nothing to make a track for.
        guard let plan = plannedScreen else {
            screenFailed("the screen to record was not known in time")
            return
        }
        screenResolved = true
        screenPlan = plan
        waitingForScreen = true
        restarting = true
        recovery.startingLate(afterSeconds: Self.screenDeadline)
        decideIfReady()
    }

    private func screenStartFailed(_ error: Error) {
        guard waitingForScreen else {
            screenFailed("screen capture failed: \(error.localizedDescription)")
            return
        }
        waitingForScreen = false
        screenStopped(error)
    }

    private func screenFailed(_ problem: String) {
        guard !screenResolved else { return }
        screenResolved = true
        screenProblem = problem
        Task { await screen.stop() }
        decideIfReady()
    }

    /// Makes the writer once the tap and the screen have started or given up, and the microphone has
    /// too unless it can still start (or the recording is stopping).
    private func decideIfReady(force: Bool = false) {
        let micPending = !micResolved && micMayStart
        guard !decided, force || (tapResolved && screenResolved && (micResolved || micPending)) else { return }
        decided = true
        if force, !micResolved { micProblem = micProblem ?? "the microphone had not started" }
        if !screenResolved { screenProblem = screenProblem ?? "screen capture had not started" }
        let video = screenPlan?.spec
        let micWanted = request.micChoice != nil && (micResolved ? micProblem == nil : micPending)
        let micSpec = micWanted ? AssetWriterSink.AudioSpec(channels: 1, sampleRate: MicSource.sampleRate) : nil
        var appSpec: AssetWriterSink.AudioSpec?
        if request.tapTarget != nil, tapResolved, tapProblem == nil, let format = tap.format {
            // 44.1 or 48 kHz, whatever the tap's device runs at: AAC takes nothing else at this bitrate
            // (AppTrackEncoding), and the writer resamples a Bluetooth headset's 16 or 24 kHz or an
            // interface's 96 kHz.
            appSpec = AssetWriterSink.AudioSpec(channels: min(max(Int(format.mChannelsPerFrame), 1), 2),
                                                sampleRate: AppTrackEncoding.sampleRate(forTapRate: format.mSampleRate))
        }
        do {
            let sink = try AssetWriterSink(url: request.files.video, video: video, mic: micSpec, app: appSpec, queue: writerQueue)
            try? PrivateFiles.restrict(request.files.video)
            sink.onFirstSample = { [weak self] _ in DispatchQueue.main.async { self?.writeProvisionalMeta() } }
            self.sink = sink
        } catch {
            fail("\(error)")
            return
        }
        let frames = (heldVideo.map { [(AssetWriterSink.Track.video, $0)] } ?? [])
        let ordered = (held + frames).sorted(by: { CMSampleBufferGetPresentationTimeStamp($0.1) < CMSampleBufferGetPresentationTimeStamp($1.1) })
        // A screen still starting: the picture is black from the recording's first sample, not from its first frame.
        if waitingForScreen, video != nil, let sink = self.sink {
            goBlack(sink, at: ordered.first.map { CMSampleBufferGetPresentationTimeStamp($0.1) } ?? AudioBuffers.nowHostTime())
        }
        for (track, buffer) in ordered {
            write(buffer, track)
        }
        held = []
        heldVideo = nil
        if video != nil { startRepeating() }
        publishStatus()
        DispatchQueue.main.async { self.writeProvisionalMeta() }
    }

    // MARK: Samples

    private func ingest(_ buffer: CMSampleBuffer, _ track: AssetWriterSink.Track) {
        guard !stopping, !failed else { return }
        guard decided else {
            // Video frames come from a small pool: hold only the newest.
            if track == .video { heldVideo = buffer } else { held.append((track, buffer)) }
            return
        }
        write(buffer, track)
    }

    private func write(_ buffer: CMSampleBuffer, _ track: AssetWriterSink.Track, isRepeat: Bool = false) {
        guard let sink, sink.has(track) else { return }
        if track == .video {
            // While the picture is off, only a restarted stream's frames are taken.
            if !isRepeat, recovery.isOpen, !restarting { return }
            // The frame written, which may be retimed just after a repeat that got in first.
            if let written = sink.appendVideo(buffer, isRepeat: isRepeat) {
                lastFrame = written
                lastFrameAt = CMSampleBufferGetPresentationTimeStamp(written)
                if !isRepeat, recovery.isOpen, let start = sink.sessionStart, let at = lastFrameAt { pictureBack(at: at, start: start) }
            }
        } else {
            sink.append(buffer, to: track)
        }
        if let error = sink.error, !failed { fail("the recording stopped writing: \(error.localizedDescription)") }
    }

    /// ScreenCaptureKit sends no new frame while nothing on screen changes; the last picture is repeated
    /// once a second so the video track keeps pace with the audio.
    private func startRepeating() {
        let timer = DispatchSource.makeTimerSource(queue: writerQueue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, !self.stopping, let frame = self.lastFrame, let at = self.lastFrameAt else { return }
            let now = AudioBuffers.nowHostTime()
            guard CMTimeGetSeconds(CMTimeSubtract(now, at)) >= 1 else { return }
            var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: now, decodeTimeStamp: .invalid)
            var copy: CMSampleBuffer?
            guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: frame, sampleTimingEntryCount: 1,
                                                        sampleTimingArray: &timing, sampleBufferOut: &copy) == noErr, let copy else { return }
            self.write(copy, .video, isRepeat: true)
        }
        timer.resume()
        repeatTimer = timer
    }

    /// The stream stopped by itself. Before the writer has a picture track the problem is only said; with
    /// one, the picture goes black, the gap is noted, and ScreenRecovery says whether to start it again.
    private func screenStopped(_ error: Error) {
        guard !stopping, !failed else { return }
        guard let sink, sink.has(.video) else {
            lastFrame = nil
            publishStatus()
            return
        }
        let now = AudioBuffers.nowHostTime()
        // A restarted stream that stops before its first frame leaves the picture black already.
        if !recovery.isOpen { goBlack(sink, at: now) }
        restarting = false
        let start = sink.sessionStart ?? now
        let error = error as NSError
        act(recovery.stopped(cause: ScreenStopCause(domain: error.domain, code: error.code), reason: error.localizedDescription,
                             atMs: Self.ms(now, since: start), allowed: ScreenSource.allowed))
    }

    /// A black frame at `at`, repeated each second by the repeat timer until a real one replaces it. If the
    /// encoder is busy it is not written now, and the timer writes it within a second.
    private func goBlack(_ sink: AssetWriterSink, at: CMTime) {
        guard let spec = screenPlan?.spec, let black = AssetWriterSink.blackFrame(width: spec.width, height: spec.height, pts: at) else {
            lastFrame = nil
            return
        }
        if let written = sink.appendVideo(black, isRepeat: false) {
            lastFrame = written
            lastFrameAt = CMSampleBufferGetPresentationTimeStamp(written)
        } else {
            lastFrame = black
            lastFrameAt = lastFrameAt ?? CMTimeSubtract(at, CMTime(value: 1, timescale: 1))
        }
    }

    private func act(_ decision: ScreenRecovery.Decision) {
        if case .retry(let after, _, _) = decision {
            writerQueue.asyncAfter(deadline: .now() + after) { [weak self] in self?.tryRestart() }
        }
        // On giving up the black picture goes on to the end, and the open gap says so.
        publishStatus()
        DispatchQueue.main.async { self.writeProvisionalMeta() }
    }

    private func tryRestart() {
        guard !stopping, !failed, recovery.isOpen, recovery.gaveUp == nil, !restarting else { return }
        restarting = true
        publishStatus()
        Task { [weak self] in
            guard let self else { return }
            do { try await self.screen.restart() } catch {
                self.writerQueue.async { self.restartFailed(error) }
            }
        }
    }

    private func restartFailed(_ error: Error) {
        restarting = false
        guard !stopping, !failed, recovery.isOpen else { return }
        act(recovery.tryFailed(reason: error.localizedDescription, allowed: ScreenSource.allowed))
    }

    /// The first real frame after a restart: the gap ends at its time.
    private func pictureBack(at: CMTime, start: CMTime) {
        recovery.resumed(atMs: Self.ms(at, since: start))
        publishStatus()
        DispatchQueue.main.async { self.writeProvisionalMeta() }
    }

    /// The menu's words for the picture's gaps, or nil when it never stopped. Writer queue.
    private func gapLine() -> String? {
        guard let last = recovery.gaps.last else { return nil }
        // A late first start (startingLate) is the one open gap with no try made.
        let late = recovery.gaps.count == 1 && last.fromMs == 0
        if late, last.toMs == nil, recovery.attempts == 0, recovery.gaveUp == nil {
            return "Waiting for macOS to start it (it may be asking to allow screen recording): black until then"
        }
        if late, let to = last.toMs { return "Started late, at \(Self.clock(Double(to) / 1000)): black before that" }
        let from = Self.clock(Double(last.fromMs) / 1000)
        let earlier = recovery.gaps.count > 1 ? " (stopped \(recovery.gaps.count) times)" : ""
        if let to = last.toMs { return "Stopped at \(from), back at \(Self.clock(Double(to) / 1000))\(earlier)" }
        if let why = recovery.gaveUp { return "Stopped at \(from): \(last.reason). Not started again: \(why)\(earlier)" }
        let trying = restarting ? "Starting it again" : "Trying again shortly"
        return "Stopped at \(from): \(last.reason). \(trying) (try \(max(recovery.attempts, 1)) of \(ScreenRecovery.waits.count))\(earlier)"
    }

    private func fail(_ message: String) {
        guard !failed else { return }
        failed = true
        DispatchQueue.main.async { self.onFailure?(message) }
    }

    /// Main queue: the microphone or the call sound stopped (or started again) by itself. Noted with the
    /// recording's clock, and the recording is marked cut, since a stretch of that track is silence.
    private func soundEvent(_ line: String) {
        guard !stopRequested, soundNotes.count < 12 else { return }
        let start = writerQueue.sync { sink?.sessionStart } ?? hostAtStart
        soundNotes.append("\(line) at \(Self.clock(CMTimeGetSeconds(CMTimeSubtract(AudioBuffers.nowHostTime(), start))))")
        writeProvisionalMeta()
    }

    // MARK: While recording

    /// A mark at this moment (C7); the metadata on disk is rewritten so a crash keeps it.
    @discardableResult
    func mark(note: String? = nil) -> Bool {
        guard marks.add(at: CMTimeGetSeconds(AudioBuffers.nowHostTime()), note: note) else { return false }
        writeProvisionalMeta()
        return true
    }

    /// Mark clocks in ms from the recording's start, for the menu.
    var markClocks: [Int] {
        marks.marks(since: CMTimeGetSeconds(writerQueue.sync { sink?.sessionStart } ?? hostAtStart)).map(\.atMs)
    }

    /// C12, once a second for a call: true exactly once, when Arc has played for 30 s and the tap gave
    /// only zeros. The first time the far end is heard, the metadata on disk says so.
    func farEndTick(appPlaying: Bool) -> Bool {
        let heardBefore = farEnd.everHeard
        let flagged = farEnd.observe(at: ProcessInfo.processInfo.systemUptime, appPlaying: appPlaying, tapPeak: appMeter.takePeak())
        if !heardBefore, farEnd.everHeard { writeProvisionalMeta() }
        return flagged
    }

    /// Once a second while the microphone records: true exactly once, when it has given only silence for 10 s.
    func micTick() -> Bool {
        guard request.micChoice != nil else { return false }
        return silentMic.observe(at: ProcessInfo.processInfo.systemUptime, peak: micMeter.takePeak())
    }

    // MARK: Stopping

    /// Stops every source and finishes the file, or throws it away. `completion` runs on the main queue
    /// with the outcome, or nil after a discard. A discard removes the metadata at once, before the
    /// sources are stopped: a recording without metadata is never handed over, so a quit, crash or power
    /// loss during the stop cannot bring back a call the user threw away.
    func stop(reason: CallStopReason?, discard: Bool, completion: @escaping (Result<Outcome?, Error>) -> Void) {
        stopRequested = true
        if discard { _ = try? request.files.discardMetadata(recordingsDirectory: request.layout.recordings) }
        let endedAt = Date()
        DispatchQueue.global(qos: .userInitiated).async {
            self.mic.stop()
            self.tap.stop()
            let screenDone = DispatchSemaphore(value: 0)
            Task { await self.screen.stop(); screenDone.signal() }
            _ = screenDone.wait(timeout: .now() + 3)
            self.writerQueue.async {
                self.stopping = true
                self.repeatTimer?.cancel()
                self.repeatTimer = nil
                if !self.decided { self.decideIfReady(force: true) }
                guard let sink = self.sink else {
                    DispatchQueue.main.async {
                        if discard { completion(Result { try self.discardFiles(); return nil }) }
                        else { completion(.failure(CaptureError("nothing was recorded"))) }
                    }
                    return
                }
                if discard {
                    sink.cancel()
                    DispatchQueue.main.async { completion(Result { try self.discardFiles(); return nil }) }
                    return
                }
                guard sink.sessionStart != nil else {
                    // Not one sample arrived: the file and metadata hold nothing, so they go as a discard would.
                    sink.cancel()
                    DispatchQueue.main.async {
                        completion(Result { try self.discardFiles(); throw CaptureError("nothing was recorded: no source delivered any sound or picture") })
                    }
                    return
                }
                let failedBefore = self.failed
                sink.finish { error in
                    // On the writer queue, with every waiting buffer written: the counts are final.
                    let written = Written(sink)
                    DispatchQueue.main.async {
                        completion(Result {
                            try self.finalise(reason: reason, endedAt: endedAt, written: written, cut: error != nil || failedBefore, finishError: error)
                        })
                    }
                }
            }
        }
    }

    private func discardFiles() throws {
        try request.files.discard(recordingsDirectory: request.layout.recordings)
    }

    /// What the writer has done, read on the writer queue.
    private struct Written {
        var sessionStart: CMTime?
        /// The tracks the writer was made with.
        var tracks: [AssetWriterSink.Track]
        /// The tracks that got samples, which are the ones in the file.
        var withSamples: [AssetWriterSink.Track]
        var counts: [AssetWriterSink.Track: AssetWriterSink.Counts]

        init(_ sink: AssetWriterSink) {
            sessionStart = sink.sessionStart
            tracks = sink.tracks
            withSamples = sink.tracksWithSamples
            counts = sink.counts
        }
    }

    private func finalise(reason: CallStopReason?, endedAt: Date, written: Written, cut: Bool, finishError: Error?) throws -> Outcome {
        guard FileManager.default.fileExists(atPath: request.files.video.path) else {
            throw CaptureError("the recording file is missing: \(finishError?.localizedDescription ?? "unknown error")")
        }
        try? PrivateFiles.restrict(request.files.video)
        var facts = self.facts(written, final: true)
        facts.endedAt = max(endedAt, facts.startedAt)
        facts.stopReason = reason
        var meta = facts.meta()
        let dropped = (written.counts[.mic]?.droppedSeconds ?? 0) + (written.counts[.app]?.droppedSeconds ?? 0)
        // `cut` means the recording itself was cut off (C4). A source that stopped and started again, or
        // sound dropped, is told in videoNote instead, which polycap shows whenever it is there.
        if cut { meta.call?.cut = true }
        try PrivateFiles.write(try meta.encoded(), to: request.files.meta)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: request.files.video.path)[.size] as? NSNumber)?.int64Value ?? 0
        return Outcome(files: request.files, meta: meta, seconds: facts.endedAt!.timeIntervalSince(facts.startedAt), bytes: bytes,
                       trackCount: written.withSamples.count, soundDropped: dropped)
    }

    /// The metadata while the recording runs: `cut` until the clean stop replaces it, and never once the
    /// stop has begun.
    private func writeProvisionalMeta() {
        guard !stopRequested, let written = writerQueue.sync(execute: { sink.map(Written.init) }) else { return }
        try? PrivateFiles.write(try facts(written, final: false).meta().encoded(), to: request.files.meta)
    }

    /// Main queue. `final` is the clean stop's: it says silent and notes a track that got nothing.
    private func facts(_ written: Written, final: Bool) -> RecordingFacts {
        // The recording's clock starts at its first sample; its wall time follows from the host clock.
        let startHost = written.sessionStart ?? hostAtStart
        let wallStart = startedAt.addingTimeInterval(max(0, CMTimeGetSeconds(CMTimeSubtract(startHost, hostAtStart))))
        let (screenProblem, screenPlan, micProblem, tapProblem, recovery, screenNote) = writerQueue.sync {
            (self.screenProblem, self.screenPlan, self.micProblem, self.tapProblem, self.recovery, self.screenNote)
        }
        let declared = Set(written.tracks)
        let present = Set(written.withSamples)
        let videoRecorded = present.contains(.video)
        let isCall = request.mode != .walkthrough
        var notes: [String] = []
        if let screenProblem { notes.append(screenProblem) }
        // The gaps themselves are `videoGaps`; the note says why the last one never ended.
        if let why = recovery.gaveUp, let gap = recovery.gaps.last, gap.toMs == nil {
            notes.append("no picture from \(Self.clock(Double(gap.fromMs) / 1000)) to the end: \(why)")
        }
        if !videoRecorded, screenProblem == nil { notes.append("no frame was captured") }
        if videoRecorded, let screenNote { notes.append(screenNote) }
        if !present.contains(.mic) {
            if request.micChoice == nil { notes.append("no microphone track: switched off before recording") }
            else if let micProblem { notes.append("no microphone track: \(micProblem)") }
            else if final, declared.contains(.mic) { notes.append("no microphone track: no sound arrived from the microphone") }
        }
        if !present.contains(.app) {
            if request.tapTarget == nil { notes.append("no sound track: switched off before recording") }
            else if let tapProblem { notes.append("no call sound track: \(tapProblem)") }
            else if final, declared.contains(.app) { notes.append(isCall ? "no call sound track: no sound arrived from Arc" : "no sound track for the Mac's sound: nothing played") }
        }
        if let note = mic.deviceNote { notes.append(note) }
        for (track, name) in [(AssetWriterSink.Track.mic, "microphone sound"), (.app, isCall ? "call sound" : "the Mac's sound")] {
            guard let counts = written.counts[track], counts.dropped > 0 else { continue }
            let at = counts.firstDropAt.map { Self.clock(CMTimeGetSeconds(CMTimeSubtract($0, startHost))) } ?? "?"
            notes.append("\(max(1, Int(counts.droppedSeconds.rounded()))) s of \(name) was dropped from \(at) (silence in its place)")
        }
        notes += soundNotes
        let exclusions = screen.exclusions
        if videoRecorded { notes += exclusions.problems }
        let appTrack: AppTrackState = !declared.contains(.app) ? .none : present.contains(.app) ? .present : .declared
        return RecordingFacts(
            mode: request.mode, startedAt: wallStart, appBuild: request.appBuild,
            audioTracks: [AudioTrackRole.mic, .app].filter { present.contains($0 == .mic ? .mic : .app) },
            marks: marks.marks(since: CMTimeGetSeconds(startHost)),
            videoRecorded: videoRecorded, videoNote: notes.isEmpty ? nil : notes.joined(separator: "; "),
            farEnd: RecordingFacts.farEnd(appTrack: appTrack, everHeard: farEnd.everHeard, final: final),
            display: screenPlan?.pointSize, excludedApps: videoRecorded ? exclusions.apps : [], told: told,
            videoGaps: videoRecorded ? recovery.gaps : [])
    }

    private func publishStatus() {
        var next = status
        next.writing = sink != nil
        next.micNote = micProblem
        next.appNote = tapProblem
        if let started = screenPlan, sink?.has(.video) == true {
            next.screenLine = "\(started.displayName) at \(request.fps) fps"
            // A window alone has nothing around it to leave out.
            next.screenDetail = gapLine() ?? screenNote ?? (started.windowID == nil ? Self.leftOut(request.excludedApps) : nil)
            next.screenGone = recovery.gaveUp.map { why in
                guard let gap = recovery.gaps.last, recovery.gaps.count > 1 || gap.fromMs > 0 else { return "The screen did not start: \(why). The sound goes on." }
                return "The screen stopped at \(Self.clock(Double(gap.fromMs) / 1000)) and was not started again: \(why). The sound goes on."
            }
        } else if decided {
            next.screenLine = "Not recorded"
            next.screenDetail = screenProblem
        }
        DispatchQueue.main.async {
            self.status = next
            self.onStatus?(next)
        }
    }

    /// "Messages, Mail and Passwords left out".
    static func leftOut(_ bundleIDs: [String]) -> String? {
        let known = ["com.apple.MobileSMS": "Messages", "com.apple.mail": "Mail", "com.apple.Passwords": "Passwords"]
        let names = bundleIDs.map { known[$0] ?? $0.split(separator: ".").last.map(String.init) ?? $0 }
        guard !names.isEmpty else { return nil }
        let list = names.count == 1 ? names[0] : names.dropLast().joined(separator: ", ") + " and " + names.last!
        return "\(list) left out"
    }

    /// Milliseconds from `start` to `time`, never negative: the recording's clock, as marks use it.
    static func ms(_ time: CMTime, since start: CMTime) -> Int {
        max(0, Int((CMTimeGetSeconds(CMTimeSubtract(time, start)) * 1000).rounded(.down)))
    }

    static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds))
        let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }
}
