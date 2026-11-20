// Two judgements about sound that the capture layer makes from numbers: how loud a buffer is (for the
// menu's Me and Others meters) and whether the far end is being heard at all (C12). A refused system-audio
// grant gives digital silence with no error, so the only way to notice is to watch the tap while Arc is
// playing.
import Foundation

public enum AudioLevel {
    /// Peak and RMS of 32-bit float samples; non-finite samples are ignored.
    public static func measure(_ samples: UnsafeBufferPointer<Float>) -> (peak: Float, rms: Float) {
        var peak: Float = 0
        var sum: Double = 0
        var count = 0
        for sample in samples where sample.isFinite {
            let magnitude = abs(sample)
            if magnitude > peak { peak = magnitude }
            sum += Double(sample) * Double(sample)
            count += 1
        }
        return (peak, count == 0 ? 0 : Float((sum / Double(count)).squareRoot()))
    }

    /// How many of `bars` meter bars to light for an RMS level: -60 dBFS and below lights none,
    /// 0 dBFS lights all.
    public static func bars(rms: Float, bars: Int = 7) -> Int {
        guard rms > 0, rms.isFinite else { return 0 }
        let db = 20 * log10(rms)
        let fraction = min(max((db + 60) / 60, 0), 1)
        return Int((fraction * Float(bars)).rounded())
    }
}

/// The call's sound track's AAC settings. AAC at 160 kbps stereo is valid only at 44.1 and 48 kHz: at
/// 88.2 or 96 kHz AVAssetWriterInput raises an Objective-C exception Swift cannot catch, and at 16, 22.05
/// or 24 kHz the writer fails after a few hundred buffers with "Cannot Encode Media", taking the mic and
/// the video with it (seen on this Mac, 2026-11-05). The tap follows its device's rate (a Bluetooth headset
/// in a call runs at 16 or 24 kHz, an audio interface may run at 96 kHz), so any rate but 44.1 kHz is
/// encoded at 48 kHz, and AVAssetWriterInput resamples what the tap gives (seen for 16, 24, 44.1 and 96 kHz).
public enum AppTrackEncoding {
    public static let bitRate = 160_000

    public static func sampleRate(forTapRate rate: Double) -> Double {
        rate == 44_100 ? 44_100 : 48_000
    }
}

/// `call.farEnd` in the metadata.
public enum FarEnd: String, Codable, Sendable { case heard, silent }

/// Watches the call's tap for C12. A stretch of digital silence after the far end has been heard is not
/// flagged: Meet sends zeros while the others are muted, so 30 s of Robin talking alone would otherwise
/// read as a broken grant. What is flagged is the failure C12 is about: Arc playing sound for 30 s while
/// the tap has delivered nothing but zeros since the recording began.
public struct FarEndMonitor: Sendable {
    public let silenceLimit: Double
    public private(set) var everHeard = false
    public private(set) var flagged = false
    /// Seconds Arc has been playing while the tap gave only zeros.
    public private(set) var silentPlayingSeconds: Double = 0
    private var lastAt: Double?

    public init(silenceLimit: Double = 30) {
        self.silenceLimit = silenceLimit
    }

    /// One reading, about once a second: whether Arc reports running output, and the loudest sample the
    /// tap delivered since the last reading (nil when no buffer arrived). Returns true exactly once, when
    /// the user should be told.
    public mutating func observe(at: Double, appPlaying: Bool, tapPeak: Float?) -> Bool {
        defer { lastAt = at }
        if let peak = tapPeak, peak > 0 { everHeard = true }
        guard !everHeard, let last = lastAt else { return false }
        if appPlaying { silentPlayingSeconds += max(0, at - last) }
        if !flagged, silentPlayingSeconds >= silenceLimit {
            flagged = true
            return true
        }
        return false
    }

    /// What the metadata says: heard once the tap delivered any sound; silent when it never did.
    public var verdict: FarEnd { everHeard ? .heard : .silent }

    /// Whether the menu warns now: flagged, and nothing heard since. Once the far end is heard the
    /// warning goes (and the app takes its notice back), though `flagged` stays true.
    public var warning: Bool { flagged && !everHeard }
}

/// Watches the microphone while anything records with it (2026-11-16: a report from the bug key recorded 60 s
/// of digital silence because the Mac's default input was a virtual device, "Sessions Input 2ch", and nothing
/// said so). Flagged when the microphone has delivered nothing above −80 dBFS for `silenceLimit` seconds since
/// the recording began: a broken or virtual input, never a pause in speech, since a real microphone's room
/// noise is far above that. Sound heard at any point clears it for good.
public struct SilentMicMonitor: Sendable {
    public let silenceLimit: Double
    /// −80 dBFS: digital silence and a virtual device's zeros are below it, a real microphone's room noise above.
    public static let floor: Float = 0.0001
    public private(set) var everHeard = false
    public private(set) var flagged = false
    private var startedAt: Double?

    public init(silenceLimit: Double = 10) {
        self.silenceLimit = silenceLimit
    }

    /// One reading, about once a second: the loudest sample the microphone delivered since the last reading
    /// (nil when no buffer arrived). Returns true exactly once, when the user should be told.
    public mutating func observe(at: Double, peak: Float?) -> Bool {
        if let peak, peak > Self.floor { everHeard = true }
        let start = startedAt ?? at
        startedAt = start
        guard !everHeard, !flagged, at - start >= silenceLimit else { return false }
        flagged = true
        return true
    }

    /// Whether the app warns now: flagged and nothing heard since.
    public var warning: Bool { flagged && !everHeard }
}

/// The input a walkthrough will record (the system default), as New thread's and the report's plates name it
/// before recording starts: a virtual device is said to be one, since it is the likeliest to give silence.
public struct MicDescription: Sendable, Equatable {
    public var name: String
    public var virtual: Bool

    public init(name: String, virtual: Bool) {
        self.name = name
        self.virtual = virtual
    }

    /// The plate's line; nil `mic` is no input at all.
    public static func line(_ mic: MicDescription?) -> (text: String, warning: Bool) {
        guard let mic else { return ("No microphone is connected, so nothing you say will be recorded.", true) }
        guard mic.virtual else { return ("Mic: \(mic.name)", false) }
        return ("Mic: \(mic.name), a virtual device, not a microphone: it may record silence. Choose your microphone in System Settings → Sound → Input.", true)
    }
}
