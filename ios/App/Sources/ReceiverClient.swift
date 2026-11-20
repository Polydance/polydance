// The receiver's thread routes over the network (docs/IPHONE.md I3): each call builds its request with
// PolydancePhoneCore's ThreadRequests from the phone's Pairing and decodes the reply there, so this file is
// only the I/O; photos are sent and fetched the same way (PhotoRequests). An ephemeral session: no cookies, cache or credentials on disk. A reply is never logged,
// and nor is the token; a failure is a ReceiverError with the receiver's own reason, or the network's.
import Foundation
import PolydancePhoneCore
import PolydanceShared

struct ReceiverClient: Sendable {
    let pairing: Pairing

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.urlCache = nil
        // The inbox is small: any network will do, mobile data included (docs/IPHONE.md U3 holds back only video).
        c.allowsExpensiveNetworkAccess = true
        c.allowsConstrainedNetworkAccess = true
        return URLSession(configuration: c)
    }()

    func listing(archived: Bool = false) async throws -> ThreadListing {
        try await decode(ThreadListing.self, ThreadRequests.list(pairing, archived: archived), "an inbox")
    }

    func thread(_ key: String) async throws -> ThreadDetail {
        try await decode(ThreadDetail.self, ThreadRequests.thread(pairing, key: key), "a thread")
    }

    func markRead(_ key: String, seq: Int) async throws -> ThreadDetail {
        try await decode(ThreadDetail.self, ThreadRequests.read(pairing, key: key, seq: seq), "a thread")
    }

    func react(_ key: String, message: Int, reaction: String) async throws -> ThreadDetail {
        try await decode(ThreadDetail.self, ThreadRequests.react(pairing, key: key, message: message, reaction: reaction), "a thread")
    }

    func pick(_ key: String, message: Int, launch: Int) async throws -> ThreadDetail {
        try await decode(ThreadDetail.self, ThreadRequests.pick(pairing, key: key, message: message, launch: launch), "a thread")
    }

    func archive(_ key: String, archived: Bool) async throws -> ThreadDetail {
        try await decode(ThreadDetail.self, ThreadRequests.archive(pairing, key: key, archived: archived), "a thread")
    }

    func hide(_ key: String, hidden: Bool) async throws {
        let (data, status) = try await send(ThreadRequests.hide(pairing, key: key, hidden: hidden))
        try ReceiverReply.check(status: status, body: data)
    }

    /// A photo for a thread about to be opened in `project`, or for a message in thread `key`; the reply names it.
    func sendPhoto(_ photo: PreparedPhoto, project: String) async throws -> PhotoReply {
        try await decode(PhotoReply.self, PhotoRequests.send(pairing, project: project, photo), "a photo's receipt")
    }

    func sendPhoto(_ photo: PreparedPhoto, thread key: String) async throws -> PhotoReply {
        try await decode(PhotoReply.self, PhotoRequests.send(pairing, thread: key, photo), "a photo's receipt")
    }

    /// A new thread whose first message is the photos already sent to its project (Robin, 2026-11-13).
    func openThread(project: String, title: String, text: String?, photos: [String], deliveryId: String) async throws -> ThreadDetail {
        try await decode(ThreadDetail.self, PhotoRequests.open(pairing, project: project, title: title, text: text, photos: photos, deliveryId: deliveryId), "a thread")
    }

    func postPhotos(thread key: String, text: String?, photos: [String], deliveryId: String) async throws -> ThreadDetail {
        try await decode(ThreadDetail.self, PhotoRequests.post(pairing, thread: key, text: text, photos: photos, deliveryId: deliveryId), "a thread")
    }

    /// A photo a message in thread `key` holds, refused unless its bytes are the sha256 it is named by.
    func photo(thread key: String, sha256: String) async throws -> Data {
        let (data, status) = try await send(PhotoRequests.fetch(pairing, thread: key, sha256: sha256))
        try ReceiverReply.check(status: status, body: data)
        guard PhotoPrep.matches(data, sha256: sha256) else { throw ReceiverError(status: status, reason: "the photo that came is not the one asked for") }
        return data
    }

    /// A project of this person's own (2026-11-13): its key, and the projects this token sees now.
    func newProject(_ name: String) async throws -> NewProjectReply {
        try await decode(NewProjectReply.self, ThreadRequests.newProject(pairing, name: name), "a project")
    }

    /// This person's connected agents, a code to connect another, and disconnecting one (2026-11-20, Agents.swift).
    func agents() async throws -> AgentList { try await decode(AgentList.self, AgentRequests.list(pairing), "a list of agents") }

    func agentCode() async throws -> AgentCode { try await decode(AgentCode.self, AgentRequests.code(pairing), "a code") }

    func disconnectAgent(_ id: String) async throws {
        let (data, status) = try await send(AgentRequests.disconnect(pairing, id: id))
        try ReceiverReply.check(status: status, body: data)
    }

    func me() async throws -> MeReply { try await decode(MeReply.self, ThreadRequests.me(pairing), "who this token is") }

    func account() async throws -> AccountReply { try await decode(AccountReply.self, UploadRequests.account(pairing), "an account") }

    private func decode<T: Decodable>(_ type: T.Type, _ request: URLRequest, _ what: String) async throws -> T {
        let (data, status) = try await send(request)
        return try ReceiverReply.decode(type, status: status, body: data, what: what)
    }

    private func send(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await Self.session.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch let error as URLError {
            throw ReceiverError(status: 0, reason: Self.words(error))
        }
    }

    /// The network's failure in words a person reads on the deck.
    static func words(_ error: URLError) -> String {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost: return "no network"
        case .timedOut: return "the receiver did not answer in time"
        case .cannotFindHost, .dnsLookupFailed: return "the receiver's name was not found"
        case .cannotConnectToHost: return "the receiver refused the connection"
        case .cancelled: return "cancelled"
        default: return "the network failed (\(error.code.rawValue))"
        }
    }
}
