// swift-tools-version: 6.0
// `npm run ios -- pair` (docs/IPHONE.md P2): a window on this Mac with the QR code Polydance for iPhone
// scans to pair with a receiver, drawn in the look every platform shares (PolydanceShared, from ../../../mac)
// with Core Image's own QR generator, so nothing new is depended on. ios/build.sh builds it into ios/build/
// and gives it the pairing on standard input; see Sources/PolydancePair/main.swift.
import PackageDescription

let package = Package(
    name: "PolydancePair",
    platforms: [.macOS(.v15)],
    dependencies: [.package(path: "../../../mac")],
    targets: [
        .executableTarget(name: "PolydancePair", dependencies: [.product(name: "PolydanceShared", package: "mac")], path: "Sources/PolydancePair",
                          swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
