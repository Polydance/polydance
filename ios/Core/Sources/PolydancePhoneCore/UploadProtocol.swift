// The receiver's upload protocol as the phone speaks it (docs/IPHONE.md U1, U2): the create body (with the
// thread a take belongs to, I3), the requests, the 8 MB chunk plan, the replies (a 409 names the offset
// the receiver has) and each run's upload state, which says what to send next. It mirrors
// src/server/http.ts and uploads.ts (createUploadSchema) and the headset's UploadWorker.kt, and holds no
// I/O beyond hashing a file and copying one chunk, so `swift test` proves it on the Mac. The app's
// UploadProbe runs it on a background URLSession, with the receiver and token of the phone's Pairing.
// Fails closed: a reply or a state file of the wrong shape is an error that names the field. The token is
// never part of a description, a mirror or an error.
import CryptoKit
import Foundation

// MARK: - Errors

public struct UploadProtocolError: Error, Sendable, Equatable, CustomStringConvertible {
    /// The field or step at fault, such as "server", "bytes" or "reply".
    public let field: String
    public let reason: String
    public init(_ field: String, _ reason: String) { self.field = field; self.reason = reason }
    public var description: String { "\(field) \(reason)" }
}

/// A key of any name, for decoders that refuse keys they do not know.
struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

// MARK: - The create body: POST /v1/uploads

/// What the phone sends, a subset of createUploadSchema (src/server/uploads.ts) with nothing it does not
/// allow. `thread` names where the take goes (RunThread: a reply, a new thread or a report); a take with
/// none starts a thread in the token's first project, as the schema allows. Keys are encoded sorted, and
/// an absent optional is left out, never sent as null.
public struct CreateUploadBody: Encodable, Sendable, Equatable {
    /// `app` in the schema; the bundle records it as source.appBuild.
    public struct AppBuild: Encodable, Sendable, Equatable {
        public var versionName: String
        /// The headset's versionCode, which the Vision Pro's build number is (docs/VISIONOS.md); the iPhone sends none.
        public var versionCode: Int?
        public var commit: String?
    }
    /// The mic track alone, sent whole before the video so the words come first.
    public struct Narration: Encodable, Sendable, Equatable {
        public var bytes: Int64
        public var sha256: String
        public init(bytes: Int64, sha256: String) { self.bytes = bytes; self.sha256 = sha256 }
    }

    public var clientId: String
    public var bytes: Int64
    public var sha256: String
    public var fileName: String
    public var recordedAt: String
    public var appPackage: String
    public var device: [String: String]?
    public var audioTracks: [String]
    public var app: AppBuild?
    public var narration: Narration?
    public var thread: RunThread?
    /// What the app opened from launches while the take ran (opened.json), as the headset sends it.
    public var opened: [Opened]?

    /// The receiver's MAX_NARRATION: about an hour of mono AAC.
    public static let maxNarrationBytes: Int64 = 64 * 1024 * 1024

