// The take, written where the system hands over the whole screen (docs/VISIONOS.md R1 to R4, docs/IPHONE.md I4): a
// ReplayKit broadcast upload extension, the same file on the Vision Pro and the iPhone, started from the deck (the
// system's own sheet asks first) and stopped by STOP, Cancel, the system's own stop, or the 30-minute limit the
// headset also has. It writes what the Quest's MuxerCapture writes, in the iPhone's run layout (PolydancePhoneCore's
// RunFolder and MovieWriter): video.mp4 with the screen (H.264), the microphone and, on the Vision Pro, the app's
// sound as two AAC tracks in that order, narration.m4a with the mic alone, run.json (`cut` until it finished
// cleanly), thread.json from the deck's next.json, and timeline.jsonl. Nothing here reaches the network; the app
// moves the finished take into its own container and uploads it (Shared/Broadcast.swift says how the two talk).
//
// The picture is the system's own size, made even for H.264; the iPhone's is also scaled to 1080 on its short side
// (BroadcastShared.maxShortSide). The iPhone hands over its screen's pixels upright for portrait whatever way the
// phone is held, so a take keeps the size of its first frame, and each turn of the screen goes into the timeline.
//
// The system gives the extension about 50 MB, so nothing is buffered here beyond the writer's two seconds of sound:
// frames go straight to the hardware encoder, and the meters' levels are read from every eighth buffer.
// ReplayKit calls processSampleBuffer one buffer at a time; a stop or cancel comes on the main thread from a
// Darwin notification, and the state they share is behind one lock.
import AVFoundation
import CoreMedia
import Foundation
import PolydancePhoneCore
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler {
    /// The headset's default limit (RecorderService's maxMinutes).
    static let maxSeconds: Double = 30 * 60

    private enum Phase { case idle, writing, finishing, done }

    private let lock = NSLock()
    private var phase = Phase.idle
    private var root: URL?
    private var log: EventLog?
    private var timeline: EventLog?
    private var run: RunFolder?
    private var meta: RunMeta?
    private var next: NextTake?
    private var writer: MovieWriter?
    private var live: LiveTake?
    private var wrongSize = 0
    private var micBuffers = 0
    private var appBuffers = 0
    private var lastLevels = 0.0
    private var micLevel = 0.0
    private var appLevel = 0.0
    private var observing = false
    private var limitReached = false
    private var lastBeat = 0.0
    /// The screen's way up as the last frame said it (RPVideoSampleOrientationKey), for the timeline's turns.
    private var turned: UInt32?

    // MARK: ReplayKit

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        let began = Date()
        guard let root = BroadcastShared.root() else {
            stopBroadcast("Polydance could not open its shared folder, so it cannot record.")
            return
        }
        do {
            try PrivateFiles.directory(root)
            try PrivateFiles.directory(BroadcastShared.runs(in: root))
            let log = try EventLog(url: BroadcastShared.events(in: root))
            self.root = root
            self.log = log
            let next = readNext(root, log: log)
            let run = try RunFolder.create(in: BroadcastShared.runs(in: root), at: began)
            if let thread = next.thread { try run.writeThread(thread) }
            let timeline = try EventLog(url: run.timelineURL)
            var tracks: [String] = []
            if next.mic { tracks.append("mic") }
            if next.app { tracks.append("app") }
            var meta = RunMeta(runName: run.name, recordedAt: EventLog.timestamp(began), device: Self.device(), appVersion: next.appVersion,
                               appCommit: next.appCommit, orientation: "landscape", width: 0, height: 0, fps: 30,
                               audioTracks: tracks.isEmpty ? ["mic"] : tracks, micName: next.mic ? BroadcastShared.deviceName : nil)
            meta.appBuild = next.appBuild
            try run.writeMeta(meta)
            lock.withLock {
                self.run = run
                self.meta = meta
                self.next = next
                self.timeline = timeline
                self.live = LiveTake(run: run.name, state: .starting, beganAt: began.timeIntervalSince1970, micHeard: false)
                self.phase = .writing
            }
            writeLive()
            observe()
            log.write("broadcast.start", ["run": run.name, "mic": next.mic, "app": next.app,
                                          "thread": next.thread.map { switch $0 { case .reply: "reply"; case .newThread: "new"; case .report: "report" } } ?? "none"])
            timeline.write("start", ["mic": next.mic, "app": next.app])
        } catch {
            log?.write("broadcast.failed", ["step": "start", "reason": ErrorWords.describe(error)])
            stopBroadcast("Polydance could not start the recording: \(ErrorWords.describe(error))")
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        let (writer, writing) = lock.withLock { (self.writer, phase == .writing) }
        guard writing else { return }
        switch sampleBufferType {
        case .video:
            if let writer {
                writer.appendVideo(sampleBuffer)
                checkFirstFrame(writer)
                checkLimit(writer)
            } else {
                openWriter(for: sampleBuffer)
            }
            noteTurn(sampleBuffer)
            beat()
        case .audioMic:
            writer?.appendAudio(sampleBuffer)
            heard(sampleBuffer, mic: true)
        case .audioApp:
            writer?.appendAppAudio(sampleBuffer)
            heard(sampleBuffer, mic: false)
        @unknown default:
            break
        }
    }

    override func broadcastPaused() {
        lock.withLock { timeline }?.write("paused")
        log?.write("broadcast.paused")
    }

    override func broadcastResumed() {
        lock.withLock { timeline }?.write("resumed")
        log?.write("broadcast.resumed")
    }

    /// The broadcast ended from outside Polydance (the system's stop) or after finishBroadcastWithError: the take is
    /// finished here if it was not already, waiting for the files, since the extension may end as this returns.
    override func broadcastFinished() {
        let done = DispatchSemaphore(value: 0)
        Task.detached { [self] in
            await finishTake(because: "the broadcast was stopped")
            done.signal()
        }
        _ = done.wait(timeout: .now() + 20)
        unobserve()
    }

    // MARK: The writer

    /// The first frame says the take's size: the system's own, made even, and on the iPhone scaled to 1080 on its
    /// short side (MovieWriterSettings.screen). A size the encoder refuses ends the take with the reason.
    private func openWriter(for sample: CMSampleBuffer) {
        guard let image = CMSampleBufferGetImageBuffer(sample) else { return }
        let sourceWidth = CVPixelBufferGetWidth(image), sourceHeight = CVPixelBufferGetHeight(image)
        let next = lock.withLock { self.next }
        guard let next, let run = lock.withLock({ self.run }) else { return }
        var settings = MovieWriterSettings.screen(width: sourceWidth, height: sourceHeight, maxShortSide: BroadcastShared.maxShortSide)
        let width = settings.width, height = settings.height
        settings.mic = next.mic
        settings.appAudio = next.app
        // The quality chosen behind the gear: about 4, 9 or 16 Mbit/s at 1920 x 1080 (RecordingQuality).
        let quality = next.quality ?? .default
        settings.videoBitRate = quality.videoBitRate(width: width, height: height)
        do {
            let writer = try MovieWriter(videoURL: run.videoURL, narrationURL: run.narrationURL, settings: settings)
            lock.withLock {
                self.writer = writer
                self.meta?.width = width
                self.meta?.height = height
                self.meta?.orientation = width < height ? "portrait" : "landscape"
                self.live?.width = width
                self.live?.height = height
            }
            writer.appendVideo(sample)
            checkFirstFrame(writer)
            log?.write("broadcast.writer", ["width": width, "height": height, "sourceWidth": sourceWidth, "sourceHeight": sourceHeight,
                                            "bitRate": settings.videoBitRate, "quality": quality.rawValue])
        } catch {
            log?.write("broadcast.failed", ["step": "writer", "width": sourceWidth, "height": sourceHeight, "reason": ErrorWords.describe(error)])
            fail("the screen's picture (\(sourceWidth) x \(sourceHeight)) could not be written: \(ErrorWords.describe(error))")
        }
    }

    /// The screen turned (the iPhone held sideways, or back): the frames stay the first one's size, so the turn
    /// goes into the timeline, with the way up ReplayKit gives (CGImagePropertyOrientation: 1 up, 6 and 8 sideways).
    private func noteTurn(_ sample: CMSampleBuffer) {
        guard let raw = CMGetAttachment(sample, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber else { return }
        let value = raw.uint32Value
        let changed: Bool = lock.withLock {
            guard turned != value else { return false }
            let first = turned == nil
            turned = value
            return !first || value != 1
        }
        guard changed else { return }
        let name = switch value {
        case 1, 2: "portrait"
        case 3, 4: "upsideDown"
        case 5, 6, 7, 8: "landscape"
        default: "unknown"
        }
        lock.withLock { timeline }?.write("turned", ["orientation": name, "exif": Int(value)])
    }

    private func checkFirstFrame(_ writer: MovieWriter) {
        let first: Bool = lock.withLock {
            guard live?.state == .starting, writer.stats.videoFrames > 0 else { return false }
            live?.state = .recording
            live?.startedAt = Date().timeIntervalSince1970
            return true
        }
        guard first else { return }
        writeLive()
        lock.withLock { timeline }?.write("firstFrame")
    }

    private func checkLimit(_ writer: MovieWriter) {
        let stats = writer.stats
        guard let start = stats.startSeconds, let last = stats.lastVideoSeconds, last - start >= Self.maxSeconds else { return }
        let first: Bool = lock.withLock {
            guard !limitReached else { return false }
            limitReached = true
            return true
        }
        guard first else { return }
        Task.detached { [self] in
            await finishTake(because: "it reached the 30-minute limit")
            stopBroadcast("Polydance stopped at its 30-minute limit; the recording is kept.")
        }
    }

    /// Counts a sound's buffers, notes the mic is heard, and every eighth buffer reads its level for the meters.
    private func heard(_ sample: CMSampleBuffer, mic: Bool) {
        let (count, firstMic): (Int, Bool) = lock.withLock {
            if mic {
                micBuffers += 1
                let first = live?.micHeard == false
                if first { live?.micHeard = true }
                return (micBuffers, first)
            }
            appBuffers += 1
            return (appBuffers, false)
        }
        if firstMic {
            writeLive()
            lock.withLock { timeline }?.write("micHeard")
        }
        guard count % 8 == 0 else { return }
        let level = Self.level(sample)
        let now = Date().timeIntervalSince1970
        let publish: (Double, Double)? = lock.withLock {
            if mic { micLevel = level } else { appLevel = level }
            guard now - lastLevels >= 0.1 else { return nil }
            lastLevels = now
            return (micLevel, appLevel)
        }
        if let (m, a) = publish, let defaults = BroadcastShared.defaults {
            defaults.set(m, forKey: BroadcastShared.micLevelKey)
            defaults.set(a, forKey: BroadcastShared.appLevelKey)
            defaults.set(now, forKey: BroadcastShared.levelsAtKey)
        }
    }

    /// The heartbeat the app reads to tell a running take from one whose extension died.
    private func beat() {
        let now = Date().timeIntervalSince1970
        let due: Bool = lock.withLock {
            guard now - lastBeat >= 1 else { return false }
            lastBeat = now
            return true
        }
        if due { BroadcastShared.defaults?.set(now, forKey: BroadcastShared.heartbeatKey) }
    }

    // MARK: Ending

    /// Finishes the files once, writes run.json's outcome and tells the app. Safe to call from any thread, any
    /// number of times: only the first does anything.
    private func finishTake(because reason: String) async {
        let state: (writer: MovieWriter?, run: RunFolder?, meta: RunMeta?)? = lock.withLock {
            guard phase == .writing else { return nil }
            phase = .finishing
            live?.state = .finishing
            return (writer, run, meta)
        }
        guard let state, let run = state.run, var meta = state.meta else { return }
        writeLive()
        lock.withLock { timeline }?.write("stop", ["reason": reason])
        meta.stoppedBecause = reason
        do {
            guard let writer = state.writer else { throw MovieWriterError(file: nil, "no picture arrived from \(BroadcastShared.systemName)") }
            let stats = try await writer.finish()
            meta.cut = false
            if let start = stats.startSeconds, let last = stats.lastVideoSeconds { meta.durationMs = Int(((last - start) * 1000).rounded()) }
            meta.videoFrames = stats.videoFrames
            meta.droppedVideoFrames = stats.droppedVideoFrames
            meta.audioBuffers = stats.audioBuffers
            meta.appAudioBuffers = meta.audioTracks.contains("app") ? stats.appAudioBuffers : nil
            meta.bytes = Self.size(run.videoURL)
            meta.narrationBytes = Self.size(run.narrationURL)
            try run.writeMeta(meta)
            lock.withLock {
                live?.state = .finished
                live?.endedAt = Date().timeIntervalSince1970
                phase = .done
            }
            log?.write("broadcast.finished", ["run": run.name, "reason": reason, "frames": stats.videoFrames, "dropped": stats.droppedVideoFrames,
                                              "mic": stats.audioBuffers, "app": stats.appAudioBuffers, "durationMs": meta.durationMs ?? -1])
        } catch {
            let why = ErrorWords.describe(error)
            // What was written stays, said to be cut off, unless nothing was: then the folder goes.
            if FileManager.default.fileExists(atPath: run.videoURL.path) {
                meta.stoppedBecause = "\(reason); it could not be finished: \(why)"
                try? run.writeMeta(meta)
            } else {
                try? FileManager.default.removeItem(at: run.directory)
            }
            lock.withLock {
                live?.state = .failed
                live?.reason = why
                live?.endedAt = Date().timeIntervalSince1970
                phase = .done
            }
            log?.write("broadcast.failed", ["step": "finish", "run": run.name, "reason": why])
        }
        writeLive()
    }

    /// Cancel on the deck: the files go and nothing is kept.
    private func cancelTake() {
        let state: (MovieWriter?, RunFolder?)? = lock.withLock {
            guard phase == .writing else { return nil }
            phase = .done
            live?.state = .cancelled
            live?.endedAt = Date().timeIntervalSince1970
            return (writer, run)
        }
        guard let state else { return }
        state.0?.cancel()
        if let run = state.1 { try? FileManager.default.removeItem(at: run.directory) }
        writeLive()
        log?.write("broadcast.cancelled", ["run": state.1?.name ?? "?"])
    }

    private func fail(_ reason: String) {
        lock.withLock {
            phase = .done
            live?.state = .failed
            live?.reason = reason
        }
        if let run = lock.withLock({ self.run }) { try? FileManager.default.removeItem(at: run.directory) }
        writeLive()
        stopBroadcast("Polydance could not record: \(reason)")
    }

    /// Ends the broadcast with the words the system shows.
    private func stopBroadcast(_ words: String) {
        finishBroadcastWithError(NSError(domain: BroadcastShared.app, code: 1, userInfo: [NSLocalizedDescriptionKey: words]))
    }

    // MARK: Talking to the app

    private func readNext(_ root: URL, log: EventLog) -> NextTake {
        let info = Bundle.main.infoDictionary ?? [:]
        let fallback = NextTake(thread: nil, mic: true, app: BroadcastShared.recordsAppSound, appVersion: info["CFBundleShortVersionString"] as? String ?? "0.0.0",
                                appBuild: (info["CFBundleVersion"] as? String).flatMap(Int.init),
                                appCommit: (info["PolydanceCommit"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "unknown")
        do {
            return try NextTake.decode(Data(contentsOf: BroadcastShared.next(in: root)))
        } catch {
            // Started before the app ever wrote one: every sound this platform records, kept on the device until sent by hand.
            log.write("broadcast.next", ["ok": false, "reason": ErrorWords.describe(error)])
            return fallback
        }
    }

    private func writeLive() {
        guard let root = lock.withLock({ self.root }), let live = lock.withLock({ self.live }) else { return }
        do {
            try PrivateFiles.write(BroadcastShared.encode(live), to: BroadcastShared.live(in: root))
        } catch {
            log?.write("broadcast.failed", ["step": "live", "reason": ErrorWords.describe(error)])
        }
        BroadcastShared.post(BroadcastShared.changedNote)
    }

    private func observe() {
        guard !lock.withLock({ observing }) else { return }
        lock.withLock { observing = true }
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let me = Unmanaged.passUnretained(self).toOpaque()
        for name in [BroadcastShared.stopNote, BroadcastShared.cancelNote] {
            CFNotificationCenterAddObserver(center, me, { _, observer, name, _, _ in
                guard let observer, let name else { return }
                let handler = Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue()
                handler.received(name.rawValue as String)
            }, name as CFString, nil, .deliverImmediately)
        }
    }

    private func unobserve() {
        guard lock.withLock({ observing }) else { return }
        lock.withLock { observing = false }
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    }

    private func received(_ name: String) {
        if name == BroadcastShared.stopNote {
            log?.write("broadcast.stopAsked")
            Task.detached { [self] in
                await finishTake(because: "STOP was pressed")
                stopBroadcast("Polydance has stopped recording. The recording is on its way.")
            }
        } else if name == BroadcastShared.cancelNote {
            log?.write("broadcast.cancelAsked")
            cancelTake()
            stopBroadcast("Polydance discarded the recording.")
        }
    }

    // MARK: Helpers

    /// The hardware's model identifier and the system, never the device's own name.
    static func device() -> [String: String] {
        var info = utsname()
        uname(&info)
        let model = withUnsafeBytes(of: &info.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return ["model": model.isEmpty ? BroadcastShared.deviceName : model,
                "system": "\(BroadcastShared.systemName) \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"]
    }

    static func size(_ url: URL) -> Int64? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
    }

    /// The buffer's loudness, 0 to 1 on the meters' scale: the peak of its first channel in decibels, -50 dB to 0.
    static func level(_ sample: CMSampleBuffer) -> Double {
        guard let format = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM, let block = CMSampleBufferGetDataBuffer(sample) else { return 0 }
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer else { return 0 }
        let float = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let bigEndian = asbd.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
        let stride = max(1, Int(asbd.mBytesPerFrame))
        var peak: Double = 0
        let raw = UnsafeRawPointer(pointer)
        var offset = 0
        while offset + (float ? 4 : 2) <= length {
            let v: Double
            if float {
                var bits = raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
                if bigEndian { bits = bits.byteSwapped }
                v = Double(abs(Float(bitPattern: bits)))
            } else if asbd.mBitsPerChannel == 16 {
                var bits = raw.loadUnaligned(fromByteOffset: offset, as: UInt16.self)
                if bigEndian { bits = bits.byteSwapped }
                v = Double(abs(Int(Int16(bitPattern: bits)))) / 32_768
            } else {
                return 0
            }
            peak = max(peak, v)
            offset += stride * 4
        }
        guard peak > 0 else { return 0 }
        let db = 20 * log10(peak)
        return min(1, max(0, (db + 50) / 50))
    }
}
