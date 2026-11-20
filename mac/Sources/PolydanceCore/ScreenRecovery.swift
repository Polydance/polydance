// What the recorder does when the screen capture stops in the middle of a recording (C14): which stops
// are tried again, how often and how far apart, and the stretches without a picture that the metadata
// names (`call.videoGaps`). Pure, so every decision is tested without a screen.
//
// Seen on 2026-11-11 (PLATFORM-NOTES): 18:31 into a call, Software Update asked `deleted` for 13.8 GB at
// urgency 4 with 22.2 GB free; in that purge `deleted` asked replayd (ScreenCaptureKit's service) to free
// space, and replayd took the high urgency as a reason to stop every stream: SCStreamError -3821, "Stream
// was stopped by the system". replayd was then left out of that purge, which ended a minute later, and
// nothing stopped capture again. So a stop by the system is tried again soon, a few times, further apart
// each time; a stop the user made, or one that means capture is not allowed or the display is gone, is not.
//
// A first start that is still under way at the recorder's deadline (macOS asking again whether Polydance
// may record the screen, as it does about monthly, at the start of a call on 2026-11-13) is a gap from
// 0 too: the track is made black and the late stream's first frame ends it.
import Foundation

/// Why ScreenCaptureKit stopped a stream, from its error (SCStreamErrorDomain, the codes in SCError.h).
public enum ScreenStopCause: Equatable, Sendable {
    /// macOS stopped it (-3821, macOS 15+), as replayd does during an urgent purge of the disk: tried again.
    case system
    /// The connection to replayd broke (-3804, -3805) or capture failed inside it (-3811): tried again.
    case interrupted
    /// The user stopped it from macOS's own screen-sharing controls (-3817): left stopped.
    case user
    /// Capture is not allowed (-3801, -3803): left stopped.
    case permission
    /// No display or window list, or nothing to capture (-3813 to -3815): left stopped. Following the call to
    /// another display is C3's display changes, which are not built.
    case display
    /// Any other error: left stopped, since nothing says another try would pass.
    case other

    public static let errorDomain = "com.apple.ScreenCaptureKit.SCStreamErrorDomain"

    public init(domain: String, code: Int) {
        guard domain == Self.errorDomain else { self = .other; return }
        switch code {
        case -3821: self = .system
        case -3804, -3805, -3811: self = .interrupted
        case -3817: self = .user
        case -3801, -3803: self = .permission
        case -3813, -3814, -3815: self = .display
        default: self = .other
        }
    }

    public var restartable: Bool { self == .system || self == .interrupted }

    /// Why the picture was left off, for the recorder's note.
    var leftOff: String {
        switch self {
        case .system, .interrupted: return "it was not started again"
        case .user: return "it was stopped from macOS's screen-sharing controls"
        case .permission: return "screen recording is no longer allowed for Polydance"
        case .display: return "the recorded display is gone"
        case .other: return "that error is not one that is tried again"
        }
    }
}

public struct ScreenRecovery: Sendable, Equatable {
    /// Seconds before each try within one gap. On 2026-11-11 replayd was done with the purge a moment after
    /// it stopped the stream, so the first try is soon; the last comes minutes later, for a purge that runs
    /// long (that one took 84 s from start to end).
    public static let waits: [Double] = [3, 10, 30, 60, 120]
    /// A recording whose picture stops more often than this is let go: macOS is not letting it run.
    public static let maxGaps = 6

    public enum Decision: Equatable, Sendable {
        /// Start the capture again in `after` seconds; `attempt` counts from 1 within this gap, of `of`.
        case retry(after: Double, attempt: Int, of: Int)
        /// The picture stays off for the rest of the recording, for this reason.
        case giveUp(String)
    }

    public private(set) var gaps: [VideoGap] = []
    /// Tries made since the open gap began.
    public private(set) var attempts = 0
    /// Why the picture stays off, once given up.
    public private(set) var gaveUp: String?

    public init() {}

    /// The last gap has no end yet: the picture is off now.
    public var isOpen: Bool { gaps.last.map { $0.toMs == nil } ?? false }

    /// The first start had not finished when the writer was made (the recorder's deadline): the picture is
    /// black from the recording's start in a gap that the first frame ends. The start is still under way,
    /// so it is not a stop and plans no try; if it fails, `stopped` takes that as a failed try. Only before
    /// anything else happened to the picture.
    public mutating func startingLate(afterSeconds deadline: Double) {
        guard gaps.isEmpty, gaveUp == nil else { return }
        gaps.append(VideoGap(fromMs: 0, reason: Self.lateReason(afterSeconds: deadline)))
        attempts = 0
    }

    /// The late start's gap reason. macOS's prompt is the likely cause, not a known one: nothing the app can
    /// read says it is open, so the words say "may".
    public static func lateReason(afterSeconds deadline: Double) -> String {
        reasonText("screen capture took over \(Int(deadline)) s to start; macOS may have been asking to allow screen recording")
    }

    /// The stream stopped by itself at `atMs` on the recording's clock (never the recorder's own stop). A
    /// stop while a gap is still open (a restarted stream that stopped before its first frame, or a late
    /// first start that failed) is a failed try.
    public mutating func stopped(cause: ScreenStopCause, reason: String, atMs: Int, allowed: Bool) -> Decision {
        if let gaveUp { return .giveUp(gaveUp) }
        if isOpen {
            guard cause.restartable else { return giveUp(cause.leftOff) }
            return tryFailed(reason: reason, allowed: allowed)
        }
        gaps.append(VideoGap(fromMs: max(0, atMs), reason: Self.reasonText(reason)))
        attempts = 0
        guard cause.restartable else { return giveUp(cause.leftOff) }
        guard allowed else { return giveUp(ScreenStopCause.permission.leftOff) }
        guard gaps.count <= Self.maxGaps else { return giveUp("it had stopped \(gaps.count) times") }
        return next()
    }

    /// A try to start it again failed, with `reason`.
    public mutating func tryFailed(reason: String, allowed: Bool) -> Decision {
        if let gaveUp { return .giveUp(gaveUp) }
        guard allowed else { return giveUp(ScreenStopCause.permission.leftOff) }
        guard attempts < Self.waits.count else {
            return giveUp("\(attempts) tries to start it again failed, the last with: \(Self.reasonText(reason))")
        }
        return next()
    }

    /// The first picture after a restart or a late start, at `atMs`: the open gap ends there.
    public mutating func resumed(atMs: Int) {
        guard isOpen, let last = gaps.indices.last else { return }
        gaps[last].toMs = max(gaps[last].fromMs, atMs)
        attempts = 0
    }

    private mutating func next() -> Decision {
        attempts += 1
        return .retry(after: Self.waits[attempts - 1], attempt: attempts, of: Self.waits.count)
    }

    private mutating func giveUp(_ why: String) -> Decision {
        gaveUp = why
        return .giveUp(why)
    }

    /// macOS's words, cut to the contract's 120 characters; never empty.
    static func reasonText(_ text: String) -> String {
        let trimmed = text.trimmingWhitespace()
        guard !trimmed.isEmpty else { return "the screen capture stopped" }
        return String(trimmed.utf16.prefix(RecordingMeta.maxGapReasonLength)) ?? String(trimmed.prefix(60))
    }
}
