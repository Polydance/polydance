// swift-tools-version: 6.0
// Polydance for Mac (docs/MAC.md). PolydanceCore holds the logic that can be tested without a
// microphone, a screen or Arc: call detection, the import metadata, file layout, settings and the
// polycap hand-off. PolydanceCapture is the menu-bar app: Core Audio, ScreenCaptureKit, AVFoundation,
// Apple Events and the UI. The core is Swift 6 with strict concurrency; the app is Swift 5 language
// mode, because the C callback APIs it drives (Core Audio IO procs, Carbon hot keys, AVFoundation
// delegates) fight strict checking without making anything safer.
//
// PolydanceShared is what the Mac, the iPhone (docs/IPHONE.md, phase I1) and the Vision Pro (docs/VISIONOS.md)
// use, so it builds for iOS 26 and visionOS 26 too: the look (Palette, Theme, the cabinet, the deck's parts, the window's pieces), the parts of
// it that are computed (RetroLook), and the thread models. Nothing in it uses Process, AppKit or UIKit.
// ios/project.yml and visionos/project.yml depend on this package for that one product; the Mac's targets are
// never built for iOS or visionOS.
//
// SpeakerTiles and the polydance-speakers command read a recorded Meet call for who Meet showed speaking
// (docs/MAC.md P3a): AVFoundation to decode, Vision to read names, all on the Mac. polycap runs the command
// in its speakers step, as it runs whisper-cli; it is not part of the app. Swift 5 mode for the same reason
// as the app: AVFoundation's and Vision's types are not Sendable, and the reader is one thread throughout.
import PackageDescription

let package = Package(
    name: "PolydanceCapture",
    platforms: [.macOS(.v15), .iOS("26.0"), .visionOS("26.0")],
    products: [
        .executable(name: "PolydanceCapture", targets: ["PolydanceCapture"]),
        .library(name: "PolydanceCore", targets: ["PolydanceCore"]),
        .library(name: "PolydanceShared", targets: ["PolydanceShared"]),
        .executable(name: "polydance-speakers", targets: ["PolydanceSpeakers"]),
    ],
    targets: [
        .target(name: "PolydanceShared", path: "Sources/PolydanceShared"),
        .target(name: "PolydanceCore", dependencies: ["PolydanceShared"], path: "Sources/PolydanceCore"),
        .executableTarget(
            name: "PolydanceCapture",
            dependencies: ["PolydanceCore", "PolydanceShared"],
            path: "Sources/PolydanceCapture",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .linkedFramework("AppKit"), .linkedFramework("AVFoundation"), .linkedFramework("Carbon"),
                .linkedFramework("CoreAudio"), .linkedFramework("CoreMedia"), .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("ServiceManagement"), .linkedFramework("UserNotifications"),
            ]
        ),
        .target(
            name: "SpeakerTiles",
            path: "Sources/SpeakerTiles",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedFramework("AVFoundation"), .linkedFramework("CoreMedia"), .linkedFramework("CoreVideo"), .linkedFramework("Vision")]
        ),
        .executableTarget(name: "PolydanceSpeakers", dependencies: ["SpeakerTiles"], path: "Sources/PolydanceSpeakers", swiftSettings: [.swiftLanguageMode(.v5)]),
        // Synthetic Meet frames and a short synthetic video; never a recorded call (those stay in the library).
        .testTarget(name: "SpeakerTilesTests", dependencies: ["SpeakerTiles"], path: "Tests/SpeakerTilesTests", swiftSettings: [.swiftLanguageMode(.v5)]),
        // Fixtures/ holds what polycap really wrote and printed (captured 2026-11-05); the tests read it by
        // path, so it is not a bundle resource.
        .testTarget(name: "PolydanceCoreTests", dependencies: ["PolydanceCore", "PolydanceShared"], path: "Tests/PolydanceCoreTests", exclude: ["Fixtures"]),
        .testTarget(name: "PolydanceSharedTests", dependencies: ["PolydanceShared"], path: "Tests/PolydanceSharedTests"),
        // The app's own capture code that runs without hardware (the writer, on synthetic sound and frames).
        .testTarget(name: "PolydanceCaptureTests", dependencies: ["PolydanceCapture", "PolydanceCore", "PolydanceShared"], path: "Tests/PolydanceCaptureTests",
                    swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
