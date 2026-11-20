// The polycap commands the main window, the settings and the threads run, beyond import and process:
// thread list, show, reply and new, project list and new, upload, hooks list and hooks run. Each goes through PolycapRunner (an
// argument array after `node polycap.js`, the explicit environment, off the main thread) and its output
// is parsed here, strictly on what the app uses. A command that fails gives its own error output
// verbatim (polycap's messages say how to fix what is wrong, such as a missing upload token), so these
// keep far more of it than the import's one-line summary does.
import Foundation
import PolydanceShared

extension PolycapCommand {
    /// `--text=<text>` is one argument, so a reply that starts with a dash is never read as an option; so is
    /// each `--photo=<path>`. A reply of photos alone has no `--text`.
    public static func threadReply(key: String, text: String, photos: [URL] = []) -> [String] {
        ["thread", "reply", key] + (text.isEmpty ? [] : ["--text=\(text)"]) + photos.map { "--photo=\($0.path)" } + ["--json"]
    }

    /// A new thread typed rather than recorded: its title, words and photos in one project, each value one argument.
    public static func threadNew(project: String, title: String, text: String, photos: [URL] = []) -> [String] {
        ["thread", "new", "--project", project, "--title=\(title)"] + (text.isEmpty ? [] : ["--text=\(text)"]) + photos.map { "--photo=\($0.path)" } + ["--json"]
    }

    public static func projectList() -> [String] { ["project", "list", "--capabilities", "--json"] }

    /// The name after `--`, so one that starts with a dash is never read as an option.
    public static func projectNew(name: String) -> [String] { ["project", "new", "--json", "--", name] }
}

extension PolycapOutput {
    /// The JSON a command printed: all of stdout when it is one JSON value (`thread show` pretty-prints),
    /// else the last line that is one, so a stray line before it does not matter.
    public static func json(_ stdout: Data, command: String) throws -> Data {
        let text = String(decoding: stdout, as: UTF8.self).trimmingWhitespace()
        if let data = text.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil, text.hasPrefix("{") || text.hasPrefix("[") {
            return data
        }
        for line in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" }).reversed() {
            let candidate = String(line).trimmingWhitespace()
            guard candidate.hasPrefix("{") || candidate.hasPrefix("["), let data = candidate.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: data)) != nil else { continue }
            return data
        }
        throw PolycapError("polycap \(command) printed no JSON")
    }

    /// `polycap upload --json`: {uploadId, thread, as, clientId, bytes, received, status, resumedFrom, narration?, sessionId?}.
    public struct Uploaded: Decodable, Sendable, Equatable {
        public var uploadId: String
        /// The thread it is in: the one replied in, the one it opened, or the report's.
        public var thread: String
        /// reply, thread or report; polycaps before 2026-11-16 sent replies only and do not say.
        public var kind: String?
        public var clientId: String?
        public var bytes: Int?
        public var received: Int?
        /// The receiver's state for it: uploading, received, processing, ready, failed.
        public var status: String
        public var resumedFrom: Int?
        public var narration: String?
        public var sessionId: String?

        enum CodingKeys: String, CodingKey {
            case uploadId, thread, kind = "as", clientId, bytes, received, status, resumedFrom, narration, sessionId
        }
    }

    public static func uploaded(from stdout: Data) throws -> Uploaded {
        let value: Uploaded
        do { value = try JSONDecoder().decode(Uploaded.self, from: try json(stdout, command: "upload")) } catch let error as PolycapError { throw error } catch {
            throw PolycapError("polycap upload printed something this app does not read: \(error)")
        }
        // src/commands/upload.ts: the receiver's ids are up_ and 16 hex digits.
        let hex = value.uploadId.dropFirst(3)
        guard value.uploadId.hasPrefix("up_"), hex.count == 16, hex.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }) else {
            throw PolycapError("polycap upload gave an upload id that is not one: \(value.uploadId)")
        }
        guard ThreadKey.isValid(value.thread) else { throw PolycapError("polycap upload gave a thread that is not one: \(value.thread)") }
        return value
    }
}

extension PolycapRunner {
    /// Network round trips to the hosted receiver.
    public static let threadTimeout: TimeInterval = 90
    /// A walkthrough of tens of minutes is hundreds of MB in 8 MB chunks.
    public static let uploadTimeout: TimeInterval = 3 * 3600
    /// What the app allows polycap's hooks when they could not be listed: src/hooks.ts gives each hook at
    /// most a day (MAX_TIMEOUT_MINUTES). Otherwise the limit follows the hooks (hooksTimeout).
    public static let hooksRunTimeout: TimeInterval = 25 * 3600

