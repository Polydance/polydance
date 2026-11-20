// Where the main window's title bar sits over the cabinet. The window has no title bar of its own to draw
// (PolydanceApp's hidden title bar), so the cabinet runs to the top edge and the traffic lights sit on the
// wood; the column's header shares their row, beside them, rather than leaving a strip of bare wood above
// it (Robin, 2026-11-07). Read from the window, not assumed: the buttons' place differs between window
// styles and macOS versions. Each reading is logged once, so the real window's layout can be checked with
// `/usr/bin/log show --predicate 'subsystem == "net.polydance.capture.mac"'`.
import AppKit
import os
import SwiftUI

/// The title bar's row as the cabinet sees it, in points from the window's top-left corner.
struct WindowChrome: Equatable {
    /// The height of the title bar's strip (0 in full screen, or with no title bar).
    var barHeight: CGFloat = 0
    /// Where the traffic lights end, from the window's left edge; 0 when they are not shown.
    var buttonsTrailing: CGFloat = 0
    /// The middle of the traffic lights' row, from the window's top; 0 when they are not shown.
    var buttonsMidY: CGFloat = 0

    var showsButtons: Bool { buttonsTrailing > 0 }

    @MainActor
    static func read(_ window: NSWindow) -> WindowChrome {
        guard let content = window.contentView else { return WindowChrome() }
        let height = content.bounds.height
        var chrome = WindowChrome()
        if !window.styleMask.contains(.fullScreen) {
            chrome.barHeight = max(0, height - window.contentLayoutRect.maxY)
        }
        if let zoom = window.standardWindowButton(.zoomButton), !zoom.isHiddenOrHasHiddenAncestor, zoom.window === window,
           !window.styleMask.contains(.fullScreen) {
            let frame = zoom.convert(zoom.bounds, to: nil)
            chrome.buttonsTrailing = frame.maxX
            chrome.buttonsMidY = height - frame.midY
        }
        return chrome
    }
}

/// Reads the hosting window's chrome when the view joins a window and whenever it resizes or changes full
/// screen, and hands it to the layout.
struct WindowChromeReader: NSViewRepresentable {
    @Binding var chrome: WindowChrome

    func makeNSView(context: Context) -> ChromeView {
        let view = ChromeView()
        view.report = { chrome = $0 }
        return view
    }

    func updateNSView(_ view: ChromeView, context: Context) {
        view.report = { chrome = $0 }
    }

    final class ChromeView: NSView {
        var report: (WindowChrome) -> Void = { _ in }
        private var observers: [NSObjectProtocol] = []
        private var logged: WindowChrome?
        private static let log = Logger(subsystem: "net.polydance.capture.mac", category: "window")

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { return }
            for name in [NSWindow.didResizeNotification, NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.read() }
                })
            }
            // The title bar is laid out after the content joins the window.
            DispatchQueue.main.async { [weak self] in self?.read() }
        }

        private func read() {
            guard let window else { return }
            let chrome = WindowChrome.read(window)
            report(chrome)
            guard chrome != logged else { return }
            logged = chrome
            let close = window.standardWindowButton(.closeButton)
            let line = "main window \(Int(window.frame.width))x\(Int(window.frame.height)): title bar \(chrome.barHeight) pt, "
                + "buttons \(chrome.showsButtons ? "shown, ending at \(chrome.buttonsTrailing) pt, middle at \(chrome.buttonsMidY) pt" : "not shown") "
                + "(close button \(close == nil ? "missing" : close!.isHiddenOrHasHiddenAncestor ? "hidden" : "visible")), "
                + "toolbar \(window.toolbar == nil ? "none" : window.toolbar!.isVisible ? "visible" : "hidden"), "
                + "full screen \(window.styleMask.contains(.fullScreen))"
            Self.log.notice("\(line, privacy: .public)")
        }
    }
}
