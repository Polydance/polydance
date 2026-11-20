// The receiver's upload protocol as the phone speaks it (docs/IPHONE.md U1, U2), checked against what
// src/server/http.ts and uploads.ts accept. No network: requests are built and replies decoded from bytes
// shaped like the receiver's own (tests/receiver.test.ts, tests/threads.test.ts).
import Foundation
import Testing
@testable import PolydancePhoneCore

private let token = "polycap_" + String(repeating: "ab", count: 32)

private func config(_ object: [String: Any]) -> Data {
    try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

private func refused(_ data: Data) -> UploadProtocolError? {
    do { _ = try Pairing.decode(data); return nil } catch let e as UploadProtocolError { return e } catch { return nil }
}

@Suite struct PairingDecodeTests {
    @Test func takesTheMacOnTheLocalNetworkAndHttps() throws {
        let local = try Pairing.decode(config(["v": 1, "server": "http://Robins-Mac.local:8790", "token": token]))
        #expect(local.server.absoluteString == "http://robins-mac.local:8790")
        #expect(local.token == token)
        #expect(local.endpoint("/v1/uploads").absoluteString == "http://robins-mac.local:8790/v1/uploads")
        #expect(try Pairing.decode(config(["v": 1, "server": "https://capture.polydance.net/", "token": token])).server.absoluteString == "https://capture.polydance.net")
        #expect(try Pairing.decode(config(["v": 1, "server": "http://localhost:8790", "token": token])).server.absoluteString == "http://localhost:8790")
        #expect(try Pairing.decode(config(["v": 1, "server": "http://127.0.0.1:8790/", "token": token])).server.absoluteString == "http://127.0.0.1:8790")
    }

    @Test func refusesWithTheFieldNamed() {
        let cases: [(Data, String)] = [
            (config(["v": 1, "server": "https://capture.polydance.net/v1", "token": token]), "server"),   // a path
            (config(["v": 1, "server": "http://capture.polydance.net", "token": token]), "server"),       // http to a public host
            (config(["v": 1, "server": "http://192.168.1.20:8790", "token": token]), "server"),           // http to a bare LAN address
            (config(["v": 1, "server": "https://capture.polydance.net/?a=1", "token": token]), "server"),
            (config(["v": 1, "server": "https://capture.polydance.net/#x", "token": token]), "server"),
            (config(["v": 1, "server": "https://me:pw@capture.polydance.net", "token": token]), "server"),
            (config(["v": 1, "server": "ftp://capture.polydance.net", "token": token]), "server"),
            (config(["v": 1, "server": "http://[::1]:8790", "token": token]), "server"),
            (config(["v": 1, "server": "capture.polydance.net", "token": token]), "server"),
            (config(["v": 1, "server": "https://capture.polydance.net", "token": token, "user": "robin"]), "user"),   // an extra key
            (config(["v": 2, "server": "https://capture.polydance.net", "token": token]), "v"),
            (config(["v": "1", "server": "https://capture.polydance.net", "token": token]), "v"),
            (config(["v": true, "server": "https://capture.polydance.net", "token": token]), "v"),
            (config(["server": "https://capture.polydance.net", "token": token]), "v"),
            (config(["v": 1, "token": token]), "server"),
            (config(["v": 1, "server": "https://capture.polydance.net"]), "token"),
            (config(["v": 1, "server": "https://capture.polydance.net", "token": ""]), "token"),
            (config(["v": 1, "server": "https://capture.polydance.net", "token": "polycap_ab cd"]), "token"),
            (config(["v": 1, "server": "https://capture.polydance.net", "token": token + "\n"]), "token"),
            (config(["v": 1, "server": "https://capture.polydance.net", "token": 42]), "token"),
            (Data("[1]".utf8), "the pairing"),
            (Data("{\"v\":1,".utf8), "the pairing"),
            (Data(repeating: 0x20, count: 4096), "the pairing"),
        ]
        for (data, field) in cases {
            let error = refused(data)
            #expect(error?.field == field, "\(String(decoding: data, as: UTF8.self)) -> \(String(describing: error))")
        }
    }

    @Test func neverShowsTheToken() throws {
        let c = try Pairing(server: "http://mac.local:8790", token: token)
        var dumped = ""
        dump(c, to: &dumped)
        for text in [String(describing: c), String(reflecting: c), "\(c)", dumped] { #expect(!text.contains(token)) }
        // A refused token is never echoed either.
        let error = refused(config(["v": 1, "server": "https://x.net", "token": "secret value"]))
        #expect(error.map { !String(describing: $0).contains("secret") } == true)
    }

    @Test func aMissingFileSaysSo() {
        let name = "no-such-\(UUID().uuidString).json"
        #expect(throws: UploadProtocolError(name, "is missing")) {
            try Pairing.load(FileManager.default.temporaryDirectory.appendingPathComponent(name))
        }
    }
}

private let meta = RunMeta(runName: "20261106-140501", recordedAt: "2026-11-06T14:05:01.250+00:00",
                           device: ["model": "iPhone14,5", "system": "iOS 26.3", "name": "Robin's iPhone"],
                           appVersion: "0.1.0", appCommit: "73072e4", orientation: "portrait", width: 1080, height: 1920, fps: 30)
private let installId = "0123456789abcdef"
private let videoSha = String(repeating: "a", count: 64)
private let narrationSha = String(repeating: "b", count: 64)

@Suite struct CreateBodyTests {
    /// The keys and shapes are those of the bodies the receiver's own tests send: tests/threads.test.ts
    /// "hears the narration before the video" (clientId, bytes, sha256, fileName, recordedAt, appPackage,
    /// audioTracks, narration { bytes, sha256 }) and tests/receiver.test.ts createBody (device, app
    /// { versionName, commit }), with this phone's values.
    static let fixture = """
    {"app":{"commit":"73072e4","versionName":"0.1.0"},"appPackage":"net.polydance.capture.iphone","audioTracks":["mic"],\
    "bytes":52428800,"clientId":"0123456789abcdef-20261106-140501","device":{"model":"iPhone14,5","system":"iOS 26.3"},\
    "fileName":"net.polydance.capture.iphone-20261106-140501.mp4","narration":{"bytes":480000,"sha256":"\(narrationSha)"},\
    "recordedAt":"2026-11-06T14:05:01.250+00:00","sha256":"\(videoSha)"}
    """
    /// Every key createUploadSchema has (src/server/uploads.ts); it is a strictObject, so nothing else.
    static let schemaKeys: Set<String> = ["clientId", "bytes", "sha256", "fileName", "recordedAt", "appPackage", "device", "apps",
                                          "audioTracks", "app", "thread", "opened", "narration", "consent"]

    func object(_ data: Data) throws -> NSDictionary { try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary) }

    @Test func matchesTheSchemasKeysExactly() throws {
        let body = try CreateUploadBody(installId: installId, runName: "20261106-140501", meta: meta, videoBytes: 52_428_800, videoSha256: videoSha,
                                        narration: .init(bytes: 480_000, sha256: narrationSha))
        let sent = try object(body.json())
        #expect(sent == (try object(Data(Self.fixture.utf8))))
        #expect(Set(sent.allKeys as! [String]).isSubset(of: Self.schemaKeys))
        // The phone's own name never leaves it.
        #expect(!String(decoding: try body.json(), as: UTF8.self).contains("Robin"))
    }

    @Test func leavesOutWhatIsAbsentAndWhatTheSchemaWouldRefuse() throws {
        var m = meta
        m.appCommit = "HEAD; rm -rf"
        let body = try CreateUploadBody(installId: installId, runName: "20261106-140501", meta: m, videoBytes: 10, videoSha256: videoSha, narration: nil)
        let sent = try object(body.json())
        #expect(sent["narration"] == nil)
        #expect(sent["thread"] == nil)
        #expect((sent["app"] as? NSDictionary) == ["versionName": "0.1.0"])
        m.appVersion = "0.1.0 beta"
        #expect(try object(CreateUploadBody(installId: installId, runName: "20261106-140501", meta: m, videoBytes: 10, videoSha256: videoSha, narration: nil).json())["app"] == nil)
    }

    @Test func theAppsBuildReachesTheReceiver() throws {
        // What the app stores in run.json: CFBundleShortVersionString alone and PolydanceCommit as build.sh
        // sets it. The screen's "0.1.0 (1)" is not a versionName the schema takes, so it never goes there.
        var m = meta
        m.appVersion = "0.1.0"
        m.appCommit = "73072e4-dirty"
        let sent = try object(CreateUploadBody(installId: installId, runName: "20261106-140501", meta: m, videoBytes: 10, videoSha256: videoSha, narration: nil).json())
        #expect((sent["app"] as? NSDictionary) == ["versionName": "0.1.0", "commit": "73072e4-dirty"])
        m.appVersion = "0.1.0 (1)"
        #expect(try object(CreateUploadBody(installId: installId, runName: "20261106-140501", meta: m, videoBytes: 10, videoSha256: videoSha, narration: nil).json())["app"] == nil)
    }

    @Test func refusesABodyTheReceiverWould() {
        let run = "20261106-140501"
        #expect(throws: UploadProtocolError.self) { try CreateUploadBody(installId: "XYZ", runName: run, meta: meta, videoBytes: 10, videoSha256: videoSha, narration: nil) }
        #expect(throws: UploadProtocolError.self) { try CreateUploadBody(installId: installId, runName: "20261106-140502", meta: meta, videoBytes: 10, videoSha256: videoSha, narration: nil) }
        #expect(throws: UploadProtocolError.self) { try CreateUploadBody(installId: installId, runName: run, meta: meta, videoBytes: 0, videoSha256: videoSha, narration: nil) }
        #expect(throws: UploadProtocolError.self) { try CreateUploadBody(installId: installId, runName: run, meta: meta, videoBytes: 10, videoSha256: videoSha.uppercased(), narration: nil) }
        #expect(throws: UploadProtocolError.self) {
            try CreateUploadBody(installId: installId, runName: run, meta: meta, videoBytes: 10, videoSha256: videoSha, narration: .init(bytes: CreateUploadBody.maxNarrationBytes + 1, sha256: narrationSha))
        }
        var noOffset = meta
        noOffset.recordedAt = "2026-11-06T14:05:01"
        #expect(throws: UploadProtocolError.self) { try CreateUploadBody(installId: installId, runName: run, meta: noOffset, videoBytes: 10, videoSha256: videoSha, narration: nil) }
        var appSound = meta
        appSound.audioTracks = ["app"]
        #expect(throws: UploadProtocolError("narration", "needs a mic track")) {
            try CreateUploadBody(installId: installId, runName: run, meta: appSound, videoBytes: 10, videoSha256: videoSha, narration: .init(bytes: 4, sha256: narrationSha))
        }
    }
}

