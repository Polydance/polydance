// The deck's top plate as the headset draws it (DeckView in DeckViews.kt): brushed cream metal, two clear
// reels with brown tape and orange labels, POLYDANCE printed around the left reel and the ballerina printed
// on the right reel's label. The reels turn only while recording, spinning up from still and running down
// to a stop like a real transport. Storage is tape: the take-up reel (right) fills and the supply reel
// (left) empties as the receiver's allowance is used, red tape once it is full, both half full while it is
// not known. Beside the storage readout a small list key opens the recordings; the bug key and the gear sit
// in the plate's top corner. The iPhone's deck shows it (docs/IPHONE.md S1); the Mac's menu has no room.
import SwiftUI

public struct TopPlate: View {
    let spinning: Bool
    /// The fraction of the allowance used, 0 to 1; nil while unknown.
    let used: Double?
    let full: Bool
    /// The readout under the right reel ("2.1 OF 8 GB"); empty hides it and the list key.
    let storage: String
    /// The ballerina, printed in the deck's ink; the caller supplies the platform's image.
    let logo: Image?
    let onStorage: (() -> Void)?
    let onBug: (() -> Void)?
    let onGear: (() -> Void)?
    @Environment(\.lookTime) private var lookTime
    @State private var motion = ReelMotion()
    @State private var runningDown = false

    public init(spinning: Bool, used: Double?, full: Bool, storage: String, logo: Image?,
                onStorage: (() -> Void)? = nil, onBug: (() -> Void)? = nil, onGear: (() -> Void)? = nil) {
        self.spinning = spinning
        self.used = used
        self.full = full
        self.storage = storage
        self.logo = logo
        self.onStorage = onStorage
        self.onBug = onBug
        self.onGear = onGear
    }

    public var body: some View {
        GeometryReader { geo in
            let layout = ReelLayout(size: geo.size)
            ZStack(alignment: .topLeading) {
                CreamPlateBackground()
                TimelineView(.animation(minimumInterval: 1 / 30, paused: lookTime != nil || !(spinning || runningDown))) { context in
                    let angle = lookTime != nil ? 0 : motion.advance(to: context.date, spinning: spinning)
                    Canvas { ctx, _ in draw(&ctx, layout, angle: angle) }
                }
                .accessibilityHidden(true)
                LabelText("Tape", size: layout.labelSize, color: Palette.print, tracking: 0.25)
                    .position(x: layout.left, y: layout.labelY)
                    .accessibilityHidden(true)
                if !storage.isEmpty {
                    HStack(spacing: 8) {
                        LabelText(storage, size: layout.labelSize + 1, color: full ? Parts.tapeFullPrint : Palette.print, tracking: 0.18)
                        if let onStorage { ListKey(action: onStorage) }
                    }
                    .fixedSize()
                    .position(x: layout.right + (onStorage == nil ? 0 : 15), y: layout.labelY)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Storage: \(storage)")
                }
                HStack(spacing: 2) {
                    if let onBug { PlateKey(label: "Report a bug or suggest a feature", action: onBug) { BugIcon(ink: $0, hole: Palette.plateLight) } }
                    if let onGear { PlateKey(label: "Settings", action: onGear) { GearIcon(ink: $0, hole: Palette.plateLight) } }
                }
                // Clear of the corner screw and of the right reel.
                .padding(.top, 2).padding(.trailing, 20)
                .frame(maxWidth: .infinity, alignment: .topTrailing)
            }
        }
        .onChange(of: spinning) { _, now in
            guard !now else { return }
            runningDown = true
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(Int(ReelMotion.runDownMs) + 100))
                if !spinning { runningDown = false }
            }
        }
    }

    private func draw(_ ctx: inout GraphicsContext, _ l: ReelLayout, angle: Double) {
        reel(&ctx, l, x: l.left, tape: used.map { 1 - $0 } ?? 0.5, hub: true, angle: angle)
        reel(&ctx, l, x: l.right, tape: used ?? 0.5, hub: false, angle: angle)
        if let logo {
            var c = ctx
            c.translateBy(x: l.right, y: l.cy)
            c.rotate(by: .degrees(angle))
            var image = c.resolve(logo)
            image.shading = .color(Parts.reelLogoInk)
            let half = l.r * 0.25
            c.draw(image, in: CGRect(x: -half, y: -half, width: half * 2, height: half * 2))
        }
        name(&ctx, l)
    }

    private func reel(_ ctx: inout GraphicsContext, _ l: ReelLayout, x: CGFloat, tape: Double, hub: Bool, angle: Double) {
        let r = l.r, cy = l.cy
        func circle(_ radius: CGFloat) -> Path { Path(ellipseIn: CGRect(x: x - radius, y: cy - radius, width: radius * 2, height: radius * 2)) }
        let minPack = r * 0.42
        let pack = minPack + (r * 0.92 - minPack) * CGFloat(min(max(tape, 0), 1))
        ctx.fill(circle(pack), with: .color(full ? Parts.reelTapeFull : Parts.reelTape))
        // A clear plastic flange: a faint fill and a dark rim, three windows turning with it.
        ctx.fill(circle(r), with: .color(Parts.reelFlange.opacity(40 / 255)))
        ctx.stroke(circle(r), with: .color(Parts.reelRim), lineWidth: 1.6)
        for i in 0..<3 {
            var c = ctx
            c.translateBy(x: x, y: cy)
            c.rotate(by: .degrees(angle + Double(i) * 120))
            let window = Path(roundedRect: CGRect(x: -r * 0.15, y: -r * 0.86, width: r * 0.3, height: r * 0.4), cornerRadius: r * 0.1)
            c.stroke(window, with: .color(Parts.reelRim.opacity(150 / 255)), lineWidth: 1.2)
        }
        // The orange label, a dark hub and three spindle teeth; the right reel's label carries the logo instead.
        ctx.fill(circle(r * 0.36), with: .color(Palette.orange))
        ctx.stroke(circle(r * 0.36), with: .color(Parts.reelLabelRim), lineWidth: 1.4)
        guard hub else { return }
        ctx.fill(circle(r * 0.1), with: .color(Parts.reelHub))
        for i in 0..<3 {
            let a = (angle + Double(i) * 120) * .pi / 180
            var tooth = Path()
            tooth.move(to: CGPoint(x: x, y: cy))
            tooth.addLine(to: CGPoint(x: x + r * 0.09 * CGFloat(sin(a)), y: cy - r * 0.09 * CGFloat(cos(a))))
            ctx.stroke(tooth, with: .color(Palette.whitePrint), lineWidth: 2)
        }
    }

    /// POLYDANCE around the top of the left reel, each letter upright on the arc, centred as the headset's
    /// drawTextOnPath centres it (205 to 335 degrees, 0.32 em apart).
    private func name(_ ctx: inout GraphicsContext, _ l: ReelLayout) {
        let size = l.nameSize
        let arc = l.r * 1.14
        let letters = "POLYDANCE".map { ctx.resolve(Text(String($0)).font(Theme.label(size)).foregroundStyle(Palette.print)) }
        let widths = letters.map { $0.measure(in: CGSize(width: 200, height: 200)).width + size * 0.32 }
        let length = arc * CGFloat(130 * Double.pi / 180)
        var along = (length - widths.reduce(0, +)) / 2
        for (letter, width) in zip(letters, widths) {
            let theta = 205 * Double.pi / 180 + Double((along + width / 2) / arc)
            let at = CGPoint(x: l.left + arc * CGFloat(cos(theta)), y: l.cy + arc * CGFloat(sin(theta)))
            var c = ctx
            c.translateBy(x: at.x, y: at.y)
            c.rotate(by: .radians(theta + .pi / 2))
            c.draw(letter, at: .zero, anchor: .bottom)
            along += width
        }
    }
}

