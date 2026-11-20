// Runs polycap for the app: `node <polycap.js> <args>` with the environment PolycapEnvironment makes.
// node and polycap.js are found once (settings, else the login shell) and stored in the settings, so the
// login shell is asked at most once per install. The main window's commands (threads, upload, hooks)
// are in PolycapCalls.swift, on top of `run`.
import Foundation

public final class PolycapRunner: @unchecked Sendable {
    public static let importTimeout: TimeInterval = 10 * 60
    /// The pipeline's own allowance: an hour's call is 15 to 20 minutes of work; this only stops a hung child.
    public static let pipelineTimeout: TimeInterval = 4 * 3600
    public static let shortTimeout: TimeInterval = 2 * 60
    static let loginShellTimeout: TimeInterval = 20

    private let settings: SettingsStore
    private let home: String
    private let inherited: [String: String]
    private let lock = NSLock()
    private var cached: PolycapInstall?
    private var resolvedRoot: String?

    public init(settings: SettingsStore, home: String = NSHomeDirectory(), inherited: [String: String] = ProcessInfo.processInfo.environment) {
        self.settings = settings
        self.home = home
        self.inherited = inherited
    }

    /// node and polycap.js, finding and storing them the first time. Blocks while the login shell
    /// answers, so call it off the main thread.
    public func install(refresh: Bool = false) throws -> PolycapInstall {
        lock.lock(); defer { lock.unlock() }
        if !refresh, let cached { return cached }
        let found = try locate()
        settings.nodePath = found.node
        settings.polycapPath = found.polycapJS
        cached = found
        return found
    }

    /// "Detect again" in the settings: forgets the stored paths and asks the login shell afresh. When the
    /// shell finds nothing, the old paths stay forgotten and the error says what to do.
    public func rediscover() throws -> PolycapInstall {
        lock.lock(); defer { lock.unlock() }
        settings.nodePath = nil
        settings.polycapPath = nil
        cached = nil
        let found = try locate()
        settings.nodePath = found.node
        settings.polycapPath = found.polycapJS
        cached = found
        return found
    }

