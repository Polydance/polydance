// The screen (C2, C3): ScreenCaptureKit capture, at most 1920 wide, a few frames a second, cursor shown, of
// one window alone (its own frames, nothing around it, even where other windows cover it) or of a display
// less the apps the user lists and this app. A call records the Arc window showing it (CallWindow, Robin,
// 2026-11-17), else the display holding Arc's front window (else the main display); a walkthrough records
// what the person pointed at before it started (ScreenTarget, 2026-11-16). A window resized while recording
// is scaled to fill the picture, its shape kept. Only started when CGPreflightScreenCaptureAccess says
// capture is allowed, which never prompts; if it is not, or the stream fails, the recording goes on as
// audio only (C11).
//
// A content filter leaves out running applications, so an app on the list that opens during the call
// (Passwords, usually not running) would be recorded. The filter is therefore built from every app with a
// window, on screen or not (a hidden or minimised Mail too), and built again whenever an app launches,
// comes back from hidden, or the Space changes; between the launch and the update a frame or two may
// still show it. Which apps were really left out is kept (ExclusionRecord) for the metadata, and an
// update that failed is said. Not verified on hardware: a stream started without Passwords running,
// then Passwords opened, its frames looked at.
//
// The display and the picture's size are chosen first (`plan`) from CoreGraphics alone, which needs no
// permission and does not wait on replayd, so the recorder can make the picture track before the stream
// has started: a start held up by macOS's screen-recording prompt then fills the track late instead of
// losing it (2026-11-13: a call's stream started 5.9 s in, after the 5 s deadline, and was audio only).
//
// When macOS stops the stream (C14), the recorder may call `restart`: a new stream on the same display,
// at the same size, filter and frame rate, so its frames go on into the same track. Not yet tried in a
// live call: the restart is built from the 2026-11-11 stop's log, and its decision is tested without a screen.
import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import PolydanceCore
import ScreenCaptureKit

