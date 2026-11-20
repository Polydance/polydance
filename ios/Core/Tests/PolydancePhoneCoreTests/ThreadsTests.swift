// Threads on the phone (docs/IPHONE.md P2, P3 and I3): the pairing as the Keychain keeps it, where a take
// goes, the thread requests, the receiver's replies, reply notices and what happens to a report. The
// replies are Fixtures/, what a `polycap serve` with threads on (ios/tools/serve-local.sh) answered the
// phone's upload token on 2026-11-07 after an agent opened CAP-1 and posted two options; the token is not
// in them. No network.
import Foundation
import PolydanceShared
import Security
import Testing
@testable import PolydancePhoneCore

private let token = "polycap_" + String(repeating: "cd", count: 32)
private let pairing = try! Pairing(server: "https://capture.polydance.net", token: token)

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/\(name)"))
}

private func json(_ data: Data?) throws -> NSDictionary {
    let bytes = try #require(data)
    return try #require(JSONSerialization.jsonObject(with: bytes) as? NSDictionary)
}

@Suite struct PairingTests {
    @Test func theKeychainKeepsWhatDecodesBack() throws {
        let local = try Pairing(server: "http://Robins-Mac.local:8790", token: token)
        #expect(try Pairing.decode(local.json()) == local)
        #expect(local.place == "robins-mac.local:8790")
        #expect(local.isLocal)
        #expect(pairing.place == "capture.polydance.net")
        #expect(!pairing.isLocal)
        // The payload the Mac draws is the same JSON: v, server, token and nothing else.
        #expect(try json(pairing.json()) == ["v": 1, "server": "https://capture.polydance.net", "token": token])
    }

    @Test func theTokenIsKeptAfterFirstUnlockOnThisDeviceOnly() throws {
        let attributes = PairingKeychain.attributes(pairing)
        #expect(attributes[kSecAttrAccessible as String] as! CFString == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        #expect(attributes[kSecAttrSynchronizable as String] as! Bool == false)
        let value = try #require(attributes[kSecValueData as String] as? Data)
        #expect(try Pairing.decode(value) == pairing)
        #expect(PairingKeychain.match[kSecClass as String] as! CFString == kSecClassGenericPassword)
        #expect(PairingKeychain.read[kSecReturnData as String] as! Bool == true)
        // The attributes that find the item hold no token.
        #expect(!String(describing: PairingKeychain.match).contains(token))
    }

    @Test func aCodeIsRefusedByNameAndNeverEchoed() {
        #expect(throws: UploadProtocolError("the code", "is not JSON")) { try Pairing.decode(Data("polycap_abc".utf8), source: "the code") }
        #expect(throws: UploadProtocolError("url", "is not a key of a pairing (v, server, token)")) {
            try Pairing.decode(Data(#"{"v":1,"server":"https://x.net","token":"t","url":"https://x.net"}"#.utf8))
        }
    }
}

@Suite struct RunThreadTests {
    @Test func encodesAsTheReceiversUploadThreadSchema() throws {
        #expect(try json(RunThread.replying(to: "MUS-12").json()) == ["key": "MUS-12"])
        #expect(try json(RunThread.replying(to: "MUS-12", replyTo: .init(message: 3, launch: 0)).json()) == ["key": "MUS-12", "replyTo": ["message": 3, "launch": 0]])
        #expect(try json(RunThread.replying(to: "CAP-1", replyTo: .init(message: 2)).json()) == ["key": "CAP-1", "replyTo": ["message": 2]])
        #expect(try json(RunThread.opening(in: "MUS").json()) == ["project": "MUS"])
        #expect(try json(RunThread.report.json()) == ["report": true])
        for thread in [try RunThread.replying(to: "MUS-12", replyTo: .init(message: 3, launch: 1)), .newThread(project: "CAP"), .report] {
            #expect(try RunThread.decode(thread.json()) == thread)
        }
    }

