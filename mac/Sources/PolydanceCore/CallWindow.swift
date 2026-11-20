// Which window a call records (Robin, 2026-11-17: "only record the browser window with the call on"; from
// C3's decision of 2026-11-05 until then a call recorded the whole display Arc was on). Arc says over Apple
// Events which of its windows shows the Meet tab as its active tab, and that window's title; macOS's window
// list says each window's number and title. The one Arc window with that title is recorded alone, as a
// walkthrough records a window it was pointed at. When it cannot be told, the call records the display as
// before, and says why. This file owns the script, its parsing and the match; it is pure, so the match is
// tested without Arc or a screen.
//
// Titles are what tie the two together: Arc's dictionary gives a window an id of its own, a title and a
// front-to-back index, but no bounds and no window number (Arc.sdef, Arc 1.171.0, read 2026-11-17). The
// window list gives titles only while screen recording is allowed, which a window's capture needs anyway.
import CoreGraphics
import Foundation

public enum CallWindow {
    /// One of Arc's windows as its script gives it.
    public struct ArcWindow: Sendable, Equatable {
        /// Front to back, from 1.
        public var index: Int
        /// The address of the tab the window shows.
        public var activeURL: String
        /// The window's title as Arc gives it, which is macOS's title for the window.
        public var title: String

        public init(index: Int, activeURL: String, title: String) {
            self.index = index
            self.activeURL = activeURL
            self.title = title
        }
    }

    /// What asking Arc for its windows gave.
    public enum Reading: Sendable, Equatable {
        case windows([ArcWindow])
        /// Arc did not answer (Automation refused, a timeout, a script error), with why.
        case failed(String)
    }

    public enum Finding: Sendable, Equatable {
        /// The call's window, to record alone.
        case window(ScreenTarget)
        /// Why it could not be told, for the recording's note; the display is recorded instead.
        case notFound(String)
    }

    /// What the script returns when Arc is not running, so it is never launched by being asked.
    public static let notRunningMarker = ArcTabsScript.notRunningMarker

    /// For each window, a line: its index, the address of its active tab and its title, split by tabs, with
    /// the title last so a tab inside one is kept. `tab` names Arc's tab class inside its `tell`, so the
    /// separator is made before it. Each window is read inside `try`, so one odd window does not lose the rest.
    public static let source = """
    if application id "\(ArcBrowser.bundleID)" is running then
        set sep to character id 9
        set found to {}
        with timeout of 3 seconds
            tell application id "\(ArcBrowser.bundleID)"
                repeat with w in windows
                    try
                        set found to found & (((index of w) as text) & sep & ((URL of active tab of w) as text) & sep & ((name of w) as text))
                    end try
                end repeat
            end tell
        end timeout
        set AppleScript's text item delimiters to linefeed
        set answer to found as text
        set AppleScript's text item delimiters to ""
        return answer
    else
        return "\(notRunningMarker)"
    end if
    """

    /// Arc's answer as windows; a line that is not index, address and title is passed over.
    public static func parse(_ output: String) -> Reading {
        if output.trimmingWhitespace() == notRunningMarker { return .windows([]) }
        var windows: [ArcWindow] = []
        for line in output.split(whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" }) {
            let fields = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            guard fields.count == 3, let index = Int(String(fields[0]).trimmingWhitespace()) else { continue }
            windows.append(ArcWindow(index: index, activeURL: String(fields[1]).trimmingWhitespace(), title: String(fields[2])))
        }
        return .windows(windows)
    }

    /// The window of Arc (`arcPIDs`) showing the call `code`, from Arc's `reading` and macOS's window list
    /// (`windows`, front to back). The frontmost Arc window whose active tab is on the call is the one; its
    /// title must name exactly one of Arc's ordinary windows in the list. Two with the same title (two windows
    /// on the call's tab title) are told apart by their order front to back, when both lists hold the same
    /// number of them; otherwise it is not guessed.
    public static func find(code: String, reading: Reading, windows: [ScreenPick.Window], arcPIDs: Set<Int32>) -> Finding {
        let arc: [ArcWindow]
        switch reading {
        case .failed(let why): return .notFound("Arc did not say which window has the call (\(why))")
        case .windows(let list): arc = list.sorted { $0.index < $1.index }
        }
        guard let showing = arc.first(where: { MeetLink.meetingCode(in: $0.activeURL) == code }) else {
            return .notFound(arc.isEmpty ? "Arc has no window" : "no Arc window shows the call's tab")
        }
        guard !showing.title.isEmpty else { return .notFound("Arc gave the call's window no title") }
        let listed = ordinary(windows, arcPIDs: arcPIDs).filter { $0.title == showing.title }
        if listed.count == 1 { return .window(listed[0].target) }
        if listed.isEmpty { return .notFound("macOS listed no Arc window with the call's title") }
        let named = arc.filter { $0.title == showing.title }
        guard named.count == listed.count, let place = named.firstIndex(of: showing) else {
            return .notFound("\(listed.count) Arc windows have the call's title")
        }
        return .window(listed[place].target)
    }

    /// Arc's ordinary windows in the list: not its menus, overlays or slivers.
    public static func ordinary(_ windows: [ScreenPick.Window], arcPIDs: Set<Int32>) -> [ScreenPick.Window] {
        windows.filter { arcPIDs.contains($0.pid) && $0.layer == 0 && $0.frame.width >= 120 && $0.frame.height >= 80 }
    }

    /// How many of Arc's windows (`reading`) name exactly one of its ordinary windows in the list by title:
    /// what `--arc-tabs` reports, so the match can be checked without a call. Nil when Arc did not answer.
    public static func matchedByTitle(_ reading: Reading, windows: [ScreenPick.Window], arcPIDs: Set<Int32>) -> Int? {
        guard case .windows(let arc) = reading else { return nil }
        let listed = ordinary(windows, arcPIDs: arcPIDs)
        return arc.filter { window in !window.title.isEmpty && listed.filter { $0.title == window.title }.count == 1 }.count
    }
}
