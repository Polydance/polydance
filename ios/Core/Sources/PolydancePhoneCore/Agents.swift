// A person's own coding agents (2026-11-20, docs/THREADS.md "Connecting your own agent"): the device asks the
// receiver for a one-time code, the person types it into `polycap connect` on their computer, and the agent on
// that machine then reads their threads and recordings and posts in them, as them. The device is where the code
// is shown and where the connected agents are listed and disconnected; the token itself never comes here.
// These are the requests, the replies and the words, the same as the Quest's Agents.kt, so `swift test` proves
// them without a network. A reply of the wrong shape is refused, never guessed at.
import Foundation
import PolydanceShared

public enum AgentRequests {
    /// GET /v1/agents: this device's person's agents.
    public static func list(_ p: Pairing) -> URLRequest { UploadRequests.base(p, "GET", "/v1/agents") }

    /// POST /v1/agents/codes: a new code; the person's last one stops working.
    public static func code(_ p: Pairing) -> URLRequest { UploadRequests.base(p, "POST", "/v1/agents/codes") }

    /// DELETE /v1/agents/:id. An id that is not one of the receiver's is refused here first.
    public static func disconnect(_ p: Pairing, id: String) throws -> URLRequest {
        guard ConnectedAgent.isValid(id) else { throw UploadProtocolError("agent", "is not an agent's id") }
        return UploadRequests.base(p, "DELETE", "/v1/agents/\(id)")
    }
}

public struct ConnectedAgent: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    /// What its machine is called, "Mac".
    public var label: String
    public var connectedAt: String?
    /// The device that showed its code, "Quest 3".
    public var connectedFrom: String?
    public var expiresAt: String?
    /// The day it last made a request, in UTC: "2026-11-20".
    public var lastUsedOn: String?
    public var expired: Bool

    enum CodingKeys: String, CodingKey { case id, label, connectedAt, connectedFrom, expiresAt, lastUsedOn, expired }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "Computer"
        connectedAt = try c.decodeIfPresent(String.self, forKey: .connectedAt)
        connectedFrom = try c.decodeIfPresent(String.self, forKey: .connectedFrom)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        lastUsedOn = try c.decodeIfPresent(String.self, forKey: .lastUsedOn)
        expired = try c.decodeIfPresent(Bool.self, forKey: .expired) ?? false
    }

    /// `paired-` and eight hex digits, as src/server/tokens.ts ISSUED_ID.
    public static func isValid(_ id: String) -> Bool { id.range(of: "^paired-[0-9a-f]{8}$", options: .regularExpression) != nil }
}

/// GET /v1/agents.
public struct AgentList: Decodable, Sendable, Equatable {
    public var agents: [ConnectedAgent]
    public var limit: Int

    enum CodingKeys: String, CodingKey { case agents, limit }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // One this build could not name or disconnect is left out, never guessed at.
        agents = try c.decode([ConnectedAgent].self, forKey: .agents).filter { ConnectedAgent.isValid($0.id) }
        limit = try c.decodeIfPresent(Int.self, forKey: .limit) ?? 5
    }

    /// Those that still work.
    public var connected: [ConnectedAgent] { agents.filter { !$0.expired } }
    public var full: Bool { connected.count >= limit }
}

/// POST /v1/agents/codes: the code as shown, "K7QF-2MXD", and when it runs out.
public struct AgentCode: Decodable, Sendable, Equatable {
    public var code: String
    public var expiresAt: Date

    enum CodingKeys: String, CodingKey { case code, expiresAt }

    public init(code: String, expiresAt: Date) { self.code = code; self.expiresAt = expiresAt }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        guard code.range(of: "^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$", options: .regularExpression) != nil else {
            throw UploadProtocolError("code", "is not a code")
        }
        guard let date = AgentWords.instant(try c.decode(String.self, forKey: .expiresAt)) else {
            throw UploadProtocolError("expiresAt", "is not a time")
        }
        expiresAt = date
    }
}

public enum AgentWords {
    /// A code's whole life, for the strip that runs down with it.
    public static let codeSeconds: TimeInterval = 600

    /// The line to type on the computer.
    public static func command(_ code: AgentCode) -> String { "polycap connect \(code.code)" }

    /// "9:41 left", or nil once it has run out. A part of a second counts as the whole of it.
    public static func left(_ code: AgentCode, now: Date) -> String? {
        let remaining = code.expiresAt.timeIntervalSince(now)
        guard remaining > 0 else { return nil }
        let s = Int(remaining.rounded(.up))
        return String(format: "%d:%02d left", s / 60, s % 60)
    }

    /// How much of the code's ten minutes is left, 0 to 1.
    public static func fraction(_ code: AgentCode, now: Date) -> Double {
        min(1, max(0, code.expiresAt.timeIntervalSince(now) / codeSeconds))
    }

    static func instant(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: iso) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso)
    }

    private static func dayMonth(_ date: Date, _ zone: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB"); f.timeZone = zone; f.dateFormat = "d MMM"
        return f.string(from: date)
    }

    /// "connected 12 Nov from Quest 3 · last used today · until 10 Feb", leaving out what the receiver did not say.
    public static func detail(_ a: ConnectedAgent, now: Date, zone: TimeZone = .current) -> String {
        var parts: [String] = []
        if let at = instant(a.connectedAt) {
            let from = a.connectedFrom.flatMap { $0.isEmpty ? nil : " from \($0)" } ?? ""
            parts.append("connected \(dayMonth(at, zone))\(from)")
        }
        // The receiver notes the day of use in UTC, so it is a day, not a moment.
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX"); day.timeZone = zone; day.dateFormat = "yyyy-MM-dd"
        if let used = a.lastUsedOn, let date = day.date(from: used) {
            parts.append(used == day.string(from: now) ? "last used today" : "last used \(dayMonth(date, zone))")
        } else {
            parts.append("not used yet")
        }
        if let until = instant(a.expiresAt) { parts.append("\(a.expired ? "ran out" : "until") \(dayMonth(until, zone))") }
        return parts.joined(separator: "  ·  ")
    }

    /// Whether the inbox shows the card that offers to connect one: the receiver connects agents, this person's
    /// list has been read and has none that works, and they have not put the card away.
    public static func offer(supported: Bool, list: AgentList?, dismissed: Bool) -> Bool {
        guard supported, !dismissed, let list else { return false }
        return list.connected.isEmpty
    }

    /// The Welcome's answer to a newcomer's first recording, which carries the same card (src/server/welcome.ts).
    public static func isWelcomeAnswer(_ message: ThreadMessage) -> Bool {
        message.by.id == "polydance" && message.deliveryId == "welcome-next"
    }

    public static func full(_ list: AgentList) -> String {
        "You have \(list.limit) agents connected, which is as many as one person may. Disconnect one first."
    }

    /// Why a code could not be had, in words a person can act on.
    public static func problem(_ error: any Error, list: AgentList?) -> String {
        guard let refused = error as? ReceiverError, refused.status != 0 else { return "Can't reach the server. Check the connection and try again." }
        switch refused.status {
        case 401: return "Sign-in expired. Pair this headset again."
        case 403: return list.flatMap { $0.full ? full($0) : nil } ?? "This account cannot connect an agent."
        case 404: return "This server doesn't connect agents yet."
        case 429: return "Too many codes just now. Try again in a few minutes."
        default: return "The server refused. Try again in a moment."
        }
    }
}
