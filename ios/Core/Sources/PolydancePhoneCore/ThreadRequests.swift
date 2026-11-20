// Threads as the phone reads and answers them (docs/IPHONE.md I3, docs/THREADS.md "Receiver API"): the
// same routes the headset's Threads.kt uses, with the phone's `upload` token. The list (GET /v1/threads),
// a thread (GET /v1/threads/:key), marking it read, reactions, picks, Archive (POST …/state, closed) and
// Delete from this inbox (POST …/hide), who the token is (GET /v1/me) and its allowance (GET /v1/account).
// Requests are built here and replies decoded into PolydanceShared's thread models, so `swift test`
// proves both against the receiver's own shapes without a network. A key, a reaction or a number the
// receiver would refuse is refused here first; a reply of the wrong shape is an error naming what it is
// not, and a refusal carries the receiver's own reason in a few words, never its whole body.
import Foundation
import PolydanceShared

/// A refusal or an unreadable reply: the HTTP status (0 when nothing came back) and why, in a few words.
public struct ReceiverError: Error, Sendable, Equatable, CustomStringConvertible {
    public let status: Int
    public let reason: String
    public init(status: Int, reason: String) { self.status = status; self.reason = reason }
    public var description: String { status == 0 ? reason : "HTTP \(status): \(reason)" }
}

public enum ThreadRequests {
    /// src/threads.ts REACTIONS, in its order: the six the headset draws.
    public static let reactions = ["heart", "thumbs-up", "thumbs-down", "haha", "emphasis", "question"]

    /// GET /v1/projects: the projects this token sees, and what the receiver can do (reports-v1, photos-v1).
    public static func projects(_ p: Pairing) -> URLRequest { UploadRequests.base(p, "GET", "/v1/projects") }

