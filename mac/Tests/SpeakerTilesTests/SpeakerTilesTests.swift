// The speaking ring, the lone badge and the green pill, the names on Meet's tiles and the video reader, on
// synthetic frames drawn the way Meet draws them (an (18, 18, 18) stage, grey tiles, a 3 px ring of
// #A8C7FA, white names at the bottom left) and on a short synthetic video written with AVAssetWriter.
// No recorded call is used: those stay in the library.
import AppKit
import AVFoundation
import XCTest
@testable import SpeakerTiles

/// Meet's colours as measured on the first call (docs/PLATFORM-NOTES.md, 2026-11-11).
private enum Meet {
    static let stage = NSColor(srgbRed: 18 / 255, green: 18 / 255, blue: 18 / 255, alpha: 1)
    static let navy = NSColor(srgbRed: 0, green: 39 / 255, blue: 88 / 255, alpha: 1)
    static let pill = NSColor(srgbRed: 95 / 255, green: 207 / 255, blue: 133 / 255, alpha: 1)
    static let pillText = NSColor(srgbRed: 4 / 255, green: 70 / 255, blue: 23 / 255, alpha: 1)

    /// The speaking badge: a disc of the ring's blue with three navy bars, its centre at `centre`.
    static func badge(at centre: NSPoint) {
        ring.setFill()
        NSBezierPath(ovalIn: NSRect(x: centre.x - 10, y: centre.y - 10, width: 20, height: 20)).fill()
        navy.setFill()
        for (dx, h) in [(-5.0, 6.0), (-1.5, 10.0), (2.0, 6.0)] { NSRect(x: centre.x + dx, y: centre.y - h / 2, width: 3, height: h).fill() }
    }

    /// The green pill Meet put behind a speaker's name while someone presented: an icon, then the name.
    static func pill(_ name: String, at origin: NSPoint) {
        let font = NSFont.systemFont(ofSize: 14, weight: .medium)
        let width = (name as NSString).size(withAttributes: [.font: font]).width + 40
        Meet.pill.setFill()
        NSBezierPath(roundedRect: NSRect(x: origin.x, y: origin.y, width: width, height: 24), xRadius: 12, yRadius: 12).fill()
        pillText.setFill()
        NSBezierPath(ovalIn: NSRect(x: origin.x + 6, y: origin.y + 6, width: 12, height: 12)).fill()
        (name as NSString).draw(at: NSPoint(x: origin.x + 28, y: origin.y + 3), withAttributes: [.font: font, .foregroundColor: pillText])
    }
    static let tile = NSColor(srgbRed: 60 / 255, green: 64 / 255, blue: 67 / 255, alpha: 1)
    static let ring = NSColor(srgbRed: 168 / 255, green: 199 / 255, blue: 250 / 255, alpha: 1)
}

private struct Tile {
    var box: TileBox
    var name: String
    var ringed = false
}

/// A frame drawn in top-left coordinates into BGRA memory, top row first, as the video reader sees one.
private final class Frame {
    let width: Int, height: Int
    var pixels: [UInt8]

    init(width: Int, height: Int, tiles: [Tile], extra: ((CGContext) -> Void)? = nil) {
        self.width = width
        self.height = height
        pixels = [UInt8](repeating: 0, count: width * height * 4)
        pixels.withUnsafeMutableBytes { raw in
            let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
            context.translateBy(x: 0, y: CGFloat(height))
            context.scaleBy(x: 1, y: -1)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
            Meet.stage.setFill()
            NSRect(x: 0, y: 0, width: width, height: height).fill()
            for tile in tiles {
                let rect = NSRect(x: tile.box.x, y: tile.box.y, width: tile.box.width, height: tile.box.height)
                Meet.tile.setFill()
                NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12).fill()
                (tile.name as NSString).draw(at: NSPoint(x: rect.minX + 12, y: rect.maxY - 30),
                                             withAttributes: [.font: NSFont.systemFont(ofSize: 16, weight: .medium), .foregroundColor: NSColor.white])
                if tile.ringed {
                    let path = NSBezierPath(roundedRect: rect.insetBy(dx: 1.5, dy: 1.5), xRadius: 12, yRadius: 12)
                    path.lineWidth = 3
                    Meet.ring.setStroke()
                    path.stroke()
                }
            }
            extra?(context)
            NSGraphicsContext.restoreGraphicsState()
        }
    }

    func withFrame<T>(_ body: (PixelFrame) throws -> T) rethrows -> T {
        try pixels.withUnsafeBytes { raw in
            try body(PixelFrame(width: width, height: height, bytesPerRow: width * 4, base: raw.baseAddress!.assumingMemoryBound(to: UInt8.self)))
        }
    }

    var image: CGImage {
        let data = Data(pixels) as CFData
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                       provider: CGDataProvider(data: data)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }
}