@Suite struct ChunkPlanTests {
    let total: Int64 = 20 * 1024 * 1024   // two whole chunks and half of one

    @Test func contentRangesStepThroughTheFile() throws {
        #expect(try ChunkPlan.next(offset: 0, total: total)?.contentRange == "bytes 0-8388607/20971520")
        #expect(try ChunkPlan.next(offset: 8_388_608, total: total)?.contentRange == "bytes 8388608-16777215/20971520")
        let last = try #require(try ChunkPlan.next(offset: 16_777_216, total: total))
        #expect(last.contentRange == "bytes 16777216-20971519/20971520")
        #expect(last.length == 4_194_304)
        #expect(try ChunkPlan.next(offset: total, total: total) == nil)
        // A resumed offset from a 409 that is not on a chunk boundary.
        #expect(try ChunkPlan.next(offset: 1000, total: total)?.contentRange == "bytes 1000-8389607/20971520")
        // An exact multiple ends on the last byte.
        #expect(try ChunkPlan.next(offset: 8_388_608, total: 16_777_216)?.contentRange == "bytes 8388608-16777215/16777216")
    }

    @Test func aFileSmallerThanOneChunkIsOneRequest() throws {
        #expect(try ChunkPlan.next(offset: 0, total: 1000)?.contentRange == "bytes 0-999/1000")
        #expect(try ChunkPlan.next(offset: 0, total: 1)?.contentRange == "bytes 0-0/1")
    }

