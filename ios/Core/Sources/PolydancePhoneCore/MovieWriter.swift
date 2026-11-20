// A take's two files (docs/IPHONE.md R1 to R4): video.mp4 with the camera (H.264) and the microphone
// (AAC mono 48 kHz), and narration.m4a with the microphone alone (R3), so words can go first without a
// copy after Stop. The Vision Pro's broadcast (docs/VISIONOS.md) also writes the app's own sound as a second
// audio track after the mic's, AAC stereo, as the headset's MuxerCapture orders them (video, mic, app); and
// its MIC switch can leave the mic out, and with it the narration. Both are fragmented every `fragmentSeconds`, as the Mac writes
// (mac/Sources/PolydanceCapture/Capture/AssetWriterSink.swift), so a take the app never finished still
// plays up to its last fragment (R2).
//
// Both files start at the first video frame of the right size: audio stamped before it is dropped
// (counted), so the narration lines up with the video from 0. A frame that is not the settings' size is
// dropped and counted, never scaled: the recorder rotates frames upright on the capture connection
// (R4), so a wrong size means a rotation that did not take, and the evidence should say so. A screen's
// picture is the one exception (`MovieWriterSettings.screen`): the iPhone's is odd-sized and taller than
// the pipeline needs, so the settings can name the source's size and the encoder scales it to theirs.
//
// AVAssetWriter packs an audio track's samples one after another whatever their timestamps say (seen on
// the Mac, 2026-11-05), so a gap in a sound's buffers (a flip's reconfiguration, a dropped buffer, an app
// that went quiet) is filled with silence of the same length, keeping later words at their time. The
// silence is made a second at a time as the encoder takes it, never all at once, so a long quiet stretch
// costs no memory. Sound waits in a short queue when an encoder is busy rather than being dropped. A track
// that is on but got no sound at all is filled with silence at the end, so the file's tracks are always
// the ones run.json's audioTracks names. Settings are checked with canApply
// first, because AVAssetWriterInput raises an Objective-C exception Swift cannot catch.
//
// appendVideo, appendAudio and appendAppAudio are called from the capture queue only; finish, cancel and stats may be
// called from anywhere. Everything mutable is behind one lock.
import AVFoundation
import CoreMedia
import Foundation

public struct MovieWriterSettings: Sendable, Equatable {
    public var width: Int
    public var height: Int
    public var fps: Int = 30
    public var videoBitRate: Int = 10_000_000
    public var audioSampleRate: Double = 48_000
    public var audioChannels: Int = 1
    public var audioBitRate: Int = 96_000
    public var fragmentSeconds: Double = 10
    /// The microphone as the first audio track and the whole narration.m4a; off, neither is written.
    public var mic = true
    /// The app's own sound as the next audio track (the Vision Pro's APP switch).
    public var appAudio = false
    public var appAudioChannels: Int = 2
    public var appAudioBitRate: Int = 160_000
    /// The frames' own size when the file's (`width` x `height`) differs: the encoder scales each frame to it.
    /// Nil, frames must be the file's size.
    public var sourceWidth: Int?
    public var sourceHeight: Int?
    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    /// The size each frame must have.
    public var inputWidth: Int { sourceWidth ?? width }
    public var inputHeight: Int { sourceHeight ?? height }
    public var scales: Bool { inputWidth != width || inputHeight != height }

    /// A screen's picture as the system hands it over (a ReplayKit broadcast): kept at its own size when that
    /// is even and its short side at most `maxShortSide`, else scaled down to fit and rounded down to even
    /// sides, which H.264 needs. An iPhone 16's 1179 x 2556 becomes 1080 x 2340; the Vision Pro's 1920 x 1080 stays.
    public static func screen(width: Int, height: Int, maxShortSide: Int? = nil) -> MovieWriterSettings {
        let short = min(width, height)
        let scale = maxShortSide.map { short > $0 && short > 0 ? Double($0) / Double(short) : 1 } ?? 1
        func even(_ side: Int) -> Int { let s = Int((Double(side) * scale).rounded(.down)); return s - s % 2 }
        var settings = MovieWriterSettings(width: even(width), height: even(height))
        if settings.width != width || settings.height != height {
            settings.sourceWidth = width
            settings.sourceHeight = height
        }
        return settings
    }
}

