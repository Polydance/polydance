// The drawn icons, as the headset draws them rather than taking them from a font (Icons.kt Glyph,
// RetroViews.kt GearIcon and BugIcon), so they are the same flat print on every platform: the inbox's
// stroke drawings on a 24-unit grid (menu, search, close, back, archive, delete, camera, reply, smile,
// star), the gear and the beetle of the bug key.
import SwiftUI

/// One of the inbox's icons, a stroke drawing on Material's 24-unit grid with round ends, 2 units wide.
public struct Glyph: View {
    public enum Kind: Sendable { case menu, search, close, back, archive, unarchive, trash, more, camera, reply, smile, star, starFilled }
    let kind: Kind
    let color: Color
    var size: CGFloat

    public init(_ kind: Kind, color: Color, size: CGFloat = 24) {
        self.kind = kind
        self.color = color
        self.size = size
    }

    public var body: some View {
        let kind = kind, color = color
        Canvas { ctx, canvas in Self.draw(&ctx, canvas, kind: kind, color: color) }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    /// The drawing, out of the view's closure so every platform's compiler types it quickly (visionOS's
    /// gave up on it inline, 2026-11-12).
    private static func draw(_ ctx: inout GraphicsContext, _ canvas: CGSize, kind: Kind, color: Color) {
        ctx.scaleBy(x: canvas.width / 24, y: canvas.height / 24)
        let stroke = StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
        func lines(_ xy: [CGFloat]) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: xy[0], y: xy[1]))
            for i in stride(from: 2, to: xy.count, by: 2) { p.addLine(to: CGPoint(x: xy[i], y: xy[i + 1])) }
            return p
        }
        func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)) }
        let ink = GraphicsContext.Shading.color(color)
        switch kind {
        case .menu:
            for y in [6.0, 12, 18] { ctx.stroke(lines([3.5, y, 20.5, y]), with: ink, style: stroke) }
        case .search:
            ctx.stroke(circle(10, 10, 6), with: ink, style: stroke)
            ctx.stroke(lines([14.5, 14.5, 20, 20]), with: ink, style: stroke)
        case .close:
            ctx.stroke(lines([6, 6, 18, 18]), with: ink, style: stroke)
            ctx.stroke(lines([18, 6, 6, 18]), with: ink, style: stroke)
        case .back:
            ctx.stroke(lines([15, 5, 8, 12, 15, 19]), with: ink, style: stroke)
        case .archive, .unarchive:
            ctx.stroke(Path(roundedRect: CGRect(x: 3, y: 4, width: 18, height: 4.5), cornerRadius: 1), with: ink, style: stroke)
            ctx.stroke(lines([5, 8.5, 5, 20, 19, 20, 19, 8.5]), with: ink, style: stroke)
            if kind == .archive {
                ctx.stroke(lines([12, 11, 12, 17]), with: ink, style: stroke)
                ctx.stroke(lines([9, 14.5, 12, 17.5, 15, 14.5]), with: ink, style: stroke)
            } else {
                ctx.stroke(lines([12, 11, 12, 17.5]), with: ink, style: stroke)
                ctx.stroke(lines([9, 13.5, 12, 10.5, 15, 13.5]), with: ink, style: stroke)
            }
        case .trash:
            ctx.stroke(lines([4, 6, 20, 6]), with: ink, style: stroke)
            ctx.stroke(lines([9, 6, 9, 3.5, 15, 3.5, 15, 6]), with: ink, style: stroke)
            ctx.stroke(lines([6, 6, 7, 20.5, 17, 20.5, 18, 6]), with: ink, style: stroke)
            ctx.stroke(lines([10, 10, 10, 17]), with: ink, style: stroke)
            ctx.stroke(lines([14, 10, 14, 17]), with: ink, style: stroke)
        case .more:
            for y in [5.0, 12, 19] { ctx.fill(circle(12, y, 2), with: ink) }
        case .camera:
            ctx.stroke(Path(roundedRect: CGRect(x: 2.5, y: 7, width: 12.5, height: 10), cornerRadius: 2), with: ink, style: stroke)
            var lens = lines([15, 10.5, 21, 7.5, 21, 16.5, 15, 13.5])
            lens.closeSubpath()
            ctx.fill(lens, with: ink)
        case .reply:
            ctx.stroke(lines([9.5, 6, 4, 11.5, 9.5, 17]), with: ink, style: stroke)
            var p = Path()
            p.move(to: CGPoint(x: 4, y: 11.5)); p.addLine(to: CGPoint(x: 13, y: 11.5))
            p.addQuadCurve(to: CGPoint(x: 20, y: 18.5), control: CGPoint(x: 20, y: 11.5))
            ctx.stroke(p, with: ink, style: stroke)
        case .smile:
            ctx.stroke(circle(12, 12, 9), with: ink, style: stroke)
            ctx.fill(circle(9, 10, 1.3), with: ink)
            ctx.fill(circle(15, 10, 1.3), with: ink)
            var mouth = Path()
            mouth.addArc(center: CGPoint(x: 12, y: 12.5), radius: 4.5, startAngle: .degrees(25), endAngle: .degrees(155), clockwise: false)
            ctx.stroke(mouth, with: ink, style: stroke)
        case .star, .starFilled:
            var star = Path()
            for i in 0..<10 {
                let a = (Double(i) * 36 - 90) * .pi / 180
                let r: CGFloat = i % 2 == 0 ? 9 : 4
                let p = CGPoint(x: 12 + r * CGFloat(cos(a)), y: 12.5 + r * CGFloat(sin(a)))
                if i == 0 { star.move(to: p) } else { star.addLine(to: p) }
            }
            star.closeSubpath()
            if kind == .starFilled { ctx.fill(star, with: ink) }
            ctx.stroke(star, with: ink, style: StrokeStyle(lineWidth: 1.6, lineJoin: .round))
        }
    }
}