    @Test func refusesAZeroByteFileAndOffsetsOutsideIt() {
        #expect(throws: UploadProtocolError("bytes", "a zero-byte file cannot be uploaded")) { try ChunkPlan.next(offset: 0, total: 0) }
        #expect(throws: UploadProtocolError.self) { try ChunkPlan.next(offset: -1, total: 10) }
        #expect(throws: UploadProtocolError.self) { try ChunkPlan.next(offset: 11, total: 10) }
        #expect(throws: UploadProtocolError.self) { try ChunkPlan.next(offset: 0, total: 10, chunkBytes: ChunkPlan.maxChunkBytes + 1) }
    }

    @Test func rangesRoundTripThroughText() throws {
        let range = try ByteRange(start: 8_388_608, end: 16_777_215, total: 20_971_520)
        #expect(ByteRange(text: range.text) == range)
        #expect(ByteRange(text: "5-4/10") == nil)
        #expect(ByteRange(text: "0-10/10") == nil)
        #expect(ByteRange(text: "0-1/2 ") == nil)
    }
}

@Suite struct RequestTests {
    let c = try! Pairing(server: "http://mac.local:8790", token: token)
    let id = "up_0123456789abcdef"

    @Test func everyRequestCarriesTheBearerToken() throws {
        let body = try CreateUploadBody(installId: installId, runName: "20261106-140501", meta: meta, videoBytes: 10, videoSha256: videoSha, narration: nil)
        let create = try UploadRequests.create(c, body: body)
        #expect(create.httpMethod == "POST")
        #expect(create.url?.absoluteString == "http://mac.local:8790/v1/uploads")
        #expect(create.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(create.httpBody == (try body.json()))
        let range = try #require(try ChunkPlan.next(offset: 8_388_608, total: 20_971_520))
        let content = try UploadRequests.content(c, uploadId: id, range: range)
        #expect(content.httpMethod == "PUT")
        #expect(content.url?.path == "/v1/uploads/up_0123456789abcdef/content")
        #expect(content.value(forHTTPHeaderField: "Content-Range") == "bytes 8388608-16777215/20971520")
        #expect(content.value(forHTTPHeaderField: "Content-Length") == "8388608")
        let narration = try UploadRequests.narration(c, uploadId: id, bytes: 480_000)
        #expect(narration.url?.path == "/v1/uploads/up_0123456789abcdef/narration")
        #expect(narration.value(forHTTPHeaderField: "Content-Type") == "audio/mp4")
        #expect(narration.value(forHTTPHeaderField: "Content-Length") == "480000")
        let status = try UploadRequests.status(c, uploadId: id)
        #expect(status.httpMethod == "GET")
        #expect(status.url?.path == "/v1/uploads/up_0123456789abcdef")
        for r in [create, content, narration, status, UploadRequests.account(c)] {
            #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
        }
    }