public struct MovieWriterStats: Sendable, Equatable {
    /// Video frames written.
    public var videoFrames = 0
    /// Video frames not written, for any reason (wrong size, encoder busy, out of order, a failure).
    public var droppedVideoFrames = 0
    /// Of the dropped frames, those whose picture was not the settings' size.
    public var wrongSizeVideoFrames = 0
    /// Microphone buffers taken into both files.
    public var audioBuffers = 0
    /// Microphone buffers not written, for any reason, including those before the first frame.
    public var droppedAudioBuffers = 0
    /// Of the dropped buffers, those stamped before the first video frame (expected at every start).
    public var audioBeforeStart = 0
    /// Gaps between microphone buffers filled with silence, and how long they came to in all.
    public var audioGaps = 0
    public var filledAudioSeconds: Double = 0
    /// The first video frame's presentation time: the start of both files.
    public var startSeconds: Double?
    /// The last video frame written, on the same clock.
    public var lastVideoSeconds: Double?
    /// Where the last microphone buffer taken ends, on the same clock.
    public var lastAudioSeconds: Double?
    /// The app's own sound, counted as the microphone's is: buffers taken, not taken, before the first
    /// frame, gaps filled and their length, and where the last one ends.
    public var appAudioBuffers = 0
    public var droppedAppAudioBuffers = 0
    public var appAudioBeforeStart = 0
    public var appAudioGaps = 0
    public var filledAppAudioSeconds: Double = 0
    public var lastAppAudioSeconds: Double?
    /// The first writer failure, naming the file ("video.mp4: ..."); nothing more is written after it.
    public var failure: String?
    public init() {}
}

public struct MovieWriterError: Error, LocalizedError, CustomStringConvertible, Equatable {
    /// "video.mp4" or "narration.m4a" when the failure is one file's; nil when it is the take's.
    public let file: String?
    public let message: String
    public init(file: String?, _ message: String) {
        self.file = file
        self.message = message
    }
    public var description: String { file.map { "\($0): \(message)" } ?? message }
    public var errorDescription: String? { description }
}

public final class MovieWriter: @unchecked Sendable {
    public let videoURL: URL
    public let narrationURL: URL
    public let settings: MovieWriterSettings

    /// A gap shorter than this between microphone buffers is jitter, not missing sound.
    static let gapTolerance = 0.1
    /// A gap longer than this is a clock gone wrong, not missing sound: counted, never filled. The app's
    /// sound can be quiet for as long as a take lasts, so its limit is the take's own.
    static let maxFill = 60.0
    static let maxAppFill = 4 * 3600.0
    /// How much sound may wait for a busy encoder before new buffers are dropped. Silence made for a gap is
    /// not counted: it is made only as the encoder takes it.
    static let maxQueuedSeconds = 2.0

    private enum Phase { case open, finishing, finished, cancelled }

    /// Sound waiting for an input: a buffer as it came, or silence still to be made.
    private enum Item {
        case sound(CMSampleBuffer, seconds: Double)
        case silence(frames: Int, format: CMAudioFormatDescription, pts: CMTime)
    }

    /// One input a sound feeds, with what waits for it.
    private final class Feed {
        let input: AVAssetWriterInput
        let writer: AVAssetWriter
        let file: String
        var pending: [Item] = []
        /// Seconds of buffers (not silence) waiting.
        var queued = 0.0
        init(input: AVAssetWriterInput, writer: AVAssetWriter, file: String) {
            self.input = input
            self.writer = writer
            self.file = file
        }
    }