    /// Paths chosen by hand in the settings, checked as the lookup checks them before they are kept.
    public func use(node: String, polycap: String) throws -> PolycapInstall {
        lock.lock(); defer { lock.unlock() }
        guard node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: node) else { throw PolycapError("\(node) is not an executable node") }
        let script = try PolycapLocator.resolveScript(polycap)
        let found = PolycapInstall(node: node, polycapJS: script)
        settings.nodePath = found.node
        settings.polycapPath = found.polycapJS
        cached = found
        return found
    }

    /// The same lookup without storing anything, for `--probe`.
    public func locate() throws -> PolycapInstall {
        try PolycapLocator.locate(nodeSetting: settings.nodePath, polycapSetting: settings.polycapPath) {
            let result = try ProcessRunner.runBlocking(
                executable: "/bin/zsh", arguments: ["-i", "-l", "-c", LoginShellProbe.script],
                environment: shellEnvironment(), timeout: Self.loginShellTimeout)
            if result.timedOut { throw PolycapError("your login shell took more than \(Int(Self.loginShellTimeout)) s to start; set node's and polycap's paths in the settings") }
            return String(decoding: result.stdout, as: UTF8.self)
        }
    }

    /// The library the app resolved (LibraryLayout), which every child is given as POLYCAP_ROOT so the app
    /// and polycap always use the same one. Until it is set, the setting or the inherited value is used.
    public var libraryRoot: String? {
        get { lock.lock(); defer { lock.unlock() }; return resolvedRoot }
        set { lock.lock(); resolvedRoot = newValue; lock.unlock() }
    }

    public func environment(for install: PolycapInstall) -> [String: String] {
        PolycapEnvironment.make(nodePath: install.node, home: home, inherited: inherited,
                                libraryRoot: libraryRoot ?? settings.libraryRoot, transcriber: settings.transcriber)
    }

    /// `node polycap.js <arguments>`. `onStart` gets the child's pid as soon as it runs.
    public func run(_ arguments: [String], timeout: TimeInterval = PolycapRunner.shortTimeout, currentDirectory: URL? = nil,
                    onStart: (@Sendable (Int32) -> Void)? = nil) async throws -> ProcessResult {
        let install = try await Task.detached(priority: .utility) { try self.install() }.value
        return try await ProcessRunner.run(executable: install.node, arguments: [install.polycapJS] + arguments,
                                           environment: environment(for: install), currentDirectory: currentDirectory, timeout: timeout,
                                           onStart: onStart)
    }

    public func importRecording(_ files: RecordingFiles, onStart: (@Sendable (Int32) -> Void)? = nil) async throws -> (PolycapOutput.Imported, ProcessResult) {
        let result = try await run(PolycapCommand.importRecording(video: files.video.path, meta: files.meta.path), timeout: Self.importTimeout,
                                   onStart: onStart)
        guard result.succeeded else { throw PolycapCommandFailure(Self.failure("import", result), result: result) }
        do { return (try PolycapOutput.imported(from: result.stdout), result) } catch {
            throw PolycapCommandFailure("\(error)", result: result)
        }
    }

    /// Runs the pipeline and then the hooks. Exit 0 means it ran; step failures are in session.json. The
    /// app's limit is the pipeline's allowance plus every configured hook's own (processTimeout), so it
    /// never stops a routine before polycap's own limit would.
    public func process(id: String, onStart: (@Sendable (Int32) -> Void)? = nil) async throws -> ProcessResult {
        guard PolycapOutput.isSessionID(id) else { throw PolycapError("not a session id: \(id)") }
        let timeout = Self.processTimeout(hooks: try? await hooksList())
        let result = try await run(PolycapCommand.process(id: id), timeout: timeout, onStart: onStart)
        if result.timedOut {
            throw PolycapCommandFailure("polycap process was stopped by the app after \(durationText(timeout)); a routine that was running was stopped "
                                        + "and recorded failed, so use Run routine on the call's page to run it again", result: result)
        }
        guard result.succeeded else { throw PolycapCommandFailure(Self.failure("process", result), result: result) }
        return result
    }

    /// The app's limit for `polycap process`: the pipeline's allowance, then every configured hook's own
    /// timeout and 10 s each to stop, since polycap runs the matching hooks one after another and enforces
    /// each hook's limit itself (src/hooks.ts allows up to a day per hook). With no listing, a day and an
    /// hour for the hooks.
    public static func processTimeout(hooks: HookListing?) -> TimeInterval {
        pipelineTimeout + hooksTimeout(hooks, named: nil)
    }

    /// The app's limit for `polycap hooks run`: the named hook's own timeout, or every hook's, plus a
    /// minute; with no listing, hooksRunTimeout.
    public static func hooksTimeout(_ hooks: HookListing?, named name: String?) -> TimeInterval {
        guard let hooks else { return hooksRunTimeout }
        let chosen = name.map { name in hooks.hooks.filter { $0.name == name } } ?? hooks.hooks
        return chosen.reduce(60) { $0 + max(0, $1.timeoutMinutes) * 60 + 10 }
    }

    static func failure(_ command: String, _ result: ProcessResult, limit: Int = 600) -> String {
        let how = result.timedOut ? "timed out" : result.signalled ? "was killed (signal \(result.exitCode))" : "exited \(result.exitCode)"
        let tail = PolycapOutput.tail(result.stderr, limit: limit)
        return "polycap \(command) \(how)" + (tail.isEmpty ? "" : ": \(tail)")
    }

    private func shellEnvironment() -> [String: String] {
        var env = ["HOME": home, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TERM": "dumb"]
        for key in ["USER", "LOGNAME", "TMPDIR", "LANG"] { if let value = inherited[key] { env[key] = value } }
        return env
    }
}