    /// Builds and checks the body against the schema's rules. `meta` is the run's run.json; the device
    /// keeps only `model` and `system`, never the phone's own name. A version or commit the schema would
    /// refuse is left out rather than failing the upload, as the headset's UploadWorker does.
    public init(installId: String, runName: String, meta: RunMeta, videoBytes: Int64, videoSha256: String, narration: Narration?,
                thread: RunThread? = nil, opened: [Opened] = []) throws {
        guard meta.runName == runName else { throw UploadProtocolError("runName", "run.json names \(meta.runName), not \(runName)") }
        clientId = try UploadProtocol.clientId(installId: installId, runName: runName)
        fileName = RunNames.uploadFileName(runName: runName)
        guard fileName.wholeMatch(of: /[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(mp4|webm|mkv|mov)/) != nil else {
            throw UploadProtocolError("fileName", "is not a name the receiver takes")
        }
        guard videoBytes > 0 else { throw UploadProtocolError("bytes", "must be more than 0") }
        bytes = videoBytes
        guard UploadProtocol.isSHA256(videoSha256) else { throw UploadProtocolError("sha256", "must be 64 lowercase hex digits") }
        sha256 = videoSha256
        guard meta.recordedAt.wholeMatch(of: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/) != nil else {
            throw UploadProtocolError("recordedAt", "must be ISO 8601 with an offset")
        }
        recordedAt = meta.recordedAt
        appPackage = RunNames.appPackage
        var kept: [String: String] = [:]
        for key in ["model", "system"] {
            guard let value = meta.device[key] else { continue }
            guard value.count <= 200 else { throw UploadProtocolError("device.\(key)", "is longer than 200 characters") }
            kept[key] = value
        }
        device = kept.isEmpty ? nil : kept
        guard (1...4).contains(meta.audioTracks.count), meta.audioTracks.allSatisfy({ $0 == "mic" || $0 == "app" }) else {
            throw UploadProtocolError("audioTracks", "must be 1 to 4 of mic and app")
        }
        audioTracks = meta.audioTracks
        if meta.appVersion.wholeMatch(of: /[A-Za-z0-9._+-]{1,40}/) != nil {
            let commit = meta.appCommit.wholeMatch(of: /([0-9a-f]{7,40}(-dirty)?|unknown)/) != nil ? meta.appCommit : nil
            app = AppBuild(versionName: meta.appVersion, versionCode: meta.appBuild.flatMap { $0 >= 0 ? $0 : nil }, commit: commit)
        }
        if let narration {
            guard audioTracks.contains("mic") else { throw UploadProtocolError("narration", "needs a mic track") }
            guard (1...Self.maxNarrationBytes).contains(narration.bytes) else {
                throw UploadProtocolError("narration.bytes", "must be 1 to \(Self.maxNarrationBytes)")
            }
            guard UploadProtocol.isSHA256(narration.sha256) else { throw UploadProtocolError("narration.sha256", "must be 64 lowercase hex digits") }
        }
        self.narration = narration
        self.thread = thread
        guard opened.count <= Opened.maxCount else { throw UploadProtocolError("opened", "has more than \(Opened.maxCount) entries") }
        for entry in opened { try entry.check() }
        self.opened = opened.isEmpty ? nil : opened
    }

    public func json() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

// MARK: - Replies

/// STATUSES in src/server/uploads.ts. An unknown status is refused, not guessed at.
public enum UploadStatus: String, Codable, Sendable, CaseIterable {
    case uploading, received, processing, ready, failed, deleted
}

/// The upload as the receiver describes it (UploadView, and describeUpload's additions, which are
/// ignored here so a growing reply still decodes). `received` is the bytes of the video it holds.
public struct UploadView: Decodable, Sendable, Equatable {
    public let id: String
    public let clientId: String?
    public let bytes: Int64
    public let received: Int64
    public let status: UploadStatus
    /// "expected" until the declared narration arrives, then "received"; absent when none was declared.
    public let narration: String?
    public let sessionId: String?
    public let error: String?

    enum CodingKeys: String, CodingKey { case id, clientId, bytes, received, status, narration, sessionId, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard UploadProtocol.isUploadId(id) else { throw UploadProtocolError("reply.id", "is not an upload id") }
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
        bytes = try c.decode(Int64.self, forKey: .bytes)
        received = try c.decode(Int64.self, forKey: .received)
        guard bytes > 0, (0...bytes).contains(received) else { throw UploadProtocolError("reply.received", "is not between 0 and the upload's bytes") }
        status = try c.decode(UploadStatus.self, forKey: .status)
        narration = try c.decodeIfPresent(String.self, forKey: .narration)
        if let narration, narration != "expected", narration != "received" { throw UploadProtocolError("reply.narration", "is not expected or received") }
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }

    public static func decode(_ data: Data) throws -> UploadView {
        do { return try JSONDecoder().decode(UploadView.self, from: data) }
        catch let error as UploadProtocolError { throw error }
        catch { throw UploadProtocolError("reply", "is not an upload") }
    }
}

/// A 409 from PUT …/content: `{"error", "received", "status"}`, the offset the receiver actually has.
public struct ConflictReply: Decodable, Sendable, Equatable {
    public let received: Int64
    public let status: UploadStatus?
    public let error: String?

    enum CodingKeys: String, CodingKey { case received, status, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        received = try c.decode(Int64.self, forKey: .received)
        guard received >= 0 else { throw UploadProtocolError("reply.received", "is negative") }
        status = try c.decodeIfPresent(UploadStatus.self, forKey: .status)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }

    /// Nil when the 409 carries no offset (a client id reused for another file, a narration refused).
    public static func parse(_ body: Data) -> ConflictReply? { try? JSONDecoder().decode(ConflictReply.self, from: body) }
}

// MARK: - Ranges and the chunk plan

/// Bytes `start` to `end` inclusive of a file of `total` bytes, as Content-Range counts them.
public struct ByteRange: Sendable, Hashable {
    public let start: Int64
    public let end: Int64
    public let total: Int64
    public var length: Int64 { end - start + 1 }
    /// "bytes 0-8388607/52428800"
    public var contentRange: String { "bytes \(start)-\(end)/\(total)" }
    /// "0-8388607/52428800", for logs and task tags.
    public var text: String { "\(start)-\(end)/\(total)" }

    public init(start: Int64, end: Int64, total: Int64) throws {
        guard total > 0 else { throw UploadProtocolError("bytes", "a zero-byte file cannot be uploaded") }
        guard start >= 0, end >= start, end < total else { throw UploadProtocolError("range", "\(start)-\(end) does not fit \(total) bytes") }
        self.start = start; self.end = end; self.total = total
    }

    /// Parses `text` back, as a task tag carries it.
    public init?(text: String) {
        guard let m = text.wholeMatch(of: /(\d{1,15})-(\d{1,15})\/(\d{1,15})/),
              let s = Int64(m.1), let e = Int64(m.2), let t = Int64(m.3),
              let range = try? ByteRange(start: s, end: e, total: t) else { return nil }
        self = range
    }
}

public enum ChunkPlan {
    /// The headset's chunk (UploadWorker.kt CHUNK): 8 MB a request.
    public static let chunkBytes: Int64 = 8 * 1024 * 1024
    /// The receiver's MAX_CHUNK.
    public static let maxChunkBytes: Int64 = 64 * 1024 * 1024

    /// The next chunk from `offset`, never past `total`; nil once everything is sent. A zero-byte file,
    /// an offset outside the file or a chunk the receiver would refuse is an error.
    public static func next(offset: Int64, total: Int64, chunkBytes: Int64 = chunkBytes) throws -> ByteRange? {
        guard total > 0 else { throw UploadProtocolError("bytes", "a zero-byte file cannot be uploaded") }
        guard (1...maxChunkBytes).contains(chunkBytes) else { throw UploadProtocolError("chunk", "must be 1 to \(maxChunkBytes) bytes") }
        guard (0...total).contains(offset) else { throw UploadProtocolError("offset", "\(offset) is outside 0 to \(total)") }
        if offset == total { return nil }
        return try ByteRange(start: offset, end: min(offset + chunkBytes, total) - 1, total: total)
    }
}

// MARK: - Requests

/// Every request carries `Authorization: Bearer <token>`, read from the config the caller just loaded.
public enum UploadRequests {
    public static func create(_ config: Pairing, body: CreateUploadBody) throws -> URLRequest {
        let data = try body.json()
        var r = base(config, "POST", "/v1/uploads")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = data
        return r
    }

    /// PUT …/narration: the whole narration, its body sent from a file by the caller.
    public static func narration(_ config: Pairing, uploadId: String, bytes: Int64) throws -> URLRequest {
        var r = try base(config, "PUT", "/v1/uploads/\(checked(uploadId))/narration")
        guard bytes > 0 else { throw UploadProtocolError("narration.bytes", "must be more than 0") }
        r.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        r.setValue(String(bytes), forHTTPHeaderField: "Content-Length")
        return r
    }

    /// PUT …/content with `Content-Range: bytes a-b/total`; the receiver also checks Content-Length.
    public static func content(_ config: Pairing, uploadId: String, range: ByteRange) throws -> URLRequest {
        var r = try base(config, "PUT", "/v1/uploads/\(checked(uploadId))/content")
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        r.setValue(range.contentRange, forHTTPHeaderField: "Content-Range")
        r.setValue(String(range.length), forHTTPHeaderField: "Content-Length")
        return r
    }

    /// GET /v1/uploads/:id: how much the receiver holds, after a task was lost.
    public static func status(_ config: Pairing, uploadId: String) throws -> URLRequest {
        try base(config, "GET", "/v1/uploads/\(checked(uploadId))")
    }

    /// GET /v1/account: storage used and allowed; a quick check that the token is taken.
    public static func account(_ config: Pairing) -> URLRequest { base(config, "GET", "/v1/account") }

    /// GET /v1/health, the receiver's one open route: whether the phone reaches it at all (and, the first
    /// time, iOS's local network question). It carries no token, since none is needed.
    public static func health(_ config: Pairing) -> URLRequest {
        var r = URLRequest(url: config.endpoint("/v1/health"), cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        r.httpMethod = "GET"
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.timeoutInterval = 15
        return r
    }

    static func base(_ config: Pairing, _ method: String, _ path: String) -> URLRequest {
        var r = URLRequest(url: config.endpoint(path), cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        r.httpMethod = method
        r.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        return r
    }

    static func checked(_ uploadId: String) throws -> String {
        guard UploadProtocol.isUploadId(uploadId) else { throw UploadProtocolError("uploadId", "is not an upload id") }
        return uploadId
    }
}

// MARK: - Shared rules and file helpers

public enum UploadProtocol {
    /// The receiver's CLIENT_ID.
    public static func clientId(installId: String, runName: String) throws -> String {
        guard isInstallId(installId) else { throw UploadProtocolError("installId", "must be 16 lowercase hex digits") }
        guard RunNames.isRunName(runName) else { throw UploadProtocolError("runName", "is not a run name") }
        let id = "\(installId)-\(runName)"
        guard id.wholeMatch(of: /[A-Za-z0-9][A-Za-z0-9._-]{0,99}/) != nil else { throw UploadProtocolError("clientId", "is not a client id the receiver takes") }
        return id
    }

    /// A new install id: 16 random lowercase hex digits, made once and kept in the upload state folder.
    public static func newInstallId() -> String {
        var g = SystemRandomNumberGenerator()
        return (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &g)) }.joined()
    }

    public static func isInstallId(_ s: String) -> Bool { s.wholeMatch(of: /[0-9a-f]{16}/) != nil }
    public static func isUploadId(_ s: String) -> Bool { s.wholeMatch(of: /up_[0-9a-f]{16}/) != nil }
    public static func isSHA256(_ s: String) -> Bool { s.wholeMatch(of: /[0-9a-f]{64}/) != nil }

    /// A refusal in a few words for the log: the receiver's own `error` text, cut to one line of 160
    /// characters, or the bare status. Never the body in full.
    public static func shortReason(status: Int, body: Data) -> String {
        struct Reply: Decodable { let error: String? }
        if let message = (try? JSONDecoder().decode(Reply.self, from: body))?.error, !message.isEmpty {
            let line = message.split(whereSeparator: \.isNewline).joined(separator: " ")
            return line.count > 160 ? String(line.prefix(159)) + "…" : line
        }
        return "HTTP \(status)"
    }

    /// sha256 of a file as lowercase hex, read a megabyte at a time so a long take is never in memory.
    public static func sha256Hex(of url: URL, bufferSize: Int = 1 << 20) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let more: Bool = try autoreleasepool {
                guard let data = try handle.read(upToCount: bufferSize), !data.isEmpty else { return false }
                hasher.update(data: data)
                return true
            }
            if !more { break }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Copies `range` of `source` into `destination` (0600, protected until first unlock), so a
    /// background task sends a file of its own and the recording is never touched. Refuses when the
    /// recording is no longer the size the upload declared.
    public static func writeChunk(of source: URL, range: ByteRange, to destination: URL) throws {
        let size = (try FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.int64Value
        guard size == range.total else { throw UploadProtocolError("chunk", "the recording is \(size.map(String.init) ?? "unreadable") bytes, not the declared \(range.total)") }
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(range.start))
        guard let data = try handle.read(upToCount: Int(range.length)), Int64(data.count) == range.length else {
            throw UploadProtocolError("chunk", "the recording ended before byte \(range.end)")
        }
        try PrivateFiles.directory(destination.deletingLastPathComponent())
        try PrivateFiles.write(data, to: destination)
    }
}

// MARK: - Background task tags

/// What a background task is, kept in its taskDescription so it survives the app being relaunched:
/// "polydance-upload/1 narration <run>" or "polydance-upload/1 content <run> <a-b/total>".
public struct UploadTaskTag: Sendable, Equatable, Hashable {
    public enum Kind: String, Sendable { case narration, content }
    public static let prefix = "polydance-upload/1"

    public let kind: Kind
    public let runName: String
    public let range: ByteRange?

    public static func narration(_ runName: String) -> UploadTaskTag { UploadTaskTag(kind: .narration, runName: runName, range: nil) }
    public static func content(_ runName: String, _ range: ByteRange) -> UploadTaskTag { UploadTaskTag(kind: .content, runName: runName, range: range) }

    private init(kind: Kind, runName: String, range: ByteRange?) { self.kind = kind; self.runName = runName; self.range = range }

    public var text: String {
        switch kind {
        case .narration: "\(Self.prefix) narration \(runName)"
        case .content: "\(Self.prefix) content \(runName) \(range!.text)"
        }
    }

    /// Nil for anything that is not exactly a tag this code writes.
    public init?(text: String) {
        let parts = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 3, parts[0] == Self.prefix, RunNames.isRunName(parts[2]) else { return nil }
        switch (parts[1], parts.count) {
        case ("narration", 3): self.init(kind: .narration, runName: parts[2], range: nil)
        case ("content", 4):
            guard let range = ByteRange(text: parts[3]) else { return nil }
            self.init(kind: .content, runName: parts[2], range: range)
        default: return nil
        }
    }

    /// The chunk's own file under Caches, removed once its task ends.
    public func chunkFile(in directory: URL) -> URL? {
        guard kind == .content, let range else { return nil }
        return directory.appendingPathComponent("\(runName)-\(range.start).part")
    }
}

// MARK: - Each run's upload state

/// What has happened to one run's upload, kept as `<state dir>/<run name>.json` (0600) so a relaunch
/// continues where the last task ended. Strict: an unknown or missing key is an error.
public struct UploadRunState: Codable, Sendable, Equatable {
    public static let currentVersion = 1
    /// Times a 409 may leave the offset where it was (another request still writing) before giving up.
    public static let maxRepeats = 3
    /// Network failures in a row (no reply at all) before giving up. Each sends the same range again
    /// later; the receiver's 409 then corrects the offset if part of it arrived.
    public static let maxRetries = 5

    public enum Phase: String, Codable, Sendable { case narration, content, done, failed }

    public var v: Int
    public var runName: String
    /// The run's folder relative to the app's home directory, whose absolute path changes between installs.
    public var runPath: String
    public var clientId: String
    public var uploadId: String
    /// The video's declared size.
    public var bytes: Int64
    public var narrationBytes: Int64?
    public var phase: Phase
    /// The first video byte the receiver does not have yet.
    public var nextOffset: Int64
    /// Send now: the video may use an expensive network (docs/IPHONE.md U3).
    public var allowExpensive: Bool
    /// Times the receiver reset the upload to 0 after a hash mismatch; once is survivable.
    public var resets: Int
    /// Replies in a row that left the offset where it was.
    public var repeats: Int
    /// Tasks in a row that ended with no reply (a dropped Wi-Fi, the receiver restarting, a force quit).
    public var retries: Int
    /// The running task's tag text, nil between tasks.
    public var inFlight: String?
    /// When the running task started, seconds since 1970, so its time survives a relaunch.
    public var taskStartedAt: Double?
    /// When the create was sent, seconds since 1970.
    public var startedAt: Double
    /// The receiver's status at the last reply.
    public var serverStatus: String?
    /// Why it failed, in a few words.
    public var error: String?

    /// The state after the create's reply. A narration still expected goes first; an upload the receiver
    /// already holds whole is done.
    public init(created view: UploadView, runName: String, runPath: String, clientId: String, narrationBytes: Int64?, allowExpensive: Bool, now: Date) {
        v = Self.currentVersion
        self.runName = runName
        self.runPath = runPath
        self.clientId = clientId
        uploadId = view.id
        bytes = view.bytes
        self.narrationBytes = narrationBytes
        nextOffset = view.received
        self.allowExpensive = allowExpensive
        resets = 0
        repeats = 0
        retries = 0
        startedAt = now.timeIntervalSince1970
        serverStatus = view.status.rawValue
        switch view.status {
        case .uploading: phase = narrationBytes != nil && view.narration == "expected" ? .narration : .content
        case .received, .processing, .ready, .failed: phase = .done
        case .deleted: phase = .failed; error = "the receiver says this upload was deleted"
        }
    }

    public static func url(in directory: URL, runName: String) -> URL { directory.appendingPathComponent("\(runName).json") }

    public static func load(_ url: URL) throws -> UploadRunState {
        do { return try JSONDecoder().decode(UploadRunState.self, from: Data(contentsOf: url)) }
        catch let error as UploadProtocolError { throw error }
        catch let error as DecodingError { throw UploadProtocolError(url.lastPathComponent, "is not an upload state: \(Self.describe(error))") }
    }

    public func save(_ url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try PrivateFiles.directory(url.deletingLastPathComponent())
        try PrivateFiles.write(encoder.encode(self), to: url)
    }

    public enum Next: Sendable, Equatable {
        case narration
        case content(ByteRange)
        case finished
    }

    /// What to send next. A content phase with nothing left is finished (the last reply confirmed it).
    public func next() throws -> Next {
        switch phase {
        case .narration: return .narration
        case .content: return try ChunkPlan.next(offset: nextOffset, total: bytes).map(Next.content) ?? .finished
        case .done, .failed: return .finished
        }
    }

    public enum Outcome: Sendable, Equatable {
        /// Send the next thing; `note` says what was let go (a refused narration).
        case next(note: String?)
        case done
        case failed(String)
    }

    /// Applies the reply to PUT …/narration. A refused narration only costs time, because the video holds
    /// the same sound, so anything but a refused token moves on to the video (as UploadWorker.kt does).
    public mutating func applyNarration(status: Int, body: Data) -> Outcome {
        inFlight = nil
        retries = 0
        switch status {
        case 200..<300:
            phase = .content
            return .next(note: nil)
        case 401, 403:
            return fail("narration HTTP \(status): \(UploadProtocol.shortReason(status: status, body: body))")
        default:
            phase = .content
            return .next(note: "narration refused (HTTP \(status): \(UploadProtocol.shortReason(status: status, body: body))); the video follows")
        }
    }

    /// Applies the reply to PUT …/content: 2xx moves on to what the receiver now holds, a 409 takes the
    /// offset it names, anything else fails with the status and the receiver's reason.
    public mutating func applyContent(status: Int, body: Data) -> Outcome {
        inFlight = nil
        retries = 0
        let received: Int64
        let server: UploadStatus?
        switch status {
        case 200..<300:
            guard let view = try? UploadView.decode(body) else { return fail("HTTP \(status) with a reply that is not an upload") }
            guard view.id == uploadId, view.bytes == bytes else { return fail("the reply is for another upload") }
            received = view.received
            server = view.status
        case 409:
            guard let reply = ConflictReply.parse(body) else { return fail("HTTP 409: \(UploadProtocol.shortReason(status: status, body: body))") }
            guard reply.received <= bytes else { return fail("HTTP 409 names offset \(reply.received), past the file's \(bytes) bytes") }
            received = reply.received
            server = reply.status
        default:
            return fail("HTTP \(status): \(UploadProtocol.shortReason(status: status, body: body))")
        }
        if let server { serverStatus = server.rawValue }
        if let server, server != .uploading {
            if received == bytes && server != .deleted { phase = .done; return .done }
            return fail("the receiver says the upload is \(server.rawValue)")
        }
        if received == 0 && nextOffset > 0 {
            // The finished file did not match its sha256 and the receiver started over.
            resets += 1
            if resets > 1 { return fail("the receiver's copy failed verification twice") }
        }
        repeats = received == nextOffset ? repeats + 1 : 0
        if repeats > Self.maxRepeats { return fail("the receiver kept the offset at \(received) \(repeats) times") }
        nextOffset = received
        return .next(note: nil)
    }

    /// Takes the receiver's own count after a task was lost (GET /v1/uploads/:id).
    public mutating func resync(from view: UploadView) -> Outcome {
        inFlight = nil
        retries = 0
        guard view.id == uploadId, view.bytes == bytes else { return fail("the status is for another upload") }
        serverStatus = view.status.rawValue
        switch view.status {
        case .uploading:
            nextOffset = view.received
            if phase == .narration && view.narration != "expected" { phase = .content }
            return .next(note: nil)
        case .received, .processing, .ready, .failed:
            phase = .done
            return .done
        case .deleted:
            return fail("the receiver says the upload was deleted")
        }
    }

    /// A task that ended with no reply at all: the phase and offset stay, and the same thing is sent again
    /// after `retryDelaySeconds`, up to `maxRetries` times in a row. `description` is the error in a few words.
    public mutating func applyTransportError(_ description: String) -> Outcome {
        inFlight = nil
        retries += 1
        if retries > Self.maxRetries { return fail("network: \(description) (\(retries) times in a row)") }
        return .next(note: "network: \(description); sending it again in \(retryDelaySeconds) s")
    }

    /// How long the next task waits before it begins: 30 s doubling to 10 minutes after network failures,
    /// a few seconds while the receiver is still writing the last request (a 409 at the same offset), else 0.
    public var retryDelaySeconds: Int {
        if retries > 0 { return min(30 << min(retries - 1, 5), 600) }
        if repeats > 0 { return min(2 * repeats, 10) }
        return 0
    }

    public mutating func fail(_ reason: String) -> Outcome {
        phase = .failed
        error = reason
        inFlight = nil
        return .failed(reason)
    }

    /// A few words for the probe's screen.
    public var summary: String {
        let mb = { (n: Int64) in String(format: "%.1f", Double(n) / 1_000_000) }
        switch phase {
        case .narration: return "sending narration"
        case .content: return "video \(mb(nextOffset))/\(mb(bytes)) MB"
        case .done: return "on the receiver (\(serverStatus ?? "received"))"
        case .failed: return "failed: \(error ?? "unknown")"
        }
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case v, runName, runPath, clientId, uploadId, bytes, narrationBytes, phase, nextOffset, allowExpensive, resets, repeats, retries
        case inFlight, taskStartedAt, startedAt, serverStatus, error
    }

    public init(from decoder: any Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        let known = Set(CodingKeys.allCases.map(\.rawValue))
        if let extra = all.allKeys.map(\.stringValue).filter({ !known.contains($0) }).sorted().first {
            throw UploadProtocolError(extra, "is not a key of an upload state")
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v)
        guard v == Self.currentVersion else { throw UploadProtocolError("v", "is \(v), not \(Self.currentVersion)") }
        runName = try c.decode(String.self, forKey: .runName)
        guard RunNames.isRunName(runName) else { throw UploadProtocolError("runName", "is not a run name") }
        runPath = try c.decode(String.self, forKey: .runPath)
        guard Self.isRelativePath(runPath) else { throw UploadProtocolError("runPath", "must be a relative path inside the app") }
        clientId = try c.decode(String.self, forKey: .clientId)
        uploadId = try c.decode(String.self, forKey: .uploadId)
        guard UploadProtocol.isUploadId(uploadId) else { throw UploadProtocolError("uploadId", "is not an upload id") }
        bytes = try c.decode(Int64.self, forKey: .bytes)
        narrationBytes = try c.decodeIfPresent(Int64.self, forKey: .narrationBytes)
        phase = try c.decode(Phase.self, forKey: .phase)
        nextOffset = try c.decode(Int64.self, forKey: .nextOffset)
        guard bytes > 0, (0...bytes).contains(nextOffset) else { throw UploadProtocolError("nextOffset", "is outside the file") }
        allowExpensive = try c.decode(Bool.self, forKey: .allowExpensive)
        resets = try c.decode(Int.self, forKey: .resets)
        repeats = try c.decode(Int.self, forKey: .repeats)
        retries = try c.decode(Int.self, forKey: .retries)
        inFlight = try c.decodeIfPresent(String.self, forKey: .inFlight)
        taskStartedAt = try c.decodeIfPresent(Double.self, forKey: .taskStartedAt)
        startedAt = try c.decode(Double.self, forKey: .startedAt)
        serverStatus = try c.decodeIfPresent(String.self, forKey: .serverStatus)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }

    /// A relative path with no empty, "." or ".." part, so a state file cannot point outside the app.
    public static func isRelativePath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return !path.isEmpty && !path.hasPrefix("/") && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    static func describe(_ error: DecodingError) -> String {
        switch error {
        case .keyNotFound(let key, _): "\(key.stringValue) is missing"
        case .typeMismatch(_, let ctx), .valueNotFound(_, let ctx), .dataCorrupted(let ctx):
            ctx.codingPath.isEmpty ? "not JSON of the right shape" : "\(ctx.codingPath.map(\.stringValue).joined(separator: ".")) has the wrong type"
        @unknown default: "unreadable"
        }
    }
}
