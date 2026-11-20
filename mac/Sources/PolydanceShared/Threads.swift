// Threads as the receiver gives them (src/threads.ts, src/server/people.ts), for every Apple platform: a
// thread key, who is in a thread, a row of the list, a thread's messages, launches and their steps. The Mac
// reads them from what `polycap thread list --json` and `thread show KEY --json` print; the iPhone reads
// them from the receiver (docs/IPHONE.md I3, PolydancePhoneCore's ThreadRequests). Unknown keys are tolerated, but a thread key goes back to the
// receiver or polycap and a link is opened in a browser, so both are checked and refused when they are not
// what they must be. Of a launch's steps only `open` with an https link means anything off the headset; app,
// require and model steps are the headset's, and are shown as such rather than skipped silently.
import Foundation

public enum ThreadKey {
    /// src/threads.ts THREAD_KEY: `^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,5}$`.
    public static func isValid(_ key: String) -> Bool {
        let parts = key.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        let project = Array(parts[0].utf8), number = Array(parts[1].utf8)
        func upper(_ b: UInt8) -> Bool { (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(b) }
        func digit(_ b: UInt8) -> Bool { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b) }
        guard (2...10).contains(project.count), upper(project[0]), project.dropFirst().allSatisfy({ upper($0) || digit($0) }) else { return false }
        guard (1...6).contains(number.count), number[0] != UInt8(ascii: "0"), number.allSatisfy(digit) else { return false }
        return true
    }
}

public struct ThreadAuthor: Decodable, Sendable, Equatable, Hashable {
    public var id: String
    public var name: String
    public var display: String?

    /// "Opus 5.5 on Robin's Mac", or the name for messages written before display names.
    public var who: String { display ?? name }
}

/// Someone in a thread, as the receiver lists them (src/server/people.ts PersonView): their name, the
/// letter on their circle, their own colour when they chose one, and whether they are only invited.
public struct ThreadPerson: Decodable, Sendable, Equatable, Hashable {
    public var name: String
    public var initial: String
    public var colour: String?
    public var invited: Bool?
    public var email: String?

    public init(name: String, initial: String, colour: String? = nil, invited: Bool? = nil, email: String? = nil) {
        self.name = name
        self.initial = initial
        self.colour = colour
        self.invited = invited
        self.email = email
    }

    /// What their colour follows when they have none of their own: an invited address, else the name
    /// (the headset's InboxPane.faces).
    public var colourKey: String { invited == true ? (email ?? name) : name }

    /// Their own colour as 0xRRGGBB, when it is a #RRGGBB the headset would also read.
    public var ownColour: UInt32? {
        guard let colour, colour.count == 7, colour.hasPrefix("#") else { return nil }
        return UInt32(colour.dropFirst(), radix: 16)
    }
}

/// One row of `polycap thread list --json` (an array of these).
public struct ThreadSummary: Decodable, Sendable, Equatable, Identifiable {
    public struct Last: Decodable, Sendable, Equatable {
        public var kind: String
        public var by: ThreadAuthor
        public var at: String
        public var text: String
    }

    public var key: String
    public var project: String
    public var title: String
    public var state: String
    public var updatedAt: String
    public var messages: Int
    public var unread: Bool
    public var waiting: Bool
    /// Recordings by others this token has not seen (receivers before 2026-10-04 do not send it).
    public var fresh: Int
    public var report: Bool
    public var last: Last
    /// Who is in it, the first six (receivers before 2026-10-12 do not send them), and how many in all.
    public var people: [ThreadPerson]
    public var peopleCount: Int
    /// The last message in a line, as the headset's list shows it, when the receiver sends one.
    public var snippet: String?
    public var lastMessageAt: String?
    /// The thread's change count, which the iPhone's reply notices remember per thread (0 when not sent).
    public var seq: Int

    public var id: String { key }
    /// What the sidebar's dot means: something here is new to this token.
    public var isNew: Bool { unread || fresh > 0 }

    enum CodingKeys: String, CodingKey { case key, project, title, state, updatedAt, messages, unread, waiting, fresh, report, last, people, peopleCount, snippet, lastMessageAt, seq }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        project = try c.decode(String.self, forKey: .project)
        title = try c.decode(String.self, forKey: .title)
        state = try c.decode(String.self, forKey: .state)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        messages = try c.decode(Int.self, forKey: .messages)
        unread = try c.decode(Bool.self, forKey: .unread)
        waiting = try c.decode(Bool.self, forKey: .waiting)
        fresh = try c.decodeIfPresent(Int.self, forKey: .fresh) ?? 0
        report = try c.decodeIfPresent(Bool.self, forKey: .report) ?? false
        last = try c.decode(Last.self, forKey: .last)
        people = try c.decodeIfPresent([ThreadPerson].self, forKey: .people) ?? []
        peopleCount = try c.decodeIfPresent(Int.self, forKey: .peopleCount) ?? people.count
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet)
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? 0
    }
}

