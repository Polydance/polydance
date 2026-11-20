// Whether the menu-bar icon can be seen (C5). When the menu bar is full, on a MacBook with a notch above
// all, macOS hides the icons that do not fit and tells the app nothing: the item exists, its window is
// simply off screen. The window list says so (kCGWindowIsOnscreen), with no permission, so the app reads
// it and says when the icon is hidden, because then nothing on screen shows that a call is recording.
import Foundation

/// One menu-bar item's window from the window list: whose it is and whether it is on screen.
public struct MenuBarItemWindow: Equatable, Sendable {
    public let pid: Int32
    public let onScreen: Bool

    public init(pid: Int32, onScreen: Bool) {
        self.pid = pid
        self.onScreen = onScreen
    }
}

public enum MenuBarIconState: Equatable, Sendable {
    case shown
    /// The item exists but macOS is not drawing it, while other apps' items are drawn: no room.
    case hidden
    /// The item does not exist yet, or no item at all is on screen (the menu bar auto-hidden, or a
    /// full-screen app in front), so there is nothing to say.
    case unknown
}

public enum MenuBarPlacement {
    /// The window list's level for menu-bar items (kCGStatusWindowLevel).
    public static let statusWindowLevel = 25
    /// A menu-bar item is a strip at most the menu bar's height; anything taller at that level is not one.
    public static let maxItemHeight: Double = 50

    public static func isItemWindow(layer: Int, height: Double) -> Bool {
        layer == statusWindowLevel && height > 0 && height <= maxItemHeight
    }

    public static func state(of pid: Int32, in windows: [MenuBarItemWindow]) -> MenuBarIconState {
        let own = windows.filter { $0.pid == pid }
        guard !own.isEmpty else { return .unknown }
        if own.contains(where: \.onScreen) { return .shown }
        return windows.contains { $0.pid != pid && $0.onScreen } ? .hidden : .unknown
    }
}

/// Readings over time: the icon counts as hidden after `needed` hidden readings in a row (the menu bar
/// settles after launch), and the notice is due once per run of the app, however often it comes and goes.
public struct MenuBarWatch: Equatable, Sendable {
    public enum Change: Equatable, Sendable {
        case becameHidden(notify: Bool)
        case becameShown
    }

    public private(set) var hidden = false
    public private(set) var notified = false
    private var hiddenReadings = 0
    private let needed: Int

    public init(needed: Int = 2) {
        self.needed = max(1, needed)
    }

    /// Unknown readings change nothing: an auto-hidden menu bar neither hides nor shows the icon.
    public mutating func observe(_ state: MenuBarIconState) -> Change? {
        switch state {
        case .unknown:
            return nil
        case .shown:
            hiddenReadings = 0
            guard hidden else { return nil }
            hidden = false
            return .becameShown
        case .hidden:
            hiddenReadings += 1
            guard !hidden, hiddenReadings >= needed else { return nil }
            hidden = true
            let notify = !notified
            notified = true
            return .becameHidden(notify: notify)
        }
    }
}
