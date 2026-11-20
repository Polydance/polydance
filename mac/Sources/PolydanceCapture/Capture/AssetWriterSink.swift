// One AVAssetWriter for the three sources (C1): tracks in the order video (H.264, if the screen is
// recorded), microphone (AAC mono), the call's sound (AAC stereo), so the audio tracks are mic then
// app as the headset records them. Written as a fragmented MP4 every 10 s, so a crash, a lid close or a
// full disk keeps everything up to the last fragment (C4). The session starts at the first sample
// appended; anything stamped earlier is dropped. All calls happen on the recorder's writer queue.
//
// Audio is never dropped because the encoder is busy: each audio track has a queue on the writer queue,
// drained while its input is ready and again a few milliseconds later while anything waits, so the
// buffers held while a recording starts go in whole. AVAssetWriter packs an audio track's samples one
// after another whatever their timestamps say (seen on this Mac, 2026-11-05: 2 s missing from a 10 s
// track made it 8 s long, with everything after the gap early), so a gap between a track's buffers (a
// source that stopped and came back, or a buffer dropped because its queue was full) is filled with
// silence of the same length, keeping later sound at its time against the other track and the video.
// Output settings are checked with canApply before an input is made: AVAssetWriterInput raises an
// Objective-C exception, which Swift cannot catch, for settings it refuses.
import AVFoundation
import CoreMedia
import Foundation
import PolydanceCore

final class AssetWriterSink {
    enum Track { case video, mic, app }

    struct VideoSpec: Equatable {
        var width: Int
        var height: Int
        var fps: Int
    }

    struct AudioSpec: Equatable {
        var channels: Int
        var sampleRate: Double
    }

    struct Counts {
        var appended = 0
        /// Audio buffers that had to wait for the encoder (all written later), and video frames dropped
        /// because the encoder was busy (the repeat timer covers those).
        var notReady = 0
        var beforeStart = 0
        var failed = 0
        /// Audio buffers dropped because a minute of sound was already waiting; silence takes their place.
        var dropped = 0
        var droppedSeconds: Double = 0
        var firstDropAt: CMTime?
        /// Silence written into gaps between a track's buffers, in seconds.
        var filledSeconds: Double = 0
        /// Video frames that arrived after a repeated frame stamped later, written 1 ms after it.
        var retimed = 0
    }

    /// How much audio may wait for the encoder per track before new buffers are dropped (a minute).
    let maxQueuedSeconds: Double
    /// A gap shorter than this between a track's buffers is jitter, not missing sound.
    static let gapTolerance: Double = 0.1
    /// A gap longer than this is a timestamp gone wrong, not sound that went missing: never filled.
    static let maxFill: Double = 5 * 3600

    private enum Pending {
        case sample(CMSampleBuffer, seconds: Double)
        case silence(start: CMTime, frames: Int, format: CMAudioFormatDescription)
    }

    let url: URL
    private let writer: AVAssetWriter
    private let queue: DispatchQueue
    private var inputs: [Track: AVAssetWriterInput] = [:]
    private var pending: [Track: [Pending]] = [:]
    private var queuedSeconds: [Track: Double] = [:]
    /// Where each audio track's next buffer should start: the end of the last one accepted.
    private var expectedNext: [Track: CMTime] = [:]
    /// A buffer was dropped since: any gap is the dropped sound, however short, not jitter.
    private var owesSilence: Set<Track> = []
    private var drainScheduled = false
    private var finishing = false
    private(set) var sessionStart: CMTime?
    private(set) var lastVideoTime: CMTime?
    private(set) var counts: [Track: Counts] = [.video: Counts(), .mic: Counts(), .app: Counts()]
    /// Called on the writer queue when a track gets its first sample.
    var onFirstSample: ((Track) -> Void)?

    /// The tracks the writer has: what the recording asked for.
    var tracks: [Track] { [.video, .mic, .app].filter { inputs[$0] != nil } }
    /// The tracks that got samples: what the file holds, since AVAssetWriter leaves an input that got
    /// none out of the file.
    var tracksWithSamples: [Track] { tracks.filter { (counts[$0]?.appended ?? 0) > 0 } }
    var error: Error? { writer.error }

