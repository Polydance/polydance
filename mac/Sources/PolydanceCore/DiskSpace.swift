// Free space on the disk that holds the library, while a call records (C15). Little free space does not
// stop a recording by itself; what cost the picture on 2026-11-11 was macOS clearing space: Software Update
// asked for 13.8 GB at the highest urgency with 22.2 GB free, and ScreenCaptureKit's service stopped every
// stream when asked to help (PLATFORM-NOTES). An earlier, low-urgency purge that day (20.8 GB free, asked
// by the file provider) did not stop it. So what starts an urgent purge is whoever asks for space and how
// much, not a level of free space, and macOS documents no level. The warning is therefore a guess with a
// margin above the one level seen: under 30 GB free.
import Darwin
import Foundation

public struct DiskSpaceWatch: Sendable, Equatable {
    /// Below this many bytes free the user is told. Above the 22.2 GB free at which the 2026-11-11 purge
    /// stopped the screen, with a margin; not a threshold macOS documents.
    public static let lowBytes: Int64 = 30_000_000_000
    /// How often the recorder looks again, in seconds.
    public static let interval: TimeInterval = 30

    /// The last reading, in bytes.
    public private(set) var free: Int64?
    /// Whether this recording has told the user already.
    public private(set) var told = false

    public init() {}

    public var isLow: Bool { free.map { $0 < Self.lowBytes } ?? false }

    /// A reading of free space. True when the user should be told now: the first time this recording sees
    /// it low, at its start or later. Once per recording, so a call is not interrupted twice.
    public mutating func observe(freeBytes: Int64) -> Bool {
        free = max(0, freeBytes)
        guard isLow, !told else { return false }
        told = true
        return true
    }

    /// What the notification and the menu say, or nil while there is room.
    public var warning: String? {
        guard isLow, let free else { return nil }
        return "Only \(Self.gigabytes(free)) free on this Mac. When macOS clears space it can stop the screen recording; "
            + "Polydance starts it again, but freeing space keeps the picture safe."
    }

    /// "22 GB", or "4.5 GB" under 10, in decimal gigabytes as Finder and the purge log count them.
    public static func gigabytes(_ bytes: Int64) -> String {
        let gb = Double(max(0, bytes)) / 1e9
        return gb < 10 ? String(format: "%.1f GB", (gb * 10).rounded(.down) / 10) : "\(Int(gb.rounded(.down))) GB"
    }

    /// Free bytes on the volume holding `path`, as df shows them and the purge log counts its freespace
    /// (statfs's blocks available to this user), or nil when it cannot be read.
    public static func freeBytes(atPath path: String) -> Int64? {
        var info = statfs()
        guard statfs(path, &info) == 0 else { return nil }
        return Int64(info.f_bavail) * Int64(info.f_bsize)
    }
}
