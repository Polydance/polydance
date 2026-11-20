// Polydance's look on the Mac and the iPhone is the headset app's (docs/DESIGN-SYSTEM.md, Robin 2026-11-06:
// "standardise this as much as possible across platforms"): a vintage tape recorder in a dark room. Warm
// charcoal casing, cream printed labels in a condensed face, amber lamps, one red record key, dark plates
// screwed to a light wooden cabinet. The colours are design/tokens.json's (Palette); Theme names what each
// is for, and gives the type.
import SwiftUI

public enum Theme {
    // Grounds: the casing a page sits on, the black plates and panels, a raised surface, the hairline edge.
    public static let background = Palette.casing
    public static let panel = Palette.panel
    public static let surface = Palette.surface
    public static let raised = Palette.edge
    public static let border = Palette.edge
    public static let divider = Palette.edge.opacity(0.75)
    public static let rule = Palette.edge.opacity(0.5)
    public static let sidebar = Palette.panel
    public static let selected = Palette.surface
    public static let field = Palette.panel
    public static let thumb = Palette.surface
    public static let meterOff = Palette.edge

    // Print: cream for what is read, tan for what is secondary, the hint colour for placeholders, white print
    // for what is new (an unread thread's title).
    public static let text = Palette.cream
    public static let soft = Palette.tan
    public static let muted = Palette.tan
    public static let faint = Palette.hint
    public static let bright = Palette.whitePrint

    // Lamps and states: green ready, red recording or wrong, amber waiting or to try, blue for links and the
    // other side of a call, cyan processing.
    public static let green = Palette.green
    public static let greenText = Palette.green
    public static let greenEdge = Palette.green.opacity(0.45)
    public static let red = Palette.red
    public static let redText = Palette.red
    public static let redButton = Palette.red
    public static let redEdge = Palette.red.opacity(0.55)
    public static let amber = Palette.amber
    public static let amberText = Palette.amber
    public static let amberEdge = Palette.amber.opacity(0.45)
    public static let amberNote = Palette.cream
    public static let markFill = Palette.amber.opacity(0.12)
    public static let greyEdge = Palette.edge
    public static let blue = Palette.blue
    public static let blueText = Palette.blue
    public static let processing = Palette.processing
    public static let unread = Palette.red

    /// Text: the system font at condensed width, as the headset's sans-serif-condensed.
    public static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight).width(.condensed) }
    /// Printed labels: condensed and bold; write them in capitals with `.retroLabel()` or LabelText.
    public static func label(_ size: CGFloat) -> Font { .system(size: size, weight: .bold).width(.condensed) }
    /// The tape counter's typewriter digits (the headset's serif-monospace).
    public static func counter(_ size: CGFloat) -> Font { .custom("Courier New", size: size).weight(.bold) }
    /// Paths, ids and commands, which must read character by character.
    public static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}

extension Color {
    /// 0xRRGGBB in sRGB, opaque: how Palette writes the tokens.
    public init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}

