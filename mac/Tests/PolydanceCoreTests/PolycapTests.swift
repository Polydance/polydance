// The hand-off to polycap: the contract's argument arrays, the explicit environment, the login shell's
// answer, strict parsing of import's output, finding polycap.js behind npm's symlink, and a real child
// process run through PolycapRunner against a fake node (a small script), never the real polycap.
import Foundation
import PolydanceCore
import XCTest

final class PolycapTests: XCTestCase {
    var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("polycap-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    func testTheContractsCommands() {
        XCTAssertEqual(PolycapCommand.importRecording(video: "/r/a b.mp4", meta: "/r/a b.meta.json"), ["import", "/r/a b.mp4", "--meta", "/r/a b.meta.json", "--json"])
        XCTAssertEqual(PolycapCommand.process(id: "2026-11-05T11-00-02_mac"), ["process", "2026-11-05T11-00-02_mac", "--json"])
        XCTAssertEqual(PolycapCommand.hooksRun(id: "s1"), ["hooks", "run", "s1", "--force", "--json"])
        XCTAssertEqual(PolycapCommand.hooksRun(id: "s1", hook: "call-routine"), ["hooks", "run", "s1", "--hook", "call-routine", "--force", "--json"])
        XCTAssertEqual(PolycapCommand.hooksList(), ["hooks", "list", "--json"])
        XCTAssertEqual(PolycapCommand.upload(video: "/v.mp4", to: WalkthroughTarget(thread: "MUS-12")), ["upload", "/v.mp4", "--thread", "MUS-12", "--json"])
        XCTAssertEqual(PolycapCommand.upload(video: "/v.mp4", to: WalkthroughTarget(thread: "MUS-12", replyTo: 4, launch: 1), meta: "/v.meta.json"),
                       ["upload", "/v.mp4", "--thread", "MUS-12", "--reply-to", "4", "--launch", "1", "--meta", "/v.meta.json", "--json"])
        XCTAssertEqual(PolycapCommand.upload(video: "/v.mp4", to: WalkthroughTarget(thread: "MUS-12", launch: 1)), ["upload", "/v.mp4", "--thread", "MUS-12", "--json"],
                       "a launch without a message to reply to means nothing")
        // New thread and the bug key (2026-11-16).
        XCTAssertEqual(PolycapCommand.upload(video: "/v.mp4", to: .newThread(in: ThreadProject(key: "KITC", name: "Kitchen Timer", mine: true)), meta: "/v.meta.json"),
                       ["upload", "/v.mp4", "--project", "KITC", "--meta", "/v.meta.json", "--json"])
        XCTAssertEqual(PolycapCommand.upload(video: "/v.mp4", to: .report), ["upload", "/v.mp4", "--report", "--json"])
        XCTAssertEqual(PolycapCommand.projectList(), ["project", "list", "--capabilities", "--json"])
        XCTAssertEqual(PolycapCommand.projectNew(name: "-Kitchen Timer"), ["project", "new", "--json", "--", "-Kitchen Timer"], "a name is never an option")
        XCTAssertEqual(PolycapCommand.threadNew(project: "KITC", title: "-Alarm", text: "Too loud", photos: [URL(fileURLWithPath: "/p/a.png")]),
                       ["thread", "new", "--project", "KITC", "--title=-Alarm", "--text=Too loud", "--photo=/p/a.png", "--json"])
        XCTAssertEqual(PolycapCommand.threadNew(project: "KITC", title: "Alarm", text: ""), ["thread", "new", "--project", "KITC", "--title=Alarm", "--json"])
        XCTAssertEqual(PolycapCommand.threadList(), ["thread", "list", "--json"])
        XCTAssertEqual(PolycapCommand.threadShow(key: "MUS-12"), ["thread", "show", "MUS-12", "--json"])
    }

