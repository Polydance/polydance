// Replies announced on the phone (docs/IPHONE.md U7), as the headset's Replies.kt announces them: off
// until turned on behind the gear, which asks iOS for permission to notify and posts one notice at once so
// the phone shows straight away that they appear. A check asks the receiver which threads are unread and
// posts one notification per thread for messages by others not yet told about (PolydancePhoneCore's
// ReplyNotices); the background refresh runs it when iOS chooses, and the app runs it whenever it comes to
// the front, where the inbox itself shows what is new, so nothing is posted then. Tapping a notice opens
// its thread, and reading a thread anywhere with this token takes its notice away. The app's badge is the
// unread count. What was told is a seq per thread in notices.json (0600). The log records counts and
// timings, never a thread's words or key.
import Foundation
import PolydancePhoneCore
import PolydanceShared
import UIKit
import UserNotifications

@MainActor
final class ReplyNotifier: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let enabledKey = "replies.on"
    nonisolated private static let thread = "thread"

    @Published private(set) var enabled: Bool
    /// The last check, in words, for the settings: when it ran and what it found.
    @Published private(set) var lastCheck: String = "not yet"

    /// Opens a thread from a tapped notice; the deck sets it. A tap that comes before the deck exists waits.
    var onOpen: ((String) -> Void)? {
        didSet { if let key = pendingOpen, let onOpen { pendingOpen = nil; onOpen(key) } }
    }
    private var pendingOpen: String?

    private let log: EventLog
    private let ledgerURL: URL
    private var center: UNUserNotificationCenter { .current() }

    init(log: EventLog, root: URL) {
        self.log = log
        ledgerURL = root.appendingPathComponent("notices.json")
        enabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
        super.init()
    }

    // MARK: On and off

    /// Asks iOS, then posts the first notice. Returns why not when iOS or the person refused.
    func turnOn() async -> String? {
        let granted: Bool
        do { granted = try await center.requestAuthorization(options: [.alert, .sound, .badge]) } catch {
            log.write("replies.on", ["granted": false, "error": ErrorWords.describe(error), "appState": ProbeAppState.current()])
            return "iOS did not ask: \(ErrorWords.describe(error))"
        }
        log.write("replies.on", ["granted": granted, "appState": ProbeAppState.current()])
        guard granted else { return "Polydance may not notify. Allow it in Settings, Notifications, Polydance." }
        enabled = true
        UserDefaults.standard.set(true, forKey: Self.enabledKey)
        post(id: "replies-on", title: "Notifications are on",
             body: "Polydance will tell you here when someone replies in a thread you have not read, when iOS lets it check.", key: nil)
        return nil
    }

    func turnOff() {
        enabled = false
        UserDefaults.standard.set(false, forKey: Self.enabledKey)
        center.getDeliveredNotifications { [weak self] delivered in
            let ids = delivered.map(\.request.identifier).filter { $0.hasPrefix("reply-") || $0 == "replies-on" }
            Task { @MainActor in self?.center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
        center.setBadgeCount(0)
        log.write("replies.off", ["appState": ProbeAppState.current()])
    }

    // MARK: The check

    /// From background refresh: asks the receiver and posts what is new. True when the receiver answered.
    func check(_ client: ReceiverClient, why: String) async -> Bool {
        let started = Date()
        var fields: [String: any Sendable] = ["why": why]
        defer {
            fields["ms"] = Int(Date().timeIntervalSince(started) * 1000)
            fields["appState"] = ProbeAppState.current()
            log.write("replies.check", fields)
        }
        guard enabled else { fields["skipped"] = "notifications are off"; return true }
        do {
            let listing = try await client.listing()
            var ledger = loadLedger()
            let plan = ReplyNotices.plan(listing.threads, told: ledger.told)
            for key in plan.clear { seen(key) }
            var posted = 0
            for key in plan.fetch {
                try Task.checkCancellation()
                let detail = try await client.thread(key)
                let (notice, seq) = ReplyNotices.notice(for: detail, told: ledger.told[key] ?? 0)
                ledger.told[key] = seq
                if let notice {
                    post(id: "reply-\(notice.key)", title: notice.title, body: notice.body, key: notice.key)
                    posted += 1
                }
            }
            saveLedger(ledger)
            setBadge(listing.unread)
            fields.merge(["ok": true, "threads": listing.threads.count, "unread": listing.unread, "fetched": plan.fetch.count, "posted": posted]) { $1 }
            lastCheck = "\(Self.clock(started)): \(listing.unread) unread, \(posted) told"
            return true
        } catch {
            fields["ok"] = false
            fields["reason"] = (error as? ReceiverError)?.description ?? ErrorWords.describe(error)
            lastCheck = "\(Self.clock(started)): failed, \(fields["reason"] as? String ?? "")"
            return false
        }
    }

    /// The inbox was on the screen: what it showed is told, so a refresh later does not announce it.
    func shown(_ listing: ThreadListing) {
        var ledger = loadLedger()
        let before = ledger
        ledger.shown(listing.threads)
        if ledger != before { saveLedger(ledger) }
        for thread in listing.threads where !thread.unread { seen(thread.key) }
        setBadge(listing.unread)
    }

    /// The thread is read: its notice goes.
    func seen(_ key: String) { center.removeDeliveredNotifications(withIdentifiers: ["reply-\(key)"]) }

    private func setBadge(_ unread: Int) {
        guard enabled else { return }
        center.setBadgeCount(unread)
    }

    private func post(id: String, title: String, body: String, key: String?) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let key { content.userInfo = [Self.thread: key]; content.threadIdentifier = key }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { [log] error in
            guard let error else { return }
            log.write("replies.post", ["ok": false, "error": (error as NSError).localizedDescription])
        }
    }

    private func loadLedger() -> NoticeLedger {
        do { return try NoticeLedger.load(ledgerURL) } catch {
            log.write("replies.ledger", ["ok": false, "reason": (error as? UploadProtocolError)?.description ?? ErrorWords.describe(error)])
            return NoticeLedger()
        }
    }

    private func saveLedger(_ ledger: NoticeLedger) {
        do { try ledger.save(ledgerURL) } catch {
            log.write("replies.ledger", ["ok": false, "reason": ErrorWords.describe(error)])
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    /// While Polydance is in front the inbox shows what is new, so a reply's notice is not shown over it;
    /// the one posted on turning them on is, since it is there to show that notices appear at all.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        notification.request.identifier == "replies-on" ? [.banner, .list] : []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let key = response.notification.request.content.userInfo[Self.thread] as? String
        await MainActor.run {
            guard let key, ThreadKey.isValid(key) else { return }
            self.log.write("replies.opened", ["appState": ProbeAppState.current()])
            if let onOpen = self.onOpen { onOpen(key) } else { self.pendingOpen = key }
        }
    }

    static func clock(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "d MMM HH:mm"
        return f.string(from: date)
    }
}