    /// POST /v1/projects { name }: a project of this token's person's own (2026-11-13, docs/THREADS.md "Projects of
    /// your own"); the receiver makes its key from the name. A name it would refuse is refused here first.
    public static func newProject(_ p: Pairing, name: String) throws -> URLRequest {
        let name = try projectName(name)
        var r = UploadRequests.base(p, "POST", "/v1/projects")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: ["name": name], options: [.sortedKeys])
        return r
    }

    /// src/threads.ts newProjectSchema's name: trimmed, 1 to 60 characters, no control characters.
    public static func projectName(_ raw: String) throws -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw UploadProtocolError("name", "is empty: a project needs a name") }
        // zod counts UTF-16 units, as JavaScript does.
        guard name.utf16.count <= 60 else { throw UploadProtocolError("name", "is over 60 characters") }
        guard !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw UploadProtocolError("name", "has a line break or another control character") }
        return name
    }

    /// GET /v1/threads?state=open (the inbox) or closed (Archived).
    public static func list(_ p: Pairing, archived: Bool = false) -> URLRequest {
        UploadRequests.base(p, "GET", "/v1/threads?state=\(archived ? "closed" : "open")")
    }

    public static func thread(_ p: Pairing, key: String) throws -> URLRequest {
        UploadRequests.base(p, "GET", "/v1/threads/\(try checked(key))")
    }

    /// POST …/read { seq }: everything up to seq is seen by this token.
    public static func read(_ p: Pairing, key: String, seq: Int) throws -> URLRequest {
        guard seq >= 0 else { throw UploadProtocolError("seq", "must be 0 or more") }
        return try post(p, key, "read", ["seq": seq])
    }

    /// POST …/reactions { message, reaction }: the same again takes it off, another replaces it.
    public static func react(_ p: Pairing, key: String, message: Int, reaction: String) throws -> URLRequest {
        guard message > 0 else { throw UploadProtocolError("message", "must be a message id, 1 or more") }
        guard reactions.contains(reaction) else { throw UploadProtocolError("reaction", "is not one of \(reactions.joined(separator: ", "))") }
        return try post(p, key, "reactions", ["message": message, "reaction": reaction])
    }

    /// POST …/picks { message, launch }: a star on one of a message's options; the same again takes it off.
    public static func pick(_ p: Pairing, key: String, message: Int, launch: Int) throws -> URLRequest {
        guard message > 0 else { throw UploadProtocolError("message", "must be a message id, 1 or more") }
        guard (0..<6).contains(launch) else { throw UploadProtocolError("launch", "must be an option, 0 to 5") }
        return try post(p, key, "picks", ["message": message, "launch": launch])
    }

    /// Archive is closing the thread (POST …/state, which the hosted receiver's nginx passes where PATCH is
    /// refused); open again brings it back.
    public static func archive(_ p: Pairing, key: String, archived: Bool) throws -> URLRequest {
        try post(p, key, "state", ["state": archived ? "closed" : "open"])
    }

    /// POST …/hide or …/unhide: off this token's inbox until someone else adds to it, or back now. No body.
    public static func hide(_ p: Pairing, key: String, hidden: Bool) throws -> URLRequest {
        var r = UploadRequests.base(p, "POST", "/v1/threads/\(try checked(key))/\(hidden ? "hide" : "unhide")")
        r.setValue("0", forHTTPHeaderField: "Content-Length")
        return r
    }

    /// GET /v1/me: who this token is, so the phone can say "Robin · iPhone".
    public static func me(_ p: Pairing) -> URLRequest { UploadRequests.base(p, "GET", "/v1/me") }

    /// GET /v1/threads/:key/models/:sha256: a model one of the thread's launches opens, for the Vision Pro's
    /// viewer as for the headset's (Models.kt). The bytes are checked against the sha256 on arrival.
    public static func model(_ p: Pairing, key: String, sha256: String) throws -> URLRequest {
        guard UploadProtocol.isSHA256(sha256) else { throw UploadProtocolError("sha256", "must be 64 lowercase hex digits") }
        return UploadRequests.base(p, "GET", "/v1/threads/\(try checked(key))/models/\(sha256)")
    }

    static func checked(_ key: String) throws -> String {
        guard ThreadKey.isValid(key) else { throw UploadProtocolError("key", "is not a thread key such as MUS-12") }
        return key
    }

    private static func post(_ p: Pairing, _ key: String, _ route: String, _ body: [String: Any]) throws -> URLRequest {
        var r = UploadRequests.base(p, "POST", "/v1/threads/\(try checked(key))/\(route)")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return r
    }
}

// MARK: - Replies

/// A project as the receiver lists it; `mine` when it is this token's person's own (2026-11-13), not the team's.
public struct ProjectRef: Decodable, Sendable, Equatable, Hashable {
    public var key: String
    public var name: String
    public var mine: Bool
    public init(key: String, name: String, mine: Bool = false) { self.key = key; self.name = name; self.mine = mine }

    enum CodingKeys: String, CodingKey { case key, name, mine }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        name = try c.decode(String.self, forKey: .name)
        // A receiver older than people's own projects never says; everything it lists is the team's.
        mine = try c.decodeIfPresent(Bool.self, forKey: .mine) ?? false
    }
}

/// POST /v1/projects: the project made, and the projects this token sees now.
public struct NewProjectReply: Decodable, Sendable, Equatable {
    public var project: ProjectRef
    public var projects: [ProjectRef]
}

/// GET /v1/threads: the inbox, newest activity first, with the projects this token sees and whether the bug
/// key has somewhere to send a report.
public struct ThreadListing: Decodable, Sendable, Equatable {
    public var me: String
    public var projects: [ProjectRef]
    public var unread: Int
    public var reports: Bool
    /// Whether this receiver makes a project of your own (POST /v1/projects), so New thread offers New project.
    public var newProjects: Bool
    /// Whether a device may ask it for a code to connect an agent (POST /v1/agents/codes, 2026-11-20).
    public var agents: Bool
    public var threads: [ThreadSummary]

