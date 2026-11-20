// The Mac's own images of the logo, the ballerina: the menu-bar icons and the logo as an NSImage. The rest
// of the look (Palette, Theme, the drawn parts) is PolydanceShared's, the same on the Mac and the iPhone.
import AppKit
import PolydanceShared
import SwiftUI

/// Polydance's logo, the ballerina, as the app shows it: the menu-bar icon and the menu's header. The
/// images are in the app's Resources (build.sh copies them; design/icons.py draws the menu-bar
/// silhouette from the logo). Without them (`swift run`, the tests) the icons fall back to drawn shapes.
enum Logo {
    /// The logo in its colours, 256 px (the headset app's polydance_mark.png).
    static let mark: NSImage? = mark(in: Bundle.main.resourceURL)
    /// The ballerina's silhouette, 18 pt tall, as a template image, at 1x and 2x.
    static let silhouette: NSImage? = silhouette(in: Bundle.main.resourceURL)

    static func mark(in folder: URL?) -> NSImage? {
        folder.flatMap { NSImage(contentsOf: $0.appendingPathComponent("PolydanceMark.png")) }
    }

    static func silhouette(in folder: URL?) -> NSImage? {
        guard let folder else { return nil }
        let reps = ["MenuBarDancer.png", "MenuBarDancer@2x.png"].compactMap { name -> NSBitmapImageRep? in
            (try? Data(contentsOf: folder.appendingPathComponent(name))).flatMap(NSBitmapImageRep.init(data:))
        }
        guard let one = reps.first else { return nil }
        let size = NSSize(width: CGFloat(one.pixelsWide), height: CGFloat(one.pixelsHigh))
        let image = NSImage(size: size)
        for rep in reps {
            rep.size = size
            image.addRepresentation(rep)
        }
        image.isTemplate = true
        return image
    }

    /// The silhouette filled with one colour, not a template, so the menu bar keeps the colour.
    static func tinted(_ base: NSImage?, _ color: NSColor) -> NSImage? {
        guard let base else { return nil }
        let image = NSImage(size: base.size, flipped: false) { rect in
            base.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
        image.isTemplate = false
        return image
    }
}

/// Menu-bar icons: the ballerina. Watching is a template image, so it follows the menu bar's colour;
/// recording (red, beside the clock) and building (amber) are coloured so they read at a glance beside
/// macOS's own indicator.
enum MenuBarIcons {
    static let red = NSColor(Palette.red)
    static let amber = NSColor(Palette.amber)

    static let watching: NSImage = Logo.silhouette ?? drawn(ring: .black, dot: .black, template: true)
    static let recording: NSImage = Logo.tinted(Logo.silhouette, red) ?? drawn(ring: nil, dot: red, template: false)
    static let building: NSImage = Logo.tinted(Logo.silhouette, amber) ?? drawn(ring: amber, dot: nil, template: false)

    /// The shapes used before the logo, for a build run without its Resources.
    private static func drawn(ring: NSColor?, dot: NSColor?, template: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
            if let ring {
                ring.setStroke()
                let path = NSBezierPath(ovalIn: NSRect(x: 2, y: 2, width: 12, height: 12))
                path.lineWidth = 1.5
                path.stroke()
            }
            if let dot {
                dot.setFill()
                NSBezierPath(ovalIn: NSRect(x: 4.5, y: 4.5, width: 7, height: 7)).fill()
            }
            return true
        }
        image.isTemplate = template
        return image
    }
}
