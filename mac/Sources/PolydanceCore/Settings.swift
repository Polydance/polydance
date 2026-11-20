// The app's settings, in UserDefaults. Every read validates and falls back to the default, so a bad
// value written by hand (`defaults write`) cannot reach the capture or a child process. The keys are
// public so SwiftUI views can bind to the same values with @AppStorage.
import Foundation

public enum Transcriber: String, CaseIterable, Sendable, Codable {
    /// whisper.cpp on this Mac: calls stay local (decided 2026-11-05).
    case whisperCpp = "whisper-cpp"
    /// Gladia's API: the call's audio, everyone's voice, leaves the Mac. It gives no speaker labels:
    /// telling the others apart (diarisation, P3) is not built, so the far end is one "Others".
    case gladia
}

public final class SettingsStore: @unchecked Sendable {
    public enum Key {
        public static let autoRecordMeet = "autoRecordMeet"
        public static let notifyOnStart = "notifyOnStart"
        public static let warnWithoutCall = "warnWithoutCall"
        public static let walkthroughMic = "walkthroughMic"
        public static let walkthroughMacSound = "walkthroughMacSound"
        public static let walkthroughScreen = "walkthroughScreen"
        public static let excludedApps = "excludedApps"
        public static let fps = "fps"
        public static let transcriber = "transcriber"
        public static let nodePath = "nodePath"
        public static let polycapPath = "polycapPath"
        public static let libraryRoot = "libraryRoot"
    }

    /// Messages, Mail and Passwords (docs/MAC.md, Open decisions).
    public static let defaultExcludedApps = ["com.apple.MobileSMS", "com.apple.mail", "com.apple.Passwords"]
    public static let defaultFPS = 5
    public static let fpsRange = 1...30

    // UserDefaults is thread-safe; the class holds nothing else.
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Record every Google Meet call in Arc by itself (default on).
    public var autoRecordMeet: Bool {
        get { defaults.object(forKey: Key.autoRecordMeet) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.autoRecordMeet) }
    }

    /// Post a notification, with Stop and Discard, when a call starts recording by itself (default on).
    public var notifyOnStart: Bool {
        get { defaults.object(forKey: Key.notifyOnStart) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.notifyOnStart) }
    }

    /// Post a notification when Arc has held the microphone for 20 s and no Meet call was found, so
    /// nothing is recording (default on; MicWithoutCallWatch).
    public var warnWithoutCall: Bool {
        get { defaults.object(forKey: Key.warnWithoutCall) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.warnWithoutCall) }
    }

    /// A walkthrough records the microphone (default on): the headset's Mic switch, on a thread's launch.
    /// A call always records it, since it is Me.
    public var walkthroughMic: Bool {
        get { defaults.object(forKey: Key.walkthroughMic) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.walkthroughMic) }
    }

    /// A walkthrough records the Mac's sound (default on): the headset's App sound switch. A call always
    /// records Arc's sound, since it is the Others.
    public var walkthroughMacSound: Bool {
        get { defaults.object(forKey: Key.walkthroughMacSound) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.walkthroughMacSound) }
    }

    public var walkthroughSounds: WalkthroughSounds {
        WalkthroughSounds(mic: walkthroughMic, macSound: walkthroughMacSound)
    }

    /// The screen the last walkthrough recorded (ScreenTarget), lit first next time; nil until one is chosen.
    public var walkthroughScreen: ScreenTarget? {
        get { defaults.data(forKey: Key.walkthroughScreen).flatMap { try? JSONDecoder().decode(ScreenTarget.self, from: $0) } }
        set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: Key.walkthroughScreen) }
    }

    /// Bundle ids left out of the screen capture. Invalid entries are dropped; an absent value is the default.
    public var excludedApps: [String] {
        get {
            guard let stored = defaults.array(forKey: Key.excludedApps) as? [String] else { return Self.defaultExcludedApps }
            var seen = Set<String>()
            return stored.filter { BundleIDRule.isValid($0) && seen.insert($0).inserted }
        }
        set {
            var seen = Set<String>()
            defaults.set(newValue.filter { BundleIDRule.isValid($0) && seen.insert($0).inserted }, forKey: Key.excludedApps)
        }
    }

    /// Screen frames per second, 1 to 30 (C2: default 5).
    public var fps: Int {
        get {
            guard let value = defaults.object(forKey: Key.fps) as? Int, Self.fpsRange.contains(value) else { return Self.defaultFPS }
            return value
        }
        set { defaults.set(min(max(newValue, Self.fpsRange.lowerBound), Self.fpsRange.upperBound), forKey: Key.fps) }
    }

    /// Passed to polycap as POLYCAP_TRANSCRIBER.
    public var transcriber: Transcriber {
        get { (defaults.string(forKey: Key.transcriber)).flatMap(Transcriber.init(rawValue:)) ?? .whisperCpp }
        set { defaults.set(newValue.rawValue, forKey: Key.transcriber) }
    }

    /// node, once found (by hand or from the login shell). Absolute paths only.
    public var nodePath: String? {
        get { absolute(defaults.string(forKey: Key.nodePath)) }
        set { setPath(newValue, Key.nodePath) }
    }

    /// polycap's bin/polycap.js, once found. Absolute paths only.
    public var polycapPath: String? {
        get { absolute(defaults.string(forKey: Key.polycapPath)) }
        set { setPath(newValue, Key.polycapPath) }
    }

    /// The library, when not $POLYCAP_ROOT or ~/PolydanceCapture. `~/` is allowed.
    public var libraryRoot: String? {
        get {
            guard let value = defaults.string(forKey: Key.libraryRoot)?.trimmingWhitespace(), !value.isEmpty else { return nil }
            return value.hasPrefix("/") || value.hasPrefix("~/") ? value : nil
        }
        set {
            if let value = newValue?.trimmingWhitespace(), !value.isEmpty { defaults.set(value, forKey: Key.libraryRoot) }
            else { defaults.removeObject(forKey: Key.libraryRoot) }
        }
    }

    private func absolute(_ value: String?) -> String? {
        guard let value = value?.trimmingWhitespace(), value.hasPrefix("/") else { return nil }
        return value
    }

    private func setPath(_ value: String?, _ key: String) {
        if let value = absolute(value) { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}