    public func threadList() async throws -> [ThreadSummary] {
        try ThreadOutput.list(try await succeed("thread list", PolycapCommand.threadList(), timeout: Self.threadTimeout))
    }

    /// Also marks the thread read for this Mac's token, as `polycap thread show` does.
    public func threadShow(key: String) async throws -> ThreadDetail {
        guard ThreadKey.isValid(key) else { throw PolycapError("\(key) is not a thread key such as MUS-12") }
        return try ThreadOutput.thread(try await succeed("thread show", PolycapCommand.threadShow(key: key), timeout: Self.threadTimeout))
    }

    /// Words, photos (files polycap converts, strips and sends: docs/THREADS.md, Photos), or both.
    public func threadReply(key: String, text: String, photos: [URL] = []) async throws -> PostedReply {
        guard ThreadKey.isValid(key) else { throw PolycapError("\(key) is not a thread key such as MUS-12") }
        let words = text.trimmingWhitespace()
        guard !words.isEmpty || !photos.isEmpty else { throw PolycapError("a reply needs some words or a photo") }
        guard words.utf8.count <= 20_000 else { throw PolycapError("a reply is at most 20,000 characters here; send a longer one with polycap thread reply --text-file") }
        guard photos.count <= ThreadPhotos.maxPerMessage else { throw PolycapError("a message holds at most \(ThreadPhotos.maxPerMessage) photos") }
        if let missing = photos.first(where: { !$0.isFileURL || !FileManager.default.fileExists(atPath: $0.path) }) {
            throw PolycapError("\(missing.lastPathComponent) is not a file on this Mac any more")
        }
        // Several photos each go through ffmpeg and the receiver, so they get longer than words.
        let timeout = Self.threadTimeout + Double(photos.count) * 60
        return try ThreadOutput.reply(try await succeed("thread reply", PolycapCommand.threadReply(key: key, text: words, photos: photos), timeout: timeout))
    }

    /// A new thread typed in the window: a title, and words, photos or both (polycap's token needs `post` for
    /// words alone; the receiver says so if it lacks it).
    public func threadNew(project: String, title: String, text: String, photos: [URL] = []) async throws -> PostedReply {
        guard ProjectKey.isValid(project) else { throw PolycapError("\(project) is not a project key such as MUS") }
        let heading = title.trimmingWhitespace(), words = text.trimmingWhitespace()
        guard !heading.isEmpty else { throw PolycapError("a new thread needs a title") }
        guard heading.utf16.count <= 120 else { throw PolycapError("a title is at most 120 characters") }
        guard !words.isEmpty || !photos.isEmpty else { throw PolycapError("a new thread needs some words or a photo") }
        guard words.utf8.count <= 20_000 else { throw PolycapError("a message is at most 20,000 characters here; send a longer one with polycap thread new --text-file") }
        guard photos.count <= ThreadPhotos.maxPerMessage else { throw PolycapError("a message holds at most \(ThreadPhotos.maxPerMessage) photos") }
        if let missing = photos.first(where: { !$0.isFileURL || !FileManager.default.fileExists(atPath: $0.path) }) {
            throw PolycapError("\(missing.lastPathComponent) is not a file on this Mac any more")
        }
        let timeout = Self.threadTimeout + Double(photos.count) * 60
        return try ThreadOutput.opened(try await succeed("thread new", PolycapCommand.threadNew(project: project, title: heading, text: words, photos: photos), timeout: timeout))
    }

    public func projectList() async throws -> ProjectListing {
        try ThreadOutput.projects(try await succeed("project list", PolycapCommand.projectList(), timeout: Self.threadTimeout))
    }

    /// A project of the Mac's person's own; the receiver makes its key from the name.
    public func projectNew(name: String) async throws -> ThreadProject {
        let named = name.trimmingWhitespace()
        guard !named.isEmpty else { throw PolycapError("a project needs a name") }
        return try ThreadOutput.madeProject(try await succeed("project new", PolycapCommand.projectNew(name: named), timeout: Self.threadTimeout))
    }

