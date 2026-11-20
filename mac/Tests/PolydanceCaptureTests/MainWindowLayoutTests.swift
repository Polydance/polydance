// The main window laid out for real, in a window on this Mac, with an empty library in a temporary folder.
// It proves the window found on 2026-11-05: with the hidden-icon banner showing, wrapping text that asked
// for its full height at the split view's narrowest made the content 3,795 points tall in an 800-point
// window, centred, so the sidebar, the banner and Settings were all off screen and the window looked empty.
// And it proves the column opens at its usual width (2026-11-07: the split view it replaced opened it at its
// minimum, and a thread's title was cut after a dozen letters), and that with the title bar hidden as the app
// hides it, the column's folder tabs start just under the traffic lights' row, not below a strip of bare wood.
import AppKit
import PolydanceCore
import SwiftUI
import XCTest
@testable import PolydanceCapture

@MainActor
final class MainWindowLayoutTests: XCTestCase {
    private var window: NSWindow?

    override func tearDown() {
        window?.orderOut(nil)
        window = nil
        super.tearDown()
    }

    private func host() throws -> (AppModel, NSWindow) {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("polydance-window-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let suite = "polydance-window-\(UUID().uuidString)"
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: suite) }
        // The column's width is kept in the standard defaults; a test starts from none.
        UserDefaults.standard.removeObject(forKey: "mainWindow.columnWidth")
        let model = AppModel(settings: SettingsStore(defaults: UserDefaults(suiteName: suite)!), environment: ["POLYCAP_ROOT": root.path])
        let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 1240, height: 800),
                              styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        // What .windowStyle(.hiddenTitleBar) asks of the window.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.contentView = NSHostingView(rootView: MainWindow(model: model))
        self.window = window
        return (model, window)
    }

    private func settle() { RunLoop.main.run(until: Date().addingTimeInterval(1.5)) }

    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }

    /// The column's list lies inside the window at the column's usual width, and starts at its top.
    private func assertFits(_ window: NSWindow, file: StaticString = #filePath, line: UInt = #line) {
        let content = window.contentView!
        let lists = views(content).compactMap { $0 as? NSTableView }
        XCTAssertEqual(lists.count, 1, file: file, line: line)
        guard let list = lists.first, let scroll = list.enclosingScrollView else { return XCTFail("no list", file: file, line: line) }
        let frame = scroll.convert(scroll.bounds, to: content)
        XCTAssertTrue(content.bounds.insetBy(dx: -1, dy: -1).contains(frame), "the column runs outside the window: \(frame)", file: file, line: line)
        // The column less its padding on the wood.
        XCTAssertEqual(frame.width, Sidebar.width.ideal - 10, accuracy: 1, "the column is not at its usual width", file: file, line: line)
        // The traffic lights show, and the column's panel starts just under their row.
        let chrome = WindowChrome.read(window)
        XCTAssertTrue(chrome.showsButtons, "the traffic lights are not shown", file: file, line: line)
        // The hosting view counts from the top.
        let top = content.isFlipped ? frame.minY : content.bounds.height - frame.maxY
        // Between them, only the Calls and Threads folder tabs (8 points of wood and a 32-point tab, 2026-11-16).
        XCTAssertGreaterThanOrEqual(top, chrome.buttonsMidY * 2 + 32, "the column's panel runs into the traffic lights' row or its tabs", file: file, line: line)
        XCTAssertLessThanOrEqual(top, chrome.buttonsMidY * 2 + 40 + 12, "bare wood above the column's tabs", file: file, line: line)
        XCTAssertGreaterThan(list.numberOfRows, 0, "the sidebar has no rows", file: file, line: line)
        XCTAssertEqual(list.visibleRect.minY, 0, "the sidebar's first rows are scrolled out of sight", file: file, line: line)
    }

    func testTheColumnStaysWithinItsWidths() {
        XCTAssertEqual(Sidebar.clamp(100), Sidebar.width.min)
        XCTAssertEqual(Sidebar.clamp(400), 400)
        XCTAssertEqual(Sidebar.clamp(5_000), Sidebar.width.max)
        XCTAssertGreaterThanOrEqual(Sidebar.width.min, 320, "narrower cuts a thread's title after a dozen letters")
    }

    func testTheWindowFitsWithoutTheBanner() throws {
        let (_, window) = try host()
        window.orderFront(nil)
        settle()
        assertFits(window)
    }

    func testTheWindowFitsWithTheHiddenIconBanner() throws {
        let (model, window) = try host()
        model.menuBarRead(.hidden)
        model.menuBarRead(.hidden)
        XCTAssertTrue(model.menuBarIconHidden)
        window.orderFront(nil)
        settle()
        assertFits(window)
    }

    func testTheBannerComingAndGoingWhileOpenKeepsTheWindowFitting() throws {
        let (model, window) = try host()
        window.orderFront(nil)
        settle()
        model.menuBarRead(.hidden)
        model.menuBarRead(.hidden)
        settle()
        assertFits(window)
        model.menuBarRead(.shown)
        settle()
        assertFits(window)
    }
}
