// The refresh probe (docs/IPHONE.md I0; U7 depends on it): asks iOS for a BGAppRefreshTask 15 minutes
// ahead each time the app goes to the background, and logs every run with the app's state and the time
// since the run before, so a day of events.jsonl shows when iOS actually ran it. The free team has no
// push, so since I3 replies are found this way: a run does `work` (ReplyNotifier's check, U7) before it
// tells iOS it is done, and an expiry cancels it. The event log is its only record: the runs today and the
// last run on screen are read back from events.jsonl, so the screen and the evidence cannot disagree.
// What stops iOS running refresh at all goes in the log too: Background App Refresh's setting and Low
// Power Mode, on each submit and run and as each changes, so a day of gaps can be matched to its cause.
// (A swipe away from the app switcher, which also stops refresh, leaves no trace the app can log.)
import BackgroundTasks
import Foundation
import PolydancePhoneCore
import UIKit

@MainActor
final class RefreshProbe: ObservableObject {
    /// "net.polydance.capture.iphone.refresh" on the iPhone, as its Info.plist permits; the Vision Pro's app,
    /// which shares this file (docs/VISIONOS.md), permits its own.
    static let identifier = (Bundle.main.bundleIdentifier ?? "net.polydance.capture.iphone") + ".refresh"
    /// How far ahead each request's earliest begin date is; iOS decides the real time.
    static let lead: TimeInterval = 15 * 60

    @Published private(set) var runsToday = 0
    @Published private(set) var lastRun: Date?
    @Published private(set) var lastSubmit = "not asked yet"

    /// What a run does before it completes: true when it worked. Nil does nothing (unpaired, or I0's probe).
    var work: (() async -> Bool)?

    private let log: EventLog
    private var observers: [NSObjectProtocol] = []

    init(log: EventLog) {
        self.log = log
        reload()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [log] _ in
            MainActor.assumeIsolated {
                log.write("power", ["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled, "appState": ProbeAppState.current()])
            }
        })
        observers.append(center.addObserver(forName: UIApplication.backgroundRefreshStatusDidChangeNotification, object: nil, queue: .main) { [log] _ in
            MainActor.assumeIsolated {
                var fields = RefreshProbe.conditions()
                fields["appState"] = ProbeAppState.current()
                log.write("refresh.status", fields)
            }
        })
    }

    /// Whether iOS may run a refresh at all: the Background App Refresh setting for this app, and Low
    /// Power Mode, which suspends it.
    static func conditions() -> [String: any Sendable] {
        let status = switch UIApplication.shared.backgroundRefreshStatus {
        case .available: "available"
        case .denied: "denied"
        case .restricted: "restricted"
        @unknown default: "unknown"
        }
        return ["backgroundRefresh": status, "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled]
    }

    /// Registers the launch handler, on the main queue. It must happen before
    /// application(_:didFinishLaunchingWithOptions:) returns, and once only (iOS ends an app that registers
    /// an identifier twice). False when Info.plist's BGTaskSchedulerPermittedIdentifiers lacks the identifier.
    static func register(_ handler: @escaping @MainActor (BGTask) -> Void) -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            MainActor.assumeIsolated { handler(task) }
        }
    }

    /// Asks for the next run. A newer request replaces an older one, so this is safe to call each time the
    /// app goes to the background. iOS refuses in the simulator, which is logged like any refusal.
    func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: Self.identifier)
        let earliest = Date().addingTimeInterval(Self.lead)
        request.earliestBeginDate = earliest
        do {
            try BGTaskScheduler.shared.submit(request)
            lastSubmit = "asked for one after \(Self.clock(earliest))"
            var fields = Self.conditions()
            fields.merge(["appState": ProbeAppState.current(), "earliest": EventLog.timestamp(earliest)]) { $1 }
            log.write("refresh.submit", fields)
        } catch {
            let ns = error as NSError
            let reason = "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
            lastSubmit = "refused (\(reason))"
            var fields = Self.conditions()
            fields.merge(["appState": ProbeAppState.current(), "error": reason]) { $1 }
            log.write("refresh.submit", fields)
        }
    }

    /// One run: logged, the next asked for, then `work` (the reply check) and completed. An expiry before the
    /// work is done cancels it and completes the task as failed.
    func run(_ task: BGTask) {
        let now = Date()
        var fields = Self.conditions()
        fields.merge(["appState": ProbeAppState.current(), "protectedData": UIApplication.shared.isProtectedDataAvailable]) { $1 }
        if let previous = Self.runDates(in: log.url).last {
            fields["sinceLastSeconds"] = Int(now.timeIntervalSince(previous).rounded())
        }
        log.write("refresh.run", fields)
        schedule()
        reload()
        guard let work else {
            task.expirationHandler = { [log] in log.write("refresh.expired", ["appState": ProbeAppState.currentIfMain()]) }
            task.setTaskCompleted(success: true)
            return
        }
        // Completed once only, by whichever comes first: the work's end or iOS's expiry (both on the main queue).
        let once = Once()
        let job = Task { @MainActor in
            let ok = await work()
            if once.first() { task.setTaskCompleted(success: ok) }
        }
        task.expirationHandler = { [log] in
            log.write("refresh.expired", ["appState": ProbeAppState.currentIfMain(), "working": true])
            job.cancel()
            MainActor.assumeIsolated { if once.first() { task.setTaskCompleted(success: false) } }
        }
    }

    /// Rereads the runs from the log, for the screen.
    func reload() {
        let dates = Self.runDates(in: log.url)
        runsToday = dates.filter { Calendar.current.isDateInToday($0) }.count
        lastRun = dates.last
    }

    /// The times of every refresh.run in the log, oldest first. A line that is not JSON, or has no
    /// readable time, is skipped: it says nothing about when a refresh ran.
    nonisolated static func runDates(in url: URL) -> [Date] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let marker = Data(#""event":"refresh.run""#.utf8)
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return data.split(separator: 0x0A).compactMap { line in
            guard line.range(of: marker) != nil,
                  let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  object["event"] as? String == "refresh.run",
                  let t = object["t"] as? String else { return nil }
            return parser.date(from: t)
        }
    }

    static func clock(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }
}

/// True the first time it is asked, false after: so a refresh task is completed exactly once.
@MainActor
private final class Once {
    private var done = false
    func first() -> Bool {
        defer { done = true }
        return !done
    }
}
