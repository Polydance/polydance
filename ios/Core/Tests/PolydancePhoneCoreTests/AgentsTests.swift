// Connecting your own agent (docs/THREADS.md, 2026-11-20): the requests a device makes, the receiver's replies
// in the shapes src/server/agents.ts answers, and the words the headsets show. The same cases as the Quest's
// AgentsTest.kt, so the two say the same things. No network.
import Foundation
import PolydanceShared
import Testing
@testable import PolydancePhoneCore

private let token = "polycap_" + String(repeating: "cd", count: 32)
private let pairing = try! Pairing(server: "https://receiver.example", token: token)
private let london = TimeZone(identifier: "Europe/London")!
private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

private let listed = Data("""
{"me":"meta-2001","limit":5,"agents":[
 {"id":"paired-0a1b2c3d","label":"Mac","connectedAt":"2026-11-12T09:30:00Z","connectedFrom":"Quest 3","expiresAt":"2027-02-10T09:30:00Z","lastUsedOn":"2026-11-20"},
 {"id":"paired-99887766","label":"Studio Linux","connectedAt":"2026-08-03T10:00:00Z","connectedFrom":"Quest 3","expiresAt":"2026-11-01T10:00:00Z","expired":true},
 {"id":"mac","label":"Not one of these"}]}
""".utf8)

@Suite struct AgentsTests {
    @Test func theRequestsAreTheReceiversRoutes() throws {
        let list = AgentRequests.list(pairing)
        #expect(list.httpMethod == "GET" && list.url?.path == "/v1/agents")
        #expect(list.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
        let code = AgentRequests.code(pairing)
        #expect(code.httpMethod == "POST" && code.url?.path == "/v1/agents/codes")
        let gone = try AgentRequests.disconnect(pairing, id: "paired-0a1b2c3d")
        #expect(gone.httpMethod == "DELETE" && gone.url?.path == "/v1/agents/paired-0a1b2c3d")
        // Anything that is not an agent's id never reaches a path.
        for bad in ["self", "mac", "paired-0A1B2C3D", "paired-0a1b2c3d/../x", ""] {
            #expect(throws: UploadProtocolError.self) { try AgentRequests.disconnect(pairing, id: bad) }
        }
    }

    @Test func theListKeepsOnlyAgentsItCanNameAndCountsThoseThatWork() throws {
        let list = try ReceiverReply.decode(AgentList.self, status: 200, body: listed, what: "a list of agents")
        #expect(list.agents.map(\.id) == ["paired-0a1b2c3d", "paired-99887766"])
        #expect(list.connected.map(\.label) == ["Mac"])
        #expect(list.limit == 5 && !list.full)
        #expect(throws: ReceiverError.self) { try ReceiverReply.decode(AgentList.self, status: 200, body: Data("{}".utf8), what: "a list of agents") }
    }

