// The one way Polydance writes and reads a time on Apple platforms: the Mac's recording metadata, a
// thread's messages from the receiver, a row's time. Shared so the Mac and the iPhone read the receiver's
// times alike.
import Foundation

/// ISO 8601 times as the metadata writes them: UTC with milliseconds, 2026-11-05T11:00:02.120Z.
public enum MetaTime {
    public static func format(_ date: Date) -> String {
        // Rounded to the millisecond first, so .480 read back is not written as .479.
        let rounded = Date(timeIntervalSinceReferenceDate: (date.timeIntervalSinceReferenceDate * 1000).rounded() / 1000)
        return rounded.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    /// Accepts the form above, without fractional seconds too, and with an offset.
    public static func parse(_ text: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) { return date }
        return try? Date.ISO8601FormatStyle().parse(text)
    }
}
