// How a take's upload is going, in the numbers and words the screens show (docs/IPHONE.md S5; Robin,
// 2026-11-14: "no idea how much is left or if it's stuck"): the share sent, megabytes sent of the whole, the
// rate over the last half minute, the time left at that rate, and how long since a byte last moved. The
// upload feeds the meter what the receiver has confirmed plus what the running task has sent so far
// (URLSession's didSendBodyData), so it moves within each 8 MB chunk, not only between them. Nothing here
// is stored, sent or logged. Pure, so the Mac tests it.
import Foundation

/// One part of a take's upload (its words, then its video) over time: enough for the rate and the stall.
public struct UploadMeter: Equatable, Sendable {
    /// The rate is taken over this many seconds, so one slow chunk does not swing the time left.
    public static let window: Double = 30
    /// The rate needs this much time behind it before it is shown.
    public static let settle: Double = 3
    /// No byte for this long, and the screen says so.
    public static let stallSeconds: Double = 20
    /// Samples are kept at least this far apart, so a half minute holds about 120 of them.
    public static let spacing: Double = 0.25

    struct Sample: Equatable, Sendable {
        let at: Double
        let sent: Int64
    }

    private(set) var samples: [Sample] = []
    /// When the count last went up, or when the meter began.
    public private(set) var lastMoved: Double?

    public init() {}

    /// `sent`: bytes of this part the phone has sent, confirmed or in flight. A lower count than before (a
    /// range sent again after a dropped connection) starts the rate over, but is not movement.
    public mutating func record(_ sent: Int64, at now: Double) {
        guard let last = samples.last else {
            samples = [Sample(at: now, sent: sent)]
            lastMoved = now
            return
        }
        if sent < last.sent {
            samples = [Sample(at: now, sent: sent)]
            return
        }
        // Nothing moved: the older sample stays, so the rate spans the pause and falls.
        guard sent > last.sent else { return }
        lastMoved = now
        // iOS reports a body's progress many times a second: samples stay `spacing` apart, the newest moving up.
        if samples.count > 1, now - samples[samples.count - 2].at < Self.spacing {
            samples[samples.count - 1] = Sample(at: now, sent: sent)
        } else {
            samples.append(Sample(at: now, sent: sent))
        }
        // One sample at or before the window's start stays as the rate's anchor.
        while samples.count > 2, samples[1].at <= now - Self.window { samples.removeFirst() }
    }

    /// Bytes a second over the last `window` seconds up to `now`, or nil until it spans `settle` seconds.
    public func rate(at now: Double) -> Double? {
        guard let newest = samples.last else { return nil }
        let anchor = samples.last { $0.at <= now - Self.window } ?? samples[0]
        let span = now - anchor.at
        guard span >= Self.settle else { return nil }
        return Double(newest.sent - anchor.sent) / span
    }

    /// Whole seconds since a byte moved, once that is `stallSeconds` or more; else nil.
    public func stalled(at now: Double) -> Int? {
        guard let lastMoved, now - lastMoved >= Self.stallSeconds else { return nil }
        return Int(now - lastMoved)
    }
}

/// A take's upload as a screen shows it at one moment.
public struct UploadProgress: Equatable, Sendable {
    public enum Stage: Equatable, Sendable {
        /// Hashing the video and asking the receiver for an upload.
        case preparing
        /// The narration, sent first so the title and transcript arrive early.
        case words
        case video
    }

    public var stage: Stage
    /// Of this stage's part: the narration's bytes while `words`, the video's while `video`.
    public var sent: Int64
    public var total: Int64
    /// Bytes a second; nil until it is known.
    public var rate: Double?
    /// Whole seconds since a byte moved, once that is long enough to say.
    public var stalledSeconds: Int?
    /// Why it is not moving, when the phone knows: "waiting for Wi-Fi", "sending again in 25 s".
    public var waiting: String?

    public init(stage: Stage, sent: Int64 = 0, total: Int64 = 0, rate: Double? = nil, stalledSeconds: Int? = nil, waiting: String? = nil) {
        self.stage = stage
        self.sent = sent
        self.total = total
        self.rate = rate
        self.stalledSeconds = stalledSeconds
        self.waiting = waiting
    }

    /// From a meter and the part's size at `now`.
    public init(stage: Stage, meter: UploadMeter, sent: Int64, total: Int64, at now: Double, waiting: String? = nil) {
        self.init(stage: stage, sent: sent, total: total, rate: meter.rate(at: now), stalledSeconds: meter.stalled(at: now), waiting: waiting)
    }

    public var fraction: Double { total > 0 ? min(1, max(0, Double(sent) / Double(total))) : 0 }

    /// "42%", rounded down so it never says 100% before the receiver has it all.
    public var percent: String { "\(Int((fraction * 100).rounded(.down)))%" }

    /// Seconds left at the current rate; nil while the rate is unknown, nothing is moving, or it has stalled.
    public var secondsLeft: Int? {
        guard stalledSeconds == nil, let rate, rate > 0 else { return nil }
        return Int((Double(max(0, total - sent)) / rate).rounded(.up))
    }

    /// Whether the screen should say it is not moving.
    public var isStuck: Bool { stalledSeconds != nil || waiting != nil }

    /// "460 of 1,087 MB".
    public var amount: String { "\(Self.megabytes(sent)) of \(Self.megabytes(total)) MB" }

    /// "2.1 MB/s · about 5 min left"; when stuck, "nothing sent for 40 s · waiting for Wi-Fi"; nil when there
    /// is nothing to say yet.
    public var pace: String? {
        if isStuck {
            let quiet = stalledSeconds.map { "nothing sent for \(Self.duration($0))" }
            return [quiet, waiting].compactMap { $0 }.joined(separator: " · ")
        }
        guard let rate else { return nil }
        let speed = String(format: "%.1f MB/s", rate / 1_000_000)
        guard let left = secondsLeft else { return speed }
        return "\(speed) · about \(Self.duration(left)) left"
    }

    /// The whole of it in one line: "42% · 460 of 1,087 MB · 2.1 MB/s · about 5 min left".
    public var line: String {
        switch stage {
        case .preparing: return "getting the take ready to send"
        case .words: return (["sending the words first", amount] + [pace].compactMap { $0 }).joined(separator: " · ")
        case .video: return ([percent, amount] + [pace].compactMap { $0 }).joined(separator: " · ")
        }
    }

    /// "460" and "1,087" for whole megabytes, "9.8" below ten, as the Recordings page writes sizes.
    public static func megabytes(_ bytes: Int64) -> String {
        let mb = Double(bytes) / 1_000_000
        if mb < 10 { return String(format: "%.1f", mb) }
        return Int(mb.rounded(.down)).formatted(.number.locale(Locale(identifier: "en_GB")))
    }

    /// "40 s", "5 min", "1 h 12 min": seconds under a minute, else rounded up to the minute.
    public static func duration(_ seconds: Int) -> String {
        if seconds < 60 { return "\(max(0, seconds)) s" }
        let minutes = (seconds + 59) / 60
        if minutes < 60 { return "\(minutes) min" }
        return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
    }
}
