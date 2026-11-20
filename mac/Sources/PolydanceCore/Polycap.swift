// How the Mac app talks to polycap, the receiver (T3): the exact argument arrays of the contract's
// commands, the explicit environment every child gets, and strict parsing of what comes back. A GUI
// app's PATH holds neither node nor polycap, so both are found once, from the settings or by asking
// the user's login shell, and stored. Nothing here passes through a shell except that one constant
// question to the login shell, which carries no values.
import Foundation

/// node and the polycap.js it runs.
public struct PolycapInstall: Codable, Sendable, Equatable {
    public var node: String
    public var polycapJS: String

    public init(node: String, polycapJS: String) {
        self.node = node
        self.polycapJS = polycapJS
    }
}

public struct PolycapError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// polycap ran and failed: the short message the menu and the ledger show, and everything it printed,
/// which goes to the recording's log whole (the message keeps only the end of stderr).
public struct PolycapCommandFailure: Error, Equatable, CustomStringConvertible {
    public let message: String
    public let result: ProcessResult
    public init(_ message: String, result: ProcessResult) {
        self.message = message
        self.result = result
    }
    public var description: String { message }
}

/// The contract's commands, as argument arrays after `node polycap.js`.
public enum PolycapCommand {
    public static func importRecording(video: String, meta: String) -> [String] {
        ["import", video, "--meta", meta, "--json"]
    }

    public static func process(id: String) -> [String] {
        ["process", id, "--json"]
    }

    public static func hooksRun(id: String, hook: String? = nil) -> [String] {
        ["hooks", "run", id] + (hook.map { ["--hook", $0] } ?? []) + ["--force", "--json"]
    }

    public static func hooksList() -> [String] {
        ["hooks", "list", "--json"]
    }

    /// A walkthrough as a thread reply. `launch` only means something with `replyTo`.
    /// Where it goes as `polycap upload` says it: --thread with the message and launch it answers, --project
    /// for a new thread, --report for a report (WalkthroughTarget).
    public static func upload(video: String, to target: WalkthroughTarget, meta: String? = nil) -> [String] {
        var args = ["upload", video]
        switch target.kind {
        case .reply:
            args += ["--thread", target.thread ?? ""]
            if let replyTo = target.replyTo {
                args += ["--reply-to", String(replyTo)]
                if let launch = target.launch { args += ["--launch", String(launch)] }
            }
        case .newThread: args += ["--project", target.project ?? ""]
        case .report: args += ["--report"]
        }
        if let meta { args += ["--meta", meta] }
        return args + ["--json"]
    }

    public static func threadList() -> [String] { ["thread", "list", "--json"] }
    public static func threadShow(key: String) -> [String] { ["thread", "show", key, "--json"] }
}

public enum PolycapEnvironment {
    /// The PATH children get: node's own folder first, then Claude Code's, Homebrew's (ffmpeg,
    /// whisper-cli) and the system's.
    public static func path(nodePath: String, home: String) -> String {
        let nodeDir = (nodePath as NSString).deletingLastPathComponent
        var seen = Set<String>()
        return [nodeDir, "\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: ":")
    }

    /// Everything a child sees. Only identity and locale are carried over from the app's own
    /// environment; the rest is set here, so what polycap and the hooks run with is written down. No key,
    /// token or Claude Code session marker is ever carried over (only the names below are). The app passes
    /// the library it resolved as `libraryRoot`, so polycap can never pick another one from its env file.
    public static func make(nodePath: String, home: String, inherited: [String: String], libraryRoot: String?, transcriber: Transcriber) -> [String: String] {
        var env: [String: String] = ["HOME": home, "PATH": path(nodePath: nodePath, home: home), "POLYCAP_TRANSCRIBER": transcriber.rawValue]
        // POLYCAP_CONFIG is a path, not a secret: polycap then reads the env file the app read.
        for key in ["USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING", "POLYCAP_CONFIG"] {
            if let value = inherited[key], !value.isEmpty { env[key] = value }
        }
        if let root = libraryRoot ?? inherited["POLYCAP_ROOT"], !root.trimmingWhitespace().isEmpty {
            env["POLYCAP_ROOT"] = expandTilde(root.trimmingWhitespace(), home: URL(fileURLWithPath: home))
        }
        return env
    }
}

/// The one question asked of the login shell, and how its answer is read.
public enum LoginShellProbe {
    public static let nodeMarker = "__POLYDANCE_NODE__="
    public static let polycapMarker = "__POLYDANCE_POLYCAP__="
    /// Run as `/bin/zsh -i -l -c <script>`: interactive and login, so nvm and Homebrew's setup in
    /// .zshrc and .zprofile have run. Constant text: no value is ever put into it.
    public static let script = "printf '\\n\(nodeMarker)%s\\n\(polycapMarker)%s\\n' \"$(command -v node)\" \"$(command -v polycap)\""