    init(url: URL, video: VideoSpec?, mic: AudioSpec?, app: AudioSpec?, queue: DispatchQueue, maxQueuedSeconds: Double = 60) throws {
        self.url = url
        self.queue = queue
        self.maxQueuedSeconds = maxQueuedSeconds
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.movieFragmentInterval = CMTime(seconds: 10, preferredTimescale: 600)
        writer.shouldOptimizeForNetworkUse = false
        if let video {
            try add(.video, mediaType: .video, settings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: video.width,
                AVVideoHeightKey: video.height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 1_500_000,
                    AVVideoExpectedSourceFrameRateKey: video.fps,
                    AVVideoMaxKeyFrameIntervalKey: max(video.fps * 4, 1),
                    AVVideoMaxKeyFrameIntervalDurationKey: 4,
                    AVVideoAllowFrameReorderingKey: false,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ] as [String: Any],
            ])
        }
        if let mic { try add(.mic, mediaType: .audio, settings: Self.aacSettings(mic, bitRate: 96_000)) }
        if let app { try add(.app, mediaType: .audio, settings: Self.aacSettings(app, bitRate: AppTrackEncoding.bitRate)) }
        guard !inputs.isEmpty else { throw CaptureError("nothing to record: no screen, no microphone and no sound tap") }
        guard writer.startWriting() else { throw CaptureError("the recording could not be started: \(writer.error?.localizedDescription ?? "unknown error")") }
    }

    static func aacSettings(_ spec: AudioSpec, bitRate: Int) -> [String: Any] {
        [AVFormatIDKey: kAudioFormatMPEG4AAC, AVNumberOfChannelsKey: spec.channels, AVSampleRateKey: spec.sampleRate, AVEncoderBitRateKey: bitRate]
    }

    private func add(_ track: Track, mediaType: AVMediaType, settings: [String: Any]) throws {
        guard writer.canApply(outputSettings: settings, forMediaType: mediaType) else {
            throw CaptureError("the \(track) track's settings are not ones the encoder takes: \(settings.filter { $0.key != AVVideoCompressionPropertiesKey })")
        }
        let input = AVAssetWriterInput(mediaType: mediaType, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw CaptureError("the \(track) track could not be added to the recording") }
        writer.add(input)
        inputs[track] = input
        if track != .video { pending[track] = [] }
    }

    func has(_ track: Track) -> Bool { inputs[track] != nil }

    private func startIfNeeded(_ pts: CMTime) {
        guard sessionStart == nil else { return }
        writer.startSession(atSourceTime: pts)
        sessionStart = pts
    }

    // MARK: Audio

    /// Queues one audio buffer for its track, starting the session at the first, with silence before it
    /// when it starts later than the track's last buffer ended. Returns whether it was taken.
    @discardableResult
    func append(_ buffer: CMSampleBuffer, to track: Track) -> Bool {
        guard track != .video, inputs[track] != nil, writer.status == .writing, !finishing else { return false }
        let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
        guard pts.isValid, let format = CMSampleBufferGetFormatDescription(buffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee, asbd.mSampleRate > 0 else {
            counts[track]?.failed += 1
            return false
        }
        startIfNeeded(pts)
        if let start = sessionStart, pts < start { counts[track]?.beforeStart += 1; return false }
        let seconds = Double(CMSampleBufferGetNumSamples(buffer)) / asbd.mSampleRate
        if let expected = expectedNext[track] {
            let gap = CMTimeGetSeconds(CMTimeSubtract(pts, expected))
            let tolerance = owesSilence.contains(track) ? 0.5 / asbd.mSampleRate : Self.gapTolerance
            if gap > tolerance, gap < Self.maxFill, Self.canFill(asbd) {
                pending[track]?.append(.silence(start: expected, frames: Int((gap * asbd.mSampleRate).rounded()), format: format))
                counts[track]?.filledSeconds += gap
                // The gap is filled up to this buffer whether or not it is then taken.
                expectedNext[track] = pts
            }
        }
        if (queuedSeconds[track] ?? 0) + seconds > maxQueuedSeconds {
            // The track's clock stays where this buffer starts, so the next buffer that is taken gets silence
            // for this one and any dropped after it, once.
            counts[track]?.dropped += 1
            counts[track]?.droppedSeconds += seconds
            if counts[track]?.firstDropAt == nil { counts[track]?.firstDropAt = pts }
            owesSilence.insert(track)
            return false
        }
        owesSilence.remove(track)
        pending[track]?.append(.sample(buffer, seconds: seconds))
        queuedSeconds[track, default: 0] += seconds
        expectedNext[track] = CMTimeAdd(pts, CMTime(seconds: seconds, preferredTimescale: CMTimeScale(asbd.mSampleRate)))
        drain()
        if !(pending[track]?.isEmpty ?? true) { counts[track]?.notReady += 1 }
        return true
    }

    /// Silence can be made for interleaved (or mono) linear PCM, which is what both sources give.
    private static func canFill(_ asbd: AudioStreamBasicDescription) -> Bool {
        asbd.mFormatID == kAudioFormatLinearPCM && asbd.mBytesPerFrame > 0
            && (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0 || asbd.mChannelsPerFrame == 1)
    }

    /// Feeds every audio track while its input takes more, and comes back shortly while anything waits.
    private func drain() {
        for track in [Track.mic, .app] { drain(track) }
        guard !drainScheduled, writer.status == .writing, pending.values.contains(where: { !$0.isEmpty }) else { return }
        drainScheduled = true
        queue.asyncAfter(deadline: .now() + 0.005) { [weak self] in
            self?.drainScheduled = false
            self?.drain()
        }
    }

    private func drain(_ track: Track) {
        guard let input = inputs[track] else { return }
        while writer.status == .writing, input.isReadyForMoreMediaData, let next = pending[track]?.first {
            switch next {
            case .sample(let buffer, let seconds):
                pending[track]?.removeFirst()
                queuedSeconds[track, default: 0] -= seconds
                written(input.append(buffer), track)
            case .silence(let start, let frames, let format):
                let rate = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee.mSampleRate ?? 48_000
                let chunk = min(frames, max(1, Int(rate)))
                if let silent = Self.silence(frames: chunk, format: format, pts: start) { written(input.append(silent), track) } else { counts[track]?.failed += 1 }
                if frames > chunk {
                    pending[track]?[0] = .silence(start: CMTimeAdd(start, CMTime(value: CMTimeValue(chunk), timescale: CMTimeScale(rate))), frames: frames - chunk, format: format)
                } else {
                    pending[track]?.removeFirst()
                }
            }
        }
    }

    private func written(_ ok: Bool, _ track: Track) {
        guard ok else { counts[track]?.failed += 1; return }
        counts[track]?.appended += 1
        if counts[track]?.appended == 1 { onFirstSample?(track) }
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

    // MARK: Video

    /// Appends a video frame and returns the buffer written, or nil. A real frame stamped at or before the
    /// last one written (a repeated frame stamped "now" got in while it was on its way) may be the only
    /// frame of a change, so it is written 1 ms after the last one instead of being dropped; a repeat that
    /// is late is simply skipped.
    @discardableResult
    func appendVideo(_ buffer: CMSampleBuffer, isRepeat: Bool) -> CMSampleBuffer? {
        guard let input = inputs[.video], writer.status == .writing, !finishing else { return nil }
        var pts = CMSampleBufferGetPresentationTimeStamp(buffer)
        guard pts.isValid else { counts[.video]?.failed += 1; return nil }
        startIfNeeded(pts)
        if let start = sessionStart, pts < start { counts[.video]?.beforeStart += 1; return nil }
        var sample = buffer
        if let last = lastVideoTime, pts <= last {
            guard !isRepeat else { counts[.video]?.beforeStart += 1; return nil }
            let later = CMTimeAdd(last, CMTime(value: 1, timescale: 1000))
            guard let copy = Self.retime(buffer, to: later) else { counts[.video]?.failed += 1; return nil }
            sample = copy
            pts = later
            counts[.video]?.retimed += 1
        }
        guard input.isReadyForMoreMediaData else { counts[.video]?.notReady += 1; return nil }
        guard input.append(sample) else { counts[.video]?.failed += 1; return nil }
        counts[.video]?.appended += 1
        if counts[.video]?.appended == 1 { onFirstSample?(.video) }
        lastVideoTime = pts
        return sample
    }

    /// A black picture, `width` by `height` in the screen's pixel format, presented at `pts`: what the track
    /// shows while there is no screen to record (C14). AVAssetWriter keeps a frame on screen until the next
    /// one, so without it a gap would show the last picture as if it were live.
    static func blackFrame(width: Int, height: Int, pts: CMTime) -> CMSampleBuffer? {
        var made: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes, &made) == kCVReturnSuccess,
              let pixels = made, CVPixelBufferLockBaseAddress(pixels, []) == kCVReturnSuccess else { return nil }
        // Video range: luma 16 is black, chroma 128 is no colour.
        for (plane, value) in [(0, Int32(16)), (1, Int32(128))] {
            guard let base = CVPixelBufferGetBaseAddressOfPlane(pixels, plane) else { continue }
            memset(base, value, CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane))
        }
        CVPixelBufferUnlockBaseAddress(pixels, [])
        var format: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescriptionOut: &format) == noErr,
              let format else { return nil }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescription: format,
                                                       sampleTiming: &timing, sampleBufferOut: &sample) == noErr else { return nil }
        return sample
    }

    /// The same picture presented at `pts`.
    static func retime(_ buffer: CMSampleBuffer, to pts: CMTime) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var copy: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: buffer, sampleTimingEntryCount: 1,
                                                    sampleTimingArray: &timing, sampleBufferOut: &copy) == noErr else { return nil }
        return copy
    }

    // MARK: Finishing

    /// Writes what is still waiting (for up to 30 s), then finishes the file. `done` runs on the writer
    /// queue, after which `counts` and `tracksWithSamples` are final.
    func finish(_ done: @escaping (Error?) -> Void) {
        guard writer.status == .writing else { done(writer.error ?? CaptureError("the recording was not writing")); return }
        if sessionStart == nil {
            // Nothing was ever appended: an empty file is not a recording.
            writer.cancelWriting()
            done(CaptureError("nothing was recorded"))
            return
        }
        finishing = true
        finishWhenDrained(until: Date().addingTimeInterval(30), done)
    }

    private func finishWhenDrained(until deadline: Date, _ done: @escaping (Error?) -> Void) {
        for track in [Track.mic, .app] { drain(track) }
        let waiting = pending.values.contains { !$0.isEmpty }
        if waiting, writer.status == .writing, Date() < deadline {
            queue.asyncAfter(deadline: .now() + 0.005) { [weak self] in self?.finishWhenDrained(until: deadline, done) }
            return
        }
        for (track, left) in pending {
            for item in left { if case .sample(_, let seconds) = item { counts[track]?.dropped += 1; counts[track]?.droppedSeconds += seconds } }
            pending[track] = []
        }
        guard writer.status == .writing else { done(writer.error ?? CaptureError("the recording stopped writing")); return }
        inputs.values.forEach { $0.markAsFinished() }
        writer.finishWriting { [writer, queue] in
            let error = writer.status == .completed ? nil : (writer.error ?? CaptureError("the recording did not finish"))
            queue.async { done(error) }
        }
    }

    func cancel() {
        for track in pending.keys { pending[track] = [] }
        if writer.status == .writing { writer.cancelWriting() }
    }
}

struct CaptureError: Error, CustomStringConvertible, LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
    var errorDescription: String? { message }
}