    @Test func refusesWhatTheReceiverWould() {
        let cases: [(String, String)] = [
            (#"{"key":"mus-12"}"#, "thread.key"),
            (#"{"key":"MUS-0"}"#, "thread.key"),
            (#"{"key":"MUS-12","replyTo":{"message":0}}"#, "thread.replyTo.message"),
            (#"{"key":"MUS-12","replyTo":{"message":2,"launch":-1}}"#, "thread.replyTo.launch"),
            (#"{"key":"MUS-12","replyTo":{"message":2,"option":1}}"#, "thread.replyTo.option"),
            (#"{"project":"M"}"#, "thread.project"),
            (#"{"project":"MUS","replyTo":{"message":2}}"#, "thread.replyTo"),
            (#"{"report":false}"#, "thread.report"),
            (#"{"report":1}"#, "report"),
            (#"{"key":"MUS-12","project":"MUS"}"#, "thread"),
            (#"{}"#, "thread"),
            (#"{"key":"MUS-12","to":"x"}"#, "thread.to"),
            ("[]", "thread.json"),
            ("{", "thread.json"),
        ]
        for (text, field) in cases {
            var error: UploadProtocolError?
            do { _ = try RunThread.decode(Data(text.utf8)) } catch let e as UploadProtocolError { error = e } catch {}
            #expect(error?.field == field, "\(text) -> \(String(describing: error))")
        }
    }

    @Test func theUploadCarriesIt() throws {
        let meta = RunMeta(runName: "20261107-221500", recordedAt: "2026-11-07T22:15:00.000+00:00", device: ["model": "iPhone17,3", "system": "iOS 27.2"],
                           appVersion: "0.1.0", appCommit: "5b5d0c2", orientation: "portrait", width: 1080, height: 1920, fps: 30)
        let body = try CreateUploadBody(installId: "0123456789abcdef", runName: "20261107-221500", meta: meta, videoBytes: 10,
                                        videoSha256: String(repeating: "a", count: 64), narration: nil, thread: .replying(to: "CAP-1"))
        #expect(try json(body.json())["thread"] as? NSDictionary == ["key": "CAP-1"])
        let report = try CreateUploadBody(installId: "0123456789abcdef", runName: "20261107-221500", meta: meta, videoBytes: 10,
                                          videoSha256: String(repeating: "a", count: 64), narration: nil, thread: .report)
        #expect(try json(report.json())["thread"] as? NSDictionary == ["report": true])
    }

    @Test func aRunKeepsItsThreadInAPrivateFile() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("runthread-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let run = try RunFolder.create(in: root, at: Date(timeIntervalSince1970: 1_800_000_000), timeZone: TimeZone(identifier: "UTC")!)
        #expect(try run.readThread() == nil)
        try run.writeThread(.newThread(project: "CAP"))
        #expect(try run.readThread() == .newThread(project: "CAP"))
        let mode = try FileManager.default.attributesOfItem(atPath: run.threadURL.path)[.posixPermissions] as? NSNumber
        #expect(mode?.intValue == 0o600)
        try Data("{\"key\":\"nope\"}".utf8).write(to: run.threadURL)
        #expect(throws: UploadProtocolError.self) { try run.readThread() }
    }
}

@Suite struct ThreadRequestTests {
    func body(_ r: URLRequest) throws -> NSDictionary { try json(r.httpBody) }

    @Test func theHeadsetsRoutesWithTheBearerToken() throws {
        let cases: [(URLRequest, String, String)] = [
            (ThreadRequests.projects(pairing), "GET", "/v1/projects"),
            (ThreadRequests.list(pairing), "GET", "/v1/threads?state=open"),
            (ThreadRequests.list(pairing, archived: true), "GET", "/v1/threads?state=closed"),
            (try ThreadRequests.thread(pairing, key: "CAP-1"), "GET", "/v1/threads/CAP-1"),
            (try ThreadRequests.read(pairing, key: "CAP-1", seq: 4), "POST", "/v1/threads/CAP-1/read"),
            (try ThreadRequests.react(pairing, key: "CAP-1", message: 2, reaction: "thumbs-up"), "POST", "/v1/threads/CAP-1/reactions"),
            (try ThreadRequests.pick(pairing, key: "CAP-1", message: 2, launch: 1), "POST", "/v1/threads/CAP-1/picks"),
            (try ThreadRequests.archive(pairing, key: "CAP-1", archived: true), "POST", "/v1/threads/CAP-1/state"),
            (try ThreadRequests.hide(pairing, key: "CAP-1", hidden: true), "POST", "/v1/threads/CAP-1/hide"),
            (try ThreadRequests.hide(pairing, key: "CAP-1", hidden: false), "POST", "/v1/threads/CAP-1/unhide"),
            (ThreadRequests.me(pairing), "GET", "/v1/me"),
            (try ThreadRequests.newProject(pairing, name: "Spottisphone"), "POST", "/v1/projects"),
        ]
        for (request, method, path) in cases {
            #expect(request.httpMethod == method)
            #expect(request.url?.absoluteString == "https://capture.polydance.net" + path)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
        }
    }

    @Test func bodiesAreTheRoutesSchemas() throws {
        // thread-routes.ts readSchema, reactionSchema, pickSchema and stateSchema: strict objects.
        #expect(try body(ThreadRequests.read(pairing, key: "CAP-1", seq: 4)) == ["seq": 4])
        #expect(try body(ThreadRequests.react(pairing, key: "CAP-1", message: 2, reaction: "heart")) == ["message": 2, "reaction": "heart"])
        #expect(try body(ThreadRequests.pick(pairing, key: "CAP-1", message: 2, launch: 0)) == ["message": 2, "launch": 0])
        #expect(try body(ThreadRequests.archive(pairing, key: "CAP-1", archived: true)) == ["state": "closed"])
        #expect(try body(ThreadRequests.archive(pairing, key: "CAP-1", archived: false)) == ["state": "open"])
        // src/threads.ts newProjectSchema: the name alone, trimmed; the receiver makes the key.
        #expect(try body(ThreadRequests.newProject(pairing, name: "  Spottisphone ")) == ["name": "Spottisphone"])
        let hide = try ThreadRequests.hide(pairing, key: "CAP-1", hidden: true)
        #expect(hide.httpBody == nil)
        #expect(hide.value(forHTTPHeaderField: "Content-Length") == "0")
        #expect(try ThreadRequests.react(pairing, key: "CAP-1", message: 2, reaction: "heart").value(forHTTPHeaderField: "Content-Type") == "application/json")
    }

    @Test func refusesWhatTheReceiverWould() {
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.thread(pairing, key: "CAP-1/../../v1/uploads") }
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.thread(pairing, key: "cap-1") }
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.react(pairing, key: "CAP-1", message: 2, reaction: "wave") }
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.react(pairing, key: "CAP-1", message: 0, reaction: "heart") }
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.pick(pairing, key: "CAP-1", message: 2, launch: 6) }
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.read(pairing, key: "CAP-1", seq: -1) }
    }

    @Test func theReactionsAreTheReceiversSix() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath).appendingPathComponent("../../../../../src/threads.ts").standardized, encoding: .utf8)
        let line = try #require(source.split(separator: "\n").first { $0.contains("export const REACTIONS = {") })
        let names = line.matches(of: /(?:'([a-z-]+)'|([a-z]+)):/).map { String($0.output.1 ?? $0.output.2 ?? "") }
        #expect(names == ThreadRequests.reactions)
        #expect(Set(ThreadMessage.reactionSymbols.keys) == Set(ThreadRequests.reactions))
    }
}

@Suite struct ReceiverReplyTests {
    @Test func theInboxAsTheReceiverListsIt() throws {
        let listing = try ReceiverReply.decode(ThreadListing.self, status: 200, body: fixture("threads-open.json"), what: "an inbox")
        #expect(listing.me == "iphone-probe")
        #expect(listing.projects == [ProjectRef(key: "CAP", name: "Polydance Capture"), ProjectRef(key: "MUS", name: "Marimba")])
        #expect(listing.reports)
        #expect(listing.unread == 1)
        let row = try #require(listing.threads.first)
        #expect(row.key == "CAP-1")
        #expect(row.unread && row.waiting && row.isNew)
        #expect(row.seq == 2)
        #expect(row.snippet == "Two options to try")
        #expect(row.last.by.who == "Opus 5.5 on Robin's Mac")
        #expect(row.people.map(\.name) == ["Robin"])
    }

    @Test func aThreadWithItsOptionsAndWhatThisTokenSaw() throws {
        let thread = try ReceiverReply.decode(ThreadDetail.self, status: 200, body: fixture("thread-unread.json"), what: "a thread")
        #expect(thread.me == "iphone-probe")
        #expect(thread.project.name == "Polydance Capture")
        #expect(thread.seq == 2)
        #expect(thread.readSeq == 0)
        #expect(thread.unread == true)
        #expect(thread.hasUnseen)
        let options = try #require(thread.ordered.last?.launches)
        #expect(options.enumerated().map { $1.title(index: $0, of: options.count) } == ["Option 1: Plain", "Option 2: Fancy"])
        #expect(options.map { $0.macLinks.map(\.absoluteString) } == [["https://example.com/plain"], ["https://example.com/fancy"]])
        #expect(thread.ordered.map(\.seq) == [1, 2])

        let read = try ReceiverReply.decode(ThreadDetail.self, status: 200, body: fixture("read.json"), what: "a thread")
        #expect(read.readSeq == 4 && read.unread == false && !read.hasUnseen)
        let message = try #require(read.ordered.last)
        #expect(read.myReaction(on: message) == "thumbs-up")
        #expect(read.myPick(on: message) == 1)
        #expect(message.reactions.first?.by.who == "Robin · iPhone probe")
        #expect(read.myReaction(on: read.ordered[0]) == nil)
    }

    @Test func whoTheTokenIsAndItsAllowance() throws {
        #expect(try ReceiverReply.decode(MeReply.self, status: 200, body: fixture("me.json"), what: "a person").who == "Robin · iPhone probe")
        let account = try ReceiverReply.decode(AccountReply.self, status: 200, body: fixture("account.json"), what: "an account")
        #expect(account.label == "0.0 OF 8 GB")
        #expect(account.used == 0 && !account.full)
        let busy = AccountReply(usedBytes: 2_400_000_000, allowanceBytes: 8_000_000_000, recordings: 3)
        #expect(busy.label == "2.4 OF 8 GB")
        #expect(abs(busy.used - 0.3) < 0.0001)
        #expect(AccountReply(usedBytes: 9_000_000_000, allowanceBytes: 8_000_000_000, recordings: 9).full)
        let projects = try ReceiverReply.decode(ProjectsReply.self, status: 200, body: fixture("projects.json"), what: "projects")
        #expect(projects.capabilities.contains("reports-v1"))
    }

    /// A project of your own (2026-11-13): replies from a `polycap serve` that day, the phone's upload token making
    /// Spottisphone, then asking for its key again.
    @Test func aProjectOfYourOwn() throws {
        let made = try ReceiverReply.decode(NewProjectReply.self, status: 201, body: fixture("project-made.json"), what: "a project")
        #expect(made.project == ProjectRef(key: "SPOT", name: "Spottisphone", mine: true))
        #expect(made.projects.map(\.mine) == [false, false, true])
        let listing = try ReceiverReply.decode(ThreadListing.self, status: 200, body: fixture("threads-own.json"), what: "an inbox")
        #expect(listing.newProjects)
        #expect(listing.projects.last == ProjectRef(key: "SPOT", name: "Spottisphone", mine: true))
        // An older receiver says neither: everything is the team's, and there is no New project.
        let older = try ReceiverReply.decode(ThreadListing.self, status: 200, body: fixture("threads-open.json"), what: "an inbox")
        #expect(!older.newProjects)
        #expect(older.projects.allSatisfy { !$0.mine })
        #expect(throws: ReceiverError(status: 409, reason: "SPOT is taken; choose another key, or leave it out and one is made from the name")) {
            try ReceiverReply.decode(NewProjectReply.self, status: 409, body: fixture("refused-project.json"), what: "a project")
        }
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.newProject(pairing, name: "   ") }
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.newProject(pairing, name: String(repeating: "a", count: 61)) }
        #expect(throws: UploadProtocolError.self) { try ThreadRequests.newProject(pairing, name: "Two\nlines") }
    }

