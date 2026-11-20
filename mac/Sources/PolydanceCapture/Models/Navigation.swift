// Where the windows are: what the main window shows, its column's tab and the plate over it, the menu's
// tab, and the Dock. The app is a
// menu-bar app with no Dock icon (LSUIElement); while the main window or the settings is open it takes a
// Dock icon and a menu bar of its own, so the window can be found with ⌘-Tab, and gives them up when
// the last of them closes.
import AppKit
import SwiftUI

enum MainSelection: Hashable {
    case call(String)
    case thread(String)
}

/// The menu's tab, and the main window's folder tab over its column.
enum MenuTab: Hashable {
    case calls
    case threads
}

/// A cream plate over the main window (Robin's pick D, 2026-11-16): New thread, or the bug key's report.
enum WindowPlate: Hashable {
    case newThread
    case report
}

enum WindowID {
    static let main = "main"
}

@MainActor
enum DockPresence {
    private static var open = 0

    static func windowAppeared() {
        open += 1
        if open == 1 { NSApp.setActivationPolicy(.regular) }
        NSApp.activate()
    }

    static func windowDisappeared() {
        open = max(0, open - 1)
        if open == 0 { NSApp.setActivationPolicy(.accessory) }
    }
}

/// Opening the windows from anywhere: the actions SwiftUI gives views, with the app brought forward
/// first (a menu-bar app is not active when its menu is used).
struct WindowOpeners: ViewModifier {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    func body(content: Content) -> some View {
        content.onAppear {
            let openWindow = self.openWindow
            let openSettings = self.openSettings
            model.openMainWindow = {
                NSApp.activate()
                openWindow(id: WindowID.main)
            }
            model.openSettings = {
                NSApp.activate()
                openSettings()
            }
        }
    }
}

extension View {
    func installsWindowOpeners(_ model: AppModel) -> some View { modifier(WindowOpeners(model: model)) }
}