    @Test func theHealthCheckCarriesNoToken() {
        let health = UploadRequests.health(c)
        #expect(health.httpMethod == "GET")
        #expect(health.url?.absoluteString == "http://mac.local:8790/v1/health")
        #expect(health.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(health.timeoutInterval == 15)
    }

    @Test func refusesAnUploadIdThatIsNotOne() {
        #expect(throws: UploadProtocolError.self) { try UploadRequests.status(c, uploadId: "../account") }
        #expect(throws: UploadProtocolError.self) { try UploadRequests.narration(c, uploadId: "up_0123", bytes: 1) }
    }
}

@Suite struct ReplyTests {
    @Test func a409GivesTheOffsetTheReceiverHas() {
        // http.ts: HttpError(409, error.message, { received, status }).
        let reply = ConflictReply.parse(Data(#"{"error":"expected offset 4194304","received":4194304,"status":"uploading"}"#.utf8))
        #expect(reply == ConflictReply.parse(Data(#"{"received":4194304,"status":"uploading","error":"expected offset 4194304"}"#.utf8)))
        #expect(reply?.received == 4_194_304)
        #expect(reply?.status == .uploading)
        // A 409 with no offset (a client id reused, a narration's sha256) is not one to resume from.
        #expect(ConflictReply.parse(Data(#"{"error":"client id x was already used for a different file"}"#.utf8)) == nil)
        #expect(ConflictReply.parse(Data(#"{"received":-1}"#.utf8)) == nil)
        #expect(ConflictReply.parse(Data("<html>".utf8)) == nil)
    }

    @Test func anUploadViewToleratesWhatDescribeUploadAdds() throws {
        let view = try UploadView.decode(Data(#"""
        {"id":"up_0123456789abcdef","clientId":"c","bytes":100,"received":40,"status":"uploading","narration":"received",
         "recordedAt":"2026-11-06T14:05:01+00:00","steps":{"done":3,"total":8},"title":"A title","summary":"Words."}
        """#.utf8))
        #expect(view.received == 40)
        #expect(view.narration == "received")
        #expect(throws: UploadProtocolError.self) { try UploadView.decode(Data(#"{"id":"up_0123456789abcdef","bytes":100,"received":40,"status":"paused"}"#.utf8)) }
        #expect(throws: UploadProtocolError.self) { try UploadView.decode(Data(#"{"id":"up_0123456789abcdef","bytes":100,"received":140,"status":"uploading"}"#.utf8)) }
        #expect(throws: UploadProtocolError.self) { try UploadView.decode(Data(#"{"id":"../x","bytes":100,"received":0,"status":"uploading"}"#.utf8)) }
    }

    @Test func aRefusalIsShortAndNeverTheWholeBody() {
        #expect(UploadProtocol.shortReason(status: 413, body: Data(#"{"error":"chunks are at most 67108864 bytes"}"#.utf8)) == "chunks are at most 67108864 bytes")
        #expect(UploadProtocol.shortReason(status: 502, body: Data("<html>bad gateway</html>".utf8)) == "HTTP 502")
        let long = UploadProtocol.shortReason(status: 400, body: Data(("{\"error\":\"" + String(repeating: "x", count: 500) + "\"}").utf8))
        #expect(long.count == 160)
    }
}

@Suite struct UploadStateTests {
    func view(_ json: String) -> UploadView { try! UploadView.decode(Data(json.utf8)) }
    let now = Date(timeIntervalSince1970: 1_793_973_901)

    func created(narration: Bool = true) -> UploadRunState {
        UploadRunState(created: view(#"{"id":"up_0123456789abcdef","clientId":"c","bytes":20971520,"received":0,"status":"uploading","narration":"expected"}"#),
                       runName: "20261106-140501", runPath: "Library/Application Support/Runs/20261106-140501", clientId: "c", narrationBytes: narration ? 480_000 : nil, allowExpensive: true, now: now)
    }

    @Test func narrationFirstThenTheVideoInChunks() throws {
        var s = created()
        #expect(try s.next() == .narration)
        #expect(s.applyNarration(status: 200, body: Data()) == .next(note: nil))
        #expect(try s.next() == .content(try ByteRange(start: 0, end: 8_388_607, total: 20_971_520)))
        #expect(s.applyContent(status: 200, body: Data(#"{"id":"up_0123456789abcdef","bytes":20971520,"received":8388608,"status":"uploading"}"#.utf8)) == .next(note: nil))
        #expect(s.nextOffset == 8_388_608)
        // A 409 moves to whatever the receiver actually has.
        #expect(s.applyContent(status: 409, body: Data(#"{"error":"expected offset 9000000","received":9000000,"status":"uploading"}"#.utf8)) == .next(note: nil))
        #expect(try s.next() == .content(try ByteRange(start: 9_000_000, end: 17_388_607, total: 20_971_520)))
        #expect(s.applyContent(status: 200, body: Data(#"{"id":"up_0123456789abcdef","bytes":20971520,"received":20971520,"status":"received"}"#.utf8)) == .done)
        #expect(s.phase == .done)
        #expect(try s.next() == .finished)
    }

    @Test func aRefusedNarrationOnlyCostsTime() {
        var s = created()
        guard case .next(let note?) = s.applyNarration(status: 409, body: Data(#"{"error":"the narration does not match its sha256; send it again"}"#.utf8)) else {
            Issue.record("expected the video to follow"); return
        }
        #expect(note.contains("sha256"))
        #expect(s.phase == .content)
        var t = created()
        #expect(t.applyNarration(status: 401, body: Data(#"{"error":"missing or unknown token"}"#.utf8)) == .failed("narration HTTP 401: missing or unknown token"))
    }

    @Test func otherFailuresStopWithTheStatusAndReason() {
        var s = created(narration: false)
        #expect(s.phase == .content)
        #expect(s.applyContent(status: 400, body: Data(#"{"error":"Content-Length must equal the Content-Range length"}"#.utf8))
                == .failed("HTTP 400: Content-Length must equal the Content-Range length"))
        #expect(s.phase == .failed)
        var t = created(narration: false)
        #expect(t.applyContent(status: 409, body: Data(#"{"error":"client id c was already used for a different file"}"#.utf8))
                == .failed("HTTP 409: client id c was already used for a different file"))
    }

    @Test func oneResetIsSurvivedAndTwoAreNot() {
        var s = created(narration: false)
        _ = s.applyContent(status: 200, body: Data(#"{"id":"up_0123456789abcdef","bytes":20971520,"received":8388608,"status":"uploading"}"#.utf8))
        let reset = Data(#"{"error":"sha256 does not match; the upload was reset to 0","received":0,"status":"uploading"}"#.utf8)
        #expect(s.applyContent(status: 409, body: reset) == .next(note: nil))
        #expect(s.nextOffset == 0)
        _ = s.applyContent(status: 200, body: Data(#"{"id":"up_0123456789abcdef","bytes":20971520,"received":8388608,"status":"uploading"}"#.utf8))
        #expect(s.applyContent(status: 409, body: reset) == .failed("the receiver's copy failed verification twice"))
    }

    @Test func aBusyReceiverIsRetriedAFewTimes() {
        var s = created(narration: false)
        let busy = Data(#"{"error":"another request is writing this upload","received":0,"status":"uploading"}"#.utf8)
        for _ in 0..<UploadRunState.maxRepeats { #expect(s.applyContent(status: 409, body: busy) == .next(note: nil)) }
        guard case .failed = s.applyContent(status: 409, body: busy) else { Issue.record("expected it to give up"); return }
    }

    @Test func aTaskWithNoReplyIsSentAgainLater() throws {
        var s = created(narration: false)
        let first = try s.next()
        s.inFlight = UploadTaskTag.content(s.runName, try ByteRange(start: 0, end: 8_388_607, total: 20_971_520)).text
        guard case .next(let note?) = s.applyTransportError("NSURLErrorDomain -1005: The network connection was lost.") else {
            Issue.record("expected the range to go again"); return
        }
        #expect(note.hasSuffix("sending it again in 30 s"))
        #expect(s.phase == .content)
        #expect(s.inFlight == nil)
        #expect(try s.next() == first, "the same range, from the same offset")
        #expect(s.retryDelaySeconds == 30)
        _ = s.applyTransportError("NSURLErrorDomain -999: cancelled")
        #expect(s.retryDelaySeconds == 60)
        // Any reply means the network works again; a 409 also corrects the offset to what arrived.
        #expect(s.applyContent(status: 409, body: Data(#"{"error":"expected offset 4096","received":4096,"status":"uploading"}"#.utf8)) == .next(note: nil))
        #expect(s.retries == 0)
        #expect(s.nextOffset == 4096)
        #expect(s.retryDelaySeconds == 0)
        var delays: [Int] = []
        for _ in 0..<UploadRunState.maxRetries {
            #expect(s.applyTransportError("NSURLErrorDomain -1004: Could not connect to the server.") != .failed(""))
            delays.append(s.retryDelaySeconds)
        }
        #expect(delays == [30, 60, 120, 240, 480])
        #expect(s.applyTransportError("NSURLErrorDomain -1004: Could not connect to the server.")
                == .failed("network: NSURLErrorDomain -1004: Could not connect to the server. (6 times in a row)"))
        #expect(s.phase == .failed)
    }

    @Test func aBusyReceiverWaitsAFewSeconds() {
        var s = created(narration: false)
        let busy = Data(#"{"error":"another request is writing this upload","received":0,"status":"uploading"}"#.utf8)
        _ = s.applyContent(status: 409, body: busy)
        #expect(s.retryDelaySeconds == 2)
        _ = s.applyContent(status: 409, body: busy)
        #expect(s.retryDelaySeconds == 4)
    }

    @Test func anUploadTheReceiverAlreadyHasIsDone() {
        let s = UploadRunState(created: view(#"{"id":"up_0123456789abcdef","bytes":100,"received":100,"status":"ready"}"#),
                               runName: "20261106-140501", runPath: "Runs/20261106-140501", clientId: "c", narrationBytes: 10, allowExpensive: true, now: now)
        #expect(s.phase == .done)
    }

    @Test func aLostTaskResyncsFromTheStatus() {
        var s = created()
        s.inFlight = UploadTaskTag.narration("20261106-140501").text
        #expect(s.resync(from: view(#"{"id":"up_0123456789abcdef","bytes":20971520,"received":4096,"status":"uploading","narration":"received"}"#)) == .next(note: nil))
        #expect(s.phase == .content)
        #expect(s.nextOffset == 4096)
        #expect(s.inFlight == nil)
    }

    @Test func savesAndLoadsStrictly() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("uploads-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var s = created()
        s.inFlight = UploadTaskTag.narration(s.runName).text
        s.taskStartedAt = 1_793_973_902.5
        let url = UploadRunState.url(in: dir, runName: s.runName)
        try s.save(url)
        #expect(try UploadRunState.load(url) == s)
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        #expect(mode?.intValue == 0o600)
        var object = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        object["token"] = "x"
        try JSONSerialization.data(withJSONObject: object).write(to: url)
        #expect(throws: UploadProtocolError("token", "is not a key of an upload state")) { try UploadRunState.load(url) }
        object["token"] = nil
        object["runPath"] = "../../Documents"
        try JSONSerialization.data(withJSONObject: object).write(to: url)
        #expect(throws: UploadProtocolError("runPath", "must be a relative path inside the app")) { try UploadRunState.load(url) }
        #expect(!UploadRunState.isRelativePath("/var/mobile"))
        #expect(!UploadRunState.isRelativePath("Runs//x"))
        #expect(UploadRunState.isRelativePath("Library/Application Support/Runs/20261106-140501"))
    }
}

@Suite struct TaskTagTests {
    @Test func tagsRoundTripAndNothingElseParses() throws {
        let range = try ByteRange(start: 0, end: 8_388_607, total: 20_971_520)
        let content = UploadTaskTag.content("20261106-140501", range)
        #expect(content.text == "polydance-upload/1 content 20261106-140501 0-8388607/20971520")
        #expect(UploadTaskTag(text: content.text) == content)
        let narration = UploadTaskTag.narration("20261106-140501")
        #expect(UploadTaskTag(text: narration.text) == narration)
        #expect(content.chunkFile(in: URL(fileURLWithPath: "/c"))?.path == "/c/20261106-140501-0.part")
        #expect(narration.chunkFile(in: URL(fileURLWithPath: "/c")) == nil)
        for bad in ["", "polydance-upload/1 content ../x 0-1/2", "polydance-upload/2 narration 20261106-140501",
                    "polydance-upload/1 narration 20261106-140501 extra", "polydance-upload/1 content 20261106-140501"] {
            #expect(UploadTaskTag(text: bad) == nil, "\(bad)")
        }
    }
}

@Suite struct FileTests {
    func temp() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("upload-files-\(UUID().uuidString)", isDirectory: true) }

    @Test func sha256OfAKnownFile() throws {
        let dir = temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let abc = dir.appendingPathComponent("abc")
        try Data("abc".utf8).write(to: abc)
        // FIPS 180-2's example, read whole and two bytes at a time.
        #expect(try UploadProtocol.sha256Hex(of: abc) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(try UploadProtocol.sha256Hex(of: abc, bufferSize: 2) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let empty = dir.appendingPathComponent("empty")
        try Data().write(to: empty)
        #expect(try UploadProtocol.sha256Hex(of: empty) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test func aChunkIsItsBytesInAPrivateFile() throws {
        let dir = temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let source = dir.appendingPathComponent("video.mp4")
        let bytes = Data((0..<1000).map { UInt8($0 % 251) })
        try bytes.write(to: source)
        let out = dir.appendingPathComponent("chunks/20261106-140501-100.part")
        try UploadProtocol.writeChunk(of: source, range: ByteRange(start: 100, end: 299, total: 1000), to: out)
        #expect(try Data(contentsOf: out) == bytes.subdata(in: 100..<300))
        #expect((try FileManager.default.attributesOfItem(atPath: out.path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        // The recording changed size since the upload was declared: refused.
        #expect(throws: UploadProtocolError.self) { try UploadProtocol.writeChunk(of: source, range: ByteRange(start: 0, end: 9, total: 999), to: out) }
    }

    @Test func clientIdsAreTheReceiversShape() throws {
        #expect(try UploadProtocol.clientId(installId: installId, runName: "20261106-140501") == "0123456789abcdef-20261106-140501")
        #expect(UploadProtocol.isInstallId(UploadProtocol.newInstallId()))
        #expect(throws: UploadProtocolError.self) { try UploadProtocol.clientId(installId: installId, runName: "../x") }
    }
}