    @Test func aRefusalIsTheReceiversReasonInAFewWords() throws {
        #expect(throws: ReceiverError(status: 404, reason: "no thread CAP-99")) {
            try ReceiverReply.decode(ThreadDetail.self, status: 404, body: fixture("refused-key.json"), what: "a thread")
        }
        #expect(throws: ReceiverError(status: 403, reason: "posting words needs scope post; this token may post photos, with or without words")) {
            try ReceiverReply.check(status: 403, body: fixture("refused-post.json"))
        }
        #expect(throws: ReceiverError(status: 200, reason: "the reply is not a thread")) {
            try ReceiverReply.decode(ThreadDetail.self, status: 200, body: Data("<html>".utf8), what: "a thread")
        }
        #expect(throws: ReceiverError(status: 502, reason: "HTTP 502")) { try ReceiverReply.check(status: 502, body: Data()) }
        #expect(ReceiverError(status: 404, reason: "no thread CAP-99").description == "HTTP 404: no thread CAP-99")
        #expect(ReceiverError(status: 0, reason: "the network is down").description == "the network is down")
    }

    @Test func aListingWithAKeyThatIsNotOneIsRefused() throws {
        var text = String(decoding: try fixture("threads-open.json"), as: UTF8.self)
        text = text.replacingOccurrences(of: "\"key\": \"CAP-1\"", with: "\"key\": \"../uploads\"")
        #expect(throws: ReceiverError.self) { try ReceiverReply.decode(ThreadListing.self, status: 200, body: Data(text.utf8), what: "an inbox") }
    }
}

