// The take's writer against synthetic camera frames and microphone buffers, with no camera, phone or
// microphone: AVAssetWriter itself into temporary files on this Mac (docs/IPHONE.md R1 to R4). Each case
// is a take as the phone would feed it: sound that starts before the first frame, a frame of the wrong
// size (a rotation that did not take), a 400 ms hole in the frames (a flip) with 300 ms of sound missing
// under it, and a source the encoder must convert (stereo, 44.1 kHz, the 16 kHz of AirPods). What it
// cannot show is the phone's own camera, encoder or timing; I0 shows those on the phone.
import AVFoundation
import CoreMedia
import Foundation
import Testing
@testable import PolydancePhoneCore

struct TakeCase: CustomTestStringConvertible, Sendable {
    let name: String
    let width: Int
    let height: Int
    let rate: Double
    let channels: Int
    let float: Bool
    var testDescription: String { name }

    static let all = [
        TakeCase(name: "portrait, 48 kHz mono float", width: 1080, height: 1920, rate: 48_000, channels: 1, float: true),
        TakeCase(name: "landscape, 44.1 kHz stereo int16", width: 1920, height: 1080, rate: 44_100, channels: 2, float: false),
        TakeCase(name: "portrait, 16 kHz mono int16 (AirPods)", width: 1080, height: 1920, rate: 16_000, channels: 1, float: false),
    ]
}

@Suite(.serialized) struct MovieWriterTests {
    static let clock = 1000.0
    static let fps = 30.0
    /// The flip: the frame after this one comes 400 ms later instead of 33 ms.
    static let flipAfter = 1.5
    static let flipGap = 0.4
    /// The microphone's own hole during the flip.
    static let audioHole = (from: 1.5, to: 1.8)
    static let end = 3.0