    /// A walkthrough as a reply in a thread, a new thread or a report. Fail closed: the recording's metadata
    /// must be there and read strictly, and one that describes a call is refused before polycap starts, since
    /// calls never leave this Mac (polycap refuses a call's metadata too). The metadata always goes with it.
    public func upload(_ files: RecordingFiles, to target: WalkthroughTarget, onStart: (@Sendable (Int32) -> Void)? = nil) async throws -> PolycapOutput.Uploaded {
        try target.validate()
        let meta: RecordingMeta
        do { meta = try RecordingMeta.decode(try Data(contentsOf: files.meta)) } catch {
            throw PolycapError("\(files.meta.lastPathComponent) could not be read, so the walkthrough was not sent: \(error)")
        }
        guard meta.call == nil else { throw PolycapError("\(files.videoName) is a call. Calls never leave this Mac, so it was not sent.") }
        let args = PolycapCommand.upload(video: files.video.path, to: target, meta: files.meta.path)
        return try PolycapOutput.uploaded(from: try await succeed("upload", args, timeout: Self.uploadTimeout, onStart: onStart))
    }

    public func hooksList() async throws -> HookListing {
        try HookListing.decode(try PolycapOutput.json(try await succeed("hooks list", PolycapCommand.hooksList(), timeout: Self.shortTimeout), command: "hooks list"))
    }

    /// `polycap hooks run <id> [--hook NAME] --force`: waits for the hooks to finish.
    public func hooksRun(id: String, hook: String? = nil) async throws -> HooksRunResult {
        guard PolycapOutput.isSessionID(id) else { throw PolycapError("not a session id: \(id)") }
        if let hook, !HookName.isValid(hook) { throw PolycapError("\(hook) is not a hook name") }
        let timeout = Self.hooksTimeout(try? await hooksList(), named: hook)
        let out = try await succeed("hooks run", PolycapCommand.hooksRun(id: id, hook: hook), timeout: timeout)
        return try HooksRunResult.decode(try PolycapOutput.json(out, command: "hooks run"))
    }

    /// Runs a command and returns its stdout, or throws with what it said on stderr, whole.
    func succeed(_ command: String, _ arguments: [String], timeout: TimeInterval, onStart: (@Sendable (Int32) -> Void)? = nil) async throws -> Data {
        let result = try await run(arguments, timeout: timeout, onStart: onStart)
        guard result.succeeded else { throw PolycapError(Self.failure(command, result, limit: 4000)) }
        return result.stdout
    }
}

/// Walkthroughs recorded for a thread (replies, new threads and reports), and what happened to each upload, in <library>/mac/uploads.json
/// (0600). The entry is written when the recording starts, so a walkthrough meant for a thread is never
/// imported as a local session at the next launch, and an upload the app did not finish (it quit, or the
/// receiver refused it) is shown with its error until the user sends it again. The recordings stay in
/// the recordings folder after they are sent.
public struct UploadLedger: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        /// Being recorded; left behind only when the app went away first.
        case recording
        /// Saved, not sent yet (the app was quitting, or an earlier upload is still going).
        case saved
        case uploading
        case uploaded
        case failed
    }

    public struct Entry: Codable, Sendable, Equatable {
        public var status: Status
        public var target: WalkthroughTarget
        public var at: String
        public var uploadId: String?
        /// What the receiver said the upload's state was when polycap finished.
        public var receiverStatus: String?
        public var error: String?
        /// The `polycap upload` sending it, while it is uploading.
        public var pid: Int32?

        public init(status: Status, target: WalkthroughTarget, at: String, uploadId: String? = nil, receiverStatus: String? = nil, error: String? = nil,
                    pid: Int32? = nil) {
            self.status = status
            self.target = target
            self.at = at
            self.uploadId = uploadId
            self.receiverStatus = receiverStatus
            self.error = error
            self.pid = pid
        }
    }

    public var version: Int = 1
    /// Keyed by the recording's video file name.
    public var recordings: [String: Entry] = [:]

    public init() {}

    public static func load(from url: URL) throws -> UploadLedger {
        guard FileManager.default.fileExists(atPath: url.path) else { return UploadLedger() }
        let ledger: UploadLedger
        do { ledger = try JSONDecoder().decode(UploadLedger.self, from: try Data(contentsOf: url)) } catch {
            throw FileRuleError("\(url.path) is not an upload ledger: \(error)")
        }
        guard ledger.version == 1 else { throw FileRuleError("\(url.path) has version \(ledger.version); this app reads version 1") }
        return ledger
    }

    public func save(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try PrivateFiles.write(try encoder.encode(self), to: url)
    }

    /// After a restart nothing is recording any more, and an upload is still going only when the
    /// `polycap upload` the app left running is (quitting the app does not stop it): that one stays
    /// uploading, to be watched until it ends. Any other upload was cut off: not sent, with why.
    public func afterRestart(at: String, stillRunning: (_ name: String, _ entry: Entry) -> Bool = { _, _ in false }) -> UploadLedger {
        var next = self
        for (name, entry) in recordings {
            switch entry.status {
            case .recording: next.recordings[name]?.status = .saved; next.recordings[name]?.at = at
            case .uploading:
                if stillRunning(name, entry) { continue }
                next.recordings[name] = Self.cutOff(entry, at: at)
            case .saved, .uploaded, .failed: break
            }
        }
        return next
    }

    /// An upload whose polycap is gone without saying how it ended.
    public static func cutOff(_ entry: Entry, at: String) -> Entry {
        var failed = entry
        failed.status = .failed
        failed.pid = nil
        failed.at = at
        failed.error = entry.pid == nil ? "the upload was cut off when the app quit; send it again to resume"
            : "polycap was still sending this when the app last quit, and has stopped; whether it finished is not known here. Send again asks the receiver and resumes, or finds it already there"
        return failed
    }
}

