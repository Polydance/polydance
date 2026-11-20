// The probe's evidence (docs/IPHONE.md I0): one JSON line per event, with the wall clock and the time
// since boot, so what iOS did while the app was away (an interruption, a background upload, a refresh)
// can be read back afterwards. The headset app's timeline.jsonl does the same. Safe to call from any
// thread. Never given a token, a transcript or a thread's words.
import Foundation

public final class EventLog: @unchecked Sendable {
    public let url: URL
    private let lock = NSLock()
    private let handle: FileHandle
    private let clock: @Sendable () -> Date

    public init(url: URL, clock: @escaping @Sendable () -> Date = { Date() }) throws {
        self.url = url
        self.clock = clock
        try PrivateFiles.directory(url.deletingLastPathComponent())
        try PrivateFiles.touch(url)
        handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
    }

    deinit { try? handle.close() }

    /// Appends `{"t": ISO time, "up": seconds since boot, "event": event, ...fields}`. Fields that are
    /// not JSON values (a URL, an error) are written as their description.
    public func write(_ event: String, _ fields: [String: any Sendable] = [:]) {
        var line: [String: Any] = [:]
        for (k, v) in fields { line[k] = Self.jsonValue(v) }
        line["event"] = event
        line["t"] = Self.timestamp(clock())
        line["up"] = (ProcessInfo.processInfo.systemUptime * 1000).rounded() / 1000
        guard var data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        try? handle.write(contentsOf: data)
    }

    /// The last `count` lines, newest last, for the probe's screen.
    public func tail(_ count: Int) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return Array(text.split(separator: "\n").suffix(count).map(String.init))
    }

    static func jsonValue(_ v: any Sendable) -> Any {
        switch v {
        case let s as String: return s
        case let b as Bool: return b
        case let i as Int: return i
        case let i as Int64: return i
        case let d as Double: return d.isFinite ? d : String(describing: d)
        case let a as [String]: return a
        case let a as [Int]: return a
        default: return String(describing: v)
        }
    }

    /// ISO 8601 with milliseconds and the phone's offset, as the headset's timeline writes it.
    public static func timestamp(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = timeZone
        return f.string(from: date)
    }
}
