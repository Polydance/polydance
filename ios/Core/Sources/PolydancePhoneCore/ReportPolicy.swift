// What happens to a report on the phone (docs/IPHONE.md B1, docs/THREADS.md "Reports"), as the headset's
// ReportPolicy decides it: a report uploads at once with no hold, and once the receiver has every byte
// and has matched the sha256 (the upload is done: received, processing, ready, or failed in the worker)
// the phone's copy goes. At each launch whatever is left is swept: a report sent but not yet removed
// goes, one still unsent (or refused) is sent again, and any report unsent after a week goes. Nothing is
// deleted on the receiver from the phone. Pure, so the rules are tested; the app does the deleting.
import Foundation

public enum ReportPolicy {
    /// An unsent report is kept this long, then deleted unsent.
    public static let keepUnsentSeconds: TimeInterval = 7 * 24 * 3600

    public enum Action: Sendable, Equatable {
        /// Still recording, or its upload is under way.
        case keep
        /// Not sent, or refused: send it (again).
        case send
        /// The phone's copy goes, and why, for the log.
        case delete(String)
    }

    /// `phase` is the run's upload state, nil when it was never created; `recordedAt` is from its run.json.
    public static func decide(phase: UploadRunState.Phase?, recording: Bool, recordedAt: Date?, now: Date) -> Action {
        if recording { return .keep }
        switch phase {
        case .done?: return .delete("the receiver has it")
        case .narration?, .content?: return .keep
        case .failed?, nil:
            guard let recordedAt else { return .delete("its run.json gives no time, so its age is unknown") }
            if now.timeIntervalSince(recordedAt) > keepUnsentSeconds { return .delete("unsent after a week") }
            return .send
        }
    }

    /// run.json's recordedAt (ISO 8601 with an offset, fractional seconds or not).
    public static func date(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = f.date(from: text) { return date }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: text)
    }
}
