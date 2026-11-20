// The call detector's decisions (docs/MAC.md D2 to D5), as a pure state machine fed about once a second.
// It starts a call recording when Arc holds the microphone and a tab is on a Meet code, and stops it when
// the microphone has been released for 20 s, the code has been gone for 5 s, the user stops, or 4 hours
// pass. Times are seconds on a monotonic clock supplied by the caller, so tests drive it with numbers.
//
// After the user stops (or discards) a call, or the cap ends it, the detector stands down until that call
// is over by the same rules, so the next tick does not start it again.

public struct CallRules: Sendable, Equatable {
    /// D4: the browser has let go of the microphone for this long.
    public var micReleaseGrace: Double
    /// D4: no tab has been on the call's meeting code for this long.
    public var codeGoneGrace: Double
    /// D4: the hard cap.
    public var cap: Double
    /// D5: recordings shorter than this are marked `short`.
    public var shortUnder: Double

    public init(micReleaseGrace: Double = 20, codeGoneGrace: Double = 5, cap: Double = 4 * 3600, shortUnder: Double = 120) {
        self.micReleaseGrace = micReleaseGrace
        self.codeGoneGrace = codeGoneGrace
        self.cap = cap
        self.shortUnder = shortUnder
    }

    public static let standard = CallRules()

    public func isShort(seconds: Double) -> Bool { seconds < shortUnder }
}

/// Why a recording stopped; the raw values are the contract's `call.stopReason`.
public enum CallStopReason: String, Codable, Sendable, CaseIterable {
    case leftCall = "left-call"
    case micReleased = "mic-released"
    case user
    case cap
    case appQuit = "app-quit"
}

/// One reading of the world.
public struct CallObservation: Sendable, Equatable {
    /// Seconds on a monotonic clock.
    public var at: Double
    /// Some Arc process is running input.
    public var micActive: Bool
    /// Meet codes in Arc's tabs; nil when the tabs were not read or Arc did not answer, which counts as
    /// "unchanged", never as "gone", so an Apple Events hiccup does not end a call.
    public var meetingCodes: [String]?

    public init(at: Double, micActive: Bool, meetingCodes: [String]?) {
        self.at = at
        self.micActive = micActive
        self.meetingCodes = meetingCodes
    }
}

public enum DetectorEvent: Sendable, Equatable {
    case start(meetingCode: String)
    case stop(reason: CallStopReason, seconds: Double, short: Bool)
}

public struct CallDetector: Sendable {
    public enum StartedBy: String, Sendable, Equatable { case detector, user }

    public struct Call: Sendable, Equatable {
        public var meetingCode: String
        public var startedAt: Double
        public var lastMicAt: Double
        public var lastCodeAt: Double
        public var startedBy: StartedBy
    }

    public struct StandDown: Sendable, Equatable {
        public var meetingCode: String
        public var lastMicAt: Double
        public var lastCodeAt: Double
    }

    public enum State: Sendable, Equatable {
        case watching
        case recording(Call)
        /// The user stopped this call, the cap ended it, or capture could not start: wait for it to end.
        case standingDown(StandDown)
    }

    public let rules: CallRules
    public private(set) var state: State = .watching

    public init(rules: CallRules = .standard) {
        self.rules = rules
    }

    public var currentCall: Call? {
        if case .recording(let call) = state { return call }
        return nil
    }

    /// Feed one observation. `autoRecord` off means calls are only recorded when the user asks;
    /// `otherRecording` is true while a walkthrough is being recorded, which a call does not interrupt.
    public mutating func observe(_ o: CallObservation, autoRecord: Bool = true, otherRecording: Bool = false) -> DetectorEvent? {
        switch state {
        case .watching:
            guard autoRecord, !otherRecording, o.micActive, let code = o.meetingCodes?.first else { return nil }
            state = .recording(Call(meetingCode: code, startedAt: o.at, lastMicAt: o.at, lastCodeAt: o.at, startedBy: .detector))
            return .start(meetingCode: code)

        case .recording(var call):
            refresh(&call.lastMicAt, &call.lastCodeAt, code: call.meetingCode, with: o)
            let seconds = o.at - call.startedAt
            if seconds >= rules.cap {
                state = .standingDown(StandDown(meetingCode: call.meetingCode, lastMicAt: call.lastMicAt, lastCodeAt: call.lastCodeAt))
                return stop(.cap, seconds)
            }
            if o.at - call.lastCodeAt >= rules.codeGoneGrace {
                state = .watching
                return stop(.leftCall, seconds)
            }
            if o.at - call.lastMicAt >= rules.micReleaseGrace {
                state = .watching
                return stop(.micReleased, seconds)
            }
            state = .recording(call)
            return nil

        case .standingDown(var down):
            refresh(&down.lastMicAt, &down.lastCodeAt, code: down.meetingCode, with: o)
            if o.at - down.lastCodeAt >= rules.codeGoneGrace || o.at - down.lastMicAt >= rules.micReleaseGrace {
                state = .watching
            } else {
                state = .standingDown(down)
            }
            return nil
        }
    }

    /// "Record now" while a call is live (mic and code both present): record it as a call even when
    /// automatic recording is off or the detector stood down. Nil means there is no call to record, and
    /// the app records a walkthrough instead.
    public mutating func startByUser(_ o: CallObservation) -> DetectorEvent? {
        if case .recording = state { return nil }
        guard o.micActive, let code = o.meetingCodes?.first else { return nil }
        state = .recording(Call(meetingCode: code, startedAt: o.at, lastMicAt: o.at, lastCodeAt: o.at, startedBy: .user))
        return .start(meetingCode: code)
    }

    /// Stop, or Stop and discard, from the menu, the notification or the shortcut.
    public mutating func stopByUser(at: Double) -> DetectorEvent? {
        guard case .recording(let call) = state else { return nil }
        state = .standingDown(StandDown(meetingCode: call.meetingCode, lastMicAt: at, lastCodeAt: at))
        return stop(.user, at - call.startedAt)
    }

    /// The app is quitting with a call recording open.
    public mutating func appQuitting(at: Double) -> DetectorEvent? {
        guard case .recording(let call) = state else { return nil }
        state = .watching
        return stop(.appQuit, at - call.startedAt)
    }

    /// The recording for the call just started could not be made; stand down rather than retry each tick.
    public mutating func captureFailed(at: Double) {
        guard case .recording(let call) = state else { return }
        state = .standingDown(StandDown(meetingCode: call.meetingCode, lastMicAt: at, lastCodeAt: at))
    }

    private func refresh(_ lastMic: inout Double, _ lastCode: inout Double, code: String, with o: CallObservation) {
        if o.micActive { lastMic = o.at }
        if let codes = o.meetingCodes {
            if codes.contains(code) { lastCode = o.at }
        } else {
            lastCode = o.at
        }
    }

    private func stop(_ reason: CallStopReason, _ seconds: Double) -> DetectorEvent {
        .stop(reason: reason, seconds: seconds, short: rules.isShort(seconds: seconds))
    }
}
