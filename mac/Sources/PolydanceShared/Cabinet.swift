// The cabinet, as the headset app builds it (Surfaces.kt, docs/DESIGN-SYSTEM.md): light wooden boards behind
// everything, dark plates screwed to them at each corner, and the deck's cream top plate. The wood is
// RetroLook.wood, the same boards, grain and seams the headset draws from java.util.Random(1966). Drawn the
// same on the Mac and the iPhone (PolydanceShared).
import SwiftUI

/// The light wooden cabinet: boards of two tones, wavy grain, a dark seam with a highlight between boards.
public struct Wood: View {
    public init() {}

    public var body: some View {
        Canvas { context, size in
            let boards = RetroLook.wood(width: size.width, height: size.height)
            for board in boards {
                let rect = CGRect(x: 0, y: board.top, width: size.width, height: board.bottom - board.top)
                context.fill(Path(rect), with: .color(Self.tone(board)))
            }
            for board in boards {
                for line in board.grain {
                    var path = Path()
                    guard let first = line.points.first else { continue }
                    path.move(to: CGPoint(x: first.x, y: first.y))
                    for point in line.points.dropFirst() { path.addLine(to: CGPoint(x: point.x, y: point.y)) }
                    context.stroke(path, with: .color(Palette.woodGrain.opacity(Double(line.alpha) / 255)), lineWidth: line.width)
                }
            }
            for board in boards.dropFirst() {
                var seam = Path()
                seam.move(to: CGPoint(x: 0, y: board.top)); seam.addLine(to: CGPoint(x: size.width, y: board.top))
                context.stroke(seam, with: .color(Palette.woodSeam), lineWidth: 2)
                var light = Path()
                light.move(to: CGPoint(x: 0, y: board.top + 1.6)); light.addLine(to: CGPoint(x: size.width, y: board.top + 1.6))
                context.stroke(light, with: .color(Palette.cream.opacity(90 / 255)), lineWidth: 1)
            }
        }
        .accessibilityHidden(true)
    }

    /// The board's wood, light or mid, with its tone shifted by the same few levels on each channel.
    private static func tone(_ board: RetroLook.Board) -> Color {
        (board.wood == 0 ? Palette.woodLight : Palette.woodMid).shifted(by: Double(board.shift) / 255)
    }
}

/// A steel screw head: a rim, a lighter face and the slot at 45 degrees (Screws.dark).
public struct Screw: View {
    public init() {}

    public var body: some View {
        Canvas { context, size in
            let r = min(size.width, size.height) / 2 - 0.6
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let head = Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
            context.fill(head, with: .color(Parts.screwFace))
            context.stroke(head, with: .color(Parts.screwRim), lineWidth: 1.2)
            var slot = Path()
            slot.move(to: CGPoint(x: c.x - r * 0.6, y: c.y - r * 0.6)); slot.addLine(to: CGPoint(x: c.x + r * 0.6, y: c.y + r * 0.6))
            context.stroke(slot, with: .color(Parts.screwRim), lineWidth: 1.2)
        }
        .frame(width: 9, height: 9)
        .accessibilityHidden(true)
    }
}

/// A plate screwed to the cabinet: a fill, a 2 pt edge, square-ish corners and a screw in each corner.
public struct PlateBackground: View {
    var fill: Color
    var screws: Bool

    public init(fill: Color = Palette.panel, screws: Bool = true) {
        self.fill = fill
        self.screws = screws
    }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 2).fill(fill)
            RoundedRectangle(cornerRadius: 2).strokeBorder(Palette.edge, lineWidth: 2)
            if screws {
                VStack {
                    HStack { Screw(); Spacer(); Screw() }
                    Spacer()
                    HStack { Screw(); Spacer(); Screw() }
                }
                .padding(6.5)
            }
        }
    }
}

/// The deck's top plate: brushed cream metal, darker towards the foot, with its own edge and screws.
public struct CreamPlateBackground: View {
    var screws: Bool

