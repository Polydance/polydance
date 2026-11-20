// What the app opened from a thread's launches while a take ran, and when (the headset's opened.json,
// Threads.kt; src/session.ts openedSchema). The Vision Pro writes one entry each time Record and open, or a
// launch key pressed during a take, opens something, so the bundle says which option was tried at which
// moment. The file is the run's `opened.json`, a JSON array; the create body sends it as `opened`. Strict on
// the way out: an entry the receiver's schema would refuse is an error naming the field, never sent.
import Foundation

public struct Opened: Codable, Sendable, Equatable {
    /// The receiver's limit on entries in one upload.
    public static let maxCount = 100

    /// Milliseconds from the start of the take.
    public var atMs: Int
    /// The launch's steps in words: "open https://…".
    public var what: String
    public var label: String?
    /// The message it came from and, when that message offered options, which one (0-based).
    public var message: Int?
    public var launch: Int?

    public init(atMs: Int, what: String, label: String? = nil, message: Int? = nil, launch: Int? = nil) {
        self.atMs = atMs
        self.what = what
        self.label = label
        self.message = message
        self.launch = launch
    }

    /// openedSchema's rules.
    public func check() throws {
        guard atMs >= 0 else { throw UploadProtocolError("opened.atMs", "must not be negative") }
        guard (1...300).contains(what.count) else { throw UploadProtocolError("opened.what", "must be 1 to 300 characters") }
        if let label, label.count > 40 { throw UploadProtocolError("opened.label", "must be at most 40 characters") }
        if let message, message < 1 { throw UploadProtocolError("opened.message", "must be positive") }
        if let launch, !(0...5).contains(launch) { throw UploadProtocolError("opened.launch", "must be 0 to 5") }
    }

    /// The run's opened.json, oldest first; none when the take opened nothing.
    public static func read(_ run: RunFolder) throws -> [Opened] {
        guard FileManager.default.fileExists(atPath: run.openedURL.path) else { return [] }
        return try JSONDecoder().decode([Opened].self, from: Data(contentsOf: run.openedURL))
    }

    /// Adds one entry to the run's opened.json (0600), refusing one the receiver would refuse.
    public static func append(_ entry: Opened, to run: RunFolder) throws {
        try entry.check()
        var all = try read(run)
        guard all.count < maxCount else { throw UploadProtocolError("opened", "already has \(maxCount) entries") }
        all.append(entry)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        try PrivateFiles.write(encoder.encode(all), to: run.openedURL)
    }

    /// "open https://example.com/menu" for a launch's https links, as Threads.kt describes a launch.
    public static func what(links: [URL]) -> String {
        let words = links.map { "open \($0.absoluteString)" }.joined(separator: ", ")
        return String(words.prefix(300))
    }
}
