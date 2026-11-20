// The app's writer against synthetic sound and pictures, with no microphone, screen or tap: AVAssetWriter
// itself, into temporary files. What it proves is the 2026-11-05 review's capture findings: the call
// sound's encoding never breaks the writer at any tap rate (cap-1), held audio goes in whole and a gap
// keeps later sound at its time (cap-2), a track that got no sound is not claimed (cap-5, seam-8), a
// late real frame is written rather than dropped behind a repeat (cap-7), and a screen capture that
// stopped mid-recording leaves black, not its last picture, until the picture comes back (C14).
import AVFoundation
import CoreMedia
import PolydanceCore
import XCTest
@testable import PolydanceCapture

final class WriterTests: XCTestCase {
    var temp: URL!
    let queue = DispatchQueue(label: "writer-tests")

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("writer-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    // MARK: Synthetic media

    static func pcmFormat(rate: Double, channels: Int) throws -> CMAudioFormatDescription {
        var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: UInt32(4 * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(4 * channels),
                                               mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
        var format: CMAudioFormatDescription?
        let status = CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                                    magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
        guard status == noErr, let format else { throw CaptureError("no format: \(status)") }
        return format
    }

    /// A buffer of a quiet tone, `frames` long, at `seconds` on a clock starting at 1000 s.
    static func tone(_ format: CMAudioFormatDescription, frames: Int, at seconds: Double) throws -> CMSampleBuffer {
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)!.pointee
        let channels = Int(asbd.mChannelsPerFrame)
        var samples = [Float](repeating: 0, count: frames * channels)
        for i in 0..<samples.count { samples[i] = 0.1 * sin(Float(i / channels) * 0.05) }
        let pts = CMTime(seconds: 1000 + seconds, preferredTimescale: 1_000_000_000)
        return try samples.withUnsafeMutableBytes { bytes in
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
            guard let buffer = AudioBuffers.make(list: &list, frames: frames, format: format, pts: pts) else { throw CaptureError("no buffer") }
            return buffer
        }
    }

    /// A 64 by 64 frame at `seconds` on the clock from 1000 s; `luma` fills it (235 is white in video range).
    static func frame(at seconds: Double, luma: UInt8? = nil) throws -> CMSampleBuffer {
        var pixels: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixels)
        guard let pixels else { throw CaptureError("no pixels") }
        if let luma {
            CVPixelBufferLockBaseAddress(pixels, [])
            memset(CVPixelBufferGetBaseAddressOfPlane(pixels, 0), Int32(luma), CVPixelBufferGetBytesPerRowOfPlane(pixels, 0) * CVPixelBufferGetHeightOfPlane(pixels, 0))
            memset(CVPixelBufferGetBaseAddressOfPlane(pixels, 1), 128, CVPixelBufferGetBytesPerRowOfPlane(pixels, 1) * CVPixelBufferGetHeightOfPlane(pixels, 1))
            CVPixelBufferUnlockBaseAddress(pixels, [])
        }
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescriptionOut: &format)
        guard let format else { throw CaptureError("no video format") }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(seconds: 1000 + seconds, preferredTimescale: 1_000_000_000), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        guard let sample else { throw CaptureError("no frame") }
        return sample
    }

    func finish(_ sink: AssetWriterSink) throws -> Error? {
        let done = expectation(description: "finished")
        var result: Error?
        queue.async { sink.finish { error in result = error; done.fulfill() } }
        wait(for: [done], timeout: 60)
        return result
    }

    /// The mean luma of a frame's centre, 0 to 255.
    static func centreLuma(_ pixels: CVPixelBuffer) -> Double {
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        let base = CVPixelBufferGetBaseAddressOfPlane(pixels, 0)!.assumingMemoryBound(to: UInt8.self)
        let row = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0), w = CVPixelBufferGetWidthOfPlane(pixels, 0), h = CVPixelBufferGetHeightOfPlane(pixels, 0)
        var sum = 0.0, n = 0.0
        for y in (h / 4)..<(3 * h / 4) { for x in (w / 4)..<(3 * w / 4) { sum += Double(base[y * row + x]); n += 1 } }
        return sum / n
    }

    /// Every decoded video frame of `url`: its time from the file's start and its centre's luma.
    func videoFrames(_ url: URL) async throws -> [(seconds: Double, luma: Double)] {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var frames: [(Double, Double)] = []
        while let sample = output.copyNextSampleBuffer() {
            guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
            frames.append((CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)), Self.centreLuma(pixels)))
        }
        return frames
    }

    /// Appends a video frame on the writer queue, waiting out a busy encoder, as the recorder's repeat timer would.
    func appendVideo(_ sink: AssetWriterSink, _ buffer: CMSampleBuffer, isRepeat: Bool = false) -> CMSampleBuffer? {
        for _ in 0..<200 {
            let busy = sink.counts[.video]?.notReady ?? 0
            if let written = sink.appendVideo(buffer, isRepeat: isRepeat) { return written }
            guard (sink.counts[.video]?.notReady ?? 0) > busy else { return nil }
            usleep(5_000)
        }
        return nil
    }

    func audioTracks(_ url: URL) async throws -> [(seconds: Double, rate: Double, channels: Int)] {
        let asset = AVURLAsset(url: url)
        var found: [(Double, Double, Int)] = []
        for track in try await asset.loadTracks(withMediaType: .audio) {
            let range = try await track.load(.timeRange)
            let format = try await track.load(.formatDescriptions).first
            let asbd = format.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
            found.append((CMTimeGetSeconds(range.duration), asbd?.mSampleRate ?? 0, Int(asbd?.mChannelsPerFrame ?? 0)))
        }
        return found
    }

    // MARK: cap-1

    /// Whatever rate the tap runs at, the call's sound is encoded at a rate AAC takes, and the whole
    /// writer finishes (at 16 to 24 kHz the old settings failed after about a hundred buffers).
    func testTheCallSoundEncodesAtEveryTapRate() async throws {
        for rate in [16_000.0, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000] {
            let url = temp.appendingPathComponent("rate-\(Int(rate)).mp4")
            let spec = AssetWriterSink.AudioSpec(channels: 2, sampleRate: AppTrackEncoding.sampleRate(forTapRate: rate))
            let sink = try AssetWriterSink(url: url, video: nil, mic: .init(channels: 1, sampleRate: 48_000), app: spec, queue: queue)
            let tap = try Self.pcmFormat(rate: rate, channels: 2)
            let mic = try Self.pcmFormat(rate: 48_000, channels: 1)
            let frames = 512
            let seconds = Double(frames) / rate
            try queue.sync {
                for i in 0..<Int(6 / seconds) { sink.append(try Self.tone(tap, frames: frames, at: Double(i) * seconds), to: .app) }
                for i in 0..<Int(6 / (1024 / 48_000.0)) { sink.append(try Self.tone(mic, frames: 1024, at: Double(i) * 1024 / 48_000), to: .mic) }
            }
            XCTAssertNil(try finish(sink), "\(rate) Hz")
            let tracks = try await audioTracks(url)
            XCTAssertEqual(tracks.count, 2, "\(rate) Hz")
            XCTAssertEqual(tracks.last?.rate, spec.sampleRate, "\(rate) Hz")
            XCTAssertEqual(tracks.last?.seconds ?? 0, 6, accuracy: 0.1, "\(rate) Hz: resampled, not stretched")
        }
    }

    /// Settings the encoder refuses are an error to report, not an exception that ends the app.
    func testSettingsTheEncoderRefusesAreAnError() {
        XCTAssertThrowsError(try AssetWriterSink(url: temp.appendingPathComponent("bad.mp4"), video: nil, mic: nil,
                                                 app: .init(channels: 2, sampleRate: 96_000), queue: queue)) { error in
            XCTAssertTrue("\(error)".contains("settings are not ones the encoder takes"), "\(error)")
        }
    }

    // MARK: cap-2

    /// Thirty seconds held while the recording started go in whole; the old sink dropped most of it.
    func testHeldSoundIsWrittenWhole() async throws {
        let url = temp.appendingPathComponent("held.mp4")
        let sink = try AssetWriterSink(url: url, video: nil, mic: .init(channels: 1, sampleRate: 48_000), app: .init(channels: 2, sampleRate: 48_000), queue: queue)
        let tap = try Self.pcmFormat(rate: 48_000, channels: 2)
        let mic = try Self.pcmFormat(rate: 48_000, channels: 1)
        // As the recorder bursts what it held: both tracks in timestamp order, in one go.
        var held: [(AssetWriterSink.Track, CMSampleBuffer)] = []
        for i in 0..<Int(30 * 48_000 / 512) { held.append((.app, try Self.tone(tap, frames: 512, at: Double(i) * 512 / 48_000))) }
        for i in 0..<Int(30 * 48_000 / 1024) { held.append((.mic, try Self.tone(mic, frames: 1024, at: Double(i) * 1024 / 48_000))) }
        held.sort { CMSampleBufferGetPresentationTimeStamp($0.1) < CMSampleBufferGetPresentationTimeStamp($1.1) }
        let sent = held.filter { $0.0 == .app }.count
        queue.sync { for (track, buffer) in held { sink.append(buffer, to: track) } }
        XCTAssertNil(try finish(sink))
        let counts = queue.sync { sink.counts }
        XCTAssertEqual(counts[.app]?.dropped, 0)
        XCTAssertEqual(counts[.mic]?.dropped, 0)
        XCTAssertEqual(counts[.app]?.appended, sent)
        let tracks = try await audioTracks(url)
        XCTAssertEqual(tracks.map(\.seconds).max() ?? 0, 30, accuracy: 0.1)
    }

    /// When more is waiting than the queue holds, what is dropped becomes silence of the same length, once:
    /// the track still lasts as long as the sound that was sent.
    func testSoundDroppedFromAFullQueueBecomesSilenceOfTheSameLength() async throws {
        let url = temp.appendingPathComponent("overflow.mp4")
        let sink = try AssetWriterSink(url: url, video: nil, mic: .init(channels: 1, sampleRate: 48_000), app: .init(channels: 2, sampleRate: 48_000),
                                       queue: queue, maxQueuedSeconds: 0.5)
        let tap = try Self.pcmFormat(rate: 48_000, channels: 2)
        let mic = try Self.pcmFormat(rate: 48_000, channels: 1)
        var held: [(AssetWriterSink.Track, CMSampleBuffer)] = []
        for i in 0..<Int(30 * 48_000 / 512) { held.append((.app, try Self.tone(tap, frames: 512, at: Double(i) * 512 / 48_000))) }
        for i in 0..<Int(30 * 48_000 / 1024) { held.append((.mic, try Self.tone(mic, frames: 1024, at: Double(i) * 1024 / 48_000))) }
        held.sort { CMSampleBufferGetPresentationTimeStamp($0.1) < CMSampleBufferGetPresentationTimeStamp($1.1) }
        queue.sync { for (track, buffer) in held { sink.append(buffer, to: track) } }
        XCTAssertNil(try finish(sink))
        let counts = try XCTUnwrap(queue.sync { sink.counts[.app] })
        XCTAssertGreaterThan(counts.dropped, 0, "the small queue overflowed")
        XCTAssertNotNil(counts.firstDropAt)
        XCTAssertEqual(counts.filledSeconds, counts.droppedSeconds, accuracy: 0.05, "each dropped stretch is filled, once")
        let tracks = try await audioTracks(url)
        XCTAssertEqual(tracks.map(\.seconds).max() ?? 0, 30, accuracy: 0.05)
    }

    /// Sound that stopped for three seconds and came back stays at its time: silence fills the gap, so
    /// the track is seven seconds long, not four with everything after the gap early.
    func testAGapInATracksSoundIsFilledWithSilence() async throws {
        let url = temp.appendingPathComponent("gap.mp4")
        let sink = try AssetWriterSink(url: url, video: nil, mic: nil, app: .init(channels: 2, sampleRate: 48_000), queue: queue)
        let tap = try Self.pcmFormat(rate: 48_000, channels: 2)
        let step = 512 / 48_000.0
        try queue.sync {
            for i in 0..<Int(2 / step) { sink.append(try Self.tone(tap, frames: 512, at: Double(i) * step), to: .app) }
            for i in 0..<Int(2 / step) { sink.append(try Self.tone(tap, frames: 512, at: 5 + Double(i) * step), to: .app) }
        }
        XCTAssertNil(try finish(sink))
        let counts = queue.sync { sink.counts }
        XCTAssertEqual(counts[.app]?.filledSeconds ?? 0, 3, accuracy: 0.05)
        let tracks = try await audioTracks(url)
        XCTAssertEqual(tracks.first?.seconds ?? 0, 7, accuracy: 0.1)
    }

    // MARK: cap-5, seam-8

    /// AVAssetWriter leaves out an input that got no samples, so the metadata must not claim it.
    func testATrackThatGotNoSoundIsNotClaimed() async throws {
        let url = temp.appendingPathComponent("noapp.mp4")
        let sink = try AssetWriterSink(url: url, video: nil, mic: .init(channels: 1, sampleRate: 48_000), app: .init(channels: 2, sampleRate: 48_000), queue: queue)
        let mic = try Self.pcmFormat(rate: 48_000, channels: 1)
        var first: [AssetWriterSink.Track] = []
        sink.onFirstSample = { first.append($0) }
        try queue.sync { for i in 0..<100 { sink.append(try Self.tone(mic, frames: 1024, at: Double(i) * 1024 / 48_000), to: .mic) } }
        XCTAssertNil(try finish(sink))
        XCTAssertEqual(queue.sync { sink.tracks }, [.mic, .app])
        XCTAssertEqual(queue.sync { sink.tracksWithSamples }, [.mic])
        XCTAssertEqual(first, [.mic], "the first sample is announced once, so the metadata can be rewritten")
        let tracks = try await audioTracks(url)
        XCTAssertEqual(tracks.map(\.channels), [1], "the file has only the microphone")
    }

    // MARK: cap-7

    /// A real frame that reaches the writer after a repeat stamped later is written 1 ms after it.
    func testALateRealFrameIsWrittenNotDropped() throws {
        let sink = try AssetWriterSink(url: temp.appendingPathComponent("video.mp4"), video: .init(width: 64, height: 64, fps: 5), mic: nil, app: nil, queue: queue)
        try queue.sync {
            XCTAssertNotNil(sink.appendVideo(try Self.frame(at: 1.0), isRepeat: false))
            XCTAssertNotNil(sink.appendVideo(try Self.frame(at: 2.0), isRepeat: true))
            let late = sink.appendVideo(try Self.frame(at: 1.99), isRepeat: false)
            XCTAssertEqual(late.map { CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp($0)) } ?? 0, 1002.001, accuracy: 0.0001)
            XCTAssertNil(sink.appendVideo(try Self.frame(at: 1.5), isRepeat: true), "a late repeat is skipped")
            XCTAssertEqual(sink.counts[.video]?.appended, 3)
            XCTAssertEqual(sink.counts[.video]?.retimed, 1)
        }
        XCTAssertNil(try finish(sink))
    }

    // MARK: C14

    /// The black frame is black in the screen's pixel format, at the size asked and the time given.
    func testTheBlackFrameIsBlack() throws {
        let pts = CMTime(seconds: 1234.5, preferredTimescale: 1_000_000_000)
        let black = try XCTUnwrap(AssetWriterSink.blackFrame(width: 1920, height: 1080, pts: pts))
        XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(black), pts)
        let pixels = try XCTUnwrap(CMSampleBufferGetImageBuffer(black))
        XCTAssertEqual(CVPixelBufferGetWidth(pixels), 1920)
        XCTAssertEqual(CVPixelBufferGetHeight(pixels), 1080)
        XCTAssertEqual(CVPixelBufferGetPixelFormatType(pixels), kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        XCTAssertEqual(Self.centreLuma(pixels), 16)
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        XCTAssertEqual(CVPixelBufferGetBaseAddressOfPlane(pixels, 1)!.assumingMemoryBound(to: UInt8.self)[10], 128)
        CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
    }

    /// The screen stopped at 2.5 s and came back at 5 s: in the file the picture is black from 2.5 s, kept
    /// up by the repeats, and the restarted stream's frames carry on in the same track at their own time,
    /// with the sound beside them throughout. Before C14 the last picture stayed on screen for the gap.
    func testAStoppedScreenLeavesBlackUntilThePictureComesBack() async throws {
        let url = temp.appendingPathComponent("screen-gap.mp4")
        let sink = try AssetWriterSink(url: url, video: .init(width: 64, height: 64, fps: 5), mic: .init(channels: 1, sampleRate: 48_000), app: nil, queue: queue)
        let mic = try Self.pcmFormat(rate: 48_000, channels: 1)
        try queue.sync {
            for i in 0..<70 { sink.append(try Self.tone(mic, frames: 4_800, at: Double(i) * 0.1), to: .mic) }
            for t in [0.0, 1.0, 2.0] { XCTAssertNotNil(appendVideo(sink, try Self.frame(at: t, luma: 235))) }
            // The stop: black at its moment, then repeated each second as the recorder's timer does.
            let black = try XCTUnwrap(AssetWriterSink.blackFrame(width: 64, height: 64, pts: CMTime(seconds: 1002.5, preferredTimescale: 1_000_000_000)))
            let written = try XCTUnwrap(appendVideo(sink, black))
            for t in [3.5, 4.5] { XCTAssertNotNil(appendVideo(sink, try XCTUnwrap(AssetWriterSink.retime(written, to: CMTime(seconds: 1000 + t, preferredTimescale: 1_000_000_000))), isRepeat: true)) }
            // The restarted stream.
            for t in [5.0, 6.0] { XCTAssertNotNil(appendVideo(sink, try Self.frame(at: t, luma: 235))) }
        }
        XCTAssertNil(try finish(sink))
        let frames = try await videoFrames(url)
        XCTAssertEqual(frames.map { ($0.seconds * 10).rounded() / 10 }, [0, 1, 2, 2.5, 3.5, 4.5, 5, 6])
        for frame in frames {
            let gap = frame.seconds >= 2.5 && frame.seconds < 5
            if gap { XCTAssertLessThan(frame.luma, 30, "black at \(frame.seconds) s") } else { XCTAssertGreaterThan(frame.luma, 200, "the picture at \(frame.seconds) s") }
        }
        let tracks = try await audioTracks(url)
        XCTAssertEqual(tracks.first?.seconds ?? 0, 7, accuracy: 0.1, "the sound runs through the gap on the same clock")
    }
}
