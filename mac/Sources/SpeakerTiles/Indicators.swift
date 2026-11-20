// Meet's other ways of showing who is talking, besides the ring (RingFinder), measured on the second
// recorded call, 2026-11-11 (docs/PLATFORM-NOTES.md):
//
// - The badge alone. With two people in a call the other fills the stage and Meet draws no ring, only its
//   speaking badge: a disc of the ring's blue with dark navy bars, in the tile's top-right corner. The
//   tile is found from the badge by walking out to Meet's background, a flat dark colour, to the right
//   and above within a few pixels, then left and down to the same colour. The colour is taken from beside
//   the badge, since it differs between calls ((18, 18, 18) on the second, about (55, 60, 68) round the
//   tiles on the first, where a fixed colour let the walk leave the window and read another app's text).
//   A badge whose corner is not right there (Robin's own small tile floats on the big one's video) is
//   not taken.
// - The green pill. While Robin presented on the second call, Meet marked the person talking with a light
//   green pill (about (95, 207, 133)) behind the name on their tile, dark green text on it, and no ring.
//   The pill is the label itself, so its text is the name.
//
// Each is reported with its kind, so polycap can say which the names rest on and check each.
import Foundation

/// Where Meet showed someone speaking, and the region its name is read from.
public struct Indicator: Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case ring, badge, pill
    }

    public var kind: Kind
    /// The tile (ring, badge) or the pill itself.
    public var box: TileBox
    /// Where the name is written: the tile's bottom left, or the pill.
    public var label: TileBox
}

public enum Indicators {
    /// A pixel's channels as (r, g, b).
    @inline(__always) static func rgb(_ frame: PixelFrame, _ x: Int, _ y: Int) -> (Int, Int, Int) {
        let p = frame.base + y * frame.bytesPerRow + x * 4
        return (Int(p[2]), Int(p[1]), Int(p[0]))
    }

    /// Meet's background where it starts beside a badge: three pixels in a row of one flat, dark, nearly
    /// grey colour ((18, 18, 18) and (55, 60, 68) seen), or nil.
    static func backdrop(_ frame: PixelFrame, x: Int, y: Int) -> (Int, Int, Int)? {
        guard x >= 0, x + 2 < frame.width, y >= 0, y < frame.height else { return nil }
        let c = rgb(frame, x, y)
        guard max(c.0, c.1, c.2) <= 80, max(c.0, c.1, c.2) - min(c.0, c.1, c.2) <= 16 else { return nil }
        for dx in 1...2 {
            let d = rgb(frame, x + dx, y)
            guard abs(d.0 - c.0) <= 3, abs(d.1 - c.1) <= 3, abs(d.2 - c.2) <= 3 else { return nil }
        }
        return c
    }

    /// Whether a pixel is the backdrop colour `c`, within the recording's noise.
    @inline(__always) static func isBackdrop(_ frame: PixelFrame, _ x: Int, _ y: Int, _ c: (Int, Int, Int)) -> Bool {
        let d = rgb(frame, x, y)
        return abs(d.0 - c.0) <= 5 && abs(d.1 - c.1) <= 5 && abs(d.2 - c.2) <= 5
    }

    /// The badge's dark bars: navy, about (0, 39, 88).
    @inline(__always) static func isNavy(r: Int, g: Int, b: Int) -> Bool {
        b >= 60 && b <= 140 && r <= 50 && g >= 15 && g <= 90 && b - r >= 50
    }

    /// The speaking pill's light green.
    @inline(__always) public static func isPillGreen(r: Int, g: Int, b: Int) -> Bool {
        g >= 180 && r >= 60 && r <= 135 && b >= 95 && b <= 165 && g - r >= 70 && g - b >= 45
    }

    /// A blob: the bounding box of horizontal runs on neighbouring rows that overlap.
    struct Blob {
        var minX: Int, maxX: Int, minY: Int, maxY: Int, pixels: Int
        var width: Int { maxX - minX + 1 }
        var height: Int { maxY - minY + 1 }
        var box: TileBox { TileBox(x: minX, y: minY, width: width, height: height) }
    }

