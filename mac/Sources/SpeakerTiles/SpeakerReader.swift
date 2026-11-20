// Reading a recorded call for who Meet showed speaking (docs/MAC.md P3a). The video is decoded in order
// with AVAssetReader (BGRA), one frame every `everyMs`; each frame's speaking rings are found
// (RingFinder) and the name on each ringed tile read (TileNames). Reading a name costs far more than
// finding a ring, so a name read on the same tile in the last `rereadMs` is reused, and read again after
// that in case Meet put someone else in that place. The report lists only the frames with a ring, as
// facts: where, and the name as read. Which line of the transcript that makes whose is polycap's
// decision (src/pipeline/speakers.ts), as is checking the ring against Me's own lines.
import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation

/// polycap reads this with a strict schema (src/pipeline/speakers.ts toolReportSchema); change both together.
public struct SpeakerReport: Codable, Equatable, Sendable {
    public struct Ring: Codable, Equatable, Sendable {
        /// How Meet showed it: a ring round the tile, its badge alone, or a green pill behind the name (Indicators).
        public var kind: Indicator.Kind
        /// The tile, or for a pill the pill.
        public var box: TileBox
        /// The name as read, nil when no name could be read on the tile.
        public var name: String?
        public var truncated: Bool?
        public var you: Bool?
        /// True when the name was read from this frame, false when reused from the same tile a moment before.
        public var fresh: Bool
    }

    public struct Sample: Codable, Equatable, Sendable {
        public var atMs: Int
        public var rings: [Ring]
    }

    /// 2: rings carry their kind (badge and pill added, 2026-11-11).
    public var version = 2
    public var tool = "polydance-speakers"
    public var width: Int
    public var height: Int
    public var everyMs: Int
    /// Frames looked at, and of them how many had a ring.
    public var sampled: Int
    public var withRing: Int
    public var namesRead: Int
    public var elapsedMs: Int
    public var samples: [Sample]
}

public enum SpeakerReaderError: Error, CustomStringConvertible {
    case noVideoTrack(String)
    case readerFailed(String)

    public var description: String {
        switch self {
        case .noVideoTrack(let path): "\(path) has no video track"
        case .readerFailed(let why): "the video could not be read: \(why)"
        }
    }
}

/// Names read on a tile, reused for `rereadMs`: a ring that stays on one tile is one person until Meet
/// rearranges the tiles, and reading every frame would cost a minute or more of an hour's call.
public struct NameCache {
    struct Entry {
        var kind: Indicator.Kind
        var box: TileBox
        var atMs: Int
        var name: TileName?
    }

    public let rereadMs: Int
    var entries: [Entry] = []

    public init(rereadMs: Int) { self.rereadMs = rereadMs }

    /// A name read on this tile at most `rereadMs` before, or nil (read it). A tile where no name could be
    /// read is tried again after a second rather than every frame.
    public func lookup(_ box: TileBox, kind: Indicator.Kind = .ring, atMs: Int) -> TileName?? {
        guard let entry = entries.last(where: { $0.kind == kind && $0.box.near(box) }) else { return nil }
        let age = atMs - entry.atMs
        if entry.name != nil, age >= 0, age < rereadMs { return .some(entry.name) }
        if entry.name == nil, age >= 0, age < 1000 { return .some(nil) }
        return nil
    }

    public mutating func store(_ box: TileBox, kind: Indicator.Kind = .ring, atMs: Int, name: TileName?) {
        entries.removeAll { $0.kind == kind && $0.box.near(box) }
        entries.append(Entry(kind: kind, box: box, atMs: atMs, name: name))
    }
}

public enum SpeakerReader {
    /// Who Meet showed speaking in one frame (Indicators) and their names, the cache deciding which to read again.
    /// A pill's name is read every time it is seen: pills are small and move with whoever is speaking.
    static func look(at frame: PixelFrame, atMs: Int, cache: inout NameCache, readName: (TileBox) throws -> TileName?) rethrows -> (rings: [SpeakerReport.Ring], read: Int) {
        var rings: [SpeakerReport.Ring] = []
        var read = 0
        for indicator in Indicators.find(in: frame) {
            let name: TileName?
            let fresh: Bool
            if indicator.kind != .pill, let cached = cache.lookup(indicator.box, kind: indicator.kind, atMs: atMs) {
                name = cached
                fresh = false
            } else {
                name = try readName(indicator.label)
                read += 1
                cache.store(indicator.box, kind: indicator.kind, atMs: atMs, name: name)
                fresh = true
            }
            rings.append(SpeakerReport.Ring(kind: indicator.kind, box: indicator.box, name: name?.name, truncated: name?.truncated == true ? true : nil,
                                            you: name?.you == true ? true : nil, fresh: fresh))
        }
        return (rings, read)
    }

