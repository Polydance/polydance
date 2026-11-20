// Meet's speaking ring (docs/MAC.md P3a). Google Meet outlines the tile of whoever is talking with a thin
// light-blue ring, its dark theme's highlight (about #A8C7FA), with a badge of the same blue in the tile's
// top corner. This finds those rings in one frame: two straight horizontal runs of that blue with the same
// extent (the ring's top and bottom edges), a run down each side, and none of that blue across the middle,
// so a filled button of the same colour ("Stop presenting") is not taken for a tile. Measured on the first
// recorded call, 2026-11-11 (docs/PLATFORM-NOTES.md): the ring is about 3 px at 1920x1080 and its pixels
// read (139 to 173, 170 to 202, 202 to 250) after the recording's compression. Meet can change its look,
// so the pipeline checks the ring against Me's own lines before it trusts a name (src/pipeline/speakers.ts).
import Foundation

/// A frame's pixels as the video reader gets them: BGRA, 8 bits a channel, `bytesPerRow` apart, top row first.
public struct PixelFrame {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    public let base: UnsafePointer<UInt8>

    public init(width: Int, height: Int, bytesPerRow: Int, base: UnsafePointer<UInt8>) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.base = base
    }

    @inline(__always) func isRingBlue(_ x: Int, _ y: Int) -> Bool {
        let p = base + y * bytesPerRow + x * 4
        return RingFinder.isRingBlue(r: Int(p[2]), g: Int(p[1]), b: Int(p[0]))
    }
}

/// A tile on the frame's own pixel grid, top-left origin.
public struct TileBox: Equatable, Hashable, Codable, Sendable {
    public var x: Int
    public var y: Int
    public var width: Int
    public var height: Int

    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var maxX: Int { x + width - 1 }
    public var maxY: Int { y + height - 1 }

    /// The same tile in two frames: every edge within `slack` pixels.
    public func near(_ other: TileBox, slack: Int = 8) -> Bool {
        abs(x - other.x) <= slack && abs(y - other.y) <= slack && abs(maxX - other.maxX) <= slack && abs(maxY - other.maxY) <= slack
    }
}

public enum RingFinder {
    /// Meet's ring blue, loosely enough for a compressed screen recording and tightly enough to leave out
    /// Discord's blurple (88, 101, 242), white text and Meet's grey tiles.
    @inline(__always) public static func isRingBlue(r: Int, g: Int, b: Int) -> Bool {
        b >= 200 && r >= 120 && r <= 215 && g >= 160 && g <= 240 && b - r >= 45 && g - r >= 15
    }

    struct Run: Equatable {
        var y: Int
        var start: Int
        var end: Int // exclusive
    }

    /// Horizontal runs of ring blue at least `minLength` long; a gap of up to 2 px (compression) does not end one.
    static func runs(in frame: PixelFrame, minLength: Int) -> [Run] {
        var found: [Run] = []
        for y in 0..<frame.height {
            var start = -1, last = -10
            for x in 0..<frame.width where frame.isRingBlue(x, y) {
                if start < 0 || x - last > 3 {
                    if start >= 0, last + 1 - start >= minLength { found.append(Run(y: y, start: start, end: last + 1)) }
                    start = x
                }
                last = x
            }
            if start >= 0, last + 1 - start >= minLength { found.append(Run(y: y, start: start, end: last + 1)) }
            // A frame full of that blue (a sky, a blue slide) is not a ring; give up on it rather than pair it all.
            if found.count > 4000 { return [] }
        }
        return found
    }

    /// The share of ring blue down column `x` over `rows`.
    static func columnShare(_ frame: PixelFrame, x: Int, rows: ClosedRange<Int>) -> Double {
        guard x >= 0, x < frame.width, !rows.isEmpty else { return 0 }
        var hits = 0
        for y in rows where frame.isRingBlue(x, y) { hits += 1 }
        return Double(hits) / Double(rows.count)
    }

    /// The share of ring blue along row `y` over `columns`.
    static func rowShare(_ frame: PixelFrame, y: Int, columns: Range<Int>) -> Double {
        guard y >= 0, y < frame.height, !columns.isEmpty else { return 0 }
        var hits = 0
        for x in columns where frame.isRingBlue(x, y) { hits += 1 }
        return Double(hits) / Double(columns.count)
    }

    /// The column in `range` most covered by ring blue over `rows`, if any is at least 85% covered.
    static func edge(_ frame: PixelFrame, columns range: ClosedRange<Int>, rows: ClosedRange<Int>) -> Int? {
        var best: (x: Int, share: Double)?
        for x in range {
            let share = columnShare(frame, x: x, rows: rows)
            if share >= 0.85, share > (best?.share ?? 0) { best = (x, share) }
        }
        return best?.x
    }

    /// Every speaking ring in the frame, as the tile it outlines, top to bottom then left to right.
    public static func rings(in frame: PixelFrame) -> [TileBox] {
        // A tile is at least about 1/32 of the frame wide and 1/27 high (60 x 40 at 1920x1080): Meet's
        // smallest, in the strip beside a shared screen, measured 270 x 160 on the first call.
        let minLength = max(40, frame.width / 32)
        let minHeight = max(30, frame.height / 27)
        let all = runs(in: frame, minLength: minLength)
        var boxes: [TileBox] = []
        for (i, top) in all.enumerated() {
            for bottom in all[(i + 1)...] where bottom.y - top.y >= minHeight && abs(bottom.start - top.start) <= 4 && abs(bottom.end - top.end) <= 4 {
                // Hollow: a ring has nothing of its colour across the middle; a filled button has it all.
                let inner = (top.start + 10)..<max(top.start + 11, top.end - 10)
                guard rowShare(frame, y: (top.y + bottom.y) / 2, columns: inner) <= 0.2 else { continue }
                // Its sides: straight edges from corner to corner, just outside the top run's ends, which stop
                // short of the rounded corners. Unbroken from top to bottom, so another line of the same
                // width above a ring (seen in a strip of tiles, 37:59 on the first call) does not make a taller box.
                let corner = min(20, (bottom.y - top.y) / 6)
                let band = (top.y + corner)...(bottom.y - corner)
                guard let left = edge(frame, columns: max(0, top.start - 30)...min(frame.width - 1, top.start + 5), rows: band),
                      let right = edge(frame, columns: max(0, top.end - 6)...min(frame.width - 1, top.end + 30), rows: band),
                      right - left >= minLength else { continue }
                let box = TileBox(x: left, y: top.y, width: right - left + 1, height: bottom.y - top.y + 1)
                // The ring's edges are a few rows thick, so several pairs describe one ring: keep the outermost.
                if let same = boxes.firstIndex(where: { $0.near(box) }) {
                    let a = boxes[same]
                    let x0 = min(a.x, box.x), y0 = min(a.y, box.y), x1 = max(a.maxX, box.maxX), y1 = max(a.maxY, box.maxY)
                    boxes[same] = TileBox(x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1)
                } else {
                    boxes.append(box)
                }
            }
        }
        return boxes.sorted { ($0.y, $0.x) < ($1.y, $1.x) }
    }
}