    /// Blobs of pixels that `test` accepts, from runs at least `minRun` long (gaps of 2 px bridged),
    /// sized within `widths` and `heights`. Gives up on a frame full of the colour.
    static func blobs(in frame: PixelFrame, minRun: Int, widths: ClosedRange<Int>, heights: ClosedRange<Int>, test: (Int, Int, Int) -> Bool) -> [Blob] {
        var open: [Blob] = [], done: [Blob] = []
        for y in 0..<frame.height {
            var row: [(Int, Int, Int)] = [] // start, end (inclusive), pixels
            var start = -1, last = -10, count = 0
            let line = frame.base + y * frame.bytesPerRow
            for x in 0..<frame.width {
                let p = line + x * 4
                guard test(Int(p[2]), Int(p[1]), Int(p[0])) else { continue }
                if start < 0 || x - last > 3 {
                    if start >= 0, last - start + 1 >= minRun { row.append((start, last, count)) }
                    start = x
                    count = 0
                }
                last = x
                count += 1
            }
            if start >= 0, last - start + 1 >= minRun { row.append((start, last, count)) }
            var next: [Blob] = []
            for run in row {
                // Every open blob this run touches joins it.
                var merged = Blob(minX: run.0, maxX: run.1, minY: y, maxY: y, pixels: run.2)
                open.removeAll { blob in
                    guard blob.maxY == y - 1 || blob.maxY == y, run.0 <= blob.maxX + 2, run.1 >= blob.minX - 2 else { return false }
                    merged = Blob(minX: min(merged.minX, blob.minX), maxX: max(merged.maxX, blob.maxX), minY: min(merged.minY, blob.minY), maxY: y, pixels: merged.pixels + blob.pixels)
                    return true
                }
                next.removeAll { blob in
                    guard run.0 <= blob.maxX + 2, run.1 >= blob.minX - 2 else { return false }
                    merged = Blob(minX: min(merged.minX, blob.minX), maxX: max(merged.maxX, blob.maxX), minY: min(merged.minY, blob.minY), maxY: y, pixels: merged.pixels + blob.pixels)
                    return true
                }
                next.append(merged)
            }
            // Blobs no run continued are finished, and kept only at a size wanted: a sky in someone's video
            // makes thousands of small patches of the ring's blue (the second call, 03:05, 2026-11-11).
            let fits = { (blob: Blob) in widths.contains(blob.width) && heights.contains(blob.height) }
            done += open.filter { $0.maxY < y && fits($0) }
            open = next + open.filter { $0.maxY == y }
            // Too many at once is a frame full of the colour, not a badge or a pill.
            if open.count > 1000 || done.count > 200 { return [] }
        }
        done += open
        return done.filter { widths.contains($0.width) && heights.contains($0.height) }
    }

    /// Meet's speaking badges: round blobs of the ring's blue, 12 to 44 px across, with navy bars inside.
    static func badges(in frame: PixelFrame) -> [TileBox] {
        blobs(in: frame, minRun: 3, widths: 12...44, heights: 12...44, test: RingFinder.isRingBlue).filter { blob in
            guard abs(blob.width - blob.height) <= max(4, blob.width / 4) else { return false }
            var navy = 0
            for y in blob.minY...blob.maxY {
                for x in blob.minX...blob.maxX {
                    let p = frame.base + y * frame.bytesPerRow + x * 4
                    if isNavy(r: Int(p[2]), g: Int(p[1]), b: Int(p[0])) { navy += 1 }
                }
            }
            return navy * 100 >= blob.width * blob.height * 6
        }.map(\.box)
    }

    /// The first x from `start` stepping by `step` where `run` backdrop pixels in a row begin, within `limit`
    /// steps. The right edge of a ring found in this frame counts as the edge too: the gap beside a ring can
    /// be under 4 px of backdrop (the first call, 14:26). Only a ring found, since a thin strip of sky between
    /// window bars in someone's video looks like a ring's edge (the second call).
    static func backdropAlong(_ frame: PixelFrame, _ c: (Int, Int, Int), from start: Int, y: Int, step: Int, limit: Int, run: Int = 3, rings: [TileBox] = []) -> Int? {
        var x = start, seen = 0
        for _ in 0..<limit {
            guard x >= 0, x < frame.width, y >= 0, y < frame.height else { return nil }
            if seen == 0, rings.contains(where: { abs(x - $0.maxX) <= 3 && y >= $0.y && y <= $0.maxY }) { return x }
            if isBackdrop(frame, x, y, c) { seen += 1; if seen >= run { return x - step * (run - 1) } } else { seen = 0 }
            x += step
        }
        return nil
    }

