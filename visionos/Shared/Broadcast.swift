// What the app and its broadcast extension agree on (docs/VISIONOS.md R1 to R4, docs/IPHONE.md I4), compiled into
// both, on the Vision Pro and the iPhone alike. Only a ReplayKit broadcast extension sees the whole screen (on
// visionOS the windows, other apps and immersive content, the room black without Apple's enterprise licence; on the
// iPhone whatever app is in front), so a take is written there, not in the app. They share an app group and nothing
// else:
//
//   <group>/Library/Application Support/Broadcast/
//     next.json      the app's: where the next take goes and which sounds it records (NextTake), kept current
//                    whenever the deck's line or switches change, so a broadcast started from anywhere is right
//     live.json      the extension's: the take under way or just ended (LiveTake), rewritten at each change
//     events.jsonl   the extension's event log (the app has its own)
//     Runs/<run>/    takes the extension writes: video.mp4, narration.m4a, run.json, thread.json, timeline.jsonl;
//                    the app adds opened.json while a take runs, and moves each finished take into its own
//                    container's Runs/, where the iPhone's upload code sends it
//
// Darwin notifications carry no data; each says "read the file again": stop and cancel from the app, changed
// from the extension. The meters' levels go through the group's defaults, written a few times a second. The names
// are each platform's own (the iPhone's group is not the Vision Pro's), and nothing else differs.
import Foundation
import PolydancePhoneCore

enum BroadcastShared {
    #if os(visionOS)
    /// The app's bundle id, which every other name here starts from.
    static let app = "net.polydance.capture.visionpro"
    /// The device, as the extension's run.json names its mic and model when the hardware gives none.
    static let deviceName = "Vision Pro"
    static let systemName = "visionOS"
    /// The app's own sound is a second track here: the Vision Pro's APP switch.
    static let recordsAppSound = true
    /// The picture as visionOS gives it (1920 x 1080 when last seen), only made even.
    static let maxShortSide: Int? = nil
    #else
    static let app = "net.polydance.capture.iphone"
    static let deviceName = "iPhone"
    static let systemName = "iOS"
    /// The screen and the microphone, which is what Robin asked for (2026-11-20): no app sound, no camera.
    static let recordsAppSound = false
    /// The iPhone's screen at its own pixels is 1179 x 2556 on an iPhone 16: scaled to 1080 on its short side, the
    /// camera's own 1080 x 1920 width, which the pipeline's frames and every player take.
    static let maxShortSide: Int? = 1080
    #endif

    static let appGroup = "group.\(app)"
    static let extensionBundleId = "\(app).broadcast"

    /// App → extension: finish the take and end the broadcast.
    static let stopNote = "\(app).stop"
    /// App → extension: end the broadcast and throw the take away (Cancel, after its question).
    static let cancelNote = "\(app).cancel"
    /// Extension → app: live.json changed (started, recording, finished, failed).
    static let changedNote = "\(app).changed"

    static let micLevelKey = "level.mic"
    static let appLevelKey = "level.app"
    static let levelsAtKey = "level.at"
    /// Written about once a second while frames arrive, so the app can tell a take whose extension died from one running.
    static let heartbeatKey = "heartbeat"

    /// The group's folder for all of it, made 0700; nil when the app group is not in the entitlements.
    static func root() -> URL? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        return container.appendingPathComponent("Library/Application Support/Broadcast", isDirectory: true)
    }

    static func runs(in root: URL) -> URL { root.appendingPathComponent("Runs", isDirectory: true) }
    static func next(in root: URL) -> URL { root.appendingPathComponent("next.json") }
    static func live(in root: URL) -> URL { root.appendingPathComponent("live.json") }
    static func events(in root: URL) -> URL { root.appendingPathComponent("events.jsonl") }

    static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func post(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    }

    /// Strict JSON in and out: an unknown key or a wrong type is an error, never a guess.
    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }
}

/// The picture's quality, chosen behind the gear: the Quest's three (RecordingQuality.kt). visionOS picks the picture's
/// size, so here only the bitrate changes: bits a pixel a frame at 30 fps, which at 1920 x 1080 is about 4, 9 and 16
/// Mbit/s. Medium is the 0.15 every take had before the choice existed (2026-11-18).
enum RecordingQuality: String, Codable, CaseIterable, Identifiable {
    case low, medium, high
    static let `default` = RecordingQuality.medium
    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    var bitsPerPixel: Double {
        switch self {
        case .low: 0.064
        case .medium: 0.15
        case .high: 0.26
        }
    }

    /// The writer's video bitrate for a picture this size, kept between 2 and 24 Mbit/s.
    func videoBitRate(width: Int, height: Int) -> Int {
        min(24_000_000, max(2_000_000, Int(Double(width * height) * 30 * bitsPerPixel)))
    }

    /// One line under the choice, at the size visionOS records (1920 x 1080 when last seen).
    var detail: String {
        let mbps = Int((Double(videoBitRate(width: 1920, height: 1080)) / 1_000_000).rounded())
        return switch self {
        case .low: "About \(mbps) Mbit/s. Smaller uploads, for slow Wi-Fi; small text blurs."
        case .medium: "About \(mbps) Mbit/s. The default."
        case .high: "About \(mbps) Mbit/s. Small text stays sharper while you move; uploads are about twice Medium's."
        }
    }
}

/// Where the next take goes and what it records, as the deck shows it. `thread` is thread.json's (RunThread, strictly
/// decoded), absent to keep the take on the headset. `quality` is absent in a next.json written before it existed,
/// which means Medium.
struct NextTake: Codable, Equatable {
    static let version = 1
    var v: Int = NextTake.version
    var thread: RunThread?
    var mic: Bool
    var app: Bool
    var quality: RecordingQuality?
    /// The app's version, build and commit, which the extension writes into run.json (it ships inside the app).
    var appVersion: String
    var appBuild: Int?
    var appCommit: String
    /// When the app wrote this, seconds since 1970.
    var at: Double

    init(thread: RunThread?, mic: Bool, app: Bool, quality: RecordingQuality = .default, appVersion: String, appBuild: Int?,
         appCommit: String, at: Date = Date()) {
        self.thread = thread
        self.mic = mic
        self.app = app
        self.quality = quality
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.appCommit = appCommit
        self.at = at.timeIntervalSince1970
    }

    static func decode(_ data: Data) throws -> NextTake {
        let next = try JSONDecoder().decode(NextTake.self, from: data)
        guard next.v == version else { throw UploadProtocolError("next.json", "is version \(next.v), not \(version)") }
        return next
    }
}

/// The take under way, or the last one, as the extension tells it.
struct LiveTake: Codable, Equatable {
    enum State: String, Codable {
        /// The broadcast began; no frame yet.
        case starting
        /// Frames are being written since `startedAt`.
        case recording
        /// Stopping: the files are being finished.
        case finishing
        /// The take is complete and waits in Runs/ for the app.
        case finished
        /// Thrown away by Cancel.
        case cancelled
        /// Nothing could be kept, with `reason`.
        case failed
    }

    var run: String
    var state: State
    /// When the broadcast began, and when its first frame was written (the take's 0), seconds since 1970.
    var beganAt: Double
    var startedAt: Double?
    var endedAt: Double?
    var reason: String?
    /// Whether the microphone has given any sound yet; false a few seconds in means it is off in the system's sheet.
    var micHeard: Bool
    var width: Int?
    var height: Int?
}
