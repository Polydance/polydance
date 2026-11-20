// The routine as the app shows it (docs/MAC.md, "Starting Robin's routine", H1 to H3): the hooks polycap
// has configured (`polycap hooks list --json`), what `polycap hooks run --json` reports, the command
// that continues the agent's conversation, and the documented hooks.json the settings can create when
// the user confirms. The hooks themselves are polycap's (src/hooks.ts): this file only reads what it
// prints, checking the fields the app passes on (a hook's name goes back to polycap as an argument).
import Foundation
import PolydanceShared

public enum HookName {
    /// src/hooks.ts HOOK_NAME: `^[a-z0-9][a-z0-9-]{0,39}$`.
    public static func isValid(_ name: String) -> Bool {
        let bytes = Array(name.utf8)
        guard (1...40).contains(bytes.count) else { return false }
        func lowerOrDigit(_ b: UInt8) -> Bool { (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(b) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b) }
        return lowerOrDigit(bytes[0]) && bytes.dropFirst().allSatisfy { lowerOrDigit($0) || $0 == UInt8(ascii: "-") }
    }
}

/// `polycap hooks list --json`: {file, found, hooks: [...]} with each hook's env shown by name only.
public struct HookListing: Decodable, Sendable, Equatable {
    public struct Hook: Decodable, Sendable, Equatable, Identifiable {
        public struct When: Decodable, Sendable, Equatable {
            /// call, walkthrough or any.
            public var mode: String
            public var minMinutes: Double?
        }

        public var name: String
        public var when: When
        public var cwd: String?
        public var run: [String]
        public var timeoutMinutes: Double
        public var envNames: [String]?

        public var id: String { name }

        /// "calls of 2 min or more", for the settings.
        public var filterText: String {
            let what = when.mode == "call" ? "calls" : when.mode == "walkthrough" ? "walkthroughs" : "every recording"
            guard let min = when.minMinutes, min > 0 else { return "Runs after \(what)" }
            let minutes = min == min.rounded() ? String(Int(min)) : String(min)
            return "Runs after \(what) of \(minutes) min or more; shorter ones are skipped"
        }

        /// The command as a person reads it: arguments with spaces in quotes. Display only; polycap runs
        /// the argument array itself, with no shell.
        public var commandText: String {
            run.map { $0.contains(where: { $0 == " " || $0 == "\"" }) ? "\"\($0.replacingOccurrences(of: "\"", with: "\\\""))\"" : $0 }.joined(separator: " ")
        }
    }

    public var file: String
    public var found: Bool
    public var hooks: [Hook]

    public static func decode(_ data: Data) throws -> HookListing {
        let value: HookListing
        do { value = try JSONDecoder().decode(HookListing.self, from: data) } catch { throw PolycapError("polycap hooks list printed something this app does not read: \(error)") }
        guard value.file.hasPrefix("/") else { throw PolycapError("polycap hooks list gave a hooks file that is not absolute: \(value.file)") }
        for hook in value.hooks {
            guard HookName.isValid(hook.name) else { throw PolycapError("polycap hooks list gave a hook name that is not one: \(hook.name)") }
            guard ["call", "walkthrough", "any"].contains(hook.when.mode) else { throw PolycapError("hook \(hook.name) has mode \(hook.when.mode), not call, walkthrough or any") }
            guard !hook.run.isEmpty else { throw PolycapError("hook \(hook.name) runs nothing") }
        }
        return value
    }

    public func hook(named name: String) -> Hook? { hooks.first { $0.name == name } }
}

/// `polycap hooks run <id> --json`: which hooks ran, which did not and why, and their runs now.
public struct HooksRunResult: Decodable, Sendable, Equatable {
    public var id: String
    public var dir: String
    public var ran: [String]
    public var notRun: [String: String]
    /// Set when another polycap is already running this session's hooks.
    public var busy: String?
    public var runs: [String: HookRuns.Run]

    public static func decode(_ data: Data) throws -> HooksRunResult {
        do { return try JSONDecoder().decode(HooksRunResult.self, from: data) } catch { throw PolycapError("polycap hooks run printed something this app does not read: \(error)") }
    }

    /// One line for the call page: what happened, when nothing ran.
    public var summary: String? {
        if let busy { return "Not run: \(busy)" }
        guard ran.isEmpty else { return nil }
        if notRun.isEmpty { return "No hook matched this call" }
        return notRun.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "; ")
    }
}

/// How a person continues the agent's conversation (src/hooks.ts resumeCommand): Claude Code's resume,
/// in the hook's folder.
public enum ResumeCommand {
    /// src/hooks.ts: agentSessionId is `^[A-Za-z0-9_-]{1,128}$`. Anything else makes no command, since
    /// the text is pasted into a terminal.
    public static func isAgentSessionID(_ id: String) -> Bool {
        let bytes = Array(id.utf8)
        return (1...128).contains(bytes.count) && bytes.allSatisfy { b in
            (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(b) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(b)
                || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b) || b == UInt8(ascii: "_") || b == UInt8(ascii: "-")
        }
    }

