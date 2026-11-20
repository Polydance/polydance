// The app's entry (docs/IPHONE.md). The screen is the deck (DeckScreen, in the look every platform shares);
// the I0 probe's parts run under it unchanged, and its own screen is a debug view behind the gear. This file
// owns only what iOS requires of the app itself: creating the one ProbeModel before launch finishes, registering the refresh task in that window (iOS
// refuses a later registration), handing background URLSession events to the upload probe, and logging
// each scene phase change so leaving and coming back are on the record with the recordings.
import BackgroundTasks
import PolydancePhoneCore
import SwiftUI
import UIKit
import UserNotifications

@main
struct PolydanceApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            DeckScreen(probe: ProbeModel.shared)
        }
        .onChange(of: scenePhase) { _, phase in
            ProbeModel.shared.scenePhaseChanged(phase)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let model = ProbeModel.shared
        // Registered here even when the model could not set up its files, so a refresh iOS was asked for
        // in an earlier launch always finds its handler.
        let registered = RefreshProbe.register { task in
            if let refresh = model.parts?.refresh {
                refresh.run(task)
            } else {
                task.setTaskCompleted(success: false)
            }
        }
        model.launched(optionKeys: (launchOptions ?? [:]).keys.map(\.rawValue).sorted(), refreshRegistered: registered)
        // Before launch finishes, so a tapped reply notice that launched the app reaches it (U7).
        UNUserNotificationCenter.current().delegate = model.parts?.notifier
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard let uploads = ProbeModel.shared.parts?.uploads else {
            completionHandler()
            return
        }
        uploads.handleBackgroundEvents(identifier: identifier, completion: completionHandler)
    }
}

/// UIApplication's state as the events name it, the one helper every part's appState field comes from
/// (the recorder, the upload probe, the refresh probe and the model). Read on the main thread only; a
/// callback on another queue passes "unknown" rather than block on the main thread.
enum ProbeAppState {
    @MainActor static func current() -> String {
        switch UIApplication.shared.applicationState {
        case .active: "active"
        case .inactive: "inactive"
        case .background: "background"
        @unknown default: "unknown"
        }
    }

    /// The state from any thread: read directly on the main thread, "unknown" elsewhere.
    static func currentIfMain() -> String {
        guard Thread.isMainThread else { return "unknown" }
        return MainActor.assumeIsolated { current() }
    }
}