    @Test func aCodeIsReadOnlyInItsOwnShape() throws {
        let code = try ReceiverReply.decode(AgentCode.self, status: 201, body: Data(#"{"code":"K7QF-2MXD","expiresAt":"2026-11-20T12:10:00Z","agents":1,"limit":5}"#.utf8), what: "a code")
        #expect(code == AgentCode(code: "K7QF-2MXD", expiresAt: at("2026-11-20T12:10:00Z")))
        for bad in [#"{"code":"k7qf-2mxd","expiresAt":"2026-11-20T12:10:00Z"}"#, #"{"code":"K7QF2MXD","expiresAt":"2026-11-20T12:10:00Z"}"#,
                    #"{"code":"K7QF-2MX0","expiresAt":"2026-11-20T12:10:00Z"}"#, #"{"code":"K7QF-2MXD","expiresAt":"soon"}"#] {
            #expect(throws: ReceiverError.self) { try ReceiverReply.decode(AgentCode.self, status: 201, body: Data(bad.utf8), what: "a code") }
        }
        #expect(throws: ReceiverError(status: 429, reason: "too many codes; try again in a few minutes")) {
            try ReceiverReply.decode(AgentCode.self, status: 429, body: Data(#"{"error":"too many codes; try again in a few minutes","reason":"slow_down"}"#.utf8), what: "a code")
        }
    }

    @Test func theCodesClockRunsDownToNothing() {
        let asked = at("2026-11-20T12:00:00Z")
        let code = AgentCode(code: "K7QF-2MXD", expiresAt: asked.addingTimeInterval(AgentWords.codeSeconds))
        #expect(AgentWords.command(code) == "polycap connect K7QF-2MXD")
        #expect(AgentWords.left(code, now: asked) == "10:00 left")
        #expect(AgentWords.left(code, now: asked.addingTimeInterval(19)) == "9:41 left")
        #expect(AgentWords.left(code, now: asked.addingTimeInterval(18.5)) == "9:42 left")
        #expect(AgentWords.left(code, now: asked.addingTimeInterval(599.999)) == "0:01 left")
        #expect(AgentWords.left(code, now: asked.addingTimeInterval(600)) == nil)
        #expect(AgentWords.fraction(code, now: asked) == 1)
        #expect(AgentWords.fraction(code, now: asked.addingTimeInterval(300)) == 0.5)
        #expect(AgentWords.fraction(code, now: asked.addingTimeInterval(700)) == 0)
        #expect(AgentWords.fraction(code, now: asked.addingTimeInterval(-60)) == 1)
    }

    @Test func anAgentsLineSaysWhenItWasConnectedUsedAndRunsOut() throws {
        let list = try ReceiverReply.decode(AgentList.self, status: 200, body: listed, what: "a list of agents")
        let now = at("2026-11-20T15:00:00Z")
        #expect(AgentWords.detail(list.agents[0], now: now, zone: london) == "connected 12 Nov from Quest 3  ·  last used today  ·  until 10 Feb")
        #expect(AgentWords.detail(list.agents[0], now: at("2026-11-22T15:00:00Z"), zone: london) == "connected 12 Nov from Quest 3  ·  last used 20 Nov  ·  until 10 Feb")
        #expect(AgentWords.detail(list.agents[1], now: now, zone: london) == "connected 3 Aug from Quest 3  ·  not used yet  ·  ran out 1 Nov")
        // What the receiver did not say is left out.
        let bare = try JSONDecoder().decode(ConnectedAgent.self, from: Data(#"{"id":"paired-0a1b2c3d"}"#.utf8))
        #expect(bare.label == "Computer")
        #expect(AgentWords.detail(bare, now: now, zone: london) == "not used yet")
    }

    @Test func theInboxOffersItOnlyWhenNoAgentWorksAndTheCardIsNotPutAway() throws {
        let one = try ReceiverReply.decode(AgentList.self, status: 200, body: listed, what: "a list of agents")
        let none = try JSONDecoder().decode(AgentList.self, from: Data(#"{"agents":[],"limit":5}"#.utf8))
        let lapsed = try JSONDecoder().decode(AgentList.self, from: Data(#"{"agents":[{"id":"paired-99887766","expired":true}],"limit":5}"#.utf8))
        #expect(AgentWords.offer(supported: true, list: none, dismissed: false))
        #expect(AgentWords.offer(supported: true, list: lapsed, dismissed: false))
        #expect(!AgentWords.offer(supported: true, list: one, dismissed: false))
        #expect(!AgentWords.offer(supported: true, list: none, dismissed: true))
        // An older receiver, or a list not read yet: nothing is offered on a guess.
        #expect(!AgentWords.offer(supported: false, list: none, dismissed: false))
        #expect(!AgentWords.offer(supported: true, list: nil, dismissed: false))
    }

    @Test func fiveIsFullAndARefusalIsSaidInWords() throws {
        let ids = (1...5).map { #"{"id":"paired-0000000\#($0)"}"# }.joined(separator: ",")
        let full = try JSONDecoder().decode(AgentList.self, from: Data(#"{"agents":[\#(ids)],"limit":5}"#.utf8))
        #expect(full.full)
        #expect(AgentWords.full(full) == "You have 5 agents connected, which is as many as one person may. Disconnect one first.")
        #expect(AgentWords.problem(ReceiverError(status: 403, reason: "token lacks scope"), list: full) == AgentWords.full(full))
        #expect(AgentWords.problem(ReceiverError(status: 403, reason: "token lacks scope"), list: nil) == "This account cannot connect an agent.")
        #expect(AgentWords.problem(ReceiverError(status: 404, reason: "not found"), list: nil) == "This server doesn't connect agents yet.")
        #expect(AgentWords.problem(ReceiverError(status: 429, reason: "too many codes"), list: nil) == "Too many codes just now. Try again in a few minutes.")
        #expect(AgentWords.problem(ReceiverError(status: 0, reason: "no network"), list: nil) == "Can't reach the server. Check the connection and try again.")
    }

    @Test func theWelcomesAnswerIsKnownByItsSenderAndItsName() throws {
        func message(by: String, delivery: String?) throws -> ThreadMessage {
            let named = delivery.map { #","deliveryId":"\#($0)""# } ?? ""
            return try JSONDecoder().decode(ThreadMessage.self, from: Data(#"{"id":2,"at":"2026-11-20T12:00:00Z","by":{"id":"\#(by)","name":"Polydance"},"text":"Here is what Polydance made of your recording"\#(named)}"#.utf8))
        }
        #expect(AgentWords.isWelcomeAnswer(try message(by: "polydance", delivery: "welcome-next")))
        // The Welcome's first message, and anyone else's message that borrows the name.
        #expect(!AgentWords.isWelcomeAnswer(try message(by: "polydance", delivery: nil)))
        #expect(!AgentWords.isWelcomeAnswer(try message(by: "paired-0a1b2c3d", delivery: "welcome-next")))
    }

    @Test func anInboxSaysWhetherItConnectsAgents() throws {
        func listing(_ extra: String) throws -> ThreadListing {
            try JSONDecoder().decode(ThreadListing.self, from: Data(#"{"me":"meta-2001","projects":[],"unread":0,"reports":true\#(extra),"threads":[]}"#.utf8))
        }
        #expect(try listing(#","agents":true"#).agents)
        #expect(try !listing("").agents)
    }
}