@Suite struct ReplyNoticeTests {
    func listing() throws -> ThreadListing { try ReceiverReply.decode(ThreadListing.self, status: 200, body: fixture("threads-open.json"), what: "an inbox") }
    func unread() throws -> ThreadDetail { try ReceiverReply.decode(ThreadDetail.self, status: 200, body: fixture("thread-unread.json"), what: "a thread") }

    @Test func looksIntoUnreadThreadsThatMovedOn() throws {
        let threads = try listing().threads
        #expect(ReplyNotices.plan(threads, told: [:]) == (fetch: ["CAP-1"], clear: []))
        #expect(ReplyNotices.plan(threads, told: ["CAP-1": 2]) == (fetch: [], clear: []))
        var read = threads
        read[0].unread = false
        #expect(ReplyNotices.plan(read, told: [:]) == (fetch: [], clear: ["CAP-1"]))
    }

    @Test func oneNoticePerThreadForWhatOthersSent() throws {
        let (notice, seq) = ReplyNotices.notice(for: try unread(), told: 0)
        #expect(notice == .init(key: "CAP-1", title: "CAP-1 · The phone reads threads", body: "Opus 5.5 on Robin's Mac: Two options to try (and 1 more)"))
        #expect(seq == 2)
        // Told up to the first message: only the second is new.
        #expect(ReplyNotices.notice(for: try unread(), told: 1).notice?.body == "Opus 5.5 on Robin's Mac: Two options to try")
        #expect(ReplyNotices.notice(for: try unread(), told: 2).notice == nil)
        // This token's own messages are never news to it.
        var mine = try unread()
        mine.me = "agent"
        #expect(ReplyNotices.notice(for: mine, told: 0).notice == nil)
        // What this token already read is not news either.
        var seen = try unread()
        seen.readSeq = 2
        #expect(ReplyNotices.notice(for: seen, told: 0).notice == nil)
    }