    enum CodingKeys: String, CodingKey { case me, projects, unread, reports, newProjects, agents, threads }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        me = try c.decode(String.self, forKey: .me)
        projects = try c.decodeIfPresent([ProjectRef].self, forKey: .projects) ?? []
        unread = try c.decodeIfPresent(Int.self, forKey: .unread) ?? 0
        reports = try c.decodeIfPresent(Bool.self, forKey: .reports) ?? false
        newProjects = try c.decodeIfPresent(Bool.self, forKey: .newProjects) ?? false
        agents = try c.decodeIfPresent(Bool.self, forKey: .agents) ?? false
        threads = try c.decode([ThreadSummary].self, forKey: .threads)
        // A row the phone would act on with a bad key is refused, not shown.
        if let bad = threads.first(where: { !ThreadKey.isValid($0.key) }) {
            throw UploadProtocolError("threads", "holds \(bad.key.prefix(20)), which is not a thread key")
        }
    }
}

/// GET /v1/projects.
public struct ProjectsReply: Decodable, Sendable, Equatable {
    public var me: String
    public var projects: [ProjectRef]
    public var capabilities: [String]
}

/// GET /v1/me: the token's label is the device ("iPhone"), its person the name ("Robin").
public struct MeReply: Decodable, Sendable, Equatable {
    public struct Person: Decodable, Sendable, Equatable {
        public var name: String
        public var initial: String?
    }
    public var me: String
    public var device: String?
    public var person: Person

    /// "Robin · iPhone", as the receiver signs this token's messages.
    public var who: String { device.map { "\(person.name) · \($0)" } ?? person.name }
}

/// GET /v1/account: what the tape shows (docs/IPHONE.md S1), this token's recordings against its allowance.
public struct AccountReply: Decodable, Sendable, Equatable {
    public var usedBytes: Int64
    public var allowanceBytes: Int64
    public var recordings: Int?

    /// How much of the tape is used, 0 to 1.
    public var used: Double { allowanceBytes > 0 ? min(max(Double(usedBytes) / Double(allowanceBytes), 0), 1) : 0 }
    public var full: Bool { allowanceBytes > 0 && usedBytes >= allowanceBytes }
    /// "2.4 OF 8 GB", in the deck's capitals.
    public var label: String {
        let gb = { (n: Int64) in Double(n) / 1_000_000_000 }
        let allowance = gb(allowanceBytes)
        let whole = allowance.rounded() == allowance ? String(format: "%.0f", allowance) : String(format: "%.1f", allowance)
        return String(format: "%.1f OF ", gb(usedBytes)) + whole + " GB"
    }
}

public enum ReceiverReply {
    /// A 2xx reply as `T`, else the receiver's refusal. `what` names the reply in the error ("a thread").
    public static func decode<T: Decodable>(_ type: T.Type, status: Int, body: Data, what: String) throws -> T {
        guard (200..<300).contains(status) else {
            throw ReceiverError(status: status, reason: UploadProtocol.shortReason(status: status, body: body.prefix(64 * 1024)))
        }
        do { return try JSONDecoder().decode(T.self, from: body) }
        catch let error as UploadProtocolError { throw ReceiverError(status: status, reason: "the reply is not \(what): \(error)") }
        catch { throw ReceiverError(status: status, reason: "the reply is not \(what)") }
    }

    /// A 2xx with nothing to read (hide, unhide), else the refusal.
    public static func check(status: Int, body: Data) throws {
        guard (200..<300).contains(status) else {
            throw ReceiverError(status: status, reason: UploadProtocol.shortReason(status: status, body: body.prefix(64 * 1024)))
        }
    }
}

extension ThreadDetail {
    /// The reactions on a message by this token, by name: what the phone shows as chosen.
    public func myReaction(on message: ThreadMessage) -> String? { message.reactions.last { $0.by.id == me }?.reaction }
    /// The option this token starred on a message, if any.
    public func myPick(on message: ThreadMessage) -> Int? { message.picks.last { $0.by.id == me }?.launch }
    /// Whether something here is newer than what this token has seen.
    public var hasUnseen: Bool { seq > (readSeq ?? 0) }
}
