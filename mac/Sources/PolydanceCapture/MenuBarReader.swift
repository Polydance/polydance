// Reads the window list for menu-bar items (MenuBarPlacement decides what it means). Bounds, owner and
// on-screen state need no permission; names, which would, are not read. One read walks every window on
// the Mac (about 8 ms for 212 on Robin's MacBook Pro), so it runs off the main thread.
import CoreGraphics
import Foundation
import PolydanceCore

enum MenuBarReader {
    static func iconState(pid: Int32 = ProcessInfo.processInfo.processIdentifier) -> MenuBarIconState {
        guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return .unknown }
        let items = list.compactMap { window -> MenuBarItemWindow? in
            guard let owner = window[kCGWindowOwnerPID as String] as? Int32,
                  let layer = window[kCGWindowLayer as String] as? Int,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let height = (bounds["Height"] as? NSNumber)?.doubleValue,
                  MenuBarPlacement.isItemWindow(layer: layer, height: height) else { return nil }
            return MenuBarItemWindow(pid: owner, onScreen: (window[kCGWindowIsOnscreen as String] as? Bool) ?? false)
        }
        return MenuBarPlacement.state(of: pid, in: items)
    }
}