    /// `cd ~/Code/calls && claude --resume <id>`, or without the `cd` when the hook's folder is not known
    /// (a hook with no cwd runs in the home folder, where a new terminal starts). The folder is quoted
    /// for the shell when it needs to be, keeping a leading `~/` outside the quotes so it still expands.
    public static func make(agentSessionId: String?, hookCwd: String?) -> String? {
        guard let id = agentSessionId, isAgentSessionID(id) else { return nil }
        let resume = "claude --resume \(id)"
        guard let cwd = hookCwd?.trimmingWhitespace(), !cwd.isEmpty else { return resume }
        return "cd \(shellPath(cwd)) && \(resume)"
    }

    static func shellPath(_ path: String) -> String {
        if path == "~" { return path }
        let plain = path.utf8.allSatisfy { b in
            (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(b) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(b)
                || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b) || "/._-~+,".utf8.contains(b)
        }
        if plain { return path }
        let quote: (String) -> String = { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        if path.hasPrefix("~/") { return "~/" + quote(String(path.dropFirst(2))) }
        return quote(path)
    }
}

extension HookRuns.Run {
    /// How long the run took, when it has finished.
    public var duration: TimeInterval? {
        guard let start = MetaTime.parse(startedAt), let end = finishedAt.flatMap(MetaTime.parse) else { return nil }
        return max(0, end.timeIntervalSince(start))
    }

    /// The card's status word.
    public var statusLabel: String {
        switch status {
        case .running: "Running"
        case .done: "Done"
        case .failed: "Failed"
        case .timeout: "Timed out"
        case .skipped: "Skipped"
        }
    }
}

/// "4 min", "45 s", "1 h 12 min": how long something took.
public func durationText(_ seconds: TimeInterval) -> String {
    let total = Int(seconds.rounded())
    if total < 60 { return "\(total) s" }
    let minutes = Int((Double(total) / 60).rounded())
    if minutes < 60 { return "\(minutes) min" }
    return "\(minutes / 60) h \(minutes % 60) min"
}

public enum HooksFileExample {
    /// ~/.config/polycap/hooks.json, as polycap looks for it when POLYCAP_HOOKS is not set.
    public static func defaultPath(home: URL) -> URL {
        home.appendingPathComponent(".config/polycap/hooks.json")
    }

    /// The hooks file polycap reads (src/config.ts): POLYCAP_HOOKS from its env file (the app gives
    /// polycap no POLYCAP_HOOKS of its own), else the default.
    public static func path(envFile: [String: String], home: URL) -> URL {
        if let set = envFile["POLYCAP_HOOKS"]?.trimmingWhitespace(), !set.isEmpty {
            return URL(fileURLWithPath: expandTilde(set, home: home)).standardizedFileURL
        }
        return defaultPath(home: home)
    }

    /// docs/MAC.md "Starting Robin's routine", word for word. Every step of the routine's tool is listed
    /// and nothing more: in headless dontAsk mode anything not listed is denied, and `Bash(polycap *)`
    /// would let other people's words drive `thread reply`, `upload` and `sync`. Edit(notes/**) covers
    /// writing the notes (Claude Code's Edit rules cover Write); the Slack draft tool is added by its
    /// /mcp name.
    public static let text = """
    {
      "version": 1,
      "hooks": [{
        "name": "call-routine",
        "when": { "mode": "call", "minMinutes": 2 },
        "cwd": "~/Code/calls",
        "run": ["claude", "-p", "Process the Polydance call in {dir} with the process-call skill.",
                "--name", "Call: {title}", "--output-format", "json",
                "--permission-mode", "dontAsk",
                "--allowedTools", "Read Glob Grep Edit(notes/**) Bash(polycap show *) Bash(polycap transcript *) Bash(polycap frames *) Bash(git add *) Bash(git commit *) Bash(git push *)"],
        "env": {},
        "timeoutMinutes": 30
      }]
    }

    """

    /// Writes the example to `url` (0600) after the user has confirmed, creating its folder (0700) only
    /// when it is missing and inside the home folder. Refuses to replace a file that is there: the
    /// settings open an existing hooks.json, they never overwrite one.
    public static func create(at url: URL, home: URL, fileManager: FileManager = .default) throws {
        let dir = url.deletingLastPathComponent()
        var isDirectory: ObjCBool = false
        if !fileManager.fileExists(atPath: dir.path, isDirectory: &isDirectory) {
            try PrivateFiles.makeDirectory(dir, within: home, fileManager: fileManager)
        } else if !isDirectory.boolValue {
            throw FileRuleError("\(dir.path) is not a folder")
        }
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else {
            throw FileRuleError(errno == EEXIST ? "\(url.path) already exists; it was left as it is" : "cannot create \(url.path): \(String(cString: strerror(errno)))")
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            try handle.write(contentsOf: Data(text.utf8))
            try handle.close()
        } catch {
            unlink(url.path)
            throw error
        }
    }

    /// The repository's docs/MAC.md, found from polycap.js (<repo>/bin/polycap.js), when it is there.
    public static func docs(polycapJS: String?, fileManager: FileManager = .default) -> URL? {
        guard let js = polycapJS else { return nil }
        let repo = URL(fileURLWithPath: js).deletingLastPathComponent().deletingLastPathComponent()
        let docs = repo.appendingPathComponent("docs/MAC.md")
        return fileManager.fileExists(atPath: docs.path) ? docs : nil
    }
}
