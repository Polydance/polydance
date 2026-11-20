// Asks Arc for the address of every tab, through NSAppleScript, only when Arc is already running (it
// is never launched by being asked: NSRunningApplication is checked first, and the script itself checks
// `is running`). The first question shows macOS's Automation prompt for Arc, once. Scripts run on one
// serial queue so NSAppleScript is never used from two threads, and one question at a time is in
// flight; the script's own timeout keeps a busy Arc from holding the detector up. A call's recording asks
// once more, which window shows the call (CallWindow): that question waits its turn on the same queue
// rather than being refused.
import AppKit
import Foundation
import PolydanceCore

/// Unchecked Sendable: the scripts are touched only on `queue`, and `inFlight` only under `lock`.
final class ArcTabReader: @unchecked Sendable {
    private let queue = DispatchQueue(label: "net.polydance.capture.arc-tabs", qos: .utility)
    private var script: NSAppleScript?
    private var windowsScript: NSAppleScript?
    private var inFlight = false
    private let lock = NSLock()

    static var arcIsRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: ArcBrowser.bundleID).isEmpty
    }

    /// Reads Arc's tabs and calls back on the main queue. Returns false, without calling back, when a
    /// question is already in flight.
    @discardableResult
    func read(_ done: @escaping (TabReading) -> Void) -> Bool {
        lock.lock()
        if inFlight { lock.unlock(); return false }
        inFlight = true
        lock.unlock()
        guard Self.arcIsRunning else {
            finish(.arcNotRunning, done)
            return true
        }
        queue.async { [self] in
            finish(ask(), done)
        }
        return true
    }

    /// One question, answered on the calling thread, for `--arc-tabs`; the app's own reads use `read(_:)`.
    func readNow() -> TabReading {
        guard Self.arcIsRunning else { return .arcNotRunning }
        return queue.sync { ask() }
    }

    /// Arc's windows, each with its active tab's address and its title, for finding a call's window. Asked
    /// on the reader's queue after any question already in flight.
    func readWindows() async -> CallWindow.Reading {
        guard Self.arcIsRunning else { return .windows([]) }
        return await withCheckedContinuation { continuation in
            queue.async { [self] in continuation.resume(returning: askWindows()) }
        }
    }

    /// The same, answered on the calling thread, for `--arc-tabs`.
    func readWindowsNow() -> CallWindow.Reading {
        guard Self.arcIsRunning else { return .windows([]) }
        return queue.sync { askWindows() }
    }

    private func finish(_ reading: TabReading, _ done: @escaping (TabReading) -> Void) {
        lock.lock(); inFlight = false; lock.unlock()
        DispatchQueue.main.async { done(reading) }
    }

    private func ask() -> TabReading {
        if script == nil {
            let compiled = NSAppleScript(source: ArcTabsScript.source)
            var error: NSDictionary?
            guard let compiled, compiled.compileAndReturnError(&error) else {
                return .failed("the tab script did not compile: \(Self.describe(error))")
            }
            script = compiled
        }
        var error: NSDictionary?
        guard let result = script?.executeAndReturnError(&error) else {
            return .failed(Self.describe(error))
        }
        return ArcTabsScript.parse(result.stringValue ?? "")
    }

    private func askWindows() -> CallWindow.Reading {
        if windowsScript == nil {
            let compiled = NSAppleScript(source: CallWindow.source)
            var error: NSDictionary?
            guard let compiled, compiled.compileAndReturnError(&error) else {
                return .failed("the window script did not compile: \(Self.describe(error))")
            }
            windowsScript = compiled
        }
        var error: NSDictionary?
        guard let result = windowsScript?.executeAndReturnError(&error) else { return .failed(Self.describe(error)) }
        return CallWindow.parse(result.stringValue ?? "")
    }

    /// -1743 is "not authorised to send Apple Events": the Automation switch for Arc is off.
    private static func describe(_ error: NSDictionary?) -> String {
        let number = error?[NSAppleScript.errorNumber] as? Int
        if number == -1743 { return "Automation for Arc is off in System Settings, Privacy & Security, Automation" }
        let message = error?[NSAppleScript.errorMessage] as? String ?? "no answer"
        return number.map { "\(message) (\($0))" } ?? message
    }
}
