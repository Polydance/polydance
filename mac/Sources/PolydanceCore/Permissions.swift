// The grants the app needs (A2) and where each lives in System Settings, in words the settings show.
// Reading and asking for them is the app's (AVFoundation, CoreGraphics, Apple Events, notifications);
// this is the part that does not need a Mac's permissions to test: the panes' addresses and what an
// Apple Events answer means. macOS 15 opens these `x-apple.systempreferences:` addresses in System
// Settings; the Privacy anchors are the ones Ventura and later still honour.
import Foundation

public enum SystemSettingsPane: String, CaseIterable, Sendable {
    case microphone
    /// Screen recording, and on macOS 15 also "System Audio Recording Only", in one pane.
    case screenAndSystemAudio
    case automation
    case notifications
    case loginItems

    public var address: String {
        switch self {
        case .microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        case .screenAndSystemAudio: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case .automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        case .notifications: "x-apple.systempreferences:com.apple.preference.notifications?id=\(RecordingMeta.appPackageID)"
        case .loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
        }
    }

    public var url: URL { URL(string: address)! }
}

/// What AEDeterminePermissionToAutomateTarget said about Arc.
public enum AutomationGrant: Sendable, Equatable {
    case allowed
    case denied
    /// macOS has not asked yet; it asks the first time the app reads Arc's tabs, or when Request is pressed.
    case notAsked
    /// Arc is not running, so macOS cannot say.
    case arcNotRunning
    case unknown(Int32)

    /// noErr, errAEEventNotPermitted (-1743), errAEEventWouldRequireUserConsent (-1744), procNotFound (-600).
    public init(status: Int32) {
        switch status {
        case 0: self = .allowed
        case -1743: self = .denied
        case -1744: self = .notAsked
        case -600: self = .arcNotRunning
        default: self = .unknown(status)
        }
    }

    public var text: String {
        switch self {
        case .allowed: "Allowed"
        case .denied: "Not allowed"
        case .notAsked: "Not asked yet"
        case .arcNotRunning: "Open Arc to check"
        case .unknown(let status): "Unknown (\(status))"
        }
    }
}