extension LibraryLayout {
    /// Walkthroughs for threads and their uploads.
    public var uploadLedger: URL { mac.appendingPathComponent("uploads.json") }
    /// Where `polycap thread show` saves a thread's photos, one folder per thread.
    public var photos: URL { root.appendingPathComponent("photos") }
    /// Screenshots pasted or images dropped into a reply, kept until the reply is sent.
    public var pastedPhotos: URL { mac.appendingPathComponent("pasted") }
}

/// Photos a reply can carry from the Mac (docs/THREADS.md, Photos, 2026-11-07): image files, chosen, dropped
/// or pasted. polycap converts, scales and strips them; this only says what may be offered to it.
public enum ThreadPhotos {
    public static let maxPerMessage = 10
    /// What polycap reads itself or converts with ffmpeg.
    public static let extensions: Set<String> = ["jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "tif", "tiff"]

    public static func isPhoto(_ url: URL) -> Bool { url.isFileURL && extensions.contains(url.pathExtension.lowercased()) }

    /// The chosen photos with these added, once each, at most ten; the second value says how many did not fit or were not photos.
    public static func adding(_ urls: [URL], to chosen: [URL]) -> (photos: [URL], refused: Int) {
        var photos = chosen
        var refused = 0
        for url in urls {
            let file = url.standardizedFileURL
            if photos.contains(file) { continue }
            if !isPhoto(file) || photos.count >= maxPerMessage { refused += 1; continue }
            photos.append(file)
        }
        return (photos, refused)
    }

    /// Writes PNG data from the pasteboard or a drop as a private file to send, named afresh each time.
    public static func savePasted(_ png: Data, in layout: LibraryLayout) throws -> URL {
        let dir = layout.pastedPhotos
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = dir.appendingPathComponent("pasted-\(UUID().uuidString.lowercased()).png")
        guard FileManager.default.createFile(atPath: file.path, contents: png, attributes: [.posixPermissions: 0o600]) else {
            throw PolycapError("could not keep the pasted image in \(dir.path)")
        }
        return file
    }

    /// A pasted copy, as opposed to a file the person chose: only these are removed once sent.
    public static func isPasted(_ url: URL, in layout: LibraryLayout) -> Bool {
        url.standardizedFileURL.deletingLastPathComponent() == layout.pastedPhotos.standardizedFileURL
    }

    /// Pasted copies left by an earlier run, whose drafts are gone: removed at launch.
    public static func clearPasted(in layout: LibraryLayout) {
        let dir = layout.pastedPhotos
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix("pasted-") && name.hasSuffix(".png") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }
}

/// A polycap this app started and left running when it quit (Foundation does not stop a child when its
/// parent exits, and the child finishes its work: an upload goes on, a process runs its hooks). Alive,
/// running polycap.js, and with `mentioning` (the recording's file or the session's id) among its
/// arguments, so a pid the system has since given to some other program is never taken for it.
public enum PolycapProcess {
    public static func isRunning(pid: Int32, mentioning: String) -> Bool {
        guard pid > 1, let args = arguments(of: pid) else { return false }
        return args.contains { $0.hasSuffix("polycap.js") } && args.contains(mentioning)
    }

    /// A process's argument vector (KERN_PROCARGS2: argc, the executable's path, padding, then argv);
    /// nil when it is gone or not readable.
    public static func arguments(of pid: Int32) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
        var index = MemoryLayout<Int32>.size
        while index < size, buffer[index] != 0 { index += 1 }  // the executable's path
        while index < size, buffer[index] == 0 { index += 1 }  // padding
        var args: [String] = []
        while args.count < argc, index < size {
            let start = index
            while index < size, buffer[index] != 0 { index += 1 }
            args.append(String(decoding: buffer[start..<index], as: UTF8.self))
            index += 1
        }
        return args
    }
}
