// Names for a recording on the phone (docs/IPHONE.md U6). A run is named by the phone's local wall clock
// when REC was pressed, as the headset names its runs. The file name the receiver is given carries the
// app's package first, so the receiver's parseRecordingName and appSlug (src/filename.ts) make session ids
// ending `_iphone` without any change there, and `_visionpro` for the Vision Pro's takes (docs/VISIONOS.md),
// which this package also writes.
import Foundation

public enum RunNames {
    /// The package in upload file names; its last part becomes the session id's slug. It is the app's own
    /// bundle id on each platform, so a bundle says which device made it.
    #if os(visionOS)
    public static let appPackage = "net.polydance.capture.visionpro"
    #else
    public static let appPackage = "net.polydance.capture.iphone"
    #endif
    public static let videoFile = "video.mp4"
    public static let narrationFile = "narration.m4a"
    public static let metaFile = "run.json"
    public static let timelineFile = "timeline.jsonl"
    /// Where the take goes (RunThread), written at REC once the phone is paired.
    public static let threadFile = "thread.json"
    /// What was opened from launches while the take ran (Opened), as the headset's opened.json.
    public static let openedFile = "opened.json"

    /// "20261106-140501" for 14:05:01 on 6 November 2026 in `timeZone`.
    public static func runName(for date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(format: "%04d%02d%02d-%02d%02d%02d", c.year!, c.month!, c.day!, c.hour!, c.minute!, c.second!)
    }

    /// Whether `name` is a run name, so a folder that is not one is never listed or uploaded.
    public static func isRunName(_ name: String) -> Bool { name.wholeMatch(of: /\d{8}-\d{6}/) != nil }

    /// "net.polydance.capture.iphone-20261106-140501.mp4": the name the receiver is told.
    public static func uploadFileName(runName: String) -> String { "\(appPackage)-\(runName).mp4" }
}
