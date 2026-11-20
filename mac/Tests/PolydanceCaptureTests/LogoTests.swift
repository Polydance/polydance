// The menu-bar icons drawn from the committed images in App/Resources (what build.sh copies into the
// app), and the logo they come from: sizes, the template flag, and the colours actually drawn.
import AppKit
import XCTest
@testable import PolydanceCapture

final class LogoTests: XCTestCase {
    private let mac = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    private var resources: URL { mac.appendingPathComponent("App/Resources") }

    /// Draws the image at 2x into a bitmap and returns it.
    private func render(_ image: NSImage) throws -> NSBitmapImageRep {
        let rep = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(image.size.width * 2), pixelsHigh: Int(image.size.height * 2),
                                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        rep.size = image.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(origin: .zero, size: image.size))
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    /// The colours of the pixels the dancer covers (alpha above 0.9), and how many are transparent.
    private func survey(_ rep: NSBitmapImageRep) -> (covered: [NSColor], clear: Int) {
        var covered: [NSColor] = []
        var clear = 0
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let color = rep.colorAt(x: x, y: y) else { continue }
                if color.alphaComponent > 0.9 { covered.append(color) } else if color.alphaComponent < 0.05 { clear += 1 }
            }
        }
        return (covered, clear)
    }

    func testTheSilhouetteIsAnEighteenPointTemplateAtOneAndTwoTimes() throws {
        let image = try XCTUnwrap(Logo.silhouette(in: resources), "App/Resources has no MenuBarDancer images: run python3 -I design/icons.py")
        XCTAssertEqual(image.size, NSSize(width: 13, height: 18))
        XCTAssertTrue(image.isTemplate, "watching follows the menu bar's colour")
        let pixels = image.representations.map { NSSize(width: $0.pixelsWide, height: $0.pixelsHigh) }
        XCTAssertEqual(pixels, [NSSize(width: 13, height: 18), NSSize(width: 26, height: 36)])
        let drawn = survey(try render(image))
        XCTAssertGreaterThan(drawn.covered.count, 100, "the dancer is drawn")
        XCTAssertGreaterThan(drawn.clear, 300, "around her is transparent")
    }

    func testRecordingIsRedAndBuildingAmber() throws {
        let base = try XCTUnwrap(Logo.silhouette(in: resources))
        for (name, color) in [("red", MenuBarIcons.red), ("amber", MenuBarIcons.amber)] {
            let image = try XCTUnwrap(Logo.tinted(base, color))
            XCTAssertFalse(image.isTemplate, "\(name) keeps its colour in the menu bar")
            XCTAssertEqual(image.size, base.size)
            let drawn = survey(try render(image))
            XCTAssertGreaterThan(drawn.covered.count, 100)
            XCTAssertGreaterThan(drawn.clear, 300, "\(name): the fill stays inside her shape")
            let want = try XCTUnwrap(color.usingColorSpace(.deviceRGB))
            for pixel in drawn.covered {
                let got = try XCTUnwrap(pixel.usingColorSpace(.deviceRGB))
                XCTAssertEqual(got.redComponent, want.redComponent, accuracy: 0.03, name)
                XCTAssertEqual(got.greenComponent, want.greenComponent, accuracy: 0.03, name)
                XCTAssertEqual(got.blueComponent, want.blueComponent, accuracy: 0.03, name)
            }
        }
    }

    func testTheMarkIsTheHeadsetAppsLogo() throws {
        let android = mac.deletingLastPathComponent().appendingPathComponent("app/android/app/src/main/res/drawable-nodpi")
        let source = android.appendingPathComponent("polydance_mark.png")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("polydance-logo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.copyItem(at: source, to: folder.appendingPathComponent("PolydanceMark.png"))
        let mark = try XCTUnwrap(Logo.mark(in: folder))
        XCTAssertEqual(mark.representations.first?.pixelsWide, 256)
        XCTAssertNil(Logo.mark(in: nil))
        XCTAssertNil(Logo.silhouette(in: folder), "no silhouette in a folder without one: the drawn fallback is used")
    }

    func testTheAppIconIsBuilt() throws {
        let icon = try XCTUnwrap(NSImage(contentsOf: resources.appendingPathComponent("AppIcon.icns")))
        let sizes = Set(icon.representations.map(\.pixelsWide))
        XCTAssertTrue(sizes.isSuperset(of: [16, 32, 64, 128, 256, 512, 1024]), "\(sizes.sorted())")
    }
}