/// One step of a launch (src/threads.ts stepSchema).
public enum LaunchStep: Decodable, Sendable, Equatable {
    case open(url: String)
    case app(package: String, activity: String?, data: String?)
    case require(package: String, versionName: String?, versionCode: Int?, minVersionCode: Int?)
    /// A 3D model the thread's store holds, named by its sha256 (64 lowercase hex digits; nil when the receiver
    /// sent one that is not, so it is never fetched).
    case model(name: String, bytes: Int, sha256: String?)
    /// A step a newer receiver knows and this app does not.
    case unknown(kind: String)

    enum CodingKeys: String, CodingKey { case `do`, url, package, activity, data, versionName, versionCode, minVersionCode, name, bytes, sha256 }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .do)
        switch kind {
        case "open": self = .open(url: try c.decode(String.self, forKey: .url))
        case "app": self = .app(package: try c.decode(String.self, forKey: .package), activity: try c.decodeIfPresent(String.self, forKey: .activity),
                                data: try c.decodeIfPresent(String.self, forKey: .data))
        case "require": self = .require(package: try c.decode(String.self, forKey: .package), versionName: try c.decodeIfPresent(String.self, forKey: .versionName),
                                        versionCode: try c.decodeIfPresent(Int.self, forKey: .versionCode),
                                        minVersionCode: try c.decodeIfPresent(Int.self, forKey: .minVersionCode))
        case "model":
            let sha = try c.decodeIfPresent(String.self, forKey: .sha256)
            self = .model(name: try c.decode(String.self, forKey: .name), bytes: try c.decode(Int.self, forKey: .bytes),
                          sha256: sha.flatMap { $0.utf8.count == 64 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } ? $0 : nil })
        default: self = .unknown(kind: kind)
        }
    }

    /// The step in words, saying plainly when it is the headset's.
    public var macText: String {
        switch self {
        case .open(let url):
            guard let link = LaunchLink.https(url) else { return "Not opened: \(url) is not an https link" }
            return "Opens \(LaunchLink.short(link))"
        case .app(let package, let activity, _):
            return "Headset only: opens the app \(package)\(activity.map { "/\($0)" } ?? "")"
        case .require(let package, let name, let code, let minCode):
            let version = [name, code.map { "(\($0))" }, minCode.map { "at least (\($0))" }].compactMap { $0 }.joined(separator: " ")
            return "Headset only: needs \(package)\(version.isEmpty ? "" : " \(version)")"
        case .model(let name, let bytes, _):
            return "Headset only: shows the 3D model \(name) (\(LaunchLink.megabytes(bytes)))"
        case .unknown(let kind):
            return "Not on the Mac: a \(kind) step"
        }
    }

    public var isMacStep: Bool { if case .open(let url) = self { return LaunchLink.https(url) != nil } else { return false } }
}

public struct Launch: Decodable, Sendable, Equatable {
    public var label: String?
    public var steps: [LaunchStep]

    public init(label: String? = nil, steps: [LaunchStep]) {
        self.label = label
        self.steps = steps
    }

    /// The links this launch opens on the Mac, in order: https only.
    public var macLinks: [URL] { steps.compactMap { if case .open(let url) = $0 { return LaunchLink.https(url) } else { return nil } } }
    /// True when the launch opens nothing on the Mac: everything in it is for the headset.
    public var isHeadsetOnly: Bool { macLinks.isEmpty }
    public var headsetSteps: [LaunchStep] { steps.filter { !$0.isMacStep } }

    /// "Option 2: Red menu" among several, else the label, else "Start".
    public func title(index: Int, of count: Int) -> String {
        if count > 1 { return "Option \(index + 1)" + (label.map { ": \($0)" } ?? "") }
        return label ?? "Start"
    }
}

public enum LaunchLink {
    /// src/threads.ts isHttpsUrl: https, a host, and no user name or password in it.
    public static func https(_ text: String) -> URL? {
        guard text.utf8.count <= 2000, let url = URL(string: text), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        return url
    }

    /// host + path, without the scheme, for a line of text.
    public static func short(_ url: URL) -> String {
        let path = url.path == "/" ? "" : url.path
        return (url.host ?? "") + path
    }

    /// 4.2 MB or 640 kB (src/threads.ts megabytes).
    public static func megabytes(_ bytes: Int) -> String {
        bytes < 1_000_000 ? "\(max(1, Int((Double(bytes) / 1000).rounded()))) kB" : String(format: "%.1f MB", Double(bytes) / 1_000_000)
    }
}

public struct ThreadMessage: Decodable, Sendable, Equatable, Identifiable {
    public struct Recording: Decodable, Sendable, Equatable {
        public struct ReplyTo: Decodable, Sendable, Equatable {
            public var message: Int
            public var launch: Int?
        }

