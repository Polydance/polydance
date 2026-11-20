// `PolydanceCapture --probe`: a self-check that touches no protected resource, so it can be run to
// verify a build without granting anything. It prints, as JSON, Core Audio's process list filtered to
// Arc, whether Arc is running, the screen-recording preflight (which never prompts), the microphone's
// authorisation status (read, not requested), where node and polycap were found, and the settings,
// then exits. It sends no Apple Events, opens no microphone, starts no capture, posts no notification
// and stores nothing.
//
// The two grants are those of the process macOS holds responsible: this app only when LaunchServices
// started it (`./build.sh probe` uses `open`); run from a shell, they are the terminal's or the IDE's
// (seen on this Mac, 2026-11-05: a bundle never granted the microphone read "authorized" from a shell).
// `launchedBy` says which it was.
import AVFoundation
import AppKit
import CoreGraphics
import Foundation
import PolydanceCore
import PolydanceShared

enum Probe {
    static func run() -> Int32 {
        let settings = SettingsStore()
        let build = AppBuildInfo.from(infoDictionary: Bundle.main.infoDictionary)
        var report: [String: Any] = [
            "probe": 1,
            "at": MetaTime.format(Date()),
            "app": [
                "bundleId": Bundle.main.bundleIdentifier ?? NSNull(),
                "versionName": build.versionName,
                "versionCode": build.versionCode ?? NSNull(),
                "commit": build.commit ?? NSNull(),
                "executable": Bundle.main.executablePath ?? CommandLine.arguments[0],
            ] as [String: Any],
        ]

        do {
            let all = try CoreAudioProcesses.read()
            let arc = ArcBrowser.processes(in: all)
            report["coreAudio"] = [
                "processCount": all.count,
                "arcProcesses": arc.map { ["objectID": $0.objectID, "pid": $0.pid, "bundleID": $0.bundleID ?? NSNull(),
                                           "isRunningInput": $0.isRunningInput, "isRunningOutput": $0.isRunningOutput] as [String: Any] },
                "arcUsingMicrophone": ArcBrowser.usingMicrophone(all),
                "arcPlayingSound": ArcBrowser.playingSound(all),
            ] as [String: Any]
        } catch {
            report["coreAudio"] = ["error": "\(error)"]
        }

        report["arcRunning"] = ArcTabReader.arcIsRunning
        let parent = getppid()
        let launcher = parentPath(parent)
        report["launchedBy"] = ["pid": parent, "path": launcher ?? NSNull(),
                                "grantsAreFor": parent == 1 ? "this app (started by launchd)" : "the launching process, not this app: run ./build.sh probe"] as [String: Any]
        report["screenCapturePreflight"] = CGPreflightScreenCaptureAccess()
        report["microphoneAuthorization"] = describe(AVCaptureDevice.authorizationStatus(for: .audio))
        report["loginItem"] = LoginItem.statusText

        let runner = PolycapRunner(settings: settings)
        do {
            let found = try runner.locate()
            report["polycap"] = ["node": found.node, "polycapJS": found.polycapJS,
                                 "source": settings.nodePath == found.node && settings.polycapPath == found.polycapJS ? "settings" : "login shell"]
        } catch {
            report["polycap"] = ["error": "\(error)"]
        }

        let resolved = LibraryLayout.resolveForApp(setting: settings.libraryRoot, environment: ProcessInfo.processInfo.environment,
                                                   home: FileManager.default.homeDirectoryForCurrentUser)
        let layout = resolved.layout
        report["library"] = ["root": layout.root.path, "recordings": layout.recordings.path, "sessions": layout.sessions.path,
                             "envFileProblem": resolved.problem ?? NSNull()] as [String: Any]
        report["settings"] = [
            "autoRecordMeet": settings.autoRecordMeet, "notifyOnStart": settings.notifyOnStart, "warnWithoutCall": settings.warnWithoutCall, "excludedApps": settings.excludedApps,
            "fps": settings.fps, "transcriber": settings.transcriber.rawValue, "libraryRoot": settings.libraryRoot ?? NSNull(),
        ] as [String: Any]

        guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else {
            FileHandle.standardError.write(Data("probe: could not encode the report\n".utf8))
            return 1
        }
        FileHandle.standardOutput.write(data + Data("\n".utf8))
        return 0
    }

    /// The parent's executable, read with proc_pidpath (no permission needed for one's own user).
    static func parentPath(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        return length > 0 ? String(cString: buffer) : nil
    }

    private static func describe(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: "authorized"
        case .denied: "denied"
        case .restricted: "restricted"
        case .notDetermined: "notDetermined"
        @unknown default: "unknown"
        }
    }
}