/// Where the reels sit in a plate of a given size: as DeckView lays them out, scaled for a phone.
struct ReelLayout {
    let r: CGFloat
    let left: CGFloat
    let right: CGFloat
    let cy: CGFloat
    let labelY: CGFloat
    let labelSize: CGFloat
    let nameSize: CGFloat

    init(size: CGSize) {
        let top: CGFloat = 30, bottom: CGFloat = 30
        let room = max(size.height - top - bottom, 0)
        r = min(max(room / 2, size.width * 0.12), size.width * 0.19)
        left = size.width * 0.27
        right = size.width * 0.665
        cy = top + room / 2
        labelY = min(cy + r + 15, size.height - 12)
        labelSize = 10
        nameSize = max(9, min(12, r * 0.2))
    }
}

/// The reels' angle and speed between frames: speed eases towards 1 while recording and back to 0, as
/// DeckView.onDraw does, so they spin up over 1.6 s and run down over 1.2 s.
@MainActor final class ReelMotion {
    static let fullDegreesPerMs = 0.15
    static let spinUpMs = 1600.0
    static let runDownMs = 1200.0
    private var angle = 0.0
    private var speed = 0.0
    private var last: Date?

    func advance(to now: Date, spinning: Bool) -> Double {
        let dt = last.map { min(now.timeIntervalSince($0), 0.1) * 1000 } ?? 0
        let target = spinning ? 1.0 : 0
        speed = speed < target ? min(speed + dt / Self.spinUpMs, target) : max(speed - dt / Self.runDownMs, target)
        let eased = speed * speed * (3 - 2 * speed)
        angle = (angle + eased * dt * Self.fullDegreesPerMs).truncatingRemainder(dividingBy: 360)
        last = speed > 0 || target > 0 ? now : nil
        return angle
    }
}

/// The small dark key beside the storage readout: three printed lines (DeckView's storageKey).
struct ListKey: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) { EmptyView() }
            .buttonStyle(ListKeyStyle())
            .accessibilityLabel("Recordings on this phone")
    }

    private struct ListKeyStyle: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            ZStack {
                RoundedRectangle(cornerRadius: 3).fill(configuration.isPressed ? Palette.surface : Palette.panel)
                VStack(spacing: 2.5) { ForEach(0..<3, id: \.self) { _ in Rectangle().fill(Palette.whitePrint).frame(width: 12, height: 1.5) } }
            }
            .frame(width: 24, height: 18)
            .padding(8).contentShape(Rectangle()).padding(-8)
        }
    }
}

/// A key printed on the cream plate: its drawing in the plate's ink, amber while pressed.
struct PlateKey<Icon: View>: View {
    let label: String
    let action: () -> Void
    @ViewBuilder let icon: (Color) -> Icon

    var body: some View {
        Button(action: action) { EmptyView() }
            .buttonStyle(PlateKeyStyle(icon: icon))
            .accessibilityLabel(label)
    }

    private struct PlateKeyStyle: ButtonStyle {
        let icon: (Color) -> Icon
        func makeBody(configuration: Configuration) -> some View {
            icon(configuration.isPressed ? Palette.amber : Palette.print)
                .frame(width: 28, height: 28)
                .frame(width: 38, height: 40)
                .contentShape(Rectangle())
        }
    }
}
