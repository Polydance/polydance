// The hand-off's fixes from the 2026-11-05 review: one outcome per recording in the menu, Retry decided
// from an explicit ledger read and the library (never a second import), an import that never starts
// while the ledger cannot be written, polycap's pid kept while it runs, the hand-offs left for the next
// launch, the app's process limit following the hooks, a failed command logged whole, a timed-out
// child's whole process group stopped, and the library and env file the app and polycap share.
import Foundation
import PolydanceCore
import XCTest

final class HandoffTests: XCTestCase {
    var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("handoff-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    var recordings: URL { temp.appendingPathComponent("mac/recordings") }
    var ledgerURL: URL { temp.appendingPathComponent("mac/handoff.json") }
    var sessions: URL { temp.appendingPathComponent("sessions") }

    func files(_ stamp: String) -> RecordingFiles { RecordingFiles(directory: recordings, baseName: "polydance-mac-20261105-\(stamp)") }

    func queue(_ worker: HandoffWorker) throws -> HandoffQueue {
        try PrivateFiles.makeDirectory(temp.appendingPathComponent("mac"), within: temp)
        return HandoffQueue(worker: worker, ledgerURL: ledgerURL) { _ in }
    }

    /// A session folder whose session.json says it was imported from `video`.
    func session(_ id: String, from video: URL) throws {
        let dir = sessions.appendingPathComponent(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let json = SessionAndQueueTests.sessionJSON(id: id, steps: ["probe": "done"])
            .replacingOccurrences(of: "\"source\": {\"kind\": \"import\",", with: "\"source\": {\"kind\": \"import\", \"originalPath\": \"\(video.path)\",")
        try Data(json.utf8).write(to: dir.appendingPathComponent("session.json"))
    }

    // MARK: ui-1: the menu and Retry

    func testARetryThatWorkedLeavesNoFailedRowForThatRecording() async throws {
        let a = files("090000")
        let worker = SessionAndQueueTests.FakeWorker(failProcess: ["session-090000"])
        let queue = try queue(worker)
        await queue.enqueue(HandoffJob(files: a))
        await queue.waitUntilIdle()
        var state = await queue.state
        XCTAssertEqual(state.finished.map(\.isFailure), [true])

        // Failing again keeps one row for the recording, not two with the same id.
        await queue.enqueue(HandoffJob(files: a, kind: .processOnly(sessionId: "session-090000", dir: "/lib/sessions/session-090000")))
        await queue.waitUntilIdle()
        state = await queue.state
        XCTAssertEqual(state.finished.count, 1)

        worker.failProcess = []
        await queue.enqueue(HandoffJob(files: a, kind: .processOnly(sessionId: "session-090000", dir: "/lib/sessions/session-090000")))
        await queue.waitUntilIdle()
        state = await queue.state
        XCTAssertEqual(state.finished.map(\.id), [a.videoName])
        XCTAssertFalse(state.finished[0].isFailure, "the stale failure is gone, so there is no Retry to press again")
        XCTAssertEqual(try HandoffLedger.load(from: ledgerURL).recordings[a.videoName]?.status, .processed)
        XCTAssertEqual(try HandoffRetry.decide(for: a, ledgerURL: ledgerURL, sessions: sessions), .alreadyProcessed(sessionId: "session-090000"),
                       "and a Retry pressed anyway does nothing")
        await queue.dismiss(id: a.videoName)
        let dismissed = await queue.state
        XCTAssertTrue(dismissed.finished.isEmpty)
    }

    func testRetryIsDecidedFromTheLedgerAndTheLibrary() throws {
        try PrivateFiles.makeDirectory(temp.appendingPathComponent("mac"), within: temp)
        try FileManager.default.createDirectory(at: recordings, withIntermediateDirectories: true)
        let failedProcess = files("090000"), failedImport = files("100000"), cutOff = files("110000"), twice = files("120000"), never = files("130000")
        var ledger = HandoffLedger()
        ledger.recordings[failedProcess.videoName] = .init(status: .processFailed, sessionId: "s9", sessionDir: "/lib/sessions/s9", at: "t", error: "boom")
        ledger.recordings[failedImport.videoName] = .init(status: .importFailed, at: "t", error: "bad file")
        ledger.recordings[cutOff.videoName] = .init(status: .importing, at: "t")
        ledger.recordings[twice.videoName] = .init(status: .importing, at: "t")
        try ledger.save(to: ledgerURL)
        // The cut-off import finished after the app quit; another was imported twice by hand.
        try session("2026-11-05T11-00-00_meet", from: cutOff.video)
        try session("2026-11-05T12-00-00_meet", from: twice.video)
        try session("2026-11-05T12-00-00_meet-2", from: twice.video)
        try session("2026-11-05T13-30-00_quest", from: URL(fileURLWithPath: "/elsewhere/clip.mp4"))

        XCTAssertEqual(try HandoffRetry.decide(for: failedProcess, ledgerURL: ledgerURL, sessions: sessions), .run(.processOnly(sessionId: "s9", dir: "/lib/sessions/s9")))
        XCTAssertEqual(try HandoffRetry.decide(for: failedImport, ledgerURL: ledgerURL, sessions: sessions), .run(.importAndProcess))
        XCTAssertEqual(try HandoffRetry.decide(for: cutOff, ledgerURL: ledgerURL, sessions: sessions),
                       .run(.processOnly(sessionId: "2026-11-05T11-00-00_meet", dir: sessions.appendingPathComponent("2026-11-05T11-00-00_meet").path)),
                       "seam-6: the import that finished is processed, not imported again")
        XCTAssertEqual(try HandoffRetry.decide(for: twice, ledgerURL: ledgerURL, sessions: sessions),
                       .ambiguous(sessionIds: ["2026-11-05T12-00-00_meet", "2026-11-05T12-00-00_meet-2"]))
        XCTAssertEqual(try HandoffRetry.decide(for: never, ledgerURL: ledgerURL, sessions: sessions), .run(.importAndProcess))

        // A symlink to the recordings folder is the same file.
        let link = temp.appendingPathComponent("linked")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: recordings)
        try Data().write(to: cutOff.video)
        try session("2026-11-05T11-00-00_meet", from: link.appendingPathComponent(cutOff.videoName))
        XCTAssertEqual(HandoffRetry.sessionsImported(from: cutOff.video, in: sessions).map(\.id), ["2026-11-05T11-00-00_meet"])

        try Data("{ not json".utf8).write(to: ledgerURL)
        XCTAssertThrowsError(try HandoffRetry.decide(for: failedProcess, ledgerURL: ledgerURL, sessions: sessions), "an unreadable ledger retries nothing")
    }

    // MARK: ui-7: fail closed on the ledger

    func testAnImportNeverStartsWhileTheLedgerCannotBeWritten() async throws {
        let worker = SessionAndQueueTests.FakeWorker()
        let queue = try queue(worker)
        try Data("{ not json".utf8).write(to: ledgerURL)
        await queue.enqueue(HandoffJob(files: files("090000")))
        await queue.enqueue(HandoffJob(files: files("100000")))
        await queue.waitUntilIdle()
        XCTAssertEqual(worker.log, [], "nothing was imported")
        let state = await queue.state
        XCTAssertEqual(state.finished.count, 2)
        XCTAssertTrue(state.finished.allSatisfy { $0.isFailure && $0.message.contains("could not be written, so it was not imported") })
        XCTAssertNotNil(state.ledgerError)

        // A session that exists is still processed: stopping then gains nothing.
        await queue.enqueue(HandoffJob(files: files("110000"), kind: .processOnly(sessionId: "s1", dir: "/lib/sessions/s1")))
        await queue.waitUntilIdle()
        XCTAssertEqual(worker.log, ["process s1"])
    }

    // MARK: ui-9: polycap's pid while it runs

    final class PeekingWorker: HandoffWorker, @unchecked Sendable {
        let ledgerURL: URL
        private let lock = NSLock()
        private var seen: [HandoffLedger.Entry] = []
        init(ledgerURL: URL) { self.ledgerURL = ledgerURL }
        var peeked: [HandoffLedger.Entry] { lock.lock(); defer { lock.unlock() }; return seen }

        private func peek(_ files: RecordingFiles) async throws {
            try await Task.sleep(nanoseconds: 80_000_000)
            if let entry = try HandoffLedger.load(from: ledgerURL).recordings[files.videoName] { keep(entry) }
        }

        private func keep(_ entry: HandoffLedger.Entry) { lock.lock(); seen.append(entry); lock.unlock() }

        func importRecording(_ files: RecordingFiles, started: @escaping @Sendable (Int32) -> Void) async throws -> PolycapOutput.Imported {
            started(4100)
            try await peek(files)
            return .init(id: "s1", dir: "/lib/sessions/s1")
        }

        func process(id: String, files: RecordingFiles, started: @escaping @Sendable (Int32) -> Void) async throws {
            started(4200)
            try await peek(files)
        }
    }

    func testPolycapsPidIsKeptWhileItRuns() async throws {
        let worker = PeekingWorker(ledgerURL: ledgerURL)
        let queue = try queue(worker)
        let a = files("090000")
        await queue.enqueue(HandoffJob(files: a))
        await queue.waitUntilIdle()
        XCTAssertEqual(worker.peeked.map(\.status), [.importing, .imported])
        XCTAssertEqual(worker.peeked.map(\.pid), [4100, 4200])
        let done = try HandoffLedger.load(from: ledgerURL).recordings[a.videoName]
        XCTAssertEqual(done?.status, .processed)
        XCTAssertNil(done?.pid)
    }

    /// What a polycap left running did is recorded through the queue, never over a job it is running.
    func testAnOutcomeSeenAfterARelaunchIsRecordedThroughTheQueue() async throws {
        let worker = SessionAndQueueTests.FakeWorker()
        let queue = try queue(worker)
        let a = files("090000")
        try await queue.settle(a, as: .init(status: .processed, sessionId: "s1", sessionDir: "/lib/sessions/s1", at: "t"))
        XCTAssertEqual(try HandoffLedger.load(from: ledgerURL).recordings[a.videoName]?.status, .processed)
        try Data("{ not json".utf8).write(to: ledgerURL)
        do { try await queue.settle(a, as: .init(status: .processed, at: "t")); XCTFail("an unreadable ledger is not overwritten") } catch {}
        XCTAssertEqual(try String(contentsOf: ledgerURL, encoding: .utf8), "{ not json")
    }

    // MARK: ui-2: what the next launch shows

    func testTheHandOffsLeftUnfinishedAreShownAtTheNextLaunch() {
        var ledger = HandoffLedger()
        for (stamp, status) in [("090000", HandoffLedger.Status.processed), ("100000", .importFailed), ("110000", .processFailed), ("120000", .imported), ("130000", .importing)] {
            ledger.recordings[files(stamp).videoName] = .init(status: status, sessionId: status == .processed || status == .processFailed || status == .imported ? "s" : nil,
                                                              sessionDir: nil, at: "t", error: status == .importFailed ? "bad file" : nil)
        }
        ledger.recordings["notes.txt"] = .init(status: .importFailed, at: "t")
        let attention = ledger.needingAttention(in: recordings)
        XCTAssertEqual(attention.map(\.files.baseName), ["polydance-mac-20261105-100000", "polydance-mac-20261105-110000",
                                                         "polydance-mac-20261105-120000", "polydance-mac-20261105-130000"])
        XCTAssertEqual(attention.map(\.actionTitle), ["Retry", "Retry", "Finish building", "Retry"])
        XCTAssertEqual(attention[0].entry.error, "bad file")
        XCTAssertTrue(attention[2].title.contains("imported but not built"))
    }

    // MARK: hook-8, ui-5, seam-10: how long the app waits

    func testTheAppWaitsAsLongAsTheHooksAreAllowed() throws {
        let listing = try HookListing.decode(Data("""
        {"file": "/Users/t/.config/polycap/hooks.json", "found": true, "hooks": [
          {"name": "call-routine", "when": {"mode": "call"}, "run": ["claude"], "timeoutMinutes": 300},
          {"name": "notes", "when": {"mode": "any"}, "run": ["true"], "timeoutMinutes": 120}]}
        """.utf8))
        let routine: TimeInterval = 300 * 60 + 10
        let notes: TimeInterval = 120 * 60 + 10
        let pipeline: TimeInterval = 4 * 3600
        XCTAssertEqual(PolycapRunner.processTimeout(hooks: listing), pipeline + routine + notes + 60)
        XCTAssertGreaterThan(PolycapRunner.processTimeout(hooks: listing), PolycapRunner.pipelineTimeout + 5 * 3600, "a five-hour routine is not cut at four")
        XCTAssertEqual(PolycapRunner.processTimeout(hooks: nil), pipeline + 25 * 3600)
        XCTAssertEqual(PolycapRunner.hooksTimeout(listing, named: "call-routine"), routine + 60)
        XCTAssertEqual(PolycapRunner.hooksTimeout(listing, named: nil), routine + notes + 60)
        XCTAssertEqual(PolycapRunner.hooksTimeout(nil, named: "x"), PolycapRunner.hooksRunTimeout)
    }

    /// ui-8: a hand-off that fails leaves polycap's whole output in the recording's log, not 600 characters.
    func testAFailedCommandIsLoggedWhole() async throws {
        let long = String(repeating: "hooks.json: hooks[0].env.SLACK is not a string; ", count: 30)
        let node = try makeExecutable(temp.appendingPathComponent("bin/node"), """
        #!/bin/sh
        if [ "$2" = "process" ]; then echo '{"id":"s1","steps":{"probe":"done"}}'; echo "START \(long) END" >&2; exit 1; fi
        exit 0
        """)
        let script = temp.appendingPathComponent("polycap.js")
        try Data("// fake".utf8).write(to: script)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "polydance-tests-\(UUID().uuidString)"))
        let settings = SettingsStore(defaults: defaults)
        settings.nodePath = node.path
        settings.polycapPath = script.path
        let layout = LibraryLayout(root: temp)
        let worker = PolycapHandoffWorker(runner: PolycapRunner(settings: settings, home: temp.path, inherited: [:]), layout: layout)
        let a = files("090000")
        do {
            try await worker.process(id: "s1", files: a) { _ in }
            XCTFail("a failing process is an error")
        } catch {
            XCTAssertLessThan("\(error)".count, 700, "the message keeps the end")
            XCTAssertFalse("\(error)".contains("START"))
        }
        let log = try String(contentsOf: layout.logs.appendingPathComponent(a.baseName + ".log"), encoding: .utf8)
        XCTAssertTrue(log.contains("START "), "the start of stderr is kept")
        XCTAssertTrue(log.contains(" END"))
        XCTAssertTrue(log.contains("{\"id\":\"s1\""), "and stdout")
        XCTAssertEqual(PrivateFiles.permissions(of: layout.logs.appendingPathComponent(a.baseName + ".log")), 0o600)
    }

    /// seam-10: a child that ignores SIGTERM is killed with its whole group after the grace, so nothing it
    /// started (whisper-cli, ffmpeg) runs on; the pid is handed over as soon as it starts.
    func testATimedOutChildIsKilledWithItsGroup() async throws {
        let grandchild = temp.appendingPathComponent("grandchild")
        let stubborn = try makeExecutable(temp.appendingPathComponent("stubborn"), """
        #!/bin/sh
        trap '' TERM
        /bin/sh -c "trap '' TERM; sleep 30" &
        echo $! > "\(grandchild.path)"
        wait
        """)
        let started = Started()
        let result = try await ProcessRunner.run(executable: stubborn.path, arguments: [], environment: ["PATH": "/bin:/usr/bin"], timeout: 0.5,
                                                 killGrace: 0.5, onStart: { started.set($0) })
        XCTAssertTrue(result.timedOut)
        XCTAssertNotNil(started.pid)
        let pid = try XCTUnwrap(Int32(try String(contentsOf: grandchild, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
        var gone = false
        for _ in 0..<40 where !gone {
            if kill(pid, 0) != 0 { gone = true } else { try await Task.sleep(nanoseconds: 50_000_000) }
        }
        if !gone { kill(pid, SIGKILL) }
        XCTAssertTrue(gone, "the grandchild was killed with the group")
    }

    final class Started: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Int32?
        func set(_ pid: Int32) { lock.lock(); value = pid; lock.unlock() }
        var pid: Int32? { lock.lock(); defer { lock.unlock() }; return value }
    }

    /// ui-9: a polycap the app left running is recognised by its arguments, not by its pid alone.
    func testAPolycapLeftRunningIsRecognised() async throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", "sleep 30; true", "/repo/bin/polycap.js", "upload", "/lib/mac/recordings/polydance-mac-20261105-140210.mp4"]
        try child.run()
        defer { child.terminate() }
        try await Task.sleep(nanoseconds: 100_000_000)
        let pid = child.processIdentifier
        XCTAssertTrue(PolycapProcess.isRunning(pid: pid, mentioning: "/lib/mac/recordings/polydance-mac-20261105-140210.mp4"))
        XCTAssertFalse(PolycapProcess.isRunning(pid: pid, mentioning: "/lib/mac/recordings/polydance-mac-20261105-150000.mp4"))
        XCTAssertFalse(PolycapProcess.isRunning(pid: getpid(), mentioning: "/lib/mac/recordings/polydance-mac-20261105-140210.mp4"), "not polycap")
        child.terminate()
        child.waitUntilExit()
        XCTAssertFalse(PolycapProcess.isRunning(pid: pid, mentioning: "/lib/mac/recordings/polydance-mac-20261105-140210.mp4"), "gone")
        XCTAssertFalse(PolycapProcess.isRunning(pid: 1, mentioning: "x"))
    }

    // MARK: ui-4, seam-5: one library for the app and polycap

    func testTheLibraryIsTheSettingThenTheEnvironmentThenPolycapsEnvFile() throws {
        let home = URL(fileURLWithPath: "/Users/someone")
        let file = ["POLYCAP_ROOT": "~/Library/PolydanceCapture"]
        XCTAssertEqual(LibraryLayout.resolve(setting: nil, environment: [:], home: home, envFile: file).root.path, "/Users/someone/Library/PolydanceCapture")
        XCTAssertEqual(LibraryLayout.resolve(setting: nil, environment: ["POLYCAP_ROOT": "/Volumes/Data/P"], home: home, envFile: file).root.path, "/Volumes/Data/P")
        XCTAssertEqual(LibraryLayout.resolve(setting: "~/Mine", environment: ["POLYCAP_ROOT": "/Volumes/Data/P"], home: home, envFile: file).root.path, "/Users/someone/Mine")
        XCTAssertEqual(LibraryLayout.resolve(setting: nil, environment: [:], home: home, envFile: [:]).root.path, "/Users/someone/PolydanceCapture")

        // The file itself: polycap's rules, only the keys asked for, and refused when others can read it.
        let env = temp.appendingPathComponent("config/polycap/env")
        try FileManager.default.createDirectory(at: env.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("# polycap\nPOLYCAP_UPLOAD_TOKEN=secret\nPOLYCAP_ROOT=\"~/Elsewhere\"\n\nPOLYCAP_HOOKS='~/hooks.json'\n".utf8).write(to: env)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: env.path)
        let values = try PolycapEnvFile.read(env, keys: ["POLYCAP_ROOT", "POLYCAP_HOOKS"])
        XCTAssertEqual(values, ["POLYCAP_ROOT": "~/Elsewhere", "POLYCAP_HOOKS": "~/hooks.json"], "no token is kept")
        XCTAssertEqual(HooksFileExample.path(envFile: values, home: home).path, "/Users/someone/hooks.json")
        XCTAssertEqual(HooksFileExample.path(envFile: [:], home: home).path, "/Users/someone/.config/polycap/hooks.json")
        XCTAssertEqual(PolycapEnvFile.path(environment: ["POLYCAP_CONFIG": env.path], home: home), env)
        XCTAssertEqual(PolycapEnvFile.path(environment: [:], home: home).path, "/Users/someone/.config/polycap/env")
        let resolved = LibraryLayout.resolveForApp(setting: nil, environment: ["POLYCAP_CONFIG": env.path], home: home)
        XCTAssertEqual(resolved.layout.root.path, "/Users/someone/Elsewhere")
        XCTAssertNil(resolved.problem)
        XCTAssertEqual(try PolycapEnvFile.read(temp.appendingPathComponent("missing"), keys: ["POLYCAP_ROOT"]), [:])

        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: env.path)
        XCTAssertThrowsError(try PolycapEnvFile.read(env, keys: ["POLYCAP_ROOT"])) { XCTAssertTrue("\($0)".contains("chmod 600")) }
        let refused = LibraryLayout.resolveForApp(setting: nil, environment: ["POLYCAP_CONFIG": env.path], home: home)
        XCTAssertEqual(refused.layout.root.path, "/Users/someone/PolydanceCapture")
        XCTAssertNotNil(refused.problem, "said, not guessed past")

        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: env.path)
        try Data("POLYCAP ROOT=x\n".utf8).write(to: env)
        XCTAssertThrowsError(try PolycapEnvFile.read(env, keys: ["POLYCAP_ROOT"]))
    }

    /// Every polycap the app runs is given the library the app resolved, whatever else is around.
    func testEveryChildIsGivenTheAppsLibrary() async throws {
        let dump = temp.appendingPathComponent("env")
        let node = try makeExecutable(temp.appendingPathComponent("bin/node"), "#!/bin/sh\nenv > \"\(dump.path)\"\n")
        let script = temp.appendingPathComponent("polycap.js")
        try Data("// fake".utf8).write(to: script)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "polydance-tests-\(UUID().uuidString)"))
        let settings = SettingsStore(defaults: defaults)
        settings.nodePath = node.path
        settings.polycapPath = script.path
        let runner = PolycapRunner(settings: settings, home: "/Users/test", inherited: ["POLYCAP_ROOT": "/from/the/app/env", "ANTHROPIC_API_KEY": "sk-must-not-reach-claude",
                                                                                     "CLAUDECODE": "1", "POLYCAP_CONFIG": "/Users/test/.config/polycap/env"])
        runner.libraryRoot = "/Users/test/Library/PolydanceCapture"
        _ = try await runner.run(["list"])
        let env = try String(contentsOf: dump, encoding: .utf8)
        XCTAssertTrue(env.contains("POLYCAP_ROOT=/Users/test/Library/PolydanceCapture\n"))
        XCTAssertTrue(env.contains("POLYCAP_CONFIG=/Users/test/.config/polycap/env\n"), "polycap reads the env file the app read")
        XCTAssertFalse(env.contains("sk-must-not-reach-claude"), "no key reaches polycap or its hooks")
        XCTAssertFalse(env.contains("CLAUDECODE"))
    }

    private func makeExecutable(_ url: URL, _ text: String) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }
}