    /// The last marked line of each kind, kept only when it is an absolute path (an alias or a shell
    /// function from `command -v` is not).
    public static func parse(_ output: String) -> (node: String?, polycap: String?) {
        var node: String?
        var polycap: String?
        for raw in output.split(whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" }) {
            let line = String(raw).trimmingWhitespace()
            if line.hasPrefix(nodeMarker) { node = String(line.dropFirst(nodeMarker.count)) }
            if line.hasPrefix(polycapMarker) { polycap = String(line.dropFirst(polycapMarker.count)) }
        }
        let keep: (String?) -> String? = { value in value.flatMap { $0.hasPrefix("/") ? $0 : nil } }
        return (keep(node), keep(polycap))
    }
}

public enum PolycapOutput {
    /// `polycap import --json`: one JSON line {"id": "...", "dir": "..."}. The last line that parses
    /// is taken, so a warning printed before it does not matter; anything else is an error.
    public struct Imported: Codable, Sendable, Equatable {
        public var id: String
        public var dir: String

        public init(id: String, dir: String) {
            self.id = id
            self.dir = dir
        }
    }

    public static func imported(from stdout: Data) throws -> Imported {
        let text = String(decoding: stdout, as: UTF8.self)
        for line in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" }).reversed() {
            let candidate = String(line).trimmingWhitespace()
            guard candidate.hasPrefix("{"), let data = candidate.data(using: .utf8),
                  let value = try? JSONDecoder().decode(Imported.self, from: data) else { continue }
            guard isSessionID(value.id) else { throw PolycapError("polycap import gave an id that is not a session id: \(value.id)") }
            guard value.dir.hasPrefix("/") else { throw PolycapError("polycap import gave a folder that is not absolute: \(value.dir)") }
            return value
        }
        throw PolycapError("polycap import printed no {\"id\", \"dir\"} line")
    }

    /// A session folder's name: no path separators, no dot names, nothing a path could escape with.
    public static func isSessionID(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 200 && id != "." && id != ".." && !id.contains("/") && !id.contains("\0") && !id.hasPrefix(".")
    }

    /// The end of a child's error output, for a message: at most `limit` characters, whole lines.
    public static func tail(_ data: Data, limit: Int = 600) -> String {
        let text = String(decoding: data, as: UTF8.self).trimmingWhitespace()
        guard text.count > limit else { return text }
        let cut = String(text.suffix(limit))
        if let newline = cut.firstIndex(of: "\n") { return String(cut[cut.index(after: newline)...]) }
        return cut
    }
}

public enum PolycapLocator {
    /// polycap as installed by npm is a symlink (bin/polycap -> ../lib/node_modules/…/bin/polycap.js);
    /// node needs the .js file itself. Relative links are resolved against the link's folder.
    public static func resolveScript(_ path: String, fileManager: FileManager = .default) throws -> String {
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        guard fileManager.fileExists(atPath: resolved) else { throw PolycapError("polycap at \(path) points to \(resolved), which does not exist") }
        guard resolved.hasSuffix(".js") else { throw PolycapError("polycap at \(path) is \(resolved), not polycap.js; set its path in the settings") }
        return resolved
    }

    /// The settings' paths when both are usable; otherwise whatever the login shell's answer gives.
    /// `shellOutput` is only called when the settings do not already answer.
    public static func locate(nodeSetting: String?, polycapSetting: String?, fileManager: FileManager = .default,
                              shellOutput: () throws -> String) throws -> PolycapInstall {
        if let node = nodeSetting, let script = polycapSetting, fileManager.isExecutableFile(atPath: node), fileManager.fileExists(atPath: script) {
            return PolycapInstall(node: node, polycapJS: try resolveScript(script, fileManager: fileManager))
        }
        let answer = LoginShellProbe.parse(try shellOutput())
        let node = nodeSetting.flatMap { fileManager.isExecutableFile(atPath: $0) ? $0 : nil } ?? answer.node
        let script = polycapSetting.flatMap { fileManager.fileExists(atPath: $0) ? $0 : nil } ?? answer.polycap
        guard let node, fileManager.isExecutableFile(atPath: node) else {
            throw PolycapError("node was not found: your login shell has no `node` on its PATH. Install Node 22 (nvm) or set node's path in the settings.")
        }
        guard let script else {
            throw PolycapError("polycap was not found: your login shell has no `polycap`. Run `npm link` in the Polydance repository or set polycap's path in the settings.")
        }
        return PolycapInstall(node: node, polycapJS: try resolveScript(script, fileManager: fileManager))
    }
}