        public var uploadId: String
        public var status: String?
        public var sessionId: String?
        public var title: String?
        public var summary: String?
        public var durationMs: Int?
        public var error: String?
        public var replyTo: ReplyTo?
        /// What there is to play: "video", "sound" (no picture) or "none" (the take's logs alone, docs/LOGS.md);
        /// nil from a receiver before 2026-11-16, which only had videos.
        public var content: String?
        /// The take sent the headset's log (docs/LOGS.md).
        public var logs: Bool?

        /// The first word of the recording's line: a take with no picture says so, and one of logs alone too.
        public var kindWord: String {
            switch content {
            case "none": "Logs only"
            case "sound": "Sound only"
            default: "Recording"
            }
        }

        /// "with logs" for a take that has a picture or sound and sent its log; nil otherwise.
        public var logsWord: String? { logs == true && content != "none" ? "with logs" : nil }
    }

    public struct Reaction: Decodable, Sendable, Equatable {
        public var reaction: String
        public var by: ThreadAuthor
    }

    public struct Pick: Decodable, Sendable, Equatable {
        public var launch: Int
        public var by: ThreadAuthor
    }

    /// A photo in the message (docs/THREADS.md, Photos, 2026-11-07), with the copy `polycap thread show`
    /// saved into the library when this token may see it. Where that copy may be is the Mac's to say
    /// (PolydanceCore's `file(in:thread:)`).
    public struct Photo: Decodable, Sendable, Equatable, Hashable {
        public var sha256: String
        public var type: String
        public var width: Int
        public var height: Int
        public var bytes: Int
        public var path: String?
    }

    public var id: Int
    /// The thread's seq when it was posted, which says whether it is newer than what was seen.
    public var seq: Int?
    public var at: String
    public var by: ThreadAuthor
    public var text: String?
    public var launches: [Launch]?
    public var recording: Recording?
    public var reactions: [Reaction]
    public var picks: [Pick]
    public var photos: [Photo]
    /// False when this token may not see the photos (not a member of the thread).
    public var canView: Bool
    /// The sender's own name for this message. The receiver's Welcome names its answer `welcome-next`, which is
    /// where the headsets draw Connect your agent (AgentWords.isWelcomeAnswer, 2026-11-20).
    public var deliveryId: String?

    enum CodingKeys: String, CodingKey { case id, seq, at, by, text, launches, recording, reactions, picks, photos, canView, deliveryId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq)
        at = try c.decode(String.self, forKey: .at)
        by = try c.decode(ThreadAuthor.self, forKey: .by)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        launches = try c.decodeIfPresent([Launch].self, forKey: .launches)
        recording = try c.decodeIfPresent(Recording.self, forKey: .recording)
        reactions = try c.decodeIfPresent([Reaction].self, forKey: .reactions) ?? []
        picks = try c.decodeIfPresent([Pick].self, forKey: .picks) ?? []
        photos = try c.decodeIfPresent([Photo].self, forKey: .photos) ?? []
        canView = try c.decodeIfPresent(Bool.self, forKey: .canView) ?? true
        deliveryId = try c.decodeIfPresent(String.self, forKey: .deliveryId)
    }

    /// One line for a message that is not the latest: "sent a recording: Settings is buried".
    public var oneLine: String {
        if let recording {
            let what = recording.title ?? recording.summary ?? (recording.status == "failed" ? "it failed to build" : recording.status ?? "")
            return "sent a recording" + (what.isEmpty ? "" : ": \(what)")
        }
        let first = text?.split(whereSeparator: \.isNewline).first
        if !photos.isEmpty {
            return (photos.count == 1 ? "sent a photo" : "sent \(photos.count) photos") + (first.map { ": \($0)" } ?? "")
        }
        if let first { return "posted: \(first)" }
        if let launches, !launches.isEmpty { return launches.count > 1 ? "posted \(launches.count) options to try" : "posted something to try" }
        return "posted"
    }

    /// The reaction names (src/threads.ts REACTIONS) as the headset shows them.
    public static let reactionSymbols = ["heart": "❤️", "thumbs-up": "👍", "thumbs-down": "👎", "haha": "😂", "emphasis": "‼️", "question": "❓"]
}

/// `polycap thread show KEY --json`, or the receiver's GET /v1/threads/:key, which also says what this token
/// has seen (readSeq), whether something is unread and whether this token hid it.
public struct ThreadDetail: Decodable, Sendable, Equatable {
    public struct Project: Decodable, Sendable, Equatable {
        public var key: String
        public var name: String
    }

    public var me: String
    public var key: String
    public var project: Project
    public var title: String
    public var state: String
    public var seq: Int
    public var messages: [ThreadMessage]
    public var report: Bool?
    public var readSeq: Int?
    public var unread: Bool?
    public var hidden: Bool?

    /// Oldest first, whatever order the receiver used.
    public var ordered: [ThreadMessage] { messages.sorted { $0.id < $1.id } }
}

/// `polycap thread reply KEY --text … --json`: {key, message}.
public struct PostedReply: Decodable, Sendable, Equatable {
    public var key: String
    public var message: Int
}