    func testTheEnvironmentIsWrittenDown() {
        let inherited = ["PATH": "/usr/bin", "USER": "robin", "TMPDIR": "/var/tmp/", "SECRET_TOKEN": "x", "POLYCAP_ROOT": "/from/env", "LANG": "en_GB.UTF-8"]
        let env = PolycapEnvironment.make(nodePath: "/Users/someone/.nvm/versions/node/v22.22.0/bin/node", home: "/Users/someone",
                                          inherited: inherited, libraryRoot: nil, transcriber: .whisperCpp)
        XCTAssertEqual(env["PATH"], "/Users/someone/.nvm/versions/node/v22.22.0/bin:/Users/someone/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
        XCTAssertEqual(env["HOME"], "/Users/someone")
        XCTAssertEqual(env["POLYCAP_TRANSCRIBER"], "whisper-cpp")
        XCTAssertEqual(env["POLYCAP_ROOT"], "/from/env")
        XCTAssertEqual(env["USER"], "robin")
        XCTAssertNil(env["SECRET_TOKEN"], "nothing else is carried over")
        XCTAssertEqual(Set(env.keys), ["HOME", "PATH", "POLYCAP_TRANSCRIBER", "POLYCAP_ROOT", "USER", "TMPDIR", "LANG"])

        let set = PolycapEnvironment.make(nodePath: "/opt/homebrew/bin/node", home: "/Users/someone", inherited: [:], libraryRoot: "~/Lib", transcriber: .gladia)
        XCTAssertEqual(set["POLYCAP_ROOT"], "/Users/someone/Lib")
        XCTAssertEqual(set["POLYCAP_TRANSCRIBER"], "gladia")
        XCTAssertEqual(set["PATH"], "/opt/homebrew/bin:/Users/someone/.local/bin:/usr/local/bin:/usr/bin:/bin", "no folder twice")
        XCTAssertNil(PolycapEnvironment.make(nodePath: "/n/node", home: "/h", inherited: [:], libraryRoot: nil, transcriber: .whisperCpp)["POLYCAP_ROOT"])
    }

    func testReadsTheLoginShellsAnswerThroughTheNoise() {
        let output = """
        Now using node v22.22.0 (npm v10.9.4)
        \(LoginShellProbe.nodeMarker)/old/node
        zsh: no such file or directory: oh-my-zsh.sh
        \(LoginShellProbe.nodeMarker)/Users/someone/.nvm/versions/node/v22.22.0/bin/node
        \(LoginShellProbe.polycapMarker)/Users/someone/.nvm/versions/node/v22.22.0/bin/polycap
        """
        let found = LoginShellProbe.parse(output)
        XCTAssertEqual(found.node, "/Users/someone/.nvm/versions/node/v22.22.0/bin/node")
        XCTAssertEqual(found.polycap, "/Users/someone/.nvm/versions/node/v22.22.0/bin/polycap")
        let missing = LoginShellProbe.parse("\(LoginShellProbe.nodeMarker)\n\(LoginShellProbe.polycapMarker)polycap: aliased to npx polycap\n")
        XCTAssertNil(missing.node)
        XCTAssertNil(missing.polycap, "an alias is not a path")
        XCTAssertFalse(LoginShellProbe.script.contains("{"), "the shell's question is constant text")
    }

    func testImportOutputIsReadStrictly() throws {
        let good = Data("warning: something\n{\"id\":\"2026-11-05T11-00-02_mac\",\"dir\":\"/Users/someone/PolydanceCapture/sessions/2026-11-05T11-00-02_mac\"}\n".utf8)
        XCTAssertEqual(try PolycapOutput.imported(from: good),
                       .init(id: "2026-11-05T11-00-02_mac", dir: "/Users/someone/PolydanceCapture/sessions/2026-11-05T11-00-02_mac"))
        for bad in ["", "imported x -> /y", "{\"id\":\"x\"}", "{\"id\":\"../etc\",\"dir\":\"/x\"}", "{\"id\":\"x\",\"dir\":\"relative\"}", "{\"id\":\"\",\"dir\":\"/x\"}"] {
            XCTAssertThrowsError(try PolycapOutput.imported(from: Data(bad.utf8)), bad)
        }
        XCTAssertEqual(PolycapOutput.tail(Data(("a\n" + String(repeating: "b", count: 50) + "\nlast line\n").utf8), limit: 20), "last line")
    }

    func testFindsPolycapJSBehindNpmsRelativeSymlink() throws {
        let bin = temp.appendingPathComponent("node/bin")
        let lib = temp.appendingPathComponent("node/lib/node_modules/polydance-capture/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: lib, withIntermediateDirectories: true)
        let script = lib.appendingPathComponent("polycap.js")
        try Data("#!/usr/bin/env node\n".utf8).write(to: script)
        let link = bin.appendingPathComponent("polycap")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: "../lib/node_modules/polydance-capture/bin/polycap.js")
        let node = try makeExecutable(bin.appendingPathComponent("node"), "#!/bin/sh\nexit 0\n")

        XCTAssertEqual(try PolycapLocator.resolveScript(link.path), script.resolvingSymlinksInPath().path)

        var asked = 0
        let found = try PolycapLocator.locate(nodeSetting: nil, polycapSetting: nil) {
            asked += 1
            return "\(LoginShellProbe.nodeMarker)\(node.path)\n\(LoginShellProbe.polycapMarker)\(link.path)\n"
        }
        XCTAssertEqual(found, PolycapInstall(node: node.path, polycapJS: script.resolvingSymlinksInPath().path))
        XCTAssertEqual(asked, 1)

        // Stored paths that still work are used without asking the shell.
        _ = try PolycapLocator.locate(nodeSetting: node.path, polycapSetting: found.polycapJS) { XCTFail("asked the shell"); return "" }

        XCTAssertThrowsError(try PolycapLocator.locate(nodeSetting: nil, polycapSetting: nil) { "" }) { error in
            XCTAssertTrue("\(error)".contains("node was not found"))
        }
        XCTAssertThrowsError(try PolycapLocator.locate(nodeSetting: node.path, polycapSetting: nil) { "\(LoginShellProbe.nodeMarker)\(node.path)\n" }) { error in
            XCTAssertTrue("\(error)".contains("polycap was not found"))
        }
        let wrapper = try makeExecutable(bin.appendingPathComponent("polycap-wrapper"), "#!/bin/sh\n")
        XCTAssertThrowsError(try PolycapLocator.resolveScript(wrapper.path), "a wrapper script is not polycap.js")
    }

    /// The whole path a recording takes to polycap: the runner runs `node polycap.js import … --json`
    /// with the written-down environment and reads the session it made. The fake node records its
    /// arguments and environment.
    func testTheRunnerRunsImportAndProcessAsArgumentArrays() async throws {
        let calls = temp.appendingPathComponent("calls")
        let node = try makeExecutable(temp.appendingPathComponent("bin/node"), """
        #!/bin/sh
        printf '%s\\n' "$@" > "\(calls.path).args"
        env > "\(calls.path).env"
        if [ "$2" = "import" ]; then printf 'note: hard linked\\n{"id":"2026-11-05T11-00-02_mac","dir":"/tmp/lib/sessions/2026-11-05T11-00-02_mac"}\\n'; fi
        if [ "$2" = "process" ]; then echo "boom" >&2; exit 3; fi
        exit 0
        """)
        let script = temp.appendingPathComponent("polycap.js")
        try Data("// fake".utf8).write(to: script)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "polydance-tests-\(UUID().uuidString)"))
        let settings = SettingsStore(defaults: defaults)
        settings.nodePath = node.path
        settings.polycapPath = script.path
        settings.transcriber = .gladia
        let runner = PolycapRunner(settings: settings, home: "/Users/test", inherited: ["USER": "test", "AWS_SECRET": "no"])

