// Runs one child process the way CLAUDE.md asks: an executable and an argument array, an explicit
// environment, no shell. Output is read on its own threads so a chatty child cannot fill a pipe and
// stall, and a timeout terminates it (SIGTERM, then SIGKILL after 5 s). Foundation makes each child the
// leader of its own process group and terminate() signals that group (seen on this Mac, 2026-11-05), so
// the SIGKILL goes to the group too: whisper-cli or ffmpeg that node started never outlive it. The
// child's pid is handed to `onStart` as soon as it runs, so a caller can record what it left running.
import Foundation

public struct ProcessResult: Sendable, Equatable {
    public var exitCode: Int32
    /// True when the child ended on a signal rather than exiting.
    public var signalled: Bool
    public var timedOut: Bool
    public var stdout: Data
    public var stderr: Data

    public var succeeded: Bool { exitCode == 0 && !signalled && !timedOut }
}

public enum ProcessRunner {
    public static func run(executable: String, arguments: [String], environment: [String: String],
                           currentDirectory: URL? = nil, timeout: TimeInterval, killGrace: TimeInterval = 5,
                           onStart: (@Sendable (Int32) -> Void)? = nil) async throws -> ProcessResult {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                do { continuation.resume(returning: try runBlocking(executable: executable, arguments: arguments, environment: environment,
                                                                   currentDirectory: currentDirectory, timeout: timeout,
                                                                   killGrace: killGrace, onStart: onStart)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    /// The same, blocking the calling thread. Never call it on the main thread.
    public static func runBlocking(executable: String, arguments: [String], environment: [String: String],
                                   currentDirectory: URL? = nil, timeout: TimeInterval, killGrace: TimeInterval = 5,
                                   onStart: (@Sendable (Int32) -> Void)? = nil) throws -> ProcessResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch {
            throw PolycapError("could not start \(executable): \(error.localizedDescription)")
        }
        onStart?(process.processIdentifier)

        let collected = Collected()
        let reads = DispatchGroup()
        for (pipe, isOut) in [(out, true), (err, false)] {
            reads.enter()
            DispatchQueue.global(qos: .utility).async {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                collected.set(data, stdout: isOut)
                reads.leave()
            }
        }

        let child = UncheckedBox(process)
        let watchdog = DispatchWorkItem {
            guard child.value.isRunning else { return }
            collected.markTimedOut()
            child.value.terminate()
            let pid = child.value.processIdentifier
            DispatchQueue.global().asyncAfter(deadline: .now() + killGrace) {
                if child.value.isRunning { killGroup(pid, SIGKILL) }
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
        process.waitUntilExit()
        watchdog.cancel()
        // A grandchild that kept the pipes open must not hold this forever once the child is gone.
        _ = reads.wait(timeout: .now() + 10)
        let (stdout, stderr, timedOut) = collected.snapshot()
        return ProcessResult(exitCode: process.terminationStatus, signalled: process.terminationReason == .uncaughtSignal,
                             timedOut: timedOut, stdout: stdout, stderr: stderr)
    }
}

/// Signals `pid`'s process group when it leads one of its own (as Foundation's children do), else the
/// process alone; never this app's own group.
func killGroup(_ pid: pid_t, _ signal: Int32) {
    let group = getpgid(pid)
    if group == pid, group != getpgid(getpid()) { kill(-pid, signal) } else { kill(pid, signal) }
}

/// Holds a value that is only touched in ways that are safe across threads (Process is, for
/// isRunning, terminate and processIdentifier).
final class UncheckedBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var out = Data()
    private var err = Data()
    private var timedOut = false

    func set(_ data: Data, stdout: Bool) {
        lock.lock(); defer { lock.unlock() }
        if stdout { out = data } else { err = data }
    }

    func markTimedOut() {
        lock.lock(); defer { lock.unlock() }
        timedOut = true
    }

    func snapshot() -> (Data, Data, Bool) {
        lock.lock(); defer { lock.unlock() }
        return (out, err, timedOut)
    }
}
