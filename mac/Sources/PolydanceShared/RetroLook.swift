// The parts of Polydance's look that are computed, not just coloured, so the Mac and the iPhone draw them
// exactly as the headset app does (docs/DESIGN-SYSTEM.md): the wood's boards and grain, from java.util.Random seeded 1966
// as WoodDrawable is, and a person's avatar colour, from Java's String.hashCode as Avatar.fill picks it.
import Foundation

/// java.util.Random: the 48-bit linear congruential generator, bit for bit.
public struct JavaRandom: Sendable {
    private var seed: UInt64
    private static let multiplier: UInt64 = 0x5DEECE66D
    private static let mask: UInt64 = (1 << 48) - 1

    public init(seed: Int64) {
        self.seed = (UInt64(bitPattern: seed) ^ Self.multiplier) & Self.mask
    }

    private mutating func next(_ bits: Int) -> Int32 {
        seed = (seed &* Self.multiplier &+ 0xB) & Self.mask
        return Int32(truncatingIfNeeded: Int64(bitPattern: seed) >> (48 - bits))
    }

    public mutating func nextInt() -> Int32 { next(32) }

    /// nextInt(bound), with Java's rejection of the uneven top of the range.
    public mutating func nextInt(_ bound: Int32) -> Int32 {
        precondition(bound > 0)
        if bound & -bound == bound { return Int32((Int64(bound) * Int64(next(31))) >> 31) }
        var bits: Int32, value: Int32
        repeat {
            bits = next(31)
            value = bits % bound
        } while bits &- value &+ (bound &- 1) < 0
        return value
    }

    public mutating func nextFloat() -> Float { Float(next(24)) / Float(1 << 24) }
}

public enum RetroLook {
    /// Java's String.hashCode over UTF-16 code units, overflowing as an Int32 does.
    public static func javaHashCode(_ text: String) -> Int32 {
        var hash: Int32 = 0
        for unit in text.utf16 { hash = hash &* 31 &+ Int32(unit) }
        return hash
    }

    /// Which avatar colour a person without their own gets: `(hashCode & 0x7fffffff) % count`, as on the headset.
    public static func avatarIndex(for key: String, count: Int) -> Int {
        Int(javaHashCode(key) & 0x7fffffff) % count
    }

    /// When a thread last moved, as the headset's list writes it (InboxText.rowTime): "14:06" today, "5 Nov"
    /// this year, "5 Nov 2025" before, in British English.
    public static func rowTime(_ date: Date, now: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_GB")
        format.timeZone = timeZone
        if calendar.isDate(date, inSameDayAs: now) { format.dateFormat = "HH:mm" }
        else if calendar.component(.year, from: date) == calendar.component(.year, from: now) { format.dateFormat = "d MMM" }
        else { format.dateFormat = "d MMM yyyy" }
        return format.string(from: date)
    }

    /// The initial on a person's circle: the first letter or digit, upper case, or "?".
    public static func initial(_ name: String) -> String {
        name.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "?"
    }

    /// One board of the cabinet: its rectangle, which of the two woods it is with its tone shift, and its grain.
    public struct Board: Sendable, Equatable {
        public var top: Double
        public var bottom: Double
        /// 0 for woodLight, 1 for woodMid.
        public var wood: Int
        /// Added to each of red, green and blue (-4 to 4).
        public var shift: Int
        public var grain: [Grain]
    }

    /// One wavy grain line: points across the board, its opacity (0 to 255) and width (in points).
    public struct Grain: Sendable, Equatable {
        public var points: [(x: Double, y: Double)]
        public var alpha: Int
        public var width: Double

        public static func == (a: Grain, b: Grain) -> Bool {
            a.alpha == b.alpha && a.width == b.width && a.points.count == b.points.count
                && zip(a.points, b.points).allSatisfy { $0.x == $1.x && $0.y == $1.y }
        }
    }

    /// The cabinet's boards for a width and height in points, as WoodDrawable.onBoundsChange lays them out
    /// (density 1: one point is one of its dp). The same size always gives the same wood.
    public static func wood(width: Double, height: Double, seed: Int64 = 1966, boardHeight: Double = 150) -> [Board] {
        var random = JavaRandom(seed: seed)
        var boards: [Board] = []
        var top = 0.0
        var index = 0
        while top < height {
            let bottom = min(top + boardHeight, height)
            let shift = Int(random.nextInt(9)) - 4
            var grain: [Grain] = []
            let lines = 10 + Int(random.nextInt(6))
            for k in 0..<lines {
                let y0 = top + (Double(k) + Double(random.nextFloat())) * (bottom - top) / Double(lines)
                let amp = 1 + Double(random.nextFloat()) * 4
                let wave = 220 + Double(random.nextFloat()) * 420
                let drift = (Double(random.nextFloat()) - 0.5) * 10
                let phase = Double(random.nextFloat()) * 6.283
                var points = [(x: 0.0, y: y0 + amp * sin(phase))]
                var x = 0.0
                while x < width {
                    x += 10
                    points.append((x, y0 + amp * sin(phase + x / wave * 6.283) + drift * x / max(width, 1)))
                }
                let alpha = 26 + Int(random.nextInt(64))
                let lineWidth = 0.6 + Double(random.nextFloat()) * 1.5
                grain.append(Grain(points: points, alpha: alpha, width: lineWidth))
            }
            boards.append(Board(top: top, bottom: bottom, wood: index % 2, shift: shift, grain: grain))
            top = bottom
            index += 1
        }
        return boards
    }
}
