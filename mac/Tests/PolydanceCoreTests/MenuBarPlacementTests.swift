// Whether the menu-bar icon is drawn, from the window list, and when the hidden-icon notice is due.
import Foundation
import PolydanceCore
import XCTest

final class MenuBarPlacementTests: XCTestCase {
    private let me: Int32 = 23524

    func testOnlyMenuBarStripsAtTheStatusLevelAreItems() {
        XCTAssertTrue(MenuBarPlacement.isItemWindow(layer: 25, height: 37))
        XCTAssertTrue(MenuBarPlacement.isItemWindow(layer: 25, height: 24))
        XCTAssertFalse(MenuBarPlacement.isItemWindow(layer: 25, height: 0))
        XCTAssertFalse(MenuBarPlacement.isItemWindow(layer: 25, height: 420), "the menu's own panel is not an item")
        XCTAssertFalse(MenuBarPlacement.isItemWindow(layer: 0, height: 37))
        XCTAssertFalse(MenuBarPlacement.isItemWindow(layer: 101, height: 37))
    }

    /// What Robin's MacBook Pro showed on 2026-11-05 at the first launch: fourteen items drawn right of the
    /// notch, and this app's (with Goose, Google Drive, Dropbox and Notion Calendar) off screen.
    func testHiddenWhenOthersAreDrawnAndOursIsNot() {
        var windows = (0..<14).map { MenuBarItemWindow(pid: 1000 + Int32($0), onScreen: true) }
        windows += [MenuBarItemWindow(pid: me, onScreen: false), MenuBarItemWindow(pid: 2001, onScreen: false)]
        XCTAssertEqual(MenuBarPlacement.state(of: me, in: windows), .hidden)
    }

    func testShownWhenAnyOfOursIsDrawn() {
        let windows = [MenuBarItemWindow(pid: me, onScreen: false), MenuBarItemWindow(pid: me, onScreen: true),
                       MenuBarItemWindow(pid: 1000, onScreen: true)]
        XCTAssertEqual(MenuBarPlacement.state(of: me, in: windows), .shown)
    }

    func testUnknownWithoutOurItemOrWithNothingDrawn() {
        XCTAssertEqual(MenuBarPlacement.state(of: me, in: []), .unknown)
        XCTAssertEqual(MenuBarPlacement.state(of: me, in: [MenuBarItemWindow(pid: 1000, onScreen: true)]), .unknown,
                       "the item is not made yet")
        // The menu bar auto-hidden, or a full-screen app: every item is off screen, ours included.
        let allOff = [MenuBarItemWindow(pid: me, onScreen: false), MenuBarItemWindow(pid: 1000, onScreen: false)]
        XCTAssertEqual(MenuBarPlacement.state(of: me, in: allOff), .unknown)
    }

    func testHiddenOnlyAfterTwoReadingsInARowAndNotifiedOnce() {
        var watch = MenuBarWatch()
        XCTAssertNil(watch.observe(.hidden), "one reading may be the menu bar settling")
        XCTAssertNil(watch.observe(.shown))
        XCTAssertNil(watch.observe(.hidden), "the count starts again after a shown reading")
        XCTAssertEqual(watch.observe(.hidden), .becameHidden(notify: true))
        XCTAssertTrue(watch.hidden)
        XCTAssertNil(watch.observe(.hidden), "said once")
        XCTAssertNil(watch.observe(.unknown), "an auto-hidden menu bar changes nothing")
        XCTAssertTrue(watch.hidden)
        XCTAssertEqual(watch.observe(.shown), .becameShown)
        XCTAssertFalse(watch.hidden)
        XCTAssertNil(watch.observe(.hidden))
        XCTAssertEqual(watch.observe(.hidden), .becameHidden(notify: false), "hidden again, but the notice was already posted")
    }

    func testUnknownReadingsDoNotCountTowardsHidden() {
        var watch = MenuBarWatch()
        XCTAssertNil(watch.observe(.hidden))
        XCTAssertNil(watch.observe(.unknown))
        XCTAssertEqual(watch.observe(.hidden), .becameHidden(notify: true), "unknown neither breaks nor adds to the run")
    }
}
