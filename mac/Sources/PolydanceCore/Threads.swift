// Threads on the Mac (docs/MAC.md, "Threads in the Mac app; calls stay local"): what `polycap thread
// list --json`, `thread show KEY --json`, `thread reply --json`, `thread new --json`, `project list
// --capabilities --json` and `project new --json` print (src/commands/thread.ts), decoded into
// PolydanceShared's thread models and checked, where a walkthrough goes (a reply, a new thread or a report),
// and the guard that keeps a Meet call out of one. polycap parses the receiver's answer loosely and prints it whole, so the app tolerates
// keys it does not know; but a thread key goes back to polycap as an argument, so it is refused when it is
// not one.
import Foundation
import PolydanceShared

public enum ThreadOutput {
    public static func list(_ stdout: Data) throws -> [ThreadSummary] {
        let threads: [ThreadSummary]
        do { threads = try JSONDecoder().decode([ThreadSummary].self, from: try PolycapOutput.json(stdout, command: "thread list")) } catch let error as PolycapError { throw error } catch {
            throw PolycapError("polycap thread list printed something this app does not read: \(error)")
        }
        if let bad = threads.first(where: { !ThreadKey.isValid($0.key) }) { throw PolycapError("polycap thread list gave \"\(bad.key)\", which is not a thread key such as MUS-12") }
        return threads
    }

    public static func thread(_ stdout: Data) throws -> ThreadDetail {
        let thread: ThreadDetail
        do { thread = try JSONDecoder().decode(ThreadDetail.self, from: try PolycapOutput.json(stdout, command: "thread show")) } catch let error as PolycapError { throw error } catch {
            throw PolycapError("polycap thread show printed something this app does not read: \(error)")
        }
        guard ThreadKey.isValid(thread.key) else { throw PolycapError("polycap thread show gave \"\(thread.key)\", which is not a thread key") }
        return thread
    }

    public static func reply(_ stdout: Data) throws -> PostedReply {
        let posted: PostedReply
        do { posted = try JSONDecoder().decode(PostedReply.self, from: try PolycapOutput.json(stdout, command: "thread reply")) } catch let error as PolycapError { throw error } catch {
            throw PolycapError("polycap thread reply printed something this app does not read: \(error)")
        }
        guard ThreadKey.isValid(posted.key), posted.message > 0 else { throw PolycapError("polycap thread reply gave \(posted.key) #\(posted.message), which is not a message") }
        return posted
    }

    /// `thread new --json`: the new thread's key and its first message, as a reply's.
    public static func opened(_ stdout: Data) throws -> PostedReply {
        let posted: PostedReply
        do { posted = try JSONDecoder().decode(PostedReply.self, from: try PolycapOutput.json(stdout, command: "thread new")) } catch let error as PolycapError { throw error } catch {
            throw PolycapError("polycap thread new printed something this app does not read: \(error)")
        }
        guard ThreadKey.isValid(posted.key), posted.message > 0 else { throw PolycapError("polycap thread new gave \(posted.key) #\(posted.message), which is not a new thread") }
        return posted
    }

    /// `project list --capabilities --json`: the projects this Mac's token sees and what the receiver offers.
    public static func projects(_ stdout: Data) throws -> ProjectListing {
        let listing: ProjectListing
        do { listing = try JSONDecoder().decode(ProjectListing.self, from: try PolycapOutput.json(stdout, command: "project list")) } catch let error as PolycapError { throw error } catch {
            throw PolycapError("polycap project list printed something this app does not read: \(error)")
        }
        if let bad = listing.projects.first(where: { !ProjectKey.isValid($0.key) }) { throw PolycapError("polycap project list gave \"\(bad.key)\", which is not a project key such as MUS") }
        return listing
    }