    public init(screws: Bool = true) { self.screws = screws }

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 2).fill(LinearGradient(colors: [Palette.plateLight, Palette.plateDark], startPoint: .top, endPoint: .bottom))
            Canvas { context, size in
                // Brushed lines, faint and even.
                var y = 2.0
                while y < size.height {
                    var line = Path()
                    line.move(to: CGPoint(x: 0, y: y)); line.addLine(to: CGPoint(x: size.width, y: y))
                    context.stroke(line, with: .color(Palette.plateEdge.opacity(0.10)), lineWidth: 0.6)
                    y += 3
                }
            }
            RoundedRectangle(cornerRadius: 2).strokeBorder(Palette.plateEdge, lineWidth: 1.5)
            if screws {
                // A plate too short for four screws has one at each end.
                GeometryReader { geo in
                    if geo.size.height < 56 {
                        HStack { Screw(); Spacer(); Screw() }.frame(maxHeight: .infinity).padding(.horizontal, 6.5)
                    } else {
                        VStack {
                            HStack { Screw(); Spacer(); Screw() }
                            Spacer()
                            HStack { Screw(); Spacer(); Screw() }
                        }
                        .padding(6.5)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

extension View {
    /// Sits the view on a dark plate screwed to the cabinet, with room inside for the screws.
    public func plate(_ fill: Color = Palette.panel, screws: Bool = true, padding: CGFloat = 14) -> some View {
        self.padding(padding).background(PlateBackground(fill: fill, screws: screws))
    }

    /// Sits the view on the light wooden cabinet.
    public func onWood() -> some View { background(Wood()) }
}

extension Color {
    /// The colour with the same amount added to each of red, green and blue in sRGB: a board's tone shift.
    func shifted(by amount: Double) -> Color {
        let c = resolve(in: EnvironmentValues())
        return Color(.sRGB, red: Double(c.red) + amount, green: Double(c.green) + amount, blue: Double(c.blue) + amount, opacity: 1)
    }

    /// The colour at a quarter of its light, as a lamp that is off is on the headset.
    func quartered() -> Color {
        let c = resolve(in: EnvironmentValues())
        return Color(.sRGB, red: Double(c.red) / 4, green: Double(c.green) / 4, blue: Double(c.blue) / 4, opacity: 1)
    }
}

/// Colours inside the drawn parts (design/tokens.json "parts"): screws, meters, the counter, lamps, keys.
public enum Parts {
    public static let screwFace = Color(hex: 0x847C70)
    public static let screwRim = Color(hex: 0x24201C)
    public static let meterFaceLit = [Color(hex: 0xFAECC8), Color(hex: 0xE2CDA0)]
    public static let meterFaceDark = [Color(hex: 0xC4BAA2), Color(hex: 0xA09680)]
    public static let meterInk = Color(hex: 0x3C2C1E)
    public static let meterZone = Color(hex: 0xC43426)
    public static let meterTickRed = Color(hex: 0xAA281C)
    public static let meterNeedle = Color(hex: 0x281C12)
    public static let meterHousing = Color(hex: 0x2E2822)
    public static let counterWindow = Color(hex: 0x0A0908)
    public static let counterDrum = [Color(hex: 0x0E0C0A), Color(hex: 0x3A332C), Color(hex: 0x0E0C0A)]
    public static let lampRing = Color(hex: 0x5A544C)
    public static let recordKeyReady = [Color(hex: 0xEC543C), Color(hex: 0xB02C1C)]
    public static let recordKeyRecording = [Color(hex: 0x962216), Color(hex: 0xBE301E)]
    public static let recordKeyStarting = [Color(hex: 0xF6BA58), Color(hex: 0xC48024)]
    public static let recordKeyDisabled = [Color(hex: 0x8C857B), Color(hex: 0x625C54)]
    public static let recordKeyEdge = Color(hex: 0x46120A)
    public static let recordKeyPrint = Color(hex: 0xFFF4EC)
    public static let keyShadow = Color(hex: 0x080706)
    // The top plate's reels (TopPlate), as DeckView draws them.
    public static let reelTape = Color(hex: 0x4A3426)
    public static let reelTapeFull = Color(hex: 0x8C281C)
    public static let reelFlange = Color(hex: 0xFFFFFF)
    public static let reelRim = Color(hex: 0x605648)
    public static let reelLabelRim = Color(hex: 0xB04016)
    public static let reelHub = Color(hex: 0x2A221B)
    public static let reelLogoInk = Color(hex: 0x28160C)
    public static let tapeFullPrint = Color(hex: 0xAA2418)
    // The meter's OFF/ON switch (VuMeter.drawSwitch): the unlit word, the bushing's nut and hole, the bat lever's
    // edge and steel, and its tip.
    public static let switchOffPrint = Color(hex: 0x70685E)
    public static let switchNut = [Color(hex: 0x96928A), Color(hex: 0x54504A)]
    public static let switchLever = [Color(hex: 0x3C3A36), Color(hex: 0xD6D2CA)]
    public static let switchTip = Color(hex: 0xE6E2DA)
}
