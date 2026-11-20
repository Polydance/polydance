// Arc holding the microphone while nothing records it: no tab is on a Meet call Polydance knows, or the
// tabs cannot be read. The first real call (2026-11-06) was missed like this, because Meet had moved to
// an address the app did not read, and nothing on screen said so. This decides when to say so: once Arc
// has held the microphone for 20 s with no call found, once per stretch of microphone use. A stretch ends
// when Arc has let go of the microphone for 20 s (D4's grace, so a brief release does not warn twice).
// It only runs while automatic recording is on and nothing is recording, and it is fed the same
// observations as the call detector, on the caller's monotonic clock in seconds.

public struct MicWithoutCallWatch: Sendable {
    /// What this tick learned about Arc's tabs.
    public enum Tabs: Sendable, Equatable {
        /// Not asked this tick (a question still in flight): changes nothing.
        case notRead
        /// A tab is on a Meet call: nothing to warn about.
        case call
        /// No tab is on a call. `meetTabs` are the Meet tabs' address forms (MeetLink.shape), so the
        /// warning can say which address Meet is on when it is one Polydance does not read as a call.
        case noCall(meetTabs: [String])
        /// Arc did not answer: Automation off, a timeout, a script error.
        case unreadable(String)

        public init(_ reading: TabReading?) {
            switch reading {
            case nil: self = .notRead
            case .failed(let why)?: self = .unreadable(why)
            case .arcNotRunning?: self = .noCall(meetTabs: [])
            case .urls(let urls)?:
                if !MeetLink.meetingCodes(in: urls).isEmpty { self = .call }
                else { self = .noCall(meetTabs: Array(Set(urls.compactMap(MeetLink.shape(of:)))).sorted()) }
            }
        }
    }

    public enum Reason: Sendable, Equatable {
        /// No Meet tab is open: the microphone is for something else (another call site, dictation).
        case noMeetTab
        /// Meet tabs are open but none is on an address Polydance reads as a call.
        case meetTabNotACall([String])
        /// The tabs could not be read.
        case tabsUnreadable(String)
    }

    public struct Warning: Sendable, Equatable {
        public var reason: Reason
        /// How long Arc has held the microphone with no call found.
        public var seconds: Double
    }

    /// Seconds of microphone with no call before the warning.
    public let after: Double
    /// Seconds without the microphone that end a stretch.
    public let micReleaseGrace: Double

    /// The warning while it holds (Arc has the microphone now), for the menu; nil otherwise.
    public private(set) var current: Warning?

    private var since: Double?
    private var reason: Reason?
    private var lastMicAt: Double?
    private var warned = false

    public init(after: Double = 20, micReleaseGrace: Double = CallRules.standard.micReleaseGrace) {
        self.after = after
        self.micReleaseGrace = micReleaseGrace
    }

    /// Feed one tick. `watching` is false while something records or automatic recording is off; then
    /// nothing is shown and the clock starts again, but a warning already given this stretch is not
    /// repeated. Returns the warning once per stretch, at the tick it first holds.
    public mutating func observe(at: Double, micActive: Bool, tabs: Tabs, watching: Bool) -> Warning? {
        if micActive {
            lastMicAt = at
        } else if lastMicAt.map({ at - $0 >= micReleaseGrace }) ?? true {
            self = MicWithoutCallWatch(after: after, micReleaseGrace: micReleaseGrace)
            return nil
        }
        guard watching else {
            since = nil
            reason = nil
            current = nil
            return nil
        }
        switch tabs {
        case .notRead: break
        case .call:
            since = nil
            reason = nil
        case .noCall(let meetTabs):
            reason = meetTabs.isEmpty ? .noMeetTab : .meetTabNotACall(meetTabs)
            if since == nil { since = at }
        case .unreadable(let why):
            reason = .tabsUnreadable(why)
            if since == nil { since = at }
        }
        guard micActive, let since, let reason, at - since >= after else {
            current = nil
            return nil
        }
        current = Warning(reason: reason, seconds: at - since)
        if warned { return nil }
        warned = true
        return current
    }
}

extension MicWithoutCallWatch.Warning {
    /// The notification's title and text, and the menu's line. `shortcut` is Record now's key.
    public func text(shortcut: String) -> (title: String, body: String, line: String) {
        let held = "Arc has been using the microphone for \(Int(seconds.rounded())) s"
        switch reason {
        case .noMeetTab:
            return ("Polydance isn't recording",
                    "\(held) and no Google Meet call is open, so nothing is recording. Only Meet calls record by themselves; \(shortcut) records this as a walkthrough.",
                    "Arc is using the microphone and no Meet call is open, so nothing is recording. \(shortcut) records a walkthrough.")
        case .meetTabNotACall(let shapes):
            let at = shapes.map { $0.replacingOccurrences(of: "https://", with: "") }.joined(separator: ", ")
            return ("Polydance isn't recording this call",
                    "\(held) and Meet is open at \(at), which Polydance doesn't read as a call. \(shortcut) records it as a walkthrough.",
                    "Arc is using the microphone and Meet is open at \(at), which Polydance doesn't read as a call, so nothing is recording. \(shortcut) records a walkthrough.")
        case .tabsUnreadable(let why):
            return ("Polydance can't see Arc's tabs",
                    "\(held), but Polydance can't read its tabs to find a Meet call, so nothing is recording: \(why)",
                    "Arc is using the microphone, but its tabs could not be read, so nothing is recording: \(why)")
        }
    }
}