    /// `project new --json`: the project made, which is the maker's own.
    public static func madeProject(_ stdout: Data) throws -> ThreadProject {
        let made: ThreadProject
        do { made = try JSONDecoder().decode(ThreadProject.self, from: try PolycapOutput.json(stdout, command: "project new")) } catch let error as PolycapError { throw error } catch {
            throw PolycapError("polycap project new printed something this app does not read: \(error)")
        }
        guard ProjectKey.isValid(made.key) else { throw PolycapError("polycap project new gave \"\(made.key)\", which is not a project key") }
        return ThreadProject(key: made.key, name: made.name, mine: true)
    }
}

/// src/threads.ts PROJECT_KEY: `^[A-Z][A-Z0-9]{1,9}$`, the part of a thread key before its number.
public enum ProjectKey {
    public static func isValid(_ key: String) -> Bool { ThreadKey.isValid("\(key)-1") }
}

/// A project New thread can open a thread in: the team's, or one of the person's own (docs/THREADS.md,
/// Projects of your own).
public struct ThreadProject: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var key: String
    public var name: String
    public var mine: Bool
    public var id: String { key }

    public init(key: String, name: String, mine: Bool) {
        self.key = key
        self.name = name
        self.mine = mine
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        name = try c.decode(String.self, forKey: .name)
        mine = try c.decodeIfPresent(Bool.self, forKey: .mine) ?? false
    }
}

/// The receiver's projects for this Mac, and whether it takes reports (reports-v1) and makes projects of
/// your own (projects-new-v1): an older receiver offers neither, and the window then offers neither.
public struct ProjectListing: Decodable, Sendable, Equatable {
    public var projects: [ThreadProject]
    public var capabilities: [String]

    public init(projects: [ThreadProject], capabilities: [String]) {
        self.projects = projects
        self.capabilities = capabilities
    }

    public var takesReports: Bool { capabilities.contains("reports-v1") }
    public var makesProjects: Bool { capabilities.contains("projects-new-v1") }
}

/// Where a walkthrough recorded from Polydance's window goes when it stops, as `polycap upload` says it:
/// a reply in a thread (`--thread`, with the message and launch it answers), the first message of a new
/// thread in a project (`--project`), or a report from the bug key for the Polydance team (`--report`).
/// It is in the upload ledger from the moment the recording starts. Ledgers from before 2026-11-16 hold
/// replies only, which read as replies here.
public struct WalkthroughTarget: Codable, Sendable, Equatable, Hashable {
    public enum Kind: Sendable, Equatable { case reply, newThread, report }

    /// The thread a reply goes in; for a new thread or a report, the one the receiver put it in, once sent.
    public var thread: String?
    public var replyTo: Int?
    /// The launch's index in that message, from 0; only with `replyTo`.
    public var launch: Int?
    /// "Option 1: gear in the top bar", for the app's own lines.
    public var label: String?
    /// The project a new thread opens in, and its name for the app's own lines.
    public var project: String?
    public var projectName: String?
    /// A report from the bug key.
    public var report: Bool?

    /// A reply in a thread.
    public init(thread: String, replyTo: Int? = nil, launch: Int? = nil, label: String? = nil) {
        self.thread = thread
        self.replyTo = replyTo
        self.launch = replyTo == nil ? nil : launch
        self.label = label
    }

    private init() {}

    /// The first message of a new thread in this project.
    public static func newThread(in project: ThreadProject) -> WalkthroughTarget {
        var target = WalkthroughTarget()
        target.project = project.key
        target.projectName = project.name
        return target
    }

    /// A report from the bug key.
    public static var report: WalkthroughTarget {
        var target = WalkthroughTarget()
        target.report = true
        return target
    }

    public var kind: Kind { report == true ? .report : project != nil ? .newThread : .reply }

    /// What it is, for the app's own lines: "a reply to MUS-12", "a new thread in Kitchen Timer", "a report".
    public var what: String {
        switch kind {
        case .reply: "a reply to \(thread ?? "a thread")"
        case .newThread: "a new thread in \(projectName ?? project ?? "a project")"
        case .report: "a report"
        }
    }