/// Three tiles in a row, as Meet laid out the first call's three people.
private func row(width: Int = 1280, height: Int = 720, ringed: Set<Int>) -> [Tile] {
    let names = ["Ada Lovelace", "Grace Hopper", "Alan Turing"]
    let tileWidth = (width - 80) / 3 - 20
    return (0..<3).map { i in
        Tile(box: TileBox(x: 40 + i * (tileWidth + 20), y: height / 4, width: tileWidth, height: height / 2), name: names[i], ringed: ringed.contains(i))
    }
}

final class RingFinderTests: XCTestCase {
    func testFindsTheRingAroundTheSpeakingTile() {
        let tiles = row(ringed: [1])
        let rings = Frame(width: 1280, height: 720, tiles: tiles).withFrame(RingFinder.rings(in:))
        XCTAssertEqual(rings.count, 1)
        XCTAssertTrue(rings.first?.near(tiles[1].box, slack: 6) == true, "\(rings) is not \(tiles[1].box)")
    }

    func testNoRingNoSpeaker() {
        XCTAssertEqual(Frame(width: 1280, height: 720, tiles: row(ringed: [])).withFrame(RingFinder.rings(in:)), [])
    }

    func testTwoPeopleTalkingAtOnceAreTwoRings() {
        let tiles = row(ringed: [0, 2])
        let rings = Frame(width: 1280, height: 720, tiles: tiles).withFrame(RingFinder.rings(in:))
        XCTAssertEqual(rings.count, 2)
        XCTAssertTrue(rings[0].near(tiles[0].box, slack: 6) && rings[1].near(tiles[2].box, slack: 6), "\(rings)")
    }

    /// Meet's "Stop presenting" button and a slide of the same blue are filled, not outlined.
    func testAFilledShapeOfTheSameBlueIsNotARing() {
        let frame = Frame(width: 1280, height: 720, tiles: row(ringed: [])) { _ in
            Meet.ring.setFill()
            NSBezierPath(roundedRect: NSRect(x: 900, y: 40, width: 220, height: 44), xRadius: 22, yRadius: 22).fill()
            NSRect(x: 100, y: 560, width: 400, height: 140).fill()
        }
        XCTAssertEqual(frame.withFrame(RingFinder.rings(in:)), [])
    }

    func testTheRecordingsBlueIsTheRingAndDiscordsIsNot() {
        // Pixels read off the first call's ring and badge, then Discord's blurple and Meet's grey.
        for (r, g, b) in [(163, 196, 241), (139, 170, 202), (168, 202, 242), (166, 200, 250), (152, 195, 240)] {
            XCTAssertTrue(RingFinder.isRingBlue(r: r, g: g, b: b), "(\(r), \(g), \(b))")
        }
        for (r, g, b) in [(88, 101, 242), (60, 64, 67), (255, 255, 255), (87, 108, 139), (0, 38, 85)] {
            XCTAssertFalse(RingFinder.isRingBlue(r: r, g: g, b: b), "(\(r), \(g), \(b))")
        }
    }
}

