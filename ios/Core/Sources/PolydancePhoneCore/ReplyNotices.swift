// Replies found by background refresh (docs/IPHONE.md U7), as the headset's Replies.check finds them: ask
// the receiver which threads are unread, look into those that moved on since the phone last told about
// them, and post one notification per thread for messages by others: who sent the latest and its first
// line, "(and 2 more)" when there were several. A thread read anywhere with this token loses its notice.
// What was told is a seq per thread, kept in notices.json (strict, 0600) so a relaunch does not tell
// again. Pure: the app does the asking and the posting, and nothing here holds a token. A notice's words
// are shown by iOS and never written to the event log.
import Foundation
import PolydanceShared

public enum ReplyNotices {
    public struct Notice: Sendable, Equatable {
        public let key: String
        /// "MUS-12 · New menu"
        public let title: String
        /// "Opus 5.5 on Robin's Mac: Is Settings easier to find? (and 1 more)"
        public let body: String
    }

    /// From the inbox: the threads to look into (unread and moved on since last told) and the threads whose
    /// notices go (read now, here or elsewhere).
    public static func plan(_ threads: [ThreadSummary], told: [String: Int]) -> (fetch: [String], clear: [String]) {
        var fetch: [String] = [], clear: [String] = []
        for thread in threads {
            if !thread.unread { clear.append(thread.key); continue }
            if thread.seq > (told[thread.key] ?? 0) { fetch.append(thread.key) }
        }
        return (fetch, clear)
    }

    /// From one thread: the notice for messages by others newer than both what was told and what this token
    /// has read, or none, and the seq to remember either way.
    public static func notice(for detail: ThreadDetail, told: Int) -> (notice: Notice?, seq: Int) {
        let since = max(told, detail.readSeq ?? 0)
        let news = detail.ordered.filter { ($0.seq ?? 0) > since && $0.by.id != detail.me }
        guard let latest = news.last else { return (nil, detail.seq) }
        let more = news.count > 1 ? " (and \(news.count - 1) more)" : ""
        return (Notice(key: detail.key, title: "\(detail.key) · \(detail.title)", body: "\(latest.by.who): \(what(latest))\(more)"), detail.seq)
    }

    /// The message in a few words: its first line, else what it is.
    static func what(_ message: ThreadMessage) -> String {
        if let line = message.text?.split(whereSeparator: \.isNewline).map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) {
            return line.count > 160 ? String(line.prefix(159)) + "…" : line
        }
        if message.launches?.isEmpty == false { return "something to try" }
        if let recording = message.recording { return recording.title.map { "a recording: \($0)" } ?? "a recording" }
        if !message.photos.isEmpty { return message.photos.count == 1 ? "a photo" : "\(message.photos.count) photos" }
        return "a message"
    }
}

/// notices.json: `{"v":1,"told":{"MUS-12":14}}`. Strict, so a damaged file is an error the app logs, and
/// then starts again from nothing rather than guessing.
public struct NoticeLedger: Codable, Sendable, Equatable {
    public static let currentVersion = 1
    public var v: Int
    public var told: [String: Int]

    public init(told: [String: Int] = [:]) { v = Self.currentVersion; self.told = told }

    enum CodingKeys: String, CodingKey, CaseIterable { case v, told }

    public init(from decoder: any Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        if let extra = all.allKeys.map(\.stringValue).filter({ $0 != "v" && $0 != "told" }).sorted().first {
            throw UploadProtocolError(extra, "is not a key of notices.json (v, told)")
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v)
        guard v == Self.currentVersion else { throw UploadProtocolError("v", "is \(v), not \(Self.currentVersion)") }
        told = try c.decode([String: Int].self, forKey: .told)
        if let bad = told.keys.sorted().first(where: { !ThreadKey.isValid($0) }) { throw UploadProtocolError("told", "has \(bad.prefix(20)), not a thread key") }
    }

    public static func load(_ url: URL) throws -> NoticeLedger {
        guard FileManager.default.fileExists(atPath: url.path) else { return NoticeLedger() }
        do { return try JSONDecoder().decode(NoticeLedger.self, from: Data(contentsOf: url)) }
        catch let error as UploadProtocolError { throw error }
        catch { throw UploadProtocolError(url.lastPathComponent, "is not a notice ledger") }
    }

    public func save(_ url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try PrivateFiles.write(encoder.encode(self), to: url)
    }

    /// Remembers that the phone has shown everything up to each thread's seq: the inbox on the screen counts
    /// as telling, so a refresh later does not repeat what was already seen there.
    public mutating func shown(_ threads: [ThreadSummary]) {
        for thread in threads where thread.seq > (told[thread.key] ?? 0) { told[thread.key] = thread.seq }
    }
}