    /// One sound (the microphone, or the app's): its clock and the inputs it feeds.
    private final class Lane {
        let feeds: [Feed]
        let maxFill: Double
        /// Where the next buffer should start: the end of the last one taken.
        var end: CMTime?
        /// A buffer was dropped since the last one taken, so any gap is that sound, however short.
        var owesSilence = false
        /// The last format taken, for the silence that ends a track.
        var format: CMAudioFormatDescription?
        var buffers = 0, dropped = 0, beforeStart = 0, gaps = 0
        var filled = 0.0
        var last: Double?
        init(feeds: [Feed], maxFill: Double) {
            self.feeds = feeds
            self.maxFill = maxFill
        }
        var isEmpty: Bool { feeds.allSatisfy { $0.pending.isEmpty } }
    }

    private let lock = NSLock()
    private let movie: AVAssetWriter
    private let narration: AVAssetWriter?
    private let videoInput: AVAssetWriterInput
    private let mic: Lane?
    private let app: Lane?
    private let videoName: String

    private var phase = Phase.open
    private var counts = MovieWriterStats()
    private var start: CMTime?
    private var lastVideo: CMTime?

    public init(videoURL: URL, narrationURL: URL, settings: MovieWriterSettings) throws {
        self.videoURL = videoURL
        self.narrationURL = narrationURL
        self.settings = settings
        videoName = videoURL.lastPathComponent
        let narrationName = narrationURL.lastPathComponent
        guard settings.width > 0, settings.height > 0, settings.width % 2 == 0, settings.height % 2 == 0 else {
            throw MovieWriterError(file: nil, "the picture size \(settings.width)x\(settings.height) is not one H.264 takes")
        }
        guard settings.inputWidth > 0, settings.inputHeight > 0 else {
            throw MovieWriterError(file: nil, "the frames' size \(settings.inputWidth)x\(settings.inputHeight) is not a picture")
        }
        guard settings.fps > 0, settings.fragmentSeconds > 0, (1...2).contains(settings.audioChannels), (1...2).contains(settings.appAudioChannels) else {
            throw MovieWriterError(file: nil, "the settings are out of range: \(settings)")
        }
        let urls = settings.mic ? [videoURL, narrationURL] : [videoURL]
        for url in urls where FileManager.default.fileExists(atPath: url.path) {
            throw MovieWriterError(file: url.lastPathComponent, "already exists; a take never writes over another")
        }
        let fragment = CMTime(seconds: settings.fragmentSeconds, preferredTimescale: 600)
        do {
            movie = try AVAssetWriter(outputURL: videoURL, fileType: .mp4)
        } catch {
            throw MovieWriterError(file: videoName, "could not be created: \(error.localizedDescription)")
        }
        if settings.mic {
            do {
                narration = try AVAssetWriter(outputURL: narrationURL, fileType: .m4a)
            } catch {
                throw MovieWriterError(file: narrationName, "could not be created: \(error.localizedDescription)")
            }
        } else {
            narration = nil
        }
        for writer in [movie] + (narration.map { [$0] } ?? []) {
            writer.movieFragmentInterval = fragment
            writer.shouldOptimizeForNetworkUse = false
        }
        // The tracks in file order: video, the microphone, the app's sound.
        videoInput = try Self.input(.video, settings: Self.videoSettings(settings), writer: movie, file: videoName)
        if let narration {
            let audio = Self.audioSettings(settings)
            let movieMic = try Self.input(.audio, settings: audio, writer: movie, file: videoName)
            let narrationMic = try Self.input(.audio, settings: audio, writer: narration, file: narrationName)
            mic = Lane(feeds: [Feed(input: movieMic, writer: movie, file: videoName), Feed(input: narrationMic, writer: narration, file: narrationName)],
                       maxFill: Self.maxFill)
        } else {
            mic = nil
        }
        if settings.appAudio {
            let appInput = try Self.input(.audio, settings: Self.appAudioSettings(settings), writer: movie, file: videoName)
            app = Lane(feeds: [Feed(input: appInput, writer: movie, file: videoName)], maxFill: Self.maxAppFill)
        } else {
            app = nil
        }
        guard movie.startWriting() else {
            throw MovieWriterError(file: videoName, "could not start: \(movie.error?.localizedDescription ?? "unknown error")")
        }
        if let narration, !narration.startWriting() {
            movie.cancelWriting()
            try? FileManager.default.removeItem(at: videoURL)
            throw MovieWriterError(file: narrationName, "could not start: \(narration.error?.localizedDescription ?? "unknown error")")
        }
        // The files are inside the run's 0700 folder already; this narrows them while they are written,
        // and finish seals them again once AVAssetWriter is done with them.
        for url in urls where FileManager.default.fileExists(atPath: url.path) { try? PrivateFiles.seal(url) }
    }

