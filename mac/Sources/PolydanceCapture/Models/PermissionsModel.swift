// The settings' Permissions panel (A2): each grant read without asking (the microphone's status, the
// screen-recording preflight, Apple Events to Arc with askUserIfNeeded false, the notification
// settings), and asked for only when the user presses Request. System audio has no status to read:
// a refused grant gives silence, so the app watches for silence during a call (C12) and the panel says
// what the last call heard. Reading Arc's grant can block while macOS thinks, so it runs off the main
// thread, as does asking.
import AVFoundation
import AppKit
import CoreGraphics
import CoreServices
import Foundation
import Observation
import PolydanceCore
import UserNotifications

@MainActor
@Observable
final class PermissionsModel {
    @ObservationIgnored weak var app: AppModel?

    private(set) var microphone = AVCaptureDevice.authorizationStatus(for: .audio)
    private(set) var screen = CGPreflightScreenCaptureAccess()
    private(set) var automation: AutomationGrant?
    private(set) var notifications: UNAuthorizationStatus?
    private(set) var askingArc = false
    /// Set after Request for the screen: macOS records the answer only after the app restarts.
    private(set) var screenAsked = false

    func refresh() {
        microphone = AVCaptureDevice.authorizationStatus(for: .audio)
        screen = CGPreflightScreenCaptureAccess()
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in self.notifications = status }
        }
        checkArc(ask: false)
    }

    func requestMicrophone() {
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            Task { @MainActor in self.refresh() }
        }
    }

    /// Shows macOS's question the first time; after a refusal it does nothing, and System Settings is the
    /// only way back.
    func requestScreen() {
        screen = CGRequestScreenCaptureAccess()
        screenAsked = true
    }

    func requestArc() { checkArc(ask: true) }

    func requestNotifications() {
        app?.notifier.requestAuthorization { _ in
            Task { @MainActor in self.refresh() }
        }
    }

    func open(_ pane: SystemSettingsPane) {
        NSWorkspace.shared.open(pane.url)
    }

    private func checkArc(ask: Bool) {
        guard !askingArc else { return }
        askingArc = true
        Task.detached(priority: .userInitiated) {
            let grant = AutomationGrant(status: Self.automationStatus(ask: ask))
            await MainActor.run {
                self.automation = grant
                self.askingArc = false
            }
        }
    }

    /// AEDeterminePermissionToAutomateTarget for Arc's bundle id: never launches Arc, and with `ask`
    /// false never shows a prompt.
    nonisolated static func automationStatus(ask: Bool) -> Int32 {
        var target = AEAddressDesc()
        let bundleID = Array(ArcBrowser.bundleID.utf8)
        let created = bundleID.withUnsafeBufferPointer { AECreateDesc(DescType(typeApplicationBundleID), $0.baseAddress, $0.count, &target) }
        guard created == noErr else { return Int32(created) }
        defer { AEDisposeDesc(&target) }
        return AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
    }

    // MARK: Words

    var microphoneText: String {
        switch microphone {
        case .authorized: "Allowed"
        case .denied: "Not allowed"
        case .restricted: "Restricted"
        case .notDetermined: "Not asked yet"
        @unknown default: "Unknown"
        }
    }

    var notificationsText: String {
        switch notifications {
        case .authorized, .provisional: "Allowed"
        case .denied: "Not allowed"
        case .notDetermined: "Not asked yet"
        case nil: "Checking…"
        @unknown default: "Unknown"
        }
    }

    var notificationsAllowed: Bool { notifications == .authorized || notifications == .provisional }
}
