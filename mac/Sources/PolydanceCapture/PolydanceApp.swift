// The app: a menu-bar extra (window style) over AppModel, with no Dock icon (LSUIElement); the main
// window "Polydance" (calls and threads), opened from the menu's Open Polydance, or by opening the app
// again (Spotlight, Finder, `open`) since a full menu bar can hide the icon, and never at launch; and the
// settings. Quitting while recording saves the recording first.
import AppKit
import SwiftUI

struct PolydanceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: delegate.model)
        } label: {
            MenuBarLabel(model: delegate.model)
        }
        .menuBarExtraStyle(.window)

        Window("Polydance", id: WindowID.main) {
            MainWindow(model: delegate.model)
        }
        // No title bar: the cabinet runs to the window's top edge, the traffic lights on the wood, as the
        // headset's panel has no chrome (Robin, 2026-11-06). The title still names the window in the Window
        // menu and Mission Control.
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1240, height: 800)
        .defaultLaunchBehavior(.suppressed)
        .restorationBehavior(.disabled)

        Settings {
            SettingsView(model: delegate.model)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        model.start()
    }

    /// Opening the app while it runs opens the main window: the way in when macOS hides the menu-bar icon.
    /// The openers come from the menu-bar label, which exists from launch even when it is not drawn.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard let open = model.openMainWindow else { return true }
        open()
        return false
    }

    /// Closing the main window leaves the menu-bar app running.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard model.phase == .recording else {
            model.prepareToQuit {}
            return .terminateNow
        }
        // The reply always comes after .terminateLater has been returned, never from inside this call.
        model.prepareToQuit { DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) } }
        return .terminateLater
    }
}
