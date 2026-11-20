// Polydance on Apple Vision Pro (docs/VISIONOS.md): the entry. One window, the Quest's one panel (the deck on the
// left, the inbox and the open thread beside it), on the wooden cabinet, opening at the Quest panel's 1440 x 900 and
// resizable down to its 720 minimum width. This file owns only what visionOS asks of the app itself: making the one
// HeadsetModel before launch finishes, registering the reply refresh in that window, handing background upload
// events to the uploads, and the notification delegate, as the iPhone's PolydanceApp does.
import BackgroundTasks
import PolydancePhoneCore
import SwiftUI
import UIKit
import UserNotifications

@main
struct PolydanceVisionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup(id: "panel") {
            PanelScreen(model: HeadsetModel.shared)
                .frame(minWidth: 720, minHeight: 560)
        }
        .windowStyle(.plain)
        .defaultSize(width: 1440, height: 900)
        .windowResizability(.contentMinSize)
        .onChange(of: scenePhase) { _, phase in
            HeadsetModel.shared.scenePhaseChanged(phase)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let model = HeadsetModel.shared
        let registered = RefreshProbe.register { task in
            if let refresh = model.parts?.refresh { refresh.run(task) } else { task.setTaskCompleted(success: false) }
        }
        model.launched(optionKeys: (launchOptions ?? [:]).keys.map(\.rawValue).sorted(), refreshRegistered: registered)
        UNUserNotificationCenter.current().delegate = model.parts?.notifier
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard let uploads = HeadsetModel.shared.parts?.uploads else {
            completionHandler()
            return
        }
        uploads.handleBackgroundEvents(identifier: identifier, completion: completionHandler)
    }
}

/// UIApplication's state as the events name it; the iPhone's shared files (UploadProbe, RefreshProbe, PairingStore,
/// ReplyNotifier) log it under this name, so the Vision Pro's log reads the same.
enum ProbeAppState {
    @MainActor static func current() -> String {
        switch UIApplication.shared.applicationState {
        case .active: "active"
        case .inactive: "inactive"
        case .background: "background"
        @unknown default: "unknown"
        }
    }

    static func currentIfMain() -> String {
        guard Thread.isMainThread else { return "unknown" }
        return MainActor.assumeIsolated { current() }
    }
}

/// The ballerina from the headset app's own file, as a template image the deck prints in its ink.
enum Logo {
    static let image: Image? = UIImage(named: "polydance_mark").map { Image(uiImage: $0).renderingMode(.template) }
}