    // MARK: Settings

    static func videoSettings(_ s: MovieWriterSettings) -> [String: Any] {
        var settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: s.width,
            AVVideoHeightKey: s.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: s.videoBitRate,
                AVVideoExpectedSourceFrameRateKey: s.fps,
                // A key frame every 2 s, so frames can be pulled from anywhere without a long decode.
                AVVideoMaxKeyFrameIntervalKey: s.fps * 2,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
        ]
        // A screen scaled to an even size: stretched to fill, since the two differ by under a pixel's share.
        if s.scales { settings[AVVideoScalingModeKey] = AVVideoScalingModeResize }
        return settings
    }

    /// AAC with an explicit channel layout (mono for one channel), so the encoder never guesses one from
    /// the source: a stereo or 44.1 kHz source is converted into exactly what the settings say.
    static func audioSettings(_ s: MovieWriterSettings) -> [String: Any] {
        aac(channels: s.audioChannels, rate: s.audioSampleRate, bitRate: s.audioBitRate)
    }

    static func appAudioSettings(_ s: MovieWriterSettings) -> [String: Any] {
        aac(channels: s.appAudioChannels, rate: s.audioSampleRate, bitRate: s.appAudioBitRate)
    }

    private static func aac(channels: Int, rate: Double, bitRate: Int) -> [String: Any] {
        var layout = AudioChannelLayout()
        layout.mChannelLayoutTag = channels == 1 ? kAudioChannelLayoutTag_Mono : kAudioChannelLayoutTag_Stereo
        let layoutData = withUnsafeBytes(of: &layout) { Data($0) }
        return [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: channels,
            AVSampleRateKey: rate,
            AVEncoderBitRateKey: bitRate,
            AVChannelLayoutKey: layoutData,
        ]
    }

    private static func input(_ type: AVMediaType, settings: [String: Any], writer: AVAssetWriter, file: String) throws -> AVAssetWriterInput {
        guard writer.canApply(outputSettings: settings, forMediaType: type) else {
            throw MovieWriterError(file: file, "the \(type.rawValue) settings are not ones the encoder takes: \(settings.filter { $0.key != AVVideoCompressionPropertiesKey && $0.key != AVChannelLayoutKey })")
        }
        let input = AVAssetWriterInput(mediaType: type, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw MovieWriterError(file: file, "the \(type.rawValue) track could not be added") }
        writer.add(input)
        return input
    }

    // MARK: Appending (capture queue)

    public var stats: MovieWriterStats { lock.withLock { snapshot() } }

    public func appendVideo(_ sample: CMSampleBuffer) {
        lock.withLock {
            guard phase == .open else { return }
            guard counts.failure == nil else { counts.droppedVideoFrames += 1; return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sample)
            guard pts.isNumeric, let image = CMSampleBufferGetImageBuffer(sample) else { counts.droppedVideoFrames += 1; return }
            guard CVPixelBufferGetWidth(image) == settings.inputWidth, CVPixelBufferGetHeight(image) == settings.inputHeight else {
                counts.droppedVideoFrames += 1
                counts.wrongSizeVideoFrames += 1
                return
            }
            if start == nil { startSession(at: pts) }
            if let last = lastVideo, pts <= last { counts.droppedVideoFrames += 1; return }
            guard videoInput.isReadyForMoreMediaData else { counts.droppedVideoFrames += 1; return }
            guard videoInput.append(sample) else {
                counts.droppedVideoFrames += 1
                noteFailure(movie, videoName)
                return
            }
            counts.videoFrames += 1
            lastVideo = pts
            counts.lastVideoSeconds = pts.seconds
            drainAudio()
        }
    }

    /// The microphone's sound, into video.mp4's mic track and narration.m4a. Ignored when the mic is off.
    public func appendAudio(_ sample: CMSampleBuffer) {
        lock.withLock {
            guard let mic else { return }
            append(sample, to: mic, gapTolerance: Self.gapTolerance)
        }
    }

    /// The app's own sound, into video.mp4's app track. Ignored when the settings have none.
    public func appendAppAudio(_ sample: CMSampleBuffer) {
        lock.withLock {
            guard let app else { return }
            append(sample, to: app, gapTolerance: Self.gapTolerance)
        }
    }

    /// Under the lock.
    private func append(_ sample: CMSampleBuffer, to lane: Lane, gapTolerance: Double) {
        guard phase == .open else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        guard counts.failure == nil, pts.isNumeric, let format = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee, asbd.mSampleRate > 0 else {
            lane.dropped += 1
            return
        }
        guard let start, pts >= start else {
            lane.dropped += 1
            lane.beforeStart += 1
            return
        }
        let rate = asbd.mSampleRate
        let seconds = Double(CMSampleBufferGetNumSamples(sample)) / rate
        if let expected = lane.end {
            let gap = (pts - expected).seconds
            let tolerance = lane.owesSilence ? 0.5 / rate : gapTolerance
            if gap > tolerance {
                lane.gaps += 1
                if gap < lane.maxFill, Self.canFill(asbd) {
                    enqueueSilence(on: lane, from: expected, seconds: gap, format: format, rate: rate)
                    lane.filled += gap
                }
                lane.end = pts
            }
        }
        if (lane.feeds.map(\.queued).max() ?? 0) + seconds > Self.maxQueuedSeconds {
            // The clock stays where this buffer starts, so the next one taken gets silence for it.
            lane.dropped += 1
            lane.owesSilence = true
            return
        }
        lane.owesSilence = false
        for feed in lane.feeds {
            feed.pending.append(.sound(sample, seconds: seconds))
            feed.queued += seconds
        }
        lane.buffers += 1
        if Self.canFill(asbd) { lane.format = format }
        let end = pts + CMTime(seconds: seconds, preferredTimescale: CMTimeScale(rate.rounded()))
        lane.end = end
        lane.last = end.seconds
        drainAudio()
    }

    /// Both files start here. Under the lock.
    private func startSession(at pts: CMTime) {
        movie.startSession(atSourceTime: pts)
        narration?.startSession(atSourceTime: pts)
        start = pts
        mic?.end = pts
        app?.end = pts
        counts.startSeconds = pts.seconds
    }

    /// Silence for a gap, ahead of the buffer after it, made as the encoder takes it. Under the lock.
    private func enqueueSilence(on lane: Lane, from: CMTime, seconds: Double, format: CMAudioFormatDescription, rate: Double) {
        let frames = Int((seconds * rate).rounded())
        guard frames > 0 else { return }
        for feed in lane.feeds { feed.pending.append(.silence(frames: frames, format: format, pts: from)) }
    }

    /// Feeds each audio input while it takes more. Under the lock.
    private func drainAudio() {
        for lane in [mic, app].compactMap({ $0 }) {
            for feed in lane.feeds { drain(feed) }
        }
    }

    private func drain(_ feed: Feed) {
        var taken = 0
        var refused = false
        while !refused, taken < feed.pending.count, feed.writer.status == .writing, feed.input.isReadyForMoreMediaData {
            switch feed.pending[taken] {
            case .sound(let buffer, let seconds):
                taken += 1
                feed.queued -= seconds
                if !feed.input.append(buffer) {
                    noteFailure(feed.writer, feed.file)
                    refused = true
                }
            case .silence(let frames, let format, let pts):
                // A second at a time; what is left stays at the front for the next call.
                let rate = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee.mSampleRate ?? 48_000
                let chunk = min(frames, Int(rate.rounded()))
                guard let silent = Self.silence(frames: chunk, format: format, pts: pts) else {
                    taken += 1
                    continue
                }
                if !feed.input.append(silent) {
                    taken += 1
                    noteFailure(feed.writer, feed.file)
                    refused = true
                } else if chunk < frames {
                    feed.pending[taken] = .silence(frames: frames - chunk, format: format,
                                                   pts: pts + CMTime(value: CMTimeValue(chunk), timescale: CMTimeScale(rate.rounded())))
                } else {
                    taken += 1
                }
            }
        }
        if taken > 0 { feed.pending.removeFirst(taken) }
        if !feed.pending.contains(where: { if case .sound = $0 { true } else { false } }) { feed.queued = 0 }
    }

    private func noteFailure(_ writer: AVAssetWriter, _ file: String) {
        guard counts.failure == nil else { return }
        counts.failure = "\(file): \(writer.error?.localizedDescription ?? "the encoder refused a sample (status \(writer.status.rawValue))")"
    }

    /// Whether the encoders would take a frame now and no sound is waiting. Tests pace synthetic input
    /// with it; the camera never waits.
    var isReady: Bool {
        lock.withLock { videoInput.isReadyForMoreMediaData && (mic?.isEmpty ?? true) && (app?.isEmpty ?? true) }
    }

    /// The counts with each sound's own. Under the lock.
    private func snapshot() -> MovieWriterStats {
        var s = counts
        if let mic {
            s.audioBuffers = mic.buffers; s.droppedAudioBuffers = mic.dropped; s.audioBeforeStart = mic.beforeStart
            s.audioGaps = mic.gaps; s.filledAudioSeconds = mic.filled; s.lastAudioSeconds = mic.last
        }
        if let app {
            s.appAudioBuffers = app.buffers; s.droppedAppAudioBuffers = app.dropped; s.appAudioBeforeStart = app.beforeStart
            s.appAudioGaps = app.gaps; s.filledAppAudioSeconds = app.filled; s.lastAppAudioSeconds = app.last
        }
        return s
    }

    // MARK: Silence

    /// Silence can be made for interleaved (or mono) linear PCM, which is what the microphone gives.
    static func canFill(_ asbd: AudioStreamBasicDescription) -> Bool {
        asbd.mFormatID == kAudioFormatLinearPCM && asbd.mBytesPerFrame > 0
            && (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0 || asbd.mChannelsPerFrame == 1)
    }

    /// `frames` of zeros in `format`, presented at `pts`.
    static func silence(frames: Int, format: CMAudioFormatDescription, pts: CMTime) -> CMSampleBuffer? {
        guard frames > 0, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee, canFill(asbd) else { return nil }
        let bytes = frames * Int(asbd.mBytesPerFrame)
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes, blockAllocator: kCFAllocatorDefault,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag,
                                                 blockBufferOut: &block) == noErr, let block,
              CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) == noErr else { return nil }
        var sample: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
                                                                   sampleCount: frames, presentationTimeStamp: pts, packetDescriptions: nil,
                                                                   sampleBufferOut: &sample) == noErr else { return nil }
        return sample
    }

    /// 48 kHz 16-bit PCM, for the silence of a track that got no sound at all.
    static func plainFormat(channels: Int) -> CMAudioFormatDescription? {
        var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: UInt32(2 * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(2 * channels),
                                               mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 16, mReserved: 0)
        var format: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                             magicCookie: nil, extensions: nil, formatDescriptionOut: &format) == noErr else { return nil }
        return format
    }

    // MARK: Finishing

    /// Writes the sound still waiting (for up to 10 s), finishes the files and seals them 0600. A take
    /// with no frame of the right size is no recording: the files are removed and the error says so.
    /// If one file fails the other is still finished and kept, and the error names the one that failed.
    public func finish() async throws -> MovieWriterStats {
        let began: (ok: Bool, started: Bool) = lock.withLock {
            guard phase == .open else { return (false, false) }
            phase = .finishing
            return (true, start != nil)
        }
        guard began.ok else { throw MovieWriterError(file: nil, "the take was already finished or cancelled") }
        guard began.started else {
            cancelWriters()
            lock.withLock { phase = .cancelled }
            throw MovieWriterError(file: nil, "nothing was recorded: no video frame of \(settings.inputWidth)x\(settings.inputHeight) arrived")
        }

        lock.withLock {
            // A track that is on but heard nothing is silence to the last frame, so it is still in the file.
            guard let start, let lastVideo else { return }
            for (lane, channels) in [(mic, settings.audioChannels), (app, settings.appAudioChannels)] {
                guard let lane, lane.buffers == 0, let format = Self.plainFormat(channels: channels) else { continue }
                let seconds = (lastVideo - start).seconds + 1 / Double(settings.fps)
                enqueueSilence(on: lane, from: start, seconds: seconds, format: format, rate: 48_000)
                lane.filled += seconds
            }
        }

        let deadline = ProcessInfo.processInfo.systemUptime + 10
        while true {
            let waiting = lock.withLock { () -> Bool in
                drainAudio()
                return counts.failure == nil && !((mic?.isEmpty ?? true) && (app?.isEmpty ?? true))
            }
            guard waiting, ProcessInfo.processInfo.systemUptime < deadline else { break }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        lock.withLock {
            // Sound still waiting now never reached a file.
            for lane in [mic, app].compactMap({ $0 }) {
                lane.dropped += lane.feeds.map { feed in feed.pending.filter { if case .sound = $0 { true } else { false } }.count }.max() ?? 0
                for feed in lane.feeds { feed.pending.removeAll(); feed.queued = 0 }
            }
        }

        // From here only this method touches the writers: appends return once the phase is not open.
        var errors: [MovieWriterError] = []
        let movieInputs = [videoInput] + ([mic, app].compactMap { $0?.feeds.first { $0.writer === movie }?.input })
        if let e = await finishWriting(movie, inputs: movieInputs, file: videoName) { errors.append(e) }
        if let narration, let input = mic?.feeds.first(where: { $0.writer === narration })?.input {
            if let e = await finishWriting(narration, inputs: [input], file: narrationURL.lastPathComponent) { errors.append(e) }
        }
        for url in (narration == nil ? [videoURL] : [videoURL, narrationURL]) where FileManager.default.fileExists(atPath: url.path) {
            do { try PrivateFiles.seal(url) } catch {
                errors.append(MovieWriterError(file: url.lastPathComponent, "could not be made private: \(error.localizedDescription)"))
            }
        }
        let final: MovieWriterStats = lock.withLock {
            phase = .finished
            return snapshot()
        }
        if let first = errors.first { throw first }
        return final
    }

    private func finishWriting(_ writer: AVAssetWriter, inputs: [AVAssetWriterInput], file: String) async -> MovieWriterError? {
        guard writer.status == .writing else {
            return MovieWriterError(file: file, "stopped writing before the end: \(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")")
        }
        for input in inputs { input.markAsFinished() }
        await writer.finishWriting()
        guard writer.status == .completed else {
            return MovieWriterError(file: file, "did not finish: \(writer.error?.localizedDescription ?? "status \(writer.status.rawValue)")")
        }
        return nil
    }

    /// Stops the writers and removes the partial files. Only an open take is cancelled: once finish has
    /// begun, the files are the take's and cancel leaves them alone.
    public func cancel() {
        let wasOpen: Bool = lock.withLock {
            guard phase == .open else { return false }
            phase = .cancelled
            for lane in [mic, app].compactMap({ $0 }) { for feed in lane.feeds { feed.pending.removeAll() } }
            return true
        }
        if wasOpen { cancelWriters() }
    }

    private func cancelWriters() {
        for writer in [movie] + (narration.map { [$0] } ?? []) where writer.status == .writing { writer.cancelWriting() }
        for url in (narration == nil ? [videoURL] : [videoURL, narrationURL]) { try? FileManager.default.removeItem(at: url) }
    }
}
