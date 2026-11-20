// What a walkthrough records, chosen by pointing at it before it starts (Robin, 2026-11-16, after his report
// that the Mac began recording with no way to tell or choose which screen): a whole display, or one window,
// as macOS's own screen recording (⇧⌘5) lets you choose. The overlay that asks lives in the app; what is
// under the pointer is decided here, from the displays' and windows' frames in CoreGraphics' global
// coordinates (origin at the top left of the main display, y down), so it is tested without a screen.
// Calls never ask: they record the window showing the call by themselves (CallWindow), else the display Arc is on.
import CoreGraphics
import Foundation

public enum ScreenTarget: Codable, Sendable, Equatable, Hashable {
    /// A display by its CoreGraphics id, and its name as macOS gives it ("Built-in Retina Display").
    case display(id: UInt32, name: String)
    /// One window by its window number, its title (empty without the screen permission) and its app's name.
    case window(id: UInt32, title: String, app: String)

    /// For the app's lines: "U28E590", "Kitchen Timer, in Arc", "a window of Arc".
    public var label: String {
        switch self {
        case .display(_, let name): name
        case .window(_, let title, let app): title.isEmpty ? "a window of \(app)" : "\(title), in \(app)"
        }
    }

    public var isWindow: Bool { if case .window = self { true } else { false } }
}

public enum ScreenPick {
    /// A window as the window list gives it: frontmost first.
    public struct Window: Sendable, Equatable {
        public var id: UInt32
        public var frame: CGRect
        public var pid: Int32
        public var app: String
        public var title: String
        /// 0 for an app's ordinary windows; menus, the Dock and overlays are on other layers.
        public var layer: Int

        public init(id: UInt32, frame: CGRect, pid: Int32, app: String, title: String, layer: Int = 0) {
            self.id = id
            self.frame = frame
            self.pid = pid
            self.app = app
            self.title = title
            self.layer = layer
        }

        public var target: ScreenTarget { .window(id: id, title: title, app: app) }
    }

    /// The display under `point`, else the nearest one (the pointer can sit on an edge between two).
    public static func display(at point: CGPoint, in displays: [DisplayChoice.Display]) -> DisplayChoice.Display? {
        if let holding = displays.first(where: { $0.frame.contains(point) }) { return holding }
        return displays.min { distance(point, $0.frame) < distance(point, $1.frame) }
    }

    /// The frontmost ordinary window under `point`, leaving out this app's own (the overlay itself) and
    /// slivers too small to be a window anyone means to record.
    public static func window(at point: CGPoint, in windows: [Window], ownPID: Int32) -> Window? {
        windows.first { $0.layer == 0 && $0.pid != ownPID && $0.frame.width >= 120 && $0.frame.height >= 80 && $0.frame.contains(point) }
    }

    /// What a click on the overlay records: the window under the pointer in Window mode (nothing when there
    /// is none), else the display under it.
    public static func target(at point: CGPoint, windowMode: Bool, displays: [DisplayChoice.Display], names: [UInt32: String],
                              windows: [Window], ownPID: Int32) -> ScreenTarget? {
        if windowMode { return window(at: point, in: windows, ownPID: ownPID)?.target }
        return display(at: point, in: displays).map { .display(id: $0.id, name: names[$0.id] ?? "Display") }
    }

    private static func distance(_ point: CGPoint, _ rect: CGRect) -> CGFloat {
        let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
        let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
        return dx * dx + dy * dy
    }
}
