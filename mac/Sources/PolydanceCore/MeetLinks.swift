// D2's second signal: one of Arc's tabs is on a Meet meeting code. This file owns the meeting-code
// rule, the AppleScript the app sends Arc (kept here so its guards are visible and tested), and the
// parsing of what Arc answers. A Meet link opened to look at it is not a call on its own; the
// detector also needs Arc to hold the microphone.

public enum MeetLink {
    static let prefix = "https://meet.google.com/"
    /// Meet answers `meet.google.com/abc-defg-hij` with a redirect to `meet.google.com/meet/abc-defg-hij`,
    /// and the tab stays there for the whole call (Arc's history on Robin's Mac, 2026-11-04 and 2026-11-06:
    /// the first real call was missed because only the short form was read).
    static let callPath = "meet/"

    /// `abc-defg-hij`: lower-case ASCII letters in groups of 3, 4 and 3.
    public static func isMeetingCode(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 12 else { return false }
        for (index, byte) in bytes.enumerated() {
            if index == 3 || index == 8 {
                if byte != UInt8(ascii: "-") { return false }
            } else if !(UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) {
                return false
            }
        }
        return true
    }

    /// The code in a tab's address, by the rule
    /// `^https://meet\.google\.com/(?:meet/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$`.
    /// Meet's landing page, a lookup link and anything not on https are not calls.
    public static func meetingCode(in url: String) -> String? {
        let bytes = Array(url.utf8)
        var head = Array(prefix.utf8)
        guard bytes.starts(with: head) else { return nil }
        if bytes[head.count...].starts(with: Array(callPath.utf8)) { head += Array(callPath.utf8) }
        guard bytes.count >= head.count + 12 else { return nil }
        let code = String(decoding: bytes[head.count..<head.count + 12], as: UTF8.self)
        guard isMeetingCode(code) else { return nil }
        let after = bytes[(head.count + 12)...]
        guard let next = after.first else { return code }
        guard next == UInt8(ascii: "/") || next == UInt8(ascii: "?") || next == UInt8(ascii: "#") else { return nil }
        // `.` in the rule does not match a line break; an address never holds one, but say so.
        return after.contains(UInt8(ascii: "\n")) || after.contains(UInt8(ascii: "\r")) ? nil : code
    }

    /// A Meet tab's address with its codes, query and fragment left out (`https://meet.google.com/meet/<code>`),
    /// for the tab check's report: which form Meet used, and nothing of any other site. Nil off Meet.
    public static func shape(of url: String) -> String? {
        guard url.hasPrefix(prefix) else { return nil }
        let path = url.dropFirst(prefix.count).prefix { $0 != "?" && $0 != "#" }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map { isMeetingCode(String($0)) ? "<code>" : String($0) }
        return prefix + parts.joined(separator: "/")
    }

    /// Every distinct code across the tabs, in the order Arc listed them (front window first).
    public static func meetingCodes(in urls: [String]) -> [String] {
        var seen = Set<String>()
        var codes: [String] = []
        for url in urls {
            if let code = meetingCode(in: url), seen.insert(code).inserted { codes.append(code) }
        }
        return codes
    }
}

/// What asking Arc for its tabs gave.
public enum TabReading: Sendable, Equatable {
    /// The addresses of every tab of every window and of every space of every window.
    case urls([String])
    /// Arc was not running, so it was not asked (and not launched).
    case arcNotRunning
    /// Arc did not answer: Automation refused, a timeout, or a script error. The detector treats this
    /// as "not known", never as "no call".
    case failed(String)

    /// The meeting codes the detector sees: nil when the tabs are not known.
    public var meetingCodes: [String]? {
        switch self {
        case .urls(let urls): MeetLink.meetingCodes(in: urls)
        case .arcNotRunning: []
        case .failed: nil
        }
    }
}

public enum ArcTabsScript {
    /// What the script returns when Arc is not running, so it is never launched by being asked.
    public static let notRunningMarker = "__POLYDANCE_ARC_NOT_RUNNING__"

    /// The AppleScript the app runs through NSAppleScript. `application id … is running` does not
    /// launch Arc, and the app also checks NSRunningApplication first. Each window's tabs and each of
    /// its spaces' tabs are read separately, inside `try`, so one odd window or space does not lose the
    /// rest; the union is returned one address per line. Arc's terms (window, space, tab, URL) are from
    /// its Arc.sdef (Arc 1.171.0, 2026-11-05).
    public static let source = """
    if application id "\(ArcBrowser.bundleID)" is running then
        set found to {}
        with timeout of 3 seconds
            tell application id "\(ArcBrowser.bundleID)"
                repeat with w in windows
                    try
                        set found to found & (URL of every tab of w)
                    end try
                    try
                        repeat with s in spaces of w
                            try
                                set found to found & (URL of every tab of s)
                            end try
                        end repeat
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

    /// Arc's answer as addresses: one per line, trimmed, without blanks, AppleScript's `missing value`
    /// for a tab with no address, or repeats (a tab is listed by its window and by its space).
    public static func parse(_ output: String) -> TabReading {
        let trimmedAll = output.trimmingWhitespace()
        if trimmedAll == notRunningMarker { return .arcNotRunning }
        var seen = Set<String>()
        var urls: [String] = []
        for line in output.split(whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" }) {
            let url = String(line).trimmingWhitespace()
            if url.isEmpty || url == "missing value" { continue }
            if seen.insert(url).inserted { urls.append(url) }
        }
        return .urls(urls)
    }
}

extension String {
    /// Spaces, tabs and line breaks off both ends, without Foundation's character sets.
    func trimmingWhitespace() -> String {
        let isSpace: (Character) -> Bool = { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" || $0 == "\r\n" }
        guard let start = firstIndex(where: { !isSpace($0) }), let end = lastIndex(where: { !isSpace($0) }) else { return "" }
        return String(self[start...end])
    }
}