/// Unchecked Sendable: what tasks and the main queue share is behind `lock`.
final class ScreenSource: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    /// What is recorded: the display and the picture's size, fixed before the stream starts.
    struct Plan {
        var spec: AssetWriterSink.VideoSpec
        var displayID: CGDirectDisplayID
        /// One window instead of the display, when that was chosen.
        var windowID: CGWindowID?
        /// The captured display in points, for `call.display`.
        var pointSize: DisplaySize
        var displayName: String
    }

    var onFrame: ((CMSampleBuffer) -> Void)?
    /// The stream stopped by itself (a display unplugged, the permission withdrawn).
    var onStop: ((Error) -> Void)?

    private var stream: SCStream?
    private let queue = DispatchQueue(label: "net.polydance.capture.screen", qos: .userInitiated)
    private let lock = NSLock()
    private var record = ExclusionRecord(requested: [])
    private var problems: [String] = []
    private var displayID: CGDirectDisplayID?
    private var windowID: CGWindowID?
    /// The stream's size and rate, kept for a restart.
    private var spec: AssetWriterSink.VideoSpec?
    /// Set by `stop`: a restart that finishes afterwards stops its stream at once.
    private var ended = false
    private var observers: [NSObjectProtocol] = []

    static var allowed: Bool { CGPreflightScreenCaptureAccess() }

    /// The listed apps that were in the filter at some point, and the filter updates that failed.
    var exclusions: (apps: [String], problems: [String]) { locked { (record.excludedApps, problems) } }

    /// The source's state is touched from the stream's queue, the main queue and async tasks.
    private func locked<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    private var ownBundleID: String { Bundle.main.bundleIdentifier ?? RecordingMeta.appPackageID }

    /// The filter for `display` from `content`: the listed apps that have windows now, and this app.
    private func filter(_ display: SCDisplay, _ content: SCShareableContent) -> SCContentFilter {
        let ids = content.applications.map(\.bundleIdentifier)
        let listed = Set(locked { record.filter(running: ids) })
        let excluded = content.applications.filter { listed.contains($0.bundleIdentifier) || $0.bundleIdentifier == ownBundleID }
        return SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
    }

    /// What was chosen (`target`), else the display holding Arc's front window (else the main display), and
    /// the picture's size, from CoreGraphics: no permission is needed and nothing waits on replayd. A chosen
    /// display or window that is gone falls back to that. Nil with no display at all.
    static func plan(fps: Int, target: ScreenTarget? = nil) -> Plan? {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success, count > 0 else { return nil }
        let displays = ids.prefix(Int(count)).map { DisplayChoice.Display(id: $0, frame: CGDisplayBounds($0)) }
        if case .window(let id, _, _)? = target, let frame = windowFrame(id), frame.width >= 2, frame.height >= 2 {
            let holder = CGDisplayPrimaryDisplay(DisplayChoice.choose(windowBounds: frame, displays: displays, mainDisplay: CGMainDisplayID()))
            let scale = CGDisplayCopyDisplayMode(holder).map { $0.width > 0 ? Double($0.pixelWidth) / Double($0.width) : 1 } ?? 1
            let size = DisplayChoice.videoSize(pointWidth: Double(frame.width), pointHeight: Double(frame.height), scale: scale)
            return Plan(spec: AssetWriterSink.VideoSpec(width: size.width, height: size.height, fps: fps), displayID: holder, windowID: id,
                        pointSize: DisplaySize(width: max(1, Int(frame.width.rounded())), height: max(1, Int(frame.height.rounded()))),
                        displayName: target?.label ?? "a window")
        }
        var chosen: CGDirectDisplayID?
        if case .display(let id, _)? = target, displays.contains(where: { $0.id == id }) { chosen = id }
        // A mirror's own id is not one ScreenCaptureKit may list: the set's primary display is.
        let displayID = CGDisplayPrimaryDisplay(chosen ?? DisplayChoice.choose(windowBounds: arcFrontWindowBounds(), displays: displays, mainDisplay: CGMainDisplayID()))
        let bounds = CGDisplayBounds(displayID)
        // Pixels per point: 2 on a Retina display at any "looks like" resolution, as the stream's filter has it.
        let scale = CGDisplayCopyDisplayMode(displayID).map { $0.width > 0 ? Double($0.pixelWidth) / Double($0.width) : 1 } ?? 1
        let size = DisplayChoice.videoSize(pointWidth: Double(bounds.width), pointHeight: Double(bounds.height), scale: scale)
        return Plan(spec: AssetWriterSink.VideoSpec(width: size.width, height: size.height, fps: fps), displayID: displayID, windowID: nil,
                    pointSize: DisplaySize(width: max(1, Int(bounds.width.rounded())), height: max(1, Int(bounds.height.rounded()))),
                    displayName: name(of: displayID))
    }

    /// Starts capture of the planned display at the planned size, so its frames fit a track made for the
    /// plan before the stream started. Throws when it cannot, or when `stop` came first.
    func start(_ plan: Plan, excludedBundleIDs: [String]) async throws {
        locked {
            record = ExclusionRecord(requested: excludedBundleIDs)
            problems = []
            ended = false
            // Kept first, so a late start that fails can be tried again by `restart`.
            displayID = plan.displayID
            windowID = plan.windowID
            spec = plan.spec
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let stream = try await startStream(try filter(display: plan.displayID, window: plan.windowID, content), plan.spec)
        // A stop while macOS was still starting it (its prompt open) must not leave the stream running.
        let kept = locked { () -> Bool in
            guard !self.ended else { return false }
            self.stream = stream
            return true
        }
        guard kept else {
            try? await stream.stopCapture()
            throw CaptureError("the recording is stopping")
        }
        // One window has nothing around it to leave out.
        if plan.windowID == nil { await MainActor.run { self.watchApps() } }
    }

    /// One window's own frames, or the display less the listed apps and this one.
    private func filter(display displayID: CGDirectDisplayID, window windowID: CGWindowID?, _ content: SCShareableContent) throws -> SCContentFilter {
        if let windowID {
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else { throw CaptureError("the window to record is gone") }
            return SCContentFilter(desktopIndependentWindow: window)
        }
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw CaptureError("the display to record is gone") }
        return filter(display, content)
    }

    /// Starts capture again after macOS stopped it: the same display, the leave-out list as it is now, and
    /// the first stream's size, so the frames fit the track. Throws when it cannot (the display is gone,
    /// capture refused), for the recorder to try later or let go.
    func restart() async throws {
        let (displayID, windowID, spec, ended, running) = locked { (self.displayID, self.windowID, self.spec, self.ended, self.stream != nil) }
        guard !ended else { throw CaptureError("the recording is stopping") }
        guard !running else { return }
        guard let displayID, let spec else { throw CaptureError("the screen was never started") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let stream = try await startStream(try filter(display: displayID, window: windowID, content), spec)
        let kept = locked { () -> Bool in
            guard !self.ended else { return false }
            self.stream = stream
            return true
        }
        if !kept { try? await stream.stopCapture() }
    }

    private func startStream(_ filter: SCContentFilter, _ spec: AssetWriterSink.VideoSpec) async throws -> SCStream {
        let config = SCStreamConfiguration()
        config.width = spec.width
        config.height = spec.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(spec.fps, 1)))
        config.showsCursor = true
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.queueDepth = 6
        config.capturesAudio = false
        config.captureMicrophone = false
        // A window's stream only scales down by default: one made smaller would sit small in a corner.
        config.scalesToFit = locked { windowID != nil }

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        return stream
    }

    /// Launches, unhides and Space changes: the filter is built again from what is running now.
    @MainActor private func watchApps() {
        let center = NSWorkspace.shared.notificationCenter
        let names = [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didUnhideApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification]
        let added = names.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { await self?.updateFilter() }
            }
        }
        locked { observers = added }
    }

    private func updateFilter() async {
        let (stream, displayID, windowID) = locked { (self.stream, self.displayID, self.windowID) }
        guard let stream, let displayID, windowID == nil else { return }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw CaptureError("the recorded display is gone") }
            try await stream.updateContentFilter(filter(display, content))
        } catch {
            locked { if problems.count < 3 { problems.append("the apps to leave out could not be updated: \(error.localizedDescription)") } }
        }
    }

    func stop() async {
        let (observers, stream) = locked { () -> ([NSObjectProtocol], SCStream?) in
            defer { self.observers = []; self.stream = nil; self.ended = true }
            return (self.observers, self.stream)
        }
        await MainActor.run { observers.forEach(NSWorkspace.shared.notificationCenter.removeObserver) }
        try? await stream?.stopCapture()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
        // Only complete frames carry a new picture; idle (nothing changed), blank, suspended, started
        // and stopped frames are skipped, and the recorder repeats the last picture through still spells.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        onFrame?(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let current = locked { () -> Bool in
            guard self.stream === stream else { return false }
            self.stream = nil
            return true
        }
        // A stream already replaced or let go says nothing about the one running now.
        if current { onStop?(error) }
    }

    /// Arc's frontmost normal window, from the window list (front to back). Bounds are readable without
    /// the screen permission; titles are not, and are not needed.
    static func arcFrontWindowBounds() -> CGRect? {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: ArcBrowser.bundleID).map(\.processIdentifier))
        guard !pids.isEmpty, let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for window in windows {
            guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
                  (window[kCGWindowLayer as String] as? Int) == 0,
                  let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict), bounds.width > 200, bounds.height > 150 else { continue }
            return bounds
        }
        return nil
    }

    /// Every window macOS lists on screen, front to back, with its title while screen recording is allowed.
    static func windowList() -> [ScreenPick.Window] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { info in
            guard let number = info[kCGWindowNumber as String] as? UInt32, let pid = info[kCGWindowOwnerPID as String] as? Int32,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: bounds) else { return nil }
            return ScreenPick.Window(id: number, frame: frame, pid: pid, app: info[kCGWindowOwnerName as String] as? String ?? "an app",
                                     title: info[kCGWindowName as String] as? String ?? "", layer: info[kCGWindowLayer as String] as? Int ?? 0)
        }
    }

    /// The display's name as macOS gives it ("Built-in Retina Display", "U28E590"), else its place in the list.
    static func name(of displayID: CGDirectDisplayID) -> String {
        let screens = NSScreen.screens
        let index = screens.firstIndex { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID }
        return index.map { screens[$0].localizedName.isEmpty ? "Display \($0 + 1)" : screens[$0].localizedName } ?? "Display"
    }

    /// A window's frame in global coordinates, while it is on screen; nil when it is gone.
    static func windowFrame(_ id: CGWindowID) -> CGRect? {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let bounds = info.first?[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: bounds)
    }
}