    /// Reads a whole video, or the part from `fromMs` to `toMs`.
    public static func read(video url: URL, everyMs: Int = 500, rereadMs: Int = 3000, fromMs: Int? = nil, toMs: Int? = nil) async throws -> SpeakerReport {
        let started = Date()
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw SpeakerReaderError.noVideoTrack(url.path) }
        let reader = try AVAssetReader(asset: asset)
        if fromMs != nil || toMs != nil {
            let start = CMTime(value: CMTimeValue(fromMs ?? 0), timescale: 1000)
            reader.timeRange = CMTimeRange(start: start, end: toMs.map { CMTime(value: CMTimeValue($0), timescale: 1000) } ?? .positiveInfinity)
        }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { throw SpeakerReaderError.readerFailed(reader.error?.localizedDescription ?? "it would not start") }

        var cache = NameCache(rereadMs: rereadMs)
        var samples: [SpeakerReport.Sample] = []
        var sampled = 0, namesRead = 0, width = 0, height = 0
        var next = Int.min
        // Each frame's buffers and Vision's are let go as soon as it is read: without a pool per frame the
        // first call's 44 minutes peaked at 942 MB (2026-11-11).
        func step(_ buffer: CMSampleBuffer) throws {
            let atMs = Int((CMSampleBufferGetPresentationTimeStamp(buffer).seconds * 1000).rounded())
            guard atMs >= next, let image = CMSampleBufferGetImageBuffer(buffer) else { return }
            // The first frame at or after each step of a fixed grid, so the frame rate cannot make the steps drift.
            next = (atMs / everyMs + 1) * everyMs
            sampled += 1
            CVPixelBufferLockBaseAddress(image, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
            guard let base = CVPixelBufferGetBaseAddress(image) else { return }
            width = CVPixelBufferGetWidth(image)
            height = CVPixelBufferGetHeight(image)
            let frame = PixelFrame(width: width, height: height, bytesPerRow: CVPixelBufferGetBytesPerRow(image), base: base.assumingMemoryBound(to: UInt8.self))
            let seen = try look(at: frame, atMs: atMs, cache: &cache) { try TileNames.read(image, label: $0) }
            namesRead += seen.read
            if !seen.rings.isEmpty { samples.append(SpeakerReport.Sample(atMs: atMs, rings: seen.rings)) }
        }
        while true {
            let more = try autoreleasepool { () throws -> Bool in
                guard let buffer = output.copyNextSampleBuffer() else { return false }
                try step(buffer)
                return true
            }
            if !more { break }
        }
        if reader.status == .failed { throw SpeakerReaderError.readerFailed(reader.error?.localizedDescription ?? "unknown error") }
        return SpeakerReport(width: width, height: height, everyMs: everyMs, sampled: sampled, withRing: samples.count, namesRead: namesRead,
                             elapsedMs: Int(Date().timeIntervalSince(started) * 1000), samples: samples)
    }

    /// One still image (a saved frame), for checking a frame by hand: its rings and their names.
    public static func read(image: CGImage) throws -> [SpeakerReport.Ring] {
        let width = image.width, height = image.height, bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
        let drawn: Bool = pixels.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                                          // The image's own colour space, so its pixels are read as written: drawn into device RGB,
                                          // Meet's (18, 18, 18) background read (6, 6, 6) and no badge's tile was found.
                                          space: image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { throw SpeakerReaderError.readerFailed("the image could not be drawn") }
        var cache = NameCache(rereadMs: 0)
        return try pixels.withUnsafeBytes { raw in
            let frame = PixelFrame(width: width, height: height, bytesPerRow: bytesPerRow, base: raw.baseAddress!.assumingMemoryBound(to: UInt8.self))
            return try look(at: frame, atMs: 0, cache: &cache) { try TileNames.read(image, label: $0) }.rings
        }
    }
}