    /// The same as a heading: "Reply to MUS-12", "New thread in Kitchen Timer", "Report".
    public var title: String {
        switch kind {
        case .reply: "Reply to \(thread ?? "a thread")"
        case .newThread: "New thread in \(projectName ?? project ?? "a project")"
        case .report: "Report"
        }
    }

    /// What happens when it stops: "sent to MUS-12", "opens a thread in Kitchen Timer", "sent to the Polydance team".
    public var whenStopped: String {
        switch kind {
        case .reply: "sent to \(thread ?? "the thread")"
        case .newThread: "opens a thread in \(projectName ?? project ?? "the project")"
        case .report: "sent to the Polydance team"
        }
    }

    /// The rules src/commands/upload.ts applies, checked before anything is recorded.
    public func validate() throws {
        switch kind {
        case .reply:
            guard let thread, ThreadKey.isValid(thread) else { throw PolycapError("\(thread ?? "no thread") is not a thread key such as MUS-12") }
            if let replyTo, replyTo < 1 { throw PolycapError("message \(replyTo) is not a message number") }
            if let launch, !(0...5).contains(launch) { throw PolycapError("launch \(launch) is not a launch index (0 to 5)") }
        case .newThread, .report:
            if report == true, project != nil { throw PolycapError("a walkthrough is a new thread or a report, not both") }
            if let project, !ProjectKey.isValid(project) { throw PolycapError("\(project) is not a project key such as MUS") }
            if replyTo != nil || launch != nil { throw PolycapError("a new thread or a report answers no message") }
            if let thread, !ThreadKey.isValid(thread) { throw PolycapError("\(thread) is not a thread key such as MUS-12") }
        }
    }
}

/// A walkthrough recorded from the window is sent to a shared server, so it must never hold a call (docs/MAC.md:
/// calls never leave this Mac). The upload refuses a call's metadata, but a walkthrough's metadata says
/// walkthrough even if a Meet call was live while it recorded, so the app also refuses to start one while
/// a call is live, and stops one, unsent, when a call starts during it.
public enum ThreadReplyGuard {
    /// Why a reply cannot be recorded now, or nil. A call is live when Arc holds the microphone on a Meet
    /// code, or while the detector is still following one (recording it, or standing down after the user
    /// stopped or discarded it).
    public static func problem(arcMicActive: Bool, meetingCode: String?, detectorWatching: Bool) -> String? {
        guard (arcMicActive && meetingCode != nil) || !detectorWatching else { return nil }
        return "A Meet call is live in Arc. Calls never leave this Mac, so leave the call before recording a reply."
    }

    /// Whether a reply being recorded has caught a call: Arc took the microphone on a Meet code.
    public static func callStarted(_ observation: CallObservation) -> Bool {
        observation.micActive && !(observation.meetingCodes ?? []).isEmpty
    }

    /// What the thread page says about a reply stopped because a call started.
    public static let stoppedNote = "A Meet call started while this reply was being recorded, so it was stopped and not sent. It may hold other people's voices or screens: send it only if it does not."
}

extension ThreadMessage.Photo {
    /// The saved copy, only where polycap keeps it: `<library>/photos/<KEY>/<sha256>.jpg|png`. Any other
    /// path is not opened, whatever polycap printed. Here rather than with the model in PolydanceShared,
    /// because the library's layout is the Mac's.
    public func file(in layout: LibraryLayout, thread key: String) -> URL? {
        guard let path, ThreadKey.isValid(key), sha256.count == 64, sha256.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              let ext = ["image/jpeg": "jpg", "image/png": "png"][type] else { return nil }
        let expected = layout.photos.appendingPathComponent(key).appendingPathComponent("\(sha256).\(ext)").standardizedFileURL
        return URL(fileURLWithPath: path).standardizedFileURL == expected ? expected : nil
    }
}
