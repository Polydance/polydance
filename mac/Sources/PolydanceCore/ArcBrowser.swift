// Which of Core Audio's processes are Arc, and what they are doing with sound. The app reads the
// process list (kAudioHardwarePropertyProcessObjectList, readable with no permission: docs/MAC.md D7)
// and hands the snapshot here, so the rule "Arc is using the mic" is one tested line.

/// One entry of Core Audio's process list, as read by the app.
public struct AudioProcessInfo: Sendable, Equatable, Codable {
    /// The process's Core Audio object, which a process tap is built from.
    public var objectID: UInt32
    public var pid: Int32
    public var bundleID: String?
    public var isRunningInput: Bool
    public var isRunningOutput: Bool

    public init(objectID: UInt32, pid: Int32, bundleID: String?, isRunningInput: Bool, isRunningOutput: Bool) {
        self.objectID = objectID
        self.pid = pid
        self.bundleID = bundleID
        self.isRunningInput = isRunningInput
        self.isRunningOutput = isRunningOutput
    }
}

public enum ArcBrowser {
    /// The main app, which owns the windows and answers Apple Events.
    public static let bundleID = "company.thebrowser.Browser"
    /// Arc's helpers are company.thebrowser.browser.helper (lower case); its audio service is one of them.
    public static let bundlePrefix = "company.thebrowser"
    /// The name the metadata uses (`call.browser`).
    public static let metaName = "arc"

    public static func isArc(_ process: AudioProcessInfo) -> Bool {
        process.bundleID?.hasPrefix(bundlePrefix) ?? false
    }

    public static func processes(in list: [AudioProcessInfo]) -> [AudioProcessInfo] {
        list.filter(isArc)
    }

    /// Arc holds the microphone when any of its processes is running input (D2's first signal).
    public static func usingMicrophone(_ list: [AudioProcessInfo]) -> Bool {
        list.contains { isArc($0) && $0.isRunningInput }
    }

    /// Arc is playing sound: the condition under which a silent tap means a refused grant (C12).
    public static func playingSound(_ list: [AudioProcessInfo]) -> Bool {
        list.contains { isArc($0) && $0.isRunningOutput }
    }

    /// The Core Audio objects a call's tap mixes: every Arc process, since Chromium's audio service
    /// serves every tab and which helper it is can change between launches (C10).
    public static func tapTargets(_ list: [AudioProcessInfo]) -> [UInt32] {
        processes(in: list).map(\.objectID)
    }
}
