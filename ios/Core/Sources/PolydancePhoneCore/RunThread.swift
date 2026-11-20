// Where a take goes (docs/IPHONE.md I3, docs/THREADS.md): a reply in a thread, a new thread in a project,
// or a report from the bug key, written as the run's thread.json when REC is pressed and sent as the
// upload's `thread` exactly as the receiver's uploadThreadSchema takes it (src/threads.ts):
// `{"key":"MUS-12"}` or `{"key":"MUS-12","replyTo":{"message":3,"launch":0}}`, `{"project":"MUS"}`, or
// `{"report":true}`. A take without thread.json was made before the phone was paired and stays on it until
// sent by hand, when the receiver puts it in the token's first project. Strict both ways: an unknown key, a
// key that is not a thread's, a project key that is not one, or two shapes at once is refused.
import Foundation
import PolydanceShared

public enum RunThread: Sendable, Equatable {
    public struct ReplyTo: Sendable, Equatable, Codable {
        public var message: Int
        public var launch: Int?
        public init(message: Int, launch: Int? = nil) { self.message = message; self.launch = launch }
    }

    case reply(key: String, replyTo: ReplyTo?)
    case newThread(project: String)
    case report

    /// src/threads.ts PROJECT_KEY: `^[A-Z][A-Z0-9]{1,9}$`.
    public static func isProjectKey(_ key: String) -> Bool { key.wholeMatch(of: /[A-Z][A-Z0-9]{1,9}/) != nil }

    /// A reply, checked: the key is a thread's and the message a real id.
    public static func replying(to key: String, replyTo: ReplyTo? = nil) throws -> RunThread {
        guard ThreadKey.isValid(key) else { throw UploadProtocolError("thread.key", "is not a thread key such as MUS-12") }
        if let replyTo {
            guard replyTo.message > 0 else { throw UploadProtocolError("thread.replyTo.message", "must be a message id, 1 or more") }
            if let launch = replyTo.launch, launch < 0 { throw UploadProtocolError("thread.replyTo.launch", "must be 0 or more") }
        }
        return .reply(key: key, replyTo: replyTo)
    }

    /// A new thread, checked.
    public static func opening(in project: String) throws -> RunThread {
        guard isProjectKey(project) else { throw UploadProtocolError("thread.project", "is not a project key such as MUS") }
        return .newThread(project: project)
    }

    public var isReport: Bool { self == .report }

    /// The thread it replies in, if any.
    public var key: String? { if case .reply(let key, _) = self { return key } else { return nil } }

    public func json() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public static func decode(_ data: Data) throws -> RunThread {
        do { return try JSONDecoder().decode(RunThread.self, from: data) }
        catch let error as UploadProtocolError { throw error }
        catch DecodingError.dataCorrupted { throw UploadProtocolError("thread.json", "is not JSON") }
        catch { throw UploadProtocolError("thread.json", "is not a JSON object") }
    }
}

extension RunThread: Codable {
    private enum Keys: String, CodingKey { case key, replyTo, project, report }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .reply(let key, let replyTo):
            try c.encode(key, forKey: .key)
            try c.encodeIfPresent(replyTo, forKey: .replyTo)
        case .newThread(let project):
            try c.encode(project, forKey: .project)
        case .report:
            try c.encode(true, forKey: .report)
        }
    }

    public init(from decoder: any Decoder) throws {
        let any = try decoder.container(keyedBy: AnyKey.self)
        let names = Set(any.allKeys.map(\.stringValue))
        if let extra = names.subtracting(["key", "replyTo", "project", "report"]).sorted().first {
            throw UploadProtocolError("thread.\(extra)", "is not a key of a thread (key and replyTo, project, or report)")
        }
        let c = try decoder.container(keyedBy: Keys.self)
        switch (names.contains("key"), names.contains("project"), names.contains("report")) {
        case (true, false, false):
            let key = try field(any, "key", String.self, "a string")
            var replyTo: ReplyTo?
            if names.contains("replyTo") {
                let r = try c.nestedContainer(keyedBy: AnyKey.self, forKey: .replyTo)
                if let extra = r.allKeys.map(\.stringValue).filter({ $0 != "message" && $0 != "launch" }).sorted().first {
                    throw UploadProtocolError("thread.replyTo.\(extra)", "is not a key of replyTo (message, launch)")
                }
                let message = try field(r, "message", Int.self, "a whole number")
                let launch = r.contains(AnyKey("launch")) ? try field(r, "launch", Int.self, "a whole number") : nil
                replyTo = ReplyTo(message: message, launch: launch)
            }
            self = try .replying(to: key, replyTo: replyTo)
        case (false, true, false):
            guard !names.contains("replyTo") else { throw UploadProtocolError("thread.replyTo", "belongs with a thread key, not a project") }
            self = try .opening(in: field(any, "project", String.self, "a string"))
        case (false, false, true):
            guard !names.contains("replyTo") else { throw UploadProtocolError("thread.replyTo", "belongs with a thread key, not a report") }
            guard try field(any, "report", Bool.self, "true") else { throw UploadProtocolError("thread.report", "must be true") }
            self = .report
        default:
            throw UploadProtocolError("thread", "must name exactly one of a thread key, a project or a report")
        }
    }
}

extension RunFolder {
    public var threadURL: URL { directory.appendingPathComponent(RunNames.threadFile) }

    /// Where the take goes, or nil for a take made unpaired. A thread.json that does not decode is an error,
    /// never a guess at where the take should go.
    public func readThread() throws -> RunThread? {
        guard FileManager.default.fileExists(atPath: threadURL.path) else { return nil }
        return try RunThread.decode(Data(contentsOf: threadURL))
    }

    public func writeThread(_ thread: RunThread) throws {
        try PrivateFiles.write(thread.json(), to: threadURL)
    }
}