/// Meet's other styles (Indicators): the badge with no ring, and the green pill.
final class IndicatorTests: XCTestCase {
    /// Two people: the other fills the stage with the badge in its top-right corner and no ring, and
    /// the recorder's own small tile floats on its video at the bottom right.
    private func twoPeople(badgeOnTheBigTile: Bool, badgeOnTheSmallTile: Bool) -> Frame {
        let big = Tile(box: TileBox(x: 120, y: 90, width: 1040, height: 560), name: "Grace Hopper")
        return Frame(width: 1280, height: 720, tiles: [big]) { _ in
            let small = NSRect(x: 900, y: 500, width: 220, height: 124)
            NSColor(srgbRed: 0.45, green: 0.4, blue: 0.35, alpha: 1).setFill()
            NSBezierPath(roundedRect: small, xRadius: 10, yRadius: 10).fill()
            ("Ada Lovelace" as NSString).draw(at: NSPoint(x: small.minX + 8, y: small.maxY - 24), withAttributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.white])
            if badgeOnTheBigTile { Meet.badge(at: NSPoint(x: 1160 - 22, y: 90 + 22)) }
            if badgeOnTheSmallTile { Meet.badge(at: NSPoint(x: small.maxX - 16, y: small.minY + 16)) }
        }
    }

    func testTheBadgeAloneFindsItsTileAndTheName() throws {
        let frame = twoPeople(badgeOnTheBigTile: true, badgeOnTheSmallTile: false)
        let found = frame.withFrame(Indicators.find(in:))
        XCTAssertEqual(found.map(\.kind), [.badge])
        XCTAssertTrue(found.first?.box.near(TileBox(x: 120, y: 90, width: 1040, height: 560), slack: 4) == true, "\(found)")
        XCTAssertEqual(try SpeakerReader.read(image: frame.image).map(\.name), ["Grace Hopper"])
    }

    /// The recorder's own tile floats on the other's: a badge on it is never read as the big tile's person.
    /// (Over a video it is not taken at all, its corner being on no background; over a camera-off tile's flat
    /// colour it is the small tile, and the name is its own.)
    func testABadgeOnATileFloatingOverAnotherIsNeverTheOthers() throws {
        let frame = twoPeople(badgeOnTheBigTile: false, badgeOnTheSmallTile: true)
        XCTAssertFalse(try SpeakerReader.read(image: frame.image).contains { $0.name == "Grace Hopper" })
    }

    func testABadgeInsideARingIsTheRings() {
        let tiles = row(ringed: [1])
        let frame = Frame(width: 1280, height: 720, tiles: tiles) { _ in Meet.badge(at: NSPoint(x: tiles[1].box.maxX - 20, y: tiles[1].box.y + 20)) }
        XCTAssertEqual(frame.withFrame(Indicators.find(in:)).map(\.kind), [.ring])
    }

    func testTheGreenPillIsTheSpeakersName() throws {
        let tiles = row(ringed: [])
        let frame = Frame(width: 1280, height: 720, tiles: tiles) { _ in Meet.pill("Alan Turing", at: NSPoint(x: tiles[2].box.x + 10, y: tiles[2].box.maxY - 40)) }
        let found = frame.withFrame(Indicators.find(in:))
        XCTAssertEqual(found.map(\.kind), [.pill])
        XCTAssertEqual(try SpeakerReader.read(image: frame.image).map(\.name), ["Alan Turing"])
    }

    func testThePillsGreenIsNotTheVideos() {
        XCTAssertTrue(Indicators.isPillGreen(r: 95, g: 207, b: 133))
        XCTAssertTrue(Indicators.isPillGreen(r: 103, g: 205, b: 136))
        for (r, g, b) in [(4, 70, 23), (0, 48, 28), (60, 140, 60), (168, 199, 250), (120, 200, 200)] {
            XCTAssertFalse(Indicators.isPillGreen(r: r, g: g, b: b), "(\(r), \(g), \(b))")
        }
    }
}

final class TileNameTests: XCTestCase {
    func testMeetsLabelsAsNames() {
        XCTAssertEqual(TileNames.clean("  Grace   Hopper "), TileName(name: "Grace Hopper"))
        XCTAssertEqual(TileNames.clean("Grace Ho…"), TileName(name: "Grace Ho", truncated: true))
        XCTAssertEqual(TileNames.clean("Grace Ho..."), TileName(name: "Grace Ho", truncated: true))
        XCTAssertEqual(TileNames.clean("Ada Lovelace (You, presenting)"), TileName(name: "Ada Lovelace", you: true))
        XCTAssertEqual(TileNames.clean("'Grace Hopper"), TileName(name: "Grace Hopper"))
        XCTAssertEqual(TileNames.clean("e Grace Hopper"), TileName(name: "Grace Hopper"), "the pill's icon read as a letter")
        XCTAssertEqual(TileNames.clean("J Smith"), TileName(name: "J Smith"))
        XCTAssertNil(TileNames.clean("…"))
        XCTAssertNil(TileNames.clean("12:04"))
        XCTAssertNil(TileNames.clean(String(repeating: "a", count: 81)))
    }

