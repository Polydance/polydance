// Notifications (PV1): one at every automatic start, with Stop and Discard, reminding Robin to tell the
// others (PV2); and notices when something needs him (the far end is silent, a hand-off failed, the
// menu-bar icon is hidden). Clicking a notice opens the main window; clicking the start notification
// does not, so it never covers the call. Permission is asked the first time one is posted; the settings
// UI can ask earlier.
import Foundation
import UserNotifications

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    enum Action: String { case stop, discard, open }

    static let callCategory = "net.polydance.capture.call-started"
    // Made on first use, and never without an app bundle (`swift run`, the window tests), where
    // UNUserNotificationCenter raises an exception instead of answering.
    private lazy var center = UNUserNotificationCenter.current()
    private let available = Bundle.main.bundleURL.pathExtension == "app"
    var onAction: ((Action) -> Void)?

    func configure() {
        guard available else { return }
        center.delegate = self
        let stop = UNNotificationAction(identifier: Action.stop.rawValue, title: "Stop", options: [])
        let discard = UNNotificationAction(identifier: Action.discard.rawValue, title: "Discard", options: [.destructive])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.callCategory, actions: [stop, discard], intentIdentifiers: [])])
    }

    /// Asks for permission (alerts and sounds) if it was never asked. For onboarding.
    func requestAuthorization(_ done: ((Bool) -> Void)? = nil) {
        guard available else { done?(false); return }
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in done?(granted) }
    }

    func callStarted(meetingCode: String) {
        post(id: "call-started", title: "Recording your Meet call",
             body: "\(meetingCode) in Arc. Let people know you're recording.", category: Self.callCategory)
    }

    func notice(id: String, title: String, body: String) {
        post(id: id, title: title, body: body, category: nil)
    }

    func clear(id: String) {
        guard available else { return }
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }

    private func post(id: String, title: String, body: String, category: String?) {
        guard available else { return }
        center.getNotificationSettings { settings in
            let send = {
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                if let category { content.categoryIdentifier = category }
                self.center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
            }
            switch settings.authorizationStatus {
            case .notDetermined: self.requestAuthorization { granted in if granted { send() } }
            case .denied: break
            default: send()
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let action: Action?
        switch response.actionIdentifier {
        case Action.stop.rawValue: action = .stop
        case Action.discard.rawValue: action = .discard
        case UNNotificationDefaultActionIdentifier:
            action = response.notification.request.content.categoryIdentifier == Self.callCategory ? nil : .open
        default: action = nil
        }
        if let action { DispatchQueue.main.async { self.onAction?(action) } }
        completionHandler()
    }
}