/// A round key holding one glyph, 44 points across for a finger, lit while pressed (Glyph.key).
public struct IconKey: View {
    let kind: Glyph.Kind
    let color: Color
    let label: String
    let action: () -> Void

    public init(_ kind: Glyph.Kind, color: Color = Palette.cream, label: String, action: @escaping () -> Void) {
        self.kind = kind
        self.color = color
        self.label = label
        self.action = action
    }

    public var body: some View {
        Button(action: action) { Glyph(kind, color: color, size: 22) }
            .buttonStyle(IconKeyStyle())
            .accessibilityLabel(label)
    }

    private struct IconKeyStyle: ButtonStyle {
        @Environment(\.isEnabled) private var enabled
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .opacity(enabled ? 1 : 0.4)
                .frame(width: 44, height: 44)
                .background(Circle().fill(Palette.cream.opacity(configuration.isPressed ? 60 / 255 : 0)))
                .contentShape(Circle())
        }
    }
}

/// The settings gear: eight teeth, a body and a hole in the ground's colour (GearIcon).
public struct GearIcon: View {
    let ink: Color
    let hole: Color

    public init(ink: Color, hole: Color) {
        self.ink = ink
        self.hole = hole
    }

    public var body: some View {
        Canvas { ctx, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let r = min(size.width, size.height) / 2 * 0.75
            for i in 0..<8 {
                var t = ctx
                t.translateBy(x: c.x, y: c.y)
                t.rotate(by: .degrees(Double(i) * 45))
                t.fill(Path(roundedRect: CGRect(x: -r * 0.2, y: -r * 1.28, width: r * 0.4, height: r * 0.68), cornerRadius: r * 0.06), with: .color(ink))
            }
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - r * 0.92, y: c.y - r * 0.92, width: r * 1.84, height: r * 1.84)), with: .color(ink))
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - r * 0.38, y: c.y - r * 0.38, width: r * 0.76, height: r * 0.76)), with: .color(hole))
        }
        .accessibilityHidden(true)
    }
}

/// The bug key's beetle: three legs a side, antennae, the shell and head, and the seam between the wing
/// cases in the ground's colour (BugIcon).
public struct BugIcon: View {
    let ink: Color
    let hole: Color

    public init(ink: Color, hole: Color) {
        self.ink = ink
        self.hole = hole
    }

    public var body: some View {
        Canvas { ctx, size in
            let cx = size.width / 2, cy = size.height / 2
            let r = min(size.width, size.height) / 2 * 0.8
            let leg = StrokeStyle(lineWidth: r * 0.13, lineCap: .round)
            func line(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat, _ color: Color) {
                var p = Path()
                p.move(to: CGPoint(x: x0, y: y0)); p.addLine(to: CGPoint(x: x1, y: y1))
                ctx.stroke(p, with: .color(color), style: leg)
            }
            for i in 0...2 {
                let y = cy - r * 0.1 + CGFloat(i) * r * 0.45
                let reach = r * (1.12 - 0.08 * CGFloat(i))
                let drop = r * (0.18 * CGFloat(i) - 0.22)
                line(cx - r * 0.4, y, cx - reach, y + drop, ink)
                line(cx + r * 0.4, y, cx + reach, y + drop, ink)
            }
            line(cx - r * 0.18, cy - r * 0.78, cx - r * 0.5, cy - r * 1.22, ink)
            line(cx + r * 0.18, cy - r * 0.78, cx + r * 0.5, cy - r * 1.22, ink)
            ctx.fill(Path(ellipseIn: CGRect(x: cx - r * 0.62, y: cy - r * 0.45, width: r * 1.24, height: r * 1.5)), with: .color(ink))
            ctx.fill(Path(ellipseIn: CGRect(x: cx - r * 0.34, y: cy - r * 0.96, width: r * 0.68, height: r * 0.68)), with: .color(ink))
            line(cx, cy - r * 0.3, cx, cy + r * 0.95, hole)
        }
        .accessibilityHidden(true)
    }
}