        let files = RecordingFiles(directory: temp.appendingPathComponent("rec dir"), baseName: "polydance-mac-20261105-110002")
        let (imported, _) = try await runner.importRecording(files)
        XCTAssertEqual(imported.id, "2026-11-05T11-00-02_mac")
        let args = try String(contentsOf: URL(fileURLWithPath: calls.path + ".args"), encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertEqual(args, [script.path, "import", files.video.path, "--meta", files.meta.path, "--json"], "a path with a space stays one argument")
        let env = try String(contentsOf: URL(fileURLWithPath: calls.path + ".env"), encoding: .utf8)
        XCTAssertTrue(env.contains("POLYCAP_TRANSCRIBER=gladia"))
        XCTAssertTrue(env.contains("HOME=/Users/test"))
        XCTAssertTrue(env.contains("PATH=\(node.deletingLastPathComponent().path):/Users/test/.local/bin:/opt/homebrew/bin"))
        XCTAssertFalse(env.contains("AWS_SECRET"))

        do {
            _ = try await runner.process(id: imported.id)
            XCTFail("a failing process is an error")
        } catch {
            XCTAssertTrue("\(error)".contains("polycap process exited 3: boom"), "\(error)")
        }
        do {
            _ = try await runner.process(id: "../x")
            XCTFail("not a session id")
        } catch {}
    }

    func testTheProcessRunnerTimesOut() async throws {
        let sleeper = try makeExecutable(temp.appendingPathComponent("sleeper"), "#!/bin/sh\nsleep 30\n")
        let started = Date()
        let result = try await ProcessRunner.run(executable: sleeper.path, arguments: [], environment: ["PATH": "/bin:/usr/bin"], timeout: 0.5)
        XCTAssertTrue(result.timedOut)
        XCTAssertFalse(result.succeeded)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    }

    private func makeExecutable(_ url: URL, _ text: String) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }
}
