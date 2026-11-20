// Which sounds a walkthrough records: the headset's Mic and App sound switches, on the Mac (Robin,
// 2026-11-11: the Mac's "✓ Mic" was a label with no way to turn the mic off). They sit in a launch's
// folded Settings, as on the headset, and the line under the keys names a sound left out, so the fold
// never hides it. They are chosen before recording and apply to every walkthrough (Record and open,
// Record a reply, ⌃⌥R with no call). A call always records both: its mic is Me and Arc's sound is the
// Others, and a switch left off since a walkthrough must not cost a call its voices.

public struct WalkthroughSounds: Equatable, Sendable {
    public var mic: Bool
    public var macSound: Bool

    public init(mic: Bool = true, macSound: Bool = true) {
        self.mic = mic
        self.macSound = macSound
    }

    /// Either is off: the launch's Settings key is amber with a dot, as on the headset.
    public var anyOff: Bool { !mic || !macSound }

    /// What Record and open records, said under the keys (the headset's Threads.describe); `leftOut` is the
    /// apps left out of the screen ("Messages, Mail and Passwords left out").
    public func records(leftOut: String? = nil) -> String {
        let what = switch (mic, macSound) {
        case (true, true): "Records the display, the mic and the Mac's sound"
        case (true, false): "Records the display and the mic, without the Mac's sound"
        case (false, true): "Records the display and the Mac's sound, without the mic"
        case (false, false): "Records the display only, without the mic or the Mac's sound"
        }
        return leftOut.map { "\(what); \($0)" } ?? what
    }
}
