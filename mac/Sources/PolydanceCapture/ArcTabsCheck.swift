// `PolydanceCapture --arc-tabs`: asks Arc for its tabs once, through the same script and reader the
// detector uses, and prints as JSON what the detector would see: how many tabs, their meeting codes, and
// the Meet tabs' addresses with codes and queries left out. No address of any other site is printed.
// It then asks for Arc's windows, as a call's recording does (CallWindow), and prints how many there are,
// how many of them macOS lists by the same title (the match a call's window is found by), and for each
// call an active tab shows, whether its window was found, with why not. No title is printed.
// It is the one way to watch the Apple Event path work without a call: the first real call
// (2026-11-06) was missed, and nothing on screen said why. It sends Arc one Apple Event, which the
// app's Automation grant covers (without one, macOS asks), and never launches Arc. Run it with
// `./build.sh tabs`, which starts it through LaunchServices so the grant used is the app's own.
import AppKit
import Foundation
import PolydanceCore
import PolydanceShared

enum ArcTabsCheck {
    static func run() -> Int32 {
        let build = AppBuildInfo.from(infoDictionary: Bundle.main.infoDictionary)
        let parent = getppid()
        let started = Date()
        let reading = ArcTabReader().readNow()
        var report: [String: Any] = [
            "arcTabs": 1,
            "at": MetaTime.format(started),
            "elapsedMs": Int((Date().timeIntervalSince(started) * 1000).rounded()),
            "commit": build.commit ?? NSNull(),
            "launchedBy": ["pid": parent, "path": Probe.parentPath(parent) ?? NSNull(),
                           "grantIsFor": parent == 1 ? "this app (started by launchd)" : "the launching process, not this app: run ./build.sh tabs"] as [String: Any],
        ]
        switch reading {
        case .urls(let urls):
            report["result"] = "urls"
            report["tabCount"] = urls.count
            report["meetingCodes"] = MeetLink.meetingCodes(in: urls)
            report["meetTabs"] = Array(Set(urls.compactMap(MeetLink.shape(of:)))).sorted()
        case .arcNotRunning:
            report["result"] = "arcNotRunning"
        case .failed(let why):
            report["result"] = "failed"
            report["error"] = why
        }
        if case .urls = reading { report["windows"] = windowReport(codes: reading.meetingCodes ?? []) }
        guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else {
            FileHandle.standardError.write(Data("arc-tabs: could not encode the report\n".utf8))
            return 1
        }
        FileHandle.standardOutput.write(data + Data("\n".utf8))
        if case .failed = reading { return 1 }
        return 0
    }

    private static func windowReport(codes: [String]) -> [String: Any] {
        let reading = ArcTabReader().readWindowsNow()
        let listed = ScreenSource.windowList()
        let arc = Set(NSRunningApplication.runningApplications(withBundleIdentifier: ArcBrowser.bundleID).map(\.processIdentifier))
        var report: [String: Any] = [
            "screenRecordingAllowed": ScreenSource.allowed,
            "listedArcWindows": CallWindow.ordinary(listed, arcPIDs: arc).count,
            "titledArcWindows": CallWindow.ordinary(listed, arcPIDs: arc).filter { !$0.title.isEmpty }.count,
        ]
        switch reading {
        case .windows(let windows):
            report["result"] = "windows"
            report["windowCount"] = windows.count
            report["matchedByTitle"] = CallWindow.matchedByTitle(reading, windows: listed, arcPIDs: arc) ?? NSNull()
        case .failed(let why):
            report["result"] = "failed"
            report["error"] = why
        }
        // One line per call: "window found", or why its display would be recorded instead.
        report["calls"] = codes.map { code -> String in
            switch CallWindow.find(code: code, reading: reading, windows: listed, arcPIDs: arc) {
            case .window: "window found"
            case .notFound(let why): why
            }
        }
        return report
    }
}
