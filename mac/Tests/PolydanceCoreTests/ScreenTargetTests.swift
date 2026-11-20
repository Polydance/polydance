// Choosing what a walkthrough records by pointing at it (2026-11-16): which display or window is under the
// pointer, in CoreGraphics' global coordinates, and the choice remembered in the settings.
import CoreGraphics
import Foundation
import XCTest
@testable import PolydanceCore

final class ScreenTargetTests: XCTestCase {
    // This Mac's two: a 2560-wide monitor above-left of the built-in display.
    let displays = [DisplayChoice.Display(id: 2, frame: CGRect(x: -1048, y: -1440, width: 2560, height: 1440)),
                    DisplayChoice.Display(id: 1, frame: CGRect(x: 0, y: 0, width: 1512, height: 982))]
    let names: [UInt32: String] = [1: "Built-in Retina Display", 2: "U28E590"]
    let windows = [
        ScreenPick.Window(id: 900, frame: CGRect(x: 0, y: 0, width: 1512, height: 24), pid: 50, app: "Menu Bar", title: "", layer: 24),
        ScreenPick.Window(id: 10, frame: CGRect(x: 100, y: 100, width: 600, height: 400), pid: 77, app: "Arc", title: "Kitchen Timer"),
        ScreenPick.Window(id: 11, frame: CGRect(x: 300, y: 200, width: 800, height: 500), pid: 78, app: "Mail", title: "Inbox"),
        ScreenPick.Window(id: 12, frame: CGRect(x: 400, y: 300, width: 600, height: 400), pid: 1, app: "Polydance", title: "Polydance"),
        ScreenPick.Window(id: 13, frame: CGRect(x: 1200, y: 600, width: 60, height: 40), pid: 79, app: "Notes", title: "tiny"),
    ]

    func testTheDisplayUnderThePointer() {
        XCTAssertEqual(ScreenPick.display(at: CGPoint(x: 500, y: 500), in: displays)?.id, 1)
        XCTAssertEqual(ScreenPick.display(at: CGPoint(x: -500, y: -500), in: displays)?.id, 2)
        XCTAssertEqual(ScreenPick.display(at: CGPoint(x: 1600, y: 500), in: displays)?.id, 1, "off every display: the nearest")
        XCTAssertEqual(ScreenPick.target(at: CGPoint(x: -500, y: -500), windowMode: false, displays: displays, names: names, windows: windows, ownPID: 1),
                       .display(id: 2, name: "U28E590"))
    }

    func testTheFrontmostOrdinaryWindowUnderThePointerNotOurs() {
        let at = { (x: CGFloat, y: CGFloat) in ScreenPick.target(at: CGPoint(x: x, y: y), windowMode: true, displays: self.displays, names: self.names, windows: self.windows, ownPID: 1) }
        XCTAssertEqual(at(150, 150), .window(id: 10, title: "Kitchen Timer", app: "Arc"))
        XCTAssertEqual(at(350, 250), .window(id: 10, title: "Kitchen Timer", app: "Arc"), "front to back: Arc is over Mail")
        XCTAssertEqual(at(900, 350), .window(id: 11, title: "Inbox", app: "Mail"), "Polydance's own window is passed over")
        XCTAssertEqual(at(10, 10), nil, "the menu bar is not a window to record")
        XCTAssertEqual(at(1220, 620), nil, "a sliver is not a window to record")
        XCTAssertEqual(at(1400, 900), nil, "the desktop: nothing in Window mode")
    }

    func testWhatTheCardSays() {
        XCTAssertEqual(ScreenTarget.display(id: 2, name: "U28E590").label, "U28E590")
        XCTAssertEqual(ScreenTarget.window(id: 10, title: "Kitchen Timer", app: "Arc").label, "Kitchen Timer, in Arc")
        XCTAssertEqual(ScreenTarget.window(id: 10, title: "", app: "Arc").label, "a window of Arc", "no title without the screen permission")
        XCTAssertTrue(ScreenTarget.window(id: 10, title: "", app: "Arc").isWindow)
    }

    func testTheLastChoiceIsRemembered() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "polydance-screen-\(UUID().uuidString)"))
        let settings = SettingsStore(defaults: defaults)
        XCTAssertNil(settings.walkthroughScreen)
        settings.walkthroughScreen = .window(id: 10, title: "Kitchen Timer", app: "Arc")
        XCTAssertEqual(SettingsStore(defaults: defaults).walkthroughScreen, .window(id: 10, title: "Kitchen Timer", app: "Arc"))
        settings.walkthroughScreen = nil
        XCTAssertNil(settings.walkthroughScreen)
        defaults.set(Data("not json".utf8), forKey: SettingsStore.Key.walkthroughScreen)
        XCTAssertNil(settings.walkthroughScreen, "something unreadable is no choice, never a guess")
    }
}