    func testTheLabelRegionIsTheTilesBottomLeft() {
        let region = TileNames.labelRegion(of: TileBox(x: 100, y: 200, width: 400, height: 300))
        XCTAssertEqual(region, TileBox(x: 100, y: 416, width: 340, height: 84))
        // A small tile still gets 44 px.
        XCTAssertEqual(TileNames.labelRegion(of: TileBox(x: 0, y: 0, width: 100, height: 60)).height, 44)
    }

    func testReadsTheNameOnTheRingedTileOnly() throws {
        let rings = try SpeakerReader.read(image: Frame(width: 1280, height: 720, tiles: row(ringed: [1])).image)
        XCTAssertEqual(rings.map(\.name), ["Grace Hopper"])
        XCTAssertEqual(rings.first?.fresh, true)
    }

    func testANameIsReusedOnTheSameTileThenReadAgain() {
        var cache = NameCache(rereadMs: 3000)
        let box = TileBox(x: 100, y: 100, width: 300, height: 200)
        cache.store(box, atMs: 1000, name: TileName(name: "Grace Hopper"))
        XCTAssertEqual(cache.lookup(TileBox(x: 103, y: 98, width: 300, height: 201), atMs: 3500), .some(TileName(name: "Grace Hopper")))
        XCTAssertNil(cache.lookup(box, atMs: 4000), "read again after rereadMs, in case Meet moved someone else there")
        XCTAssertNil(cache.lookup(TileBox(x: 600, y: 100, width: 300, height: 200), atMs: 1500), "another tile")
        cache.store(box, atMs: 5000, name: nil)
        XCTAssertEqual(cache.lookup(box, atMs: 5500), .some(nil), "an unreadable label is not tried every frame")
        XCTAssertNil(cache.lookup(box, atMs: 6000))
    }
}

final class SpeakerReaderTests: XCTestCase {
    /// Four seconds at 5 fps, 960x540, H.264: Grace Hopper's tile ringed for two seconds, then Alan Turing's.
    private func writeVideo(to url: URL) throws {
        let width = 960, height = 540
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        let frames = [Frame(width: width, height: height, tiles: row(width: width, height: height, ringed: [1])),
                      Frame(width: width, height: height, tiles: row(width: width, height: height, ringed: [2]))]
        for i in 0..<20 {
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.01) }
            var buffer: CVPixelBuffer?
            XCTAssertEqual(CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer), kCVReturnSuccess)
            let pixel = try XCTUnwrap(buffer)
            CVPixelBufferLockBaseAddress(pixel, [])
            let source = frames[i < 10 ? 0 : 1]
            let rowBytes = CVPixelBufferGetBytesPerRow(pixel), base = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
            source.pixels.withUnsafeBytes { raw in
                for y in 0..<height { memcpy(base + y * rowBytes, raw.baseAddress! + y * width * 4, width * 4) }
            }
            CVPixelBufferUnlockBaseAddress(pixel, [])
            XCTAssertTrue(adaptor.append(pixel, withPresentationTime: CMTime(value: CMTimeValue(i * 200), timescale: 1000)))
        }
        input.markAsFinished()
        let done = expectation(description: "written")
        writer.finishWriting { done.fulfill() }
        wait(for: [done], timeout: 30)
        XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
    }

    func testReadsWhoWasRingedThroughAVideo() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("speaker-tiles-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("call.mp4")
        try writeVideo(to: url)

        let report = try await SpeakerReader.read(video: url, everyMs: 500, rereadMs: 3000)
        XCTAssertEqual(report.width, 960)
        XCTAssertEqual(report.sampled, 8, "one frame every 500 ms of 4 s")
        XCTAssertEqual(report.withRing, 8)
        let names = report.samples.map { $0.rings.map { $0.name ?? "?" } }
        XCTAssertEqual(names, Array(repeating: ["Grace Hopper"], count: 4) + Array(repeating: ["Alan Turing"], count: 4))
        XCTAssertEqual(report.namesRead, 2, "each tile's name read once, then reused")

        let part = try await SpeakerReader.read(video: url, everyMs: 500, fromMs: 2000)
        XCTAssertEqual(part.samples.first?.atMs, 2000)
        XCTAssertEqual(Set(part.samples.flatMap { $0.rings.compactMap(\.name) }), ["Alan Turing"])
    }
}
