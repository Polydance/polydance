// swift-tools-version: 6.2
// Polydance for iPhone (docs/IPHONE.md). PolydancePhoneCore holds what can be tested on this Mac without
// a camera, a phone or the network: run names, the run folder and its run.json, the event log, the movie
// writer (fed synthetic buffers in tests), the receiver's upload protocol, and since I3 the pairing, where a
// take goes, the thread requests and replies, reply notices and the report policy. Threads decode into the
// models the Mac shares (PolydanceShared, from ../../mac, the one product of that package built here). The
// app in ../App drives the camera, the background URLSession and the screen, and is built by ../build.sh
// through XcodeGen.
import PackageDescription

let package = Package(
    name: "PolydancePhoneCore",
    platforms: [.iOS(.v26), .macOS(.v15), .visionOS(.v26)],
    products: [
        .library(name: "PolydancePhoneCore", targets: ["PolydancePhoneCore"]),
    ],
    dependencies: [
        .package(path: "../../mac"),
    ],
    targets: [
        .target(name: "PolydancePhoneCore", dependencies: [.product(name: "PolydanceShared", package: "mac")], path: "Sources/PolydancePhoneCore"),
        .testTarget(name: "PolydancePhoneCoreTests", dependencies: ["PolydancePhoneCore", .product(name: "PolydanceShared", package: "mac")],
                    // Fixtures/ holds what the local receiver (ios/tools/serve-local.sh) really answered the phone's
                    // token on 2026-11-07; the tests read it by path, so it is not a bundle resource.
                    path: "Tests/PolydancePhoneCoreTests", exclude: ["Fixtures"]),
    ]
)