    /// As backdropAlong, down or up a column.
    static func backdropDown(_ frame: PixelFrame, _ c: (Int, Int, Int), x: Int, from start: Int, step: Int, limit: Int, run: Int = 3) -> Int? {
        var y = start, seen = 0
        for _ in 0..<limit {
            guard x >= 0, x < frame.width, y >= 0, y < frame.height else { return nil }
            if isBackdrop(frame, x, y, c) { seen += 1; if seen >= run { return y - step * (run - 1) } } else { seen = 0 }
            y += step
        }
        return nil
    }

    /// The tile a badge sits in the top-right corner of: Meet's background within 40 px to its right (its
    /// colour taken there) and the same colour within 40 px above, then the tile's left and bottom edges
    /// where that colour starts again. Nil when the badge is not in such a corner (a small tile floating on
    /// another's video) or the tile is implausibly small.
    static func tile(of badge: TileBox, in frame: PixelFrame, rings: [TileBox] = []) -> TileBox? {
        let cy = badge.y + badge.height / 2, cx = badge.x + badge.width / 2
        // The tile's own colour just beside the badge: a camera-off tile is flat and dark too, so the
        // background is the first flat dark run that is not that colour.
        guard badge.maxX + 3 < frame.width else { return nil }
        let inside = rgb(frame, badge.maxX + 3, cy)
        var found: (x: Int, colour: (Int, Int, Int))?
        for x in (badge.maxX + 1)...min(frame.width - 3, badge.maxX + 40) {
            if let c = backdrop(frame, x: x, y: cy), abs(c.0 - inside.0) + abs(c.1 - inside.1) + abs(c.2 - inside.2) > 18 { found = (x, c); break }
        }
        guard let (rightStage, c) = found,
              let topStage = backdropDown(frame, c, x: cx, from: badge.y - 1, step: -1, limit: 40) else { return nil }
        let right = rightStage - 1, top = topStage + 1
        // Below the rounded corners, along the top and down the right side.
        guard let leftStage = backdropAlong(frame, c, from: badge.x - 1, y: top + 30, step: -1, limit: frame.width, rings: rings),
              let bottomStage = backdropDown(frame, c, x: right - 30, from: badge.maxY + 1, step: 1, limit: frame.height) else { return nil }
        let left = leftStage + 1, bottom = bottomStage - 1
        let width = right - left + 1, height = bottom - top + 1
        // Meet's tiles run from about 1:2 (portrait, in a strip) to under 2:1 (the two-person stage measured
        // 1097 x 580); a box much wider has run past the tile into another window (the first call, 14:26).
        guard width >= max(80, frame.width / 16), height >= max(60, frame.height / 14), width * 10 <= height * 21, height * 10 <= width * 25 else { return nil }
        return TileBox(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
    }

    /// Meet's green speaking pills: filled light-green labels at least 40 px wide and 12 to 40 px high.
    static func pills(in frame: PixelFrame) -> [TileBox] {
        blobs(in: frame, minRun: 6, widths: 40...600, heights: 12...40, test: isPillGreen)
            .filter { $0.pixels * 100 >= $0.width * $0.height * 35 }
            .map(\.box)
    }

    /// Every way Meet showed someone speaking in a frame: rings, badges with no ring round their tile, and
    /// green pills. A badge inside a ring is the ring's.
    public static func find(in frame: PixelFrame) -> [Indicator] {
        let rings = RingFinder.rings(in: frame)
        var found = rings.map { Indicator(kind: .ring, box: $0, label: TileNames.labelRegion(of: $0)) }
        for badge in badges(in: frame) {
            let inRing = rings.contains { badge.x >= $0.x - 10 && badge.maxX <= $0.maxX + 10 && badge.y >= $0.y - 10 && badge.maxY <= $0.maxY + 10 }
            guard !inRing, let tile = tile(of: badge, in: frame, rings: rings), !found.contains(where: { $0.box.near(tile, slack: 12) }) else { continue }
            found.append(Indicator(kind: .badge, box: tile, label: TileNames.labelRegion(of: tile)))
        }
        for pill in pills(in: frame) {
            // The pill opens with a speaker icon about as wide as the pill is high, which Vision read as an
            // "e"; the name is the rest.
            let x = min(pill.maxX - 8, pill.x + pill.height)
            found.append(Indicator(kind: .pill, box: pill, label: TileBox(x: x, y: pill.y, width: pill.maxX - x + 1, height: pill.height)))
        }
        return found
    }
}
