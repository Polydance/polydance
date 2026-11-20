// What the menu reads from a session folder (session.json, hook-runs.json), the recent list, the
// hand-off queue with a fake worker, the settings, and the far-end check (C12).
import Foundation
import PolydanceCore
import XCTest

final class SessionAndQueueTests: XCTestCase {
    var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("session-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temp)
    }

    static func sessionJSON(id: String, steps: [String: String], call: String? = nil, title: String? = nil, recordedAt: String = "2026-11-05T11:00:02.120Z") -> String {
        let stepText = steps.map { "\"\($0.key)\": {\"status\": \"\($0.value)\"\($0.value == "failed" ? ", \"error\": \"whisper-cli failed\"" : "")}" }.joined(separator: ", ")
        return """
        {"version": 1, "id": "\(id)", "title": "\(id)", "createdAt": "2026-11-05T11:53:00.000Z", "recordedAt": "\(recordedAt)", "recordedAtSource": "argument",
         "source": {"kind": "import", "originalName": "polydance-mac-20261105-110002.mp4", "appPackage": "net.polydance.capture.mac", "bytes": 10,
                    "sha256": "\(String(repeating: "a", count: 64))", "audioTracks": ["mic", "app"], "marks": [{"atMs": 1000}]\(call.map { ", \"call\": \($0)" } ?? "")},
         "media": {"video": "video.mp4", "durationMs": 3133000, "width": 1920, "height": 1246},
         "steps": {\(stepText)}, "frameCount": 34\(title.map { ", \"summary\": {\"title\": \"\($0)\", \"text\": \"t\", \"model\": \"m\"}" } ?? ""),
         "tool": {"name": "polydance-capture", "version": "0.1.0"}, "futureField": true}
        """
    }

    func write(_ text: String, _ path: String) throws {
        let url = temp.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    func testReadsTheSessionFieldsTheMenuShowsAndToleratesTheRest() throws {
        try write(Self.sessionJSON(id: "s1", steps: ["probe": "done", "audio": "done", "transcribe": "pending"],
                                   call: "{\"app\": \"meet\", \"meetingCode\": \"abc-defg-hij\", \"startedAt\": \"2026-11-05T11:00:02.120Z\", \"short\": false, \"video\": \"none\"}"),
                  "sessions/s1/session.json")
        let session = try SessionInfo.load(from: temp.appendingPathComponent("sessions/s1"))
        XCTAssertEqual(session.displayTitle, "Meet abc-defg-hij")
        XCTAssertEqual(session.source.call?.video, "none")
        XCTAssertEqual(session.source.marks?.count, 1)
        XCTAssertEqual(session.media?.durationMs, 3_133_000)
        try write("{\"id\": 1}", "sessions/bad/session.json")
        XCTAssertThrowsError(try SessionInfo.load(from: temp.appendingPathComponent("sessions/bad")))
    }

    func testStepRowsMarkTheFirstPendingStepAsRunning() throws {
        try write(Self.sessionJSON(id: "s1", steps: ["probe": "done", "audio": "done", "transcribe": "pending", "frames": "done", "pointing": "skipped",
                                                     "markers": "pending", "summary": "pending", "storyboard": "pending"]), "s1/session.json")
        let session = try SessionInfo.load(from: temp.appendingPathComponent("s1"))
        let rows = BuildProgress.rows(session: session, processing: true)
        XCTAssertEqual(rows.map(\.label), ["Audio", "Transcribe", "Frames", "Markers", "Title and summary", "Storyboard"])
        XCTAssertEqual(rows.map(\.state), [.done, .running, .done, .pending, .pending, .pending])
        XCTAssertEqual(BuildProgress.rows(session: session, processing: false).map(\.state), [.done, .pending, .done, .pending, .pending, .pending])
        XCTAssertEqual(BuildProgress.rows(session: nil, processing: true).first?.state, .running)

        try write(Self.sessionJSON(id: "s2", steps: ["probe": "failed", "audio": "done", "transcribe": "failed"]), "s2/session.json")
        let failed = BuildProgress.rows(session: try SessionInfo.load(from: temp.appendingPathComponent("s2")), processing: false)
        XCTAssertEqual(failed.first?.label, "Probe", "a failed probe is shown")
        XCTAssertEqual(failed.first(where: { $0.id == "transcribe" })?.detail, "whisper-cli failed")
    }

    func testLogsIsShownOnlyForATakeThatSentSome() throws {
        // A headset take with logs (docs/LOGS.md): the step shows, and runs in its turn.
        try write(Self.sessionJSON(id: "l1", steps: ["probe": "done", "logs": "pending", "audio": "pending"]), "l1/session.json")
        let rows = BuildProgress.rows(session: try SessionInfo.load(from: temp.appendingPathComponent("l1")), processing: true)
        XCTAssertEqual(rows.first?.label, "Logs")
        XCTAssertEqual(rows.first?.state, .running)
        // Skipped (no logs sent, as for every Mac recording), it is not shown and the next step runs.
        try write(Self.sessionJSON(id: "l2", steps: ["probe": "done", "logs": "skipped", "audio": "pending"]), "l2/session.json")
        let skipped = BuildProgress.rows(session: try SessionInfo.load(from: temp.appendingPathComponent("l2")), processing: true)
        XCTAssertFalse(skipped.contains { $0.id == "logs" })
        XCTAssertEqual(skipped.first?.state, .running)
    }

    func testSpeakersIsShownForACallWithItsReasonAndNotForAnOlderSession() throws {
        let steps = ["probe": "done", "audio": "done", "transcribe": "done", "speakers": "skipped", "frames": "done", "pointing": "skipped", "markers": "done", "summary": "done", "storyboard": "done"]
        try write(Self.sessionJSON(id: "c1", steps: steps, call: "{\"app\": \"meet\"}"), "c1/session.json")
        let call = BuildProgress.rows(session: try SessionInfo.load(from: temp.appendingPathComponent("c1")), processing: false)
        XCTAssertEqual(call.map(\.label), ["Audio", "Transcribe", "Speakers", "Frames", "Markers", "Title and summary", "Storyboard"])
        XCTAssertEqual(call.first(where: { $0.id == "speakers" })?.state, .skipped)

        try write(Self.sessionJSON(id: "w1", steps: steps), "w1/session.json")
        XCTAssertFalse(BuildProgress.rows(session: try SessionInfo.load(from: temp.appendingPathComponent("w1")), processing: false).contains { $0.id == "speakers" },
                       "a walkthrough has no speakers to name")
    }

    func testHookRunsAreReadStrictlyAndSummarised() throws {
        let done = """
        {"version": 1, "runs": {"call-routine": {"status": "done", "startedAt": "2026-11-05T12:10:00.000Z", "finishedAt": "2026-11-05T12:14:00.000Z",
          "exitCode": 0, "pid": 4242, "agentSessionId": "7d0c0d4e-1111-2222-3333-444455556666", "log": "hooks/call-routine.log"}}}
        """
        let runs = try HookRuns.decode(Data(done.utf8))
        XCTAssertEqual(runs.runs["call-routine"]?.status, .done)
        XCTAssertEqual(BuildProgress.routine(runs, processing: false),
                       StepRow(id: "routine", label: "Your routine", state: .done, detail: "claude --resume 7d0c0d4e-1111-2222-3333-444455556666"))
        XCTAssertEqual(BuildProgress.routine(nil, processing: true).detail, "when the bundle is ready")

        let failed = try HookRuns.decode(Data("{\"version\": 1, \"runs\": {\"a\": {\"status\": \"timeout\", \"startedAt\": \"2026-11-05T12:10:00Z\", \"signal\": \"SIGTERM\"}}}".utf8))
        XCTAssertEqual(BuildProgress.routine(failed, processing: false).state, .failed)
        XCTAssertEqual(BuildProgress.routine(failed, processing: false).detail, "a timed out")
        let running = try HookRuns.decode(Data("{\"version\": 1, \"runs\": {\"a\": {\"status\": \"running\", \"startedAt\": \"2026-11-05T12:10:00Z\", \"pid\": 9}}}".utf8))
        XCTAssertEqual(BuildProgress.routine(running, processing: true).state, .running)
        let skipped = try HookRuns.decode(Data("{\"version\": 1, \"runs\": {\"a\": {\"status\": \"skipped\", \"startedAt\": \"2026-11-05T12:10:00Z\", \"note\": \"short\"}}}".utf8))
        XCTAssertEqual(BuildProgress.routine(skipped, processing: false), StepRow(id: "routine", label: "Your routine", state: .skipped, detail: "short"))

        for bad in [
            "{\"version\": 2, \"runs\": {}}",
            "{\"version\": 1, \"runs\": {\"a\": {\"status\": \"exploded\", \"startedAt\": \"x\"}}}",
            "{\"version\": 1, \"runs\": {\"a\": {\"status\": \"done\", \"startedAt\": \"x\", \"stdout\": \"secret\"}}}",
            "{\"version\": 1, \"runs\": {}, \"extra\": 1}",
            "{\"version\": 1, \"runs\": {\"a\": {\"status\": \"done\"}}}",
        ] {
            XCTAssertThrowsError(try HookRuns.decode(Data(bad.utf8)), bad)
        }
        XCTAssertNil(try HookRuns.load(from: temp), "no file yet is no runs, not an error")
    }

    func testRecentListsThisAppsRecordingsNewestFirstWithTheRoutinesOutcome() throws {
        let done = ["probe": "done", "audio": "done", "transcribe": "done", "frames": "done", "pointing": "skipped", "markers": "done", "summary": "done", "storyboard": "done"]
        try write(Self.sessionJSON(id: "2026-11-05T09-30-00_mac", steps: done, call: "{\"app\": \"meet\", \"startedAt\": \"2026-11-05T09:30:00Z\"}",
                                   title: "Weekly product sync", recordedAt: "2026-11-05T09:30:00.000Z"), "sessions/2026-11-05T09-30-00_mac/session.json")
        try write("{\"version\": 1, \"runs\": {\"call-routine\": {\"status\": \"done\", \"startedAt\": \"2026-11-05T10:10:00Z\"}}}",
                  "sessions/2026-11-05T09-30-00_mac/hook-runs.json")
        try write(Self.sessionJSON(id: "2026-11-05T11-00-02_mac", steps: done, call: "{\"app\": \"meet\", \"startedAt\": \"2026-11-05T11:00:02Z\", \"meetingCode\": \"abc-defg-hij\", \"short\": true}"),
                  "sessions/2026-11-05T11-00-02_mac/session.json")
        try write(Self.sessionJSON(id: "2026-11-05T12-00-00_mac", steps: ["audio": "pending"], recordedAt: "2026-11-05T12:00:00.000Z"),
                  "sessions/2026-11-05T12-00-00_mac/session.json")
        try write(Self.sessionJSON(id: "2026-11-05T13-00-00_quest", steps: done).replacingOccurrences(of: "net.polydance.capture.mac", with: "com.marimba.example"),
                  "sessions/2026-11-05T13-00-00_quest/session.json")
        try write("not json", "sessions/2026-11-05T14-00-00_broken/session.json")

        let recent = LibraryIndex.recent(sessions: temp.appendingPathComponent("sessions"))
        XCTAssertEqual(recent.map(\.id), ["2026-11-05T12-00-00_mac", "2026-11-05T11-00-02_mac", "2026-11-05T09-30-00_mac"])
        XCTAssertEqual(recent.map(\.chip), [.notBuilt, .short, .routineDone])
        XCTAssertEqual(recent[2].title, "Weekly product sync")
        XCTAssertEqual(recent[1].title, "Meet abc-defg-hij")
        XCTAssertFalse(recent[0].isCall, "a walkthrough")
        XCTAssertEqual(recent[2].frameCount, 34)
        XCTAssertEqual(LibraryIndex.recent(sessions: temp.appendingPathComponent("none")), [])
    }

    // MARK: The hand-off queue

    final class FakeWorker: HandoffWorker, @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [String] = []
        var failImport: Set<String>
        var failProcess: Set<String>

        init(failImport: Set<String> = [], failProcess: Set<String> = []) {
            self.failImport = failImport
            self.failProcess = failProcess
        }

        var log: [String] { lock.lock(); defer { lock.unlock() }; return calls }

        private func note(_ call: String) { lock.lock(); calls.append(call); lock.unlock() }

        func importRecording(_ files: RecordingFiles, started: @escaping @Sendable (Int32) -> Void) async throws -> PolycapOutput.Imported {
            note("import \(files.baseName)")
            started(4100)
            try await Task.sleep(nanoseconds: 30_000_000)
            if failImport.contains(files.baseName) { throw PolycapError("polycap import exited 1: bad file") }
            return .init(id: "session-\(files.baseName.suffix(6))", dir: "/lib/sessions/session-\(files.baseName.suffix(6))")
        }

        func process(id: String, files: RecordingFiles, started: @escaping @Sendable (Int32) -> Void) async throws {
            note("process \(id)")
            started(4200)
            try await Task.sleep(nanoseconds: 30_000_000)
            if failProcess.contains(id) { throw PolycapError("polycap process exited 2") }
        }
    }

    final class Snapshots: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [HandoffSnapshot] = []
        func add(_ s: HandoffSnapshot) { lock.lock(); all.append(s); lock.unlock() }
        var list: [HandoffSnapshot] { lock.lock(); defer { lock.unlock() }; return all }
    }

    func testHandsOverOneAtATimeInOrderAndRecordsEachOutcome() async throws {
        let dir = temp.appendingPathComponent("mac/recordings")
        let a = RecordingFiles(directory: dir, baseName: "polydance-mac-20261105-090000")
        let b = RecordingFiles(directory: dir, baseName: "polydance-mac-20261105-100000")
        let c = RecordingFiles(directory: dir, baseName: "polydance-mac-20261105-110000")
        let worker = FakeWorker(failImport: [b.baseName], failProcess: ["session-110000"])
        let ledgerURL = temp.appendingPathComponent("mac/handoff.json")
        try PrivateFiles.makeDirectory(temp.appendingPathComponent("mac"), within: temp)
        let snapshots = Snapshots()
        let queue = HandoffQueue(worker: worker, ledgerURL: ledgerURL) { snapshots.add($0) }
        await queue.enqueue(HandoffJob(files: a))
        await queue.enqueue(HandoffJob(files: b))
        await queue.enqueue(HandoffJob(files: c))
        await queue.enqueue(HandoffJob(files: a))  // already queued: ignored
        await queue.waitUntilIdle()

        XCTAssertEqual(worker.log, ["import polydance-mac-20261105-090000", "process session-090000",
                                    "import polydance-mac-20261105-100000",
                                    "import polydance-mac-20261105-110000", "process session-110000"])
        // Never two at once.
        XCTAssertTrue(snapshots.list.allSatisfy { snap in snap.current == nil || !snap.queued.contains(where: { $0.id == snap.current?.id }) })
        let ledger = try HandoffLedger.load(from: ledgerURL)
        XCTAssertNil(ledger.recordings[a.videoName]?.pid, "a finished hand-off keeps no pid")
        XCTAssertEqual(ledger.recordings[a.videoName]?.status, .processed)
        XCTAssertEqual(ledger.recordings[a.videoName]?.sessionId, "session-090000")
        XCTAssertEqual(ledger.recordings[b.videoName]?.status, .importFailed)
        XCTAssertEqual(ledger.recordings[b.videoName]?.error, "polycap import exited 1: bad file")
        XCTAssertEqual(ledger.recordings[c.videoName]?.status, .processFailed)
        let state = await queue.state
        XCTAssertNil(state.current)
        XCTAssertEqual(state.finished.map(\.id), [c.videoName, b.videoName, a.videoName])
        XCTAssertEqual(state.finished.last?.stage, .done(sessionId: "session-090000", dir: "/lib/sessions/session-090000"))

        // Processing again, when asked, does not import again.
        await queue.enqueue(HandoffJob(files: c, kind: .processOnly(sessionId: "session-110000", dir: "/lib/sessions/session-110000")))
        await queue.waitUntilIdle()
        XCTAssertEqual(worker.log.suffix(1), ["process session-110000"])
    }

    // MARK: Settings

    func testSettingsDefaultsAndValidation() throws {
        let name = "settings-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let settings = SettingsStore(defaults: defaults)
        XCTAssertTrue(settings.autoRecordMeet)
        XCTAssertTrue(settings.notifyOnStart)
        XCTAssertEqual(settings.excludedApps, ["com.apple.MobileSMS", "com.apple.mail", "com.apple.Passwords"])
        XCTAssertEqual(settings.fps, 5)
        XCTAssertEqual(settings.transcriber, .whisperCpp)
        XCTAssertNil(settings.nodePath)
        XCTAssertNil(settings.libraryRoot)
        XCTAssertEqual(settings.walkthroughSounds, WalkthroughSounds(mic: true, macSound: true), "a walkthrough records both until a switch is turned off")

        settings.autoRecordMeet = false
        settings.fps = 120
        XCTAssertEqual(settings.fps, 30)
        settings.excludedApps = ["com.tinyspeck.slackmacgap", "not valid!", "com.tinyspeck.slackmacgap"]
        XCTAssertEqual(settings.excludedApps, ["com.tinyspeck.slackmacgap"])
        settings.excludedApps = []
        XCTAssertEqual(settings.excludedApps, [], "an empty list is the user's choice, not the default")
        settings.nodePath = "node"
        XCTAssertNil(settings.nodePath, "only absolute paths")
        settings.nodePath = "/opt/homebrew/bin/node"
        XCTAssertEqual(settings.nodePath, "/opt/homebrew/bin/node")
        settings.libraryRoot = "~/Elsewhere"
        XCTAssertEqual(settings.libraryRoot, "~/Elsewhere")
        settings.libraryRoot = ""
        XCTAssertNil(settings.libraryRoot)

        defaults.set("loud", forKey: SettingsStore.Key.transcriber)
        defaults.set(0, forKey: SettingsStore.Key.fps)
        defaults.set("yes", forKey: SettingsStore.Key.autoRecordMeet)
        XCTAssertEqual(settings.transcriber, .whisperCpp, "a bad value written by hand falls back to the default")
        XCTAssertEqual(settings.fps, 5)
        XCTAssertTrue(settings.autoRecordMeet)
        XCTAssertFalse(SettingsStore(defaults: defaults).autoRecordMeet == false)

        settings.walkthroughMic = false
        XCTAssertEqual(SettingsStore(defaults: defaults).walkthroughSounds, WalkthroughSounds(mic: false, macSound: true), "the switch is remembered")
        defaults.set("off", forKey: SettingsStore.Key.walkthroughMacSound)
        XCTAssertTrue(settings.walkthroughMacSound, "a bad value written by hand records the sound rather than losing it")
    }

    /// The line under a launch's keys names a sound left out, as the headset's does, so the folded switches never hide it.
    func testWhatAWalkthroughRecordsIsSaid() {
        let leftOut = "Messages, Mail and Passwords left out"
        XCTAssertEqual(WalkthroughSounds().records(leftOut: leftOut), "Records the display, the mic and the Mac's sound; Messages, Mail and Passwords left out")
        XCTAssertEqual(WalkthroughSounds(mic: false).records(), "Records the display and the Mac's sound, without the mic")
        XCTAssertEqual(WalkthroughSounds(macSound: false).records(), "Records the display and the mic, without the Mac's sound")
        XCTAssertEqual(WalkthroughSounds(mic: false, macSound: false).records(), "Records the display only, without the mic or the Mac's sound")
        XCTAssertFalse(WalkthroughSounds().anyOff)
        XCTAssertTrue(WalkthroughSounds(mic: false).anyOff)
        XCTAssertTrue(WalkthroughSounds(macSound: false).anyOff)
    }

    // MARK: The far end (C12)

    func testFarEndIsFlaggedOnlyWhenArcPlaysAndTheTapNeverHeardAnything() {
        var refused = FarEndMonitor()
        var flaggedAt: Int?
        for t in 0...60 where refused.observe(at: Double(t), appPlaying: true, tapPeak: 0) { flaggedAt = t }
        XCTAssertEqual(flaggedAt, 30)
        XCTAssertEqual(refused.verdict, .silent)
        XCTAssertTrue(refused.warning)

        var quietArc = FarEndMonitor()
        for t in 0...120 { XCTAssertFalse(quietArc.observe(at: Double(t), appPlaying: false, tapPeak: 0)) }
        XCTAssertEqual(quietArc.verdict, .silent, "nothing was ever heard")

        var working = FarEndMonitor()
        XCTAssertFalse(working.observe(at: 0, appPlaying: true, tapPeak: 0.2))
        for t in 1...200 { XCTAssertFalse(working.observe(at: Double(t), appPlaying: true, tapPeak: 0), "muted others after sound is not a refused grant") }
        XCTAssertEqual(working.verdict, .heard)

        var late = FarEndMonitor()
        for t in 0...20 { _ = late.observe(at: Double(t), appPlaying: true, tapPeak: nil) }
        XCTAssertFalse(late.observe(at: 21, appPlaying: true, tapPeak: 0.01))
        for t in 22...80 { XCTAssertFalse(late.observe(at: Double(t), appPlaying: true, tapPeak: 0)) }
        XCTAssertEqual(late.verdict, .heard)
    }

    /// Waiting alone in a meeting trips C12; once the others are heard the warning goes, though the
    /// monitor remembers it was raised.
    /// 2026-11-16: a report recorded 60 s of zeros from a virtual default input and nothing said so.
    func testASilentMicrophoneIsFlaggedOnceAndAPauseNeverIs() {
        var mic = SilentMicMonitor()
        XCTAssertFalse(mic.observe(at: 100, peak: 0))
        for second in 1...9 { XCTAssertFalse(mic.observe(at: 100 + Double(second), peak: nil), "\(second) s") }
        XCTAssertTrue(mic.observe(at: 110, peak: 0.00005), "10 s of nothing above -80 dBFS")
        XCTAssertTrue(mic.warning)
        XCTAssertFalse(mic.observe(at: 111, peak: 0), "said once")
        XCTAssertFalse(mic.observe(at: 112, peak: 0.02))
        XCTAssertFalse(mic.warning, "heard after all: the warning goes")

        var talking = SilentMicMonitor()
        XCTAssertFalse(talking.observe(at: 0, peak: 0.003), "room noise from a real microphone")
        for second in 1...60 { XCTAssertFalse(talking.observe(at: Double(second), peak: 0), "a pause is not a broken microphone") }
        XCTAssertFalse(talking.warning)
    }

    func testThePlatesSayWhichMicrophoneWillRecord() {
        XCTAssertEqual(MicDescription.line(MicDescription(name: "MacBook Pro Microphone", virtual: false)).text, "Mic: MacBook Pro Microphone")
        XCTAssertFalse(MicDescription.line(MicDescription(name: "MacBook Pro Microphone", virtual: false)).warning)
        let virtual = MicDescription.line(MicDescription(name: "Sessions Input 2ch", virtual: true))
        XCTAssertTrue(virtual.warning)
        XCTAssertTrue(virtual.text.contains("Sessions Input 2ch, a virtual device"))
        XCTAssertTrue(virtual.text.contains("System Settings → Sound → Input"))
        XCTAssertTrue(MicDescription.line(nil).warning)
    }

    func testTheFarEndWarningClearsOnceTheOthersAreHeard() {
        var alone = FarEndMonitor()
        for t in 0...31 { _ = alone.observe(at: Double(t), appPlaying: true, tapPeak: 0) }
        XCTAssertTrue(alone.flagged)
        XCTAssertTrue(alone.warning)
        XCTAssertFalse(alone.observe(at: 32, appPlaying: true, tapPeak: 0.3))
        XCTAssertFalse(alone.warning, "heard now")
        XCTAssertTrue(alone.flagged)
        XCTAssertEqual(alone.verdict, .heard)
    }

    /// cap-1: the app track is encoded at 44.1 or 48 kHz whatever the tap runs at; AAC refuses 88.2 and 96 kHz
    /// and fails mid-call at 16 to 24 kHz.
    func testTheCallSoundIsEncodedAtARateAACTakes() {
        let rates: [Double] = [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 192_000]
        XCTAssertEqual(rates.map(AppTrackEncoding.sampleRate(forTapRate:)),
                       [48_000, 48_000, 48_000, 48_000, 48_000, 44_100, 48_000, 48_000, 48_000, 48_000])
    }

    func testMeterLevels() {
        let loud: [Float] = [0.5, -0.5, 0.5, -0.5]
        let level = loud.withUnsafeBufferPointer { AudioLevel.measure($0) }
        XCTAssertEqual(level.peak, 0.5)
        XCTAssertEqual(level.rms, 0.5, accuracy: 0.0001)
        let odd: [Float] = [.nan, 1, .infinity]
        XCTAssertEqual(odd.withUnsafeBufferPointer { AudioLevel.measure($0) }.peak, 1)
        XCTAssertEqual(AudioLevel.bars(rms: 0), 0)
        XCTAssertEqual(AudioLevel.bars(rms: 1), 7)
        XCTAssertEqual(AudioLevel.bars(rms: 0.001), 0, "-60 dBFS")
        XCTAssertEqual(AudioLevel.bars(rms: 0.032), 4, "-30 dBFS lights about half")
    }
}