    @Test func aMessageInAFewWords() throws {
        var detail = try unread()
        detail.messages[1].text = "\n  \nFirst real line\nsecond"
        #expect(ReplyNotices.notice(for: detail, told: 1).notice?.body == "Opus 5.5 on Robin's Mac: First real line")
        detail.messages[1].text = nil
        #expect(ReplyNotices.notice(for: detail, told: 1).notice?.body == "Opus 5.5 on Robin's Mac: something to try")
        detail.messages[1].launches = nil
        #expect(ReplyNotices.notice(for: detail, told: 1).notice?.body == "Opus 5.5 on Robin's Mac: a message")
    }

    @Test func theLedgerIsStrictAndPrivate() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("notices-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(try NoticeLedger.load(url) == NoticeLedger())
        var ledger = NoticeLedger(told: ["CAP-1": 2])
        ledger.shown(try listing().threads)
        #expect(ledger.told == ["CAP-1": 2])
        ledger.told["CAP-1"] = 1
        ledger.shown(try listing().threads)
        #expect(ledger.told == ["CAP-1": 2])
        try ledger.save(url)
        #expect(try NoticeLedger.load(url) == ledger)
        #expect((try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        try Data(#"{"v":1,"told":{"CAP-1":2},"extra":true}"#.utf8).write(to: url)
        #expect(throws: UploadProtocolError("extra", "is not a key of notices.json (v, told)")) { try NoticeLedger.load(url) }
        try Data(#"{"v":1,"told":{"../x":2}}"#.utf8).write(to: url)
        #expect(throws: UploadProtocolError.self) { try NoticeLedger.load(url) }
    }
}

@Suite struct ReportPolicyTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func goesOnceTheReceiverHasItAndAfterAWeekUnsent() {
        let hourAgo = now.addingTimeInterval(-3600), weekAgo = now.addingTimeInterval(-8 * 24 * 3600)
        #expect(ReportPolicy.decide(phase: .done, recording: false, recordedAt: hourAgo, now: now) == .delete("the receiver has it"))
        #expect(ReportPolicy.decide(phase: nil, recording: false, recordedAt: hourAgo, now: now) == .send)
        #expect(ReportPolicy.decide(phase: .failed, recording: false, recordedAt: hourAgo, now: now) == .send)
        #expect(ReportPolicy.decide(phase: .content, recording: false, recordedAt: hourAgo, now: now) == .keep)
        #expect(ReportPolicy.decide(phase: .narration, recording: false, recordedAt: weekAgo, now: now) == .keep)
        #expect(ReportPolicy.decide(phase: nil, recording: true, recordedAt: weekAgo, now: now) == .keep)
        #expect(ReportPolicy.decide(phase: .failed, recording: false, recordedAt: weekAgo, now: now) == .delete("unsent after a week"))
        #expect(ReportPolicy.decide(phase: nil, recording: false, recordedAt: nil, now: now) == .delete("its run.json gives no time, so its age is unknown"))
    }

    @Test func readsRunJsonsTime() {
        #expect(ReportPolicy.date("2026-11-07T22:15:00.250+00:00") == Date(timeIntervalSince1970: 1_794_089_700.25))
        #expect(ReportPolicy.date("2026-11-07T22:15:00Z") == Date(timeIntervalSince1970: 1_794_089_700))
        #expect(ReportPolicy.date("yesterday") == nil)
    }
}