    func temp() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("movie-writer-\(UUID().uuidString)", isDirectory: true)
        try PrivateFiles.directory(url)
        return url
    }

    // MARK: The take

    @Test(arguments: TakeCase.all)
    func writesUprightFilesOnOneClock(_ c: TakeCase) async throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent(RunNames.videoFile)
        let narration = dir.appendingPathComponent(RunNames.narrationFile)
        let settings = MovieWriterSettings(width: c.width, height: c.height)
        let writer = try MovieWriter(videoURL: video, narrationURL: narration, settings: settings)

        // Frame times: 30 fps up to the flip, a 400 ms hole, then 30 fps to the end.
        var frameTimes: [Double] = []
        var t = 0.0
        while t <= Self.flipAfter + 1e-9 { frameTimes.append(t); t += 1 / Self.fps }
        t = frameTimes.last! + Self.flipGap
        while t < Self.end - 1e-9 { frameTimes.append(t); t += 1 / Self.fps }
        let lastBeforeFlip = frameTimes.last { $0 <= Self.flipAfter + 1e-9 }!

        // Sound from half a second before the first frame to just past the last, 1024 frames a buffer,
        // with the hole under the flip.
        let format = try Self.pcmFormat(rate: c.rate, channels: c.channels, float: c.float)
        let step = 1024 / c.rate
        var audioTimes: [Double] = []
        var skipped = 0
        var a = -0.5
        while a < Self.end + 0.1 {
            if a >= Self.audioHole.from && a < Self.audioHole.to { skipped += 1 } else { audioTimes.append(a) }
            a += step
        }
        // The hole is whole buffers: 300 ms at 48 kHz, 256 ms in 64 ms buffers at 16 kHz.
        let hole = Double(skipped) * step
        let expectedBeforeStart = audioTimes.filter { $0 < 0 }.count

        // As the capture queue would deliver them: in time order, with two wrong-size frames, one before
        // any good frame (which must not start the files) and one in the middle.
        enum Item { case frame(Double, wide: Bool), sound(Double) }
        var items: [(Double, Item)] = frameTimes.map { ($0, .frame($0, wide: false)) } + audioTimes.map { ($0, .sound($0)) }
        items.append((-0.1, .frame(-0.1, wide: true)))
        items.append((0.51, .frame(0.51, wide: true)))
        items.sort { $0.0 < $1.0 }

        // The flip is measured as the capture sink measures it: FlipClock fed what the writer took.
        var clock = FlipClock()
        var reports: [FlipClock.Report] = []
        for (_, item) in items {
            switch item {
            case .frame(let at, let wide):
                try await Self.waitUntilReady(writer)
                let size = wide ? (1280, 720) : (c.width, c.height)
                let facing = at <= Self.flipAfter + 1e-9 ? "back" : "front"
                if facing == "front", clock.awaited == nil, reports.isEmpty { clock.expect("front") }
                let sample = try Self.frame(width: size.0, height: size.1, at: at)
                let before = writer.stats.videoFrames
                writer.appendVideo(sample)
                let after = writer.stats
                if let report = clock.frame(pts: CMSampleBufferGetPresentationTimeStamp(sample).seconds, written: after.videoFrames > before,
                                            facing: facing, sessionStart: after.startSeconds) {
                    reports.append(report)
                }
            case .sound(let at):
                writer.appendAudio(try Self.tone(format, frames: 1024, at: at))
            }
        }
        let live = writer.stats
        #expect(live.videoFrames == frameTimes.count)

        let stats = try await writer.finish()
        #expect(stats.startSeconds == Self.clock, "the files start at the first good frame, not the wrong-size one before it")
        #expect(abs((stats.lastVideoSeconds ?? 0) - (Self.clock + frameTimes.last!)) < 1e-6)
        #expect(stats.videoFrames == frameTimes.count)
        #expect(stats.droppedVideoFrames == 2)
        #expect(stats.wrongSizeVideoFrames == 2)
        #expect(stats.audioBeforeStart == expectedBeforeStart, "every buffer stamped before the first frame is dropped")
        #expect(stats.droppedAudioBuffers == expectedBeforeStart, "and nothing else")
        #expect(stats.audioBuffers == audioTimes.count - expectedBeforeStart)
        #expect(stats.audioGaps == 1)
        #expect(abs(stats.filledAudioSeconds - hole) < 0.002, "the hole is filled with silence: \(stats.filledAudioSeconds) s of \(hole) s")
        #expect(stats.failure == nil)

        // The flip's gap and where the front camera begins, on the writer's clock.
        let firstAfterFlip = frameTimes.first { $0 > lastBeforeFlip }!
        #expect(reports == [FlipClock.Report(facing: "front", gapMs: Int(Self.flipGap * 1000), atMs: Int((firstAfterFlip * 1000).rounded()))])

        // Files: both there, both private.
        for url in [video, narration] {
            let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
            #expect(mode == 0o600, "\(url.lastPathComponent) is \(String(mode ?? 0, radix: 8))")
        }

        // Read back with AVFoundation.
        let movie = AVURLAsset(url: video)
        let videoTracks = try await movie.loadTracks(withMediaType: .video)
        #expect(videoTracks.count == 1)
        let track = try #require(videoTracks.first)
        let size = try await track.load(.naturalSize)
        #expect(size == CGSize(width: c.width, height: c.height), "upright pixels at the settings' size: \(size)")
        #expect(try await track.load(.preferredTransform) == .identity, "no rotation in the metadata")
        let videoSeconds = try await track.load(.timeRange).duration.seconds
        #expect(abs(videoSeconds - Self.end) < 0.1, "video lasts \(videoSeconds) s")

        let movieAudio = try await Self.audioTracks(movie)
        let narrationAsset = AVURLAsset(url: narration)
        let narrationAudio = try await Self.audioTracks(narrationAsset)
        #expect(try await narrationAsset.loadTracks(withMediaType: .video).isEmpty)
        #expect(movieAudio.count == 1)
        #expect(narrationAudio.count == 1)
        let soundEnd = (stats.lastAudioSeconds ?? 0) - Self.clock
        for (file, tracks) in [("video.mp4", movieAudio), ("narration.m4a", narrationAudio)] {
            let audio = try #require(tracks.first)
            #expect(audio.channels == 1, "\(file): mono from \(c.channels) channels")
            #expect(audio.rate == 48_000, "\(file): 48 kHz from \(c.rate)")
            // The sound runs from the first frame to where the last buffer ended: the hole did not
            // shorten it, so later words are still at their time.
            #expect(abs(audio.seconds - soundEnd) < 0.1, "\(file): sound lasts \(audio.seconds) s, expected \(soundEnd)")
            #expect(audio.start < 0.05, "\(file): sound starts at \(audio.start) s")
        }

        // And with ffprobe, which is what the receiver reads them with.
        if let ffprobe = Self.ffprobe() {
            let probed = try Self.probe(ffprobe, video)
            let streams = try #require(probed["streams"] as? [[String: Any]])
            let v = try #require(streams.first { $0["codec_type"] as? String == "video" })
            #expect(v["codec_name"] as? String == "h264")
            #expect(v["width"] as? Int == c.width)
            #expect(v["height"] as? Int == c.height)
            let sideData = (v["side_data_list"] as? [[String: Any]]) ?? []
            #expect(!sideData.contains { $0["rotation"] != nil || $0["side_data_type"] as? String == "Display Matrix" }, "no display matrix: \(sideData)")
            #expect((v["tags"] as? [String: Any])?["rotate"] == nil)
            #expect(streams.filter { $0["codec_type"] as? String == "audio" }.count == 1)

            let n = try Self.probe(ffprobe, narration)
            let nStreams = try #require(n["streams"] as? [[String: Any]])
            #expect(nStreams.count == 1)
            #expect(nStreams.first?["codec_name"] as? String == "aac")
            #expect(nStreams.first?["channels"] as? Int == 1)
            #expect(nStreams.first?["sample_rate"] as? String == "48000")
        }
    }

    // MARK: Edges

    @Test func aTakeWithNoGoodFrameIsNoRecording() async throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent(RunNames.videoFile)
        let narration = dir.appendingPathComponent(RunNames.narrationFile)
        let writer = try MovieWriter(videoURL: video, narrationURL: narration, settings: MovieWriterSettings(width: 1080, height: 1920))
        let format = try Self.pcmFormat(rate: 48_000, channels: 1, float: true)
        writer.appendVideo(try Self.frame(width: 1920, height: 1080, at: 0))
        writer.appendAudio(try Self.tone(format, frames: 1024, at: 0.01))
        #expect(writer.stats.wrongSizeVideoFrames == 1)
        #expect(writer.stats.audioBeforeStart == 1, "with no frame there is no start, so all sound is before it")
        await #expect(throws: MovieWriterError.self) { try await writer.finish() }
        #expect(!FileManager.default.fileExists(atPath: video.path))
        #expect(!FileManager.default.fileExists(atPath: narration.path))
        await #expect(throws: MovieWriterError.self) { try await writer.finish() }
    }

    @Test func cancelRemovesThePartialFiles() async throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent(RunNames.videoFile)
        let narration = dir.appendingPathComponent(RunNames.narrationFile)
        let writer = try MovieWriter(videoURL: video, narrationURL: narration, settings: MovieWriterSettings(width: 1920, height: 1080))
        for i in 0..<10 {
            try await Self.waitUntilReady(writer)
            writer.appendVideo(try Self.frame(width: 1920, height: 1080, at: Double(i) / 30))
        }
        writer.cancel()
        #expect(!FileManager.default.fileExists(atPath: video.path))
        #expect(!FileManager.default.fileExists(atPath: narration.path))
        writer.appendVideo(try Self.frame(width: 1920, height: 1080, at: 1))
        #expect(writer.stats.videoFrames == 10, "nothing is taken after cancel")
        await #expect(throws: MovieWriterError.self) { try await writer.finish() }
    }

    @Test func neverWritesOverAnotherTakeOrTakesABadSize() throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent(RunNames.videoFile)
        let narration = dir.appendingPathComponent(RunNames.narrationFile)
        try PrivateFiles.write(Data("earlier".utf8), to: video)
        #expect(throws: MovieWriterError(file: "video.mp4", "already exists; a take never writes over another")) {
            try MovieWriter(videoURL: video, narrationURL: narration, settings: MovieWriterSettings(width: 1080, height: 1920))
        }
        #expect(try String(contentsOf: video, encoding: .utf8) == "earlier")
        try FileManager.default.removeItem(at: video)
        #expect(throws: MovieWriterError.self) {
            try MovieWriter(videoURL: video, narrationURL: narration, settings: MovieWriterSettings(width: 1081, height: 1920))
        }
    }

    // MARK: A screen (the iPhone's broadcast, docs/IPHONE.md I4)

    @Test func aScreensSizeIsKeptOrScaledToEvenSides() {
        let iphone = MovieWriterSettings.screen(width: 1179, height: 2556, maxShortSide: 1080)
        #expect((iphone.width, iphone.height) == (1080, 2340))
        #expect((iphone.inputWidth, iphone.inputHeight) == (1179, 2556))
        #expect(iphone.scales)
        let landscape = MovieWriterSettings.screen(width: 2556, height: 1179, maxShortSide: 1080)
        #expect((landscape.width, landscape.height) == (2340, 1080))
        // Already small enough and even: untouched, so nothing is scaled.
        let small = MovieWriterSettings.screen(width: 886, height: 1920, maxShortSide: 1080)
        #expect((small.width, small.height, small.scales) == (886, 1920, false))
        // The Vision Pro's: no limit, even, the same.
        let vision = MovieWriterSettings.screen(width: 1920, height: 1080)
        #expect((vision.width, vision.height, vision.scales) == (1920, 1080, false))
        // Odd and small: one pixel off the odd side only.
        let odd = MovieWriterSettings.screen(width: 751, height: 1334, maxShortSide: 1080)
        #expect((odd.width, odd.height, odd.inputWidth) == (750, 1334, 751))
    }

    @Test func anOddSizedScreenIsWrittenScaled() async throws {
        let dir = try temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent(RunNames.videoFile)
        let narration = dir.appendingPathComponent(RunNames.narrationFile)
        let settings = MovieWriterSettings.screen(width: 1179, height: 2556, maxShortSide: 1080)
        let writer = try MovieWriter(videoURL: video, narrationURL: narration, settings: settings)
        let format = try Self.pcmFormat(rate: 48_000, channels: 1, float: true)
        for i in 0..<30 {
            try await Self.waitUntilReady(writer)
            writer.appendVideo(try Self.frame(width: 1179, height: 2556, at: Double(i) / 30))
            writer.appendAudio(try Self.tone(format, frames: 1600, at: Double(i) / 30))
        }
        // A frame of the file's own size is not the source's, so it is refused, as any wrong size is.
        writer.appendVideo(try Self.frame(width: 1080, height: 2340, at: 1.01))
        let stats = try await writer.finish()
        #expect(stats.videoFrames == 30)
        #expect(stats.wrongSizeVideoFrames == 1)
        let track = try #require(try await AVURLAsset(url: video).loadTracks(withMediaType: .video).first)
        let size = try await track.load(.naturalSize)
        #expect((Int(size.width), Int(size.height)) == (1080, 2340))
        #expect(try await track.load(.preferredTransform) == .identity, "upright pixels, no rotation flag")
    }

    // MARK: Synthetic media

    static func waitUntilReady(_ writer: MovieWriter) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !writer.isReady {
            guard Date() < deadline else { throw MovieWriterError(file: nil, "the encoder did not become ready in 5 s") }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    static func pcmFormat(rate: Double, channels: Int, float: Bool) throws -> CMAudioFormatDescription {
        let bytes = float ? 4 : 2
        let flags = float ? kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked : kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked
        var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: flags,
                                               mBytesPerPacket: UInt32(bytes * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(bytes * channels),
                                               mChannelsPerFrame: UInt32(channels), mBitsPerChannel: UInt32(bytes * 8), mReserved: 0)
        var format: CMAudioFormatDescription?
        let status = CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                                    magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
        guard status == noErr, let format else { throw MovieWriterError(file: nil, "no audio format: \(status)") }
        return format
    }

    /// A buffer of a quiet tone, `frames` long, at `seconds` on a clock starting at 1000 s.
    static func tone(_ format: CMAudioFormatDescription, frames: Int, at seconds: Double) throws -> CMSampleBuffer {
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)!.pointee
        let channels = Int(asbd.mChannelsPerFrame)
        let float = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        var data = Data(count: frames * Int(asbd.mBytesPerFrame))
        data.withUnsafeMutableBytes { raw in
            for i in 0..<(frames * channels) {
                let v = 0.1 * sin(Double(i / channels) * 2 * .pi * 440 / asbd.mSampleRate)
                if float { raw.storeBytes(of: Float(v), toByteOffset: i * 4, as: Float.self) }
                else { raw.storeBytes(of: Int16(v * Double(Int16.max)), toByteOffset: i * 2, as: Int16.self) }
            }
        }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: data.count, blockAllocator: kCFAllocatorDefault,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: data.count, flags: kCMBlockBufferAssureMemoryNowFlag,
                                                 blockBufferOut: &block) == noErr, let block else { throw MovieWriterError(file: nil, "no block") }
        let copied = data.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: data.count) }
        guard copied == noErr else { throw MovieWriterError(file: nil, "no copy: \(copied)") }
        var sample: CMSampleBuffer?
        let pts = CMTime(seconds: clock + seconds, preferredTimescale: 1_000_000_000)
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
                                                                   sampleCount: frames, presentationTimeStamp: pts, packetDescriptions: nil,
                                                                   sampleBufferOut: &sample) == noErr, let sample else { throw MovieWriterError(file: nil, "no audio buffer") }
        return sample
    }

    /// A 420v frame (the camera's own format) of a grey that changes with time, at `seconds` on the clock.
    static func frame(width: Int, height: Int, at seconds: Double) throws -> CMSampleBuffer {
        var pixels: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixels)
        guard let pixels else { throw MovieWriterError(file: nil, "no pixels") }
        CVPixelBufferLockBaseAddress(pixels, [])
        for plane in 0..<CVPixelBufferGetPlaneCount(pixels) {
            if let base = CVPixelBufferGetBaseAddressOfPlane(pixels, plane) {
                let value: Int32 = plane == 0 ? Int32(16 + Int(seconds * 60) % 200) : 128
                memset(base, value, CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane))
            }
        }
        CVPixelBufferUnlockBaseAddress(pixels, [])
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescriptionOut: &format)
        guard let format else { throw MovieWriterError(file: nil, "no video format") }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMTime(seconds: clock + seconds, preferredTimescale: 1_000_000_000),
                                        decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        guard let sample else { throw MovieWriterError(file: nil, "no frame") }
        return sample
    }

    struct AudioTrack { let seconds: Double; let start: Double; let rate: Double; let channels: Int }

    static func audioTracks(_ asset: AVURLAsset) async throws -> [AudioTrack] {
        var found: [AudioTrack] = []
        for track in try await asset.loadTracks(withMediaType: .audio) {
            let range = try await track.load(.timeRange)
            let format = try await track.load(.formatDescriptions).first
            let asbd = format.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
            found.append(AudioTrack(seconds: range.duration.seconds, start: range.start.seconds, rate: asbd?.mSampleRate ?? 0, channels: Int(asbd?.mChannelsPerFrame ?? 0)))
        }
        return found
    }

    // MARK: ffprobe

    /// ffprobe from PATH, or Homebrew's, when it is installed; the AVFoundation checks run either way.
    static func ffprobe() -> URL? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let dirs = path.split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin"]
        return dirs.map { URL(fileURLWithPath: $0).appendingPathComponent("ffprobe") }.first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    /// ffprobe's streams as JSON, run with an argument array (no shell).
    static func probe(_ ffprobe: URL, _ file: URL) throws -> [String: Any] {
        let process = Process()
        process.executableURL = ffprobe
        process.arguments = ["-v", "error", "-show_streams", "-of", "json", file.path]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw MovieWriterError(file: file.lastPathComponent, "ffprobe exited \(process.terminationStatus)") }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw MovieWriterError(file: file.lastPathComponent, "ffprobe gave no JSON object") }
        return json
    }
}
