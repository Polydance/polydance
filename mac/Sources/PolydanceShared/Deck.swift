// The deck's parts as the headset app draws them (RetroViews.kt, DeckViews.kt, InboxPane.kt;
// docs/DESIGN-SYSTEM.md), in SwiftUI: printed labels, lamps, the red record key, the rolling tape counter,
// the needle meters, tags, keys, pills and avatars. Sizes are the headset's scaled to a desk: its dp
// read across a room, these points read at arm's length. Shared by the Mac and the iPhone (PolydanceShared).
import SwiftUI

/// Printed lettering: condensed bold capitals, spaced out (tracking in ems, as Android's letterSpacing).
public struct LabelText: View {
    let text: String
    var size: CGFloat = 11
    var color: Color = Palette.tan
    var tracking: CGFloat = 0.14

    public init(_ text: String, size: CGFloat = 11, color: Color = Palette.tan, tracking: CGFloat = 0.14) {
        self.text = text
        self.size = size
        self.color = color
        self.tracking = tracking
    }

    public var body: some View {
        Text(text.uppercased()).font(Theme.label(size)).tracking(size * tracking).foregroundStyle(color)
    }
}

extension EnvironmentValues {
    /// The moment the look's moving parts are drawn at (the lamps' pulse, the recording key's glow): the
    /// timeline's own when nil, or a fixed one so pictures of the look are the same every time (LookSnapshots).
    @Entry public var lookTime: Date?
}

/// One of the deck's lights with its name under it: REC and PROCESSING pulse while lit, READY is steady.
public struct Lamp: View {
    let name: String
    let color: Color
    let lit: Bool
    var pulses: Bool
    @Environment(\.lookTime) private var lookTime

    public init(name: String, color: Color, lit: Bool, pulses: Bool = false) {
        self.name = name
        self.color = color
        self.lit = lit
        self.pulses = pulses
    }

    public var body: some View {
        VStack(spacing: 5) {
            TimelineView(.animation(minimumInterval: 1 / 20, paused: !(lit && pulses))) { context in
                let glow = !lit ? 0 : pulses ? 0.5 + 0.5 * abs(sin((lookTime ?? context.date).timeIntervalSinceReferenceDate / 0.6 * .pi)) : 1
                ZStack {
                    if lit { Circle().fill(color.opacity(0.35 * glow)).frame(width: 22, height: 22) }
                    Circle().fill(lit ? color.opacity(0.6 + 0.4 * glow) : Self.off(color)).frame(width: 11, height: 11)
                    Circle().stroke(Parts.lampRing, lineWidth: 1).frame(width: 11, height: 11)
                }
                .frame(width: 22, height: 22)
            }
            LabelText(name, size: 9, color: Palette.whitePrint, tracking: 0.24)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) \(lit ? "on" : "off")")
    }

    /// A lamp that is off is its colour at a quarter of the light, as on the headset.
    private static func off(_ color: Color) -> Color { color.quartered() }
}

/// The red record key: REC when ready, held down and glowing with STOP while recording, amber while
/// starting or stopping, grey when it cannot be pressed. `word` prints another word on it, such as FULL on
/// the iPhone when the receiver's allowance is used up.
public struct RecordKey: View {
    public enum Mode: Equatable, Sendable { case ready, recording, starting, disabled }
    let mode: Mode
    var width: CGFloat
    var height: CGFloat
    var word: String?
    let action: () -> Void

    public init(mode: Mode, width: CGFloat = 112, height: CGFloat = 40, word: String? = nil, action: @escaping () -> Void) {
        self.mode = mode
        self.width = width
        self.height = height
        self.word = word
        self.action = action
    }

    public var body: some View {
        Button(action: action) { EmptyView() }
            .buttonStyle(RecordKeyStyle(mode: mode, width: width, height: height, override: word))
            .disabled(mode == .starting || mode == .disabled)
            .accessibilityLabel(mode == .recording ? "Stop recording" : mode == .ready ? "Record" : mode == .starting ? "Busy" : "Record, unavailable")
    }
}

private struct RecordKeyStyle: ButtonStyle {
    let mode: RecordKey.Mode
    let width: CGFloat
    let height: CGFloat
    let override: String?
    @Environment(\.lookTime) private var lookTime

    func makeBody(configuration: Configuration) -> some View {
        let sunk = mode == .recording || configuration.isPressed
        let faces: [Color] = switch mode {
        case .ready: Parts.recordKeyReady
        case .recording: Parts.recordKeyRecording
        case .starting: Parts.recordKeyStarting
        case .disabled: Parts.recordKeyDisabled
        }
        let printed = switch mode { case .ready: "REC"; case .recording: "STOP"; case .starting: "…"; case .disabled: "REC" }
        let word = override ?? printed
        return ZStack {
            if mode == .recording {
                TimelineView(.animation(minimumInterval: 1 / 24)) { context in
                    let phase = (lookTime ?? context.date).timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2
                    RoundedRectangle(cornerRadius: 10).fill(Palette.red.opacity((60 + 120 * abs(sin(phase * .pi))) / 255))
                        .frame(width: width + 12, height: height + 10)
                }
            }
            if !sunk { RoundedRectangle(cornerRadius: 5).fill(Parts.keyShadow).frame(width: width, height: height).offset(y: 4) }
            ZStack {
                RoundedRectangle(cornerRadius: 5).fill(LinearGradient(colors: faces, startPoint: .top, endPoint: .bottom))
                RoundedRectangle(cornerRadius: 5).stroke(Parts.recordKeyEdge, lineWidth: 1.2)
                Text(word).font(Theme.label(15)).tracking(15 * 0.3)
                    .foregroundStyle(mode == .disabled ? Palette.whitePrint : Parts.recordKeyPrint)
            }
            .frame(width: width, height: height)
            .offset(y: sunk ? 3 : 0)
        }
        .frame(width: width + 12, height: height + 10)
        .contentShape(Rectangle())
    }
}

/// Recording time on a mechanical counter: digit drums that roll to the next number, a colon of two cream
/// dots between minutes and seconds, and an hours drum once the recording passes an hour.
public struct RollingCounter: View {
    let seconds: Int
    var cell: CGFloat
    var height: CGFloat

    public init(seconds: Int, cell: CGFloat = 20, height: CGFloat = 34) {
        self.seconds = seconds
        self.cell = cell
        self.height = height
    }

    public var body: some View {
        let total = max(0, seconds)
        let hours = total / 3600, minutes = (total / 60) % 60, secs = total % 60
        HStack(spacing: 0) {
            if hours > 0 {
                drum(hours % 10)
                colon
            }
            drum(minutes / 10); drum(minutes % 10).padding(.leading, 3)
            colon
            drum(secs / 10); drum(secs % 10).padding(.leading, 3)
        }
        .padding(.horizontal, 6)
        .frame(height: height)
        .background(RoundedRectangle(cornerRadius: 6).fill(Parts.counterWindow))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.edge, lineWidth: 1.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(format: "%d:%02d:%02d", hours, minutes, secs))
    }

    private func drum(_ digit: Int) -> some View {
        Text("\(digit)")
            .font(Theme.counter(height * 0.58))
            .foregroundStyle(Palette.cream)
            .contentTransition(.numericText(countsDown: false))
            .animation(.easeInOut(duration: 0.26), value: digit)
            .frame(width: cell, height: height - 10)
            .background(LinearGradient(colors: Parts.counterDrum, startPoint: .top, endPoint: .bottom))
            .clipped()
    }

    private var colon: some View {
        VStack(spacing: height * 0.22) {
            Circle().fill(Palette.cream).frame(width: 3.5, height: 3.5)
            Circle().fill(Palette.cream).frame(width: 3.5, height: 3.5)
        }
        .frame(width: 11)
    }
}

/// An analog meter (the headset's VuMeter): a lit cream face with a dB scale, a red zone, a needle that
/// follows `level` (0 to 1 across the scale), and a dark housing strip carrying the track's name, or, given a
/// `toggle`, the track's own OFF/ON switch: the headset's bat-handle toggle on a taller strip, which alone takes
/// the press (the rest of the meter is inert), dimmed and locked while `toggleEnabled` is false.
public struct NeedleMeter: View {
    let label: String
    let level: Double
    let active: Bool
    var strip: String?
    var toggle: Binding<Bool>?
    var toggleEnabled: Bool

    public init(label: String, level: Double, active: Bool, strip: String? = nil) {
        self.label = label
        self.level = level
        self.active = active
        self.strip = strip
        toggle = nil
        toggleEnabled = true
    }

    /// The meter with its track's switch on the strip (the headset's MIC and APP meters).
    public init(label: String, level: Double, active: Bool, toggle: Binding<Bool>, toggleEnabled: Bool = true) {
        self.label = label
        self.level = level
        self.active = active
        strip = nil
        self.toggle = toggle
        self.toggleEnabled = toggleEnabled
    }

    private static let ticks: [(db: Double, text: String)] = [(-40, "40"), (-30, "30"), (-20, "20"), (-10, "10"), (-6, "6"), (-3, "3")]
    private static func position(_ db: Double) -> Double { min(max((db + 40) / 37, 0), 1) }

    public var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            // With a switch the strip is taller (the headset's 50 dp), and the face is drawn as for a shorter meter.
            let stripHeight = toggle == nil ? h * 0.28 : max(40, h * 0.4)
            let housingTop = h - stripHeight
            let faceHeight = housingTop / 0.72
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(RadialGradient(colors: active ? Parts.meterFaceLit : Parts.meterFaceDark, center: UnitPoint(x: 0.5, y: 0.9), startRadius: 0, endRadius: w * 0.75))
                Canvas { context, _ in Self.drawScale(&context, width: w, height: faceHeight, label: label) }
                Needle(level: active ? level : 0)
                    .stroke(Parts.meterNeedle, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: w, height: faceHeight)
                    .animation(.easeOut(duration: 0.18), value: level)
                // The housing strip hides where the needle meets its spindle and carries the track's name or switch.
                UnevenRoundedRectangle(bottomLeadingRadius: 8, bottomTrailingRadius: 8)
                    .fill(Parts.meterHousing)
                    .frame(height: stripHeight)
                    .overlay {
                        if let toggle {
                            BatSwitch(on: toggle.wrappedValue, enabled: toggleEnabled)
                                .contentShape(Rectangle())
                                .onTapGesture { if toggleEnabled { toggle.wrappedValue.toggle() } }
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("\(label) track")
                                .accessibilityValue(toggle.wrappedValue ? "on" : "off")
                                .accessibilityAddTraits(.isButton)
                                .accessibilityHint(toggleEnabled ? "Turns the \(label) track \(toggle.wrappedValue ? "off" : "on") for the next recording"
                                                                 : "Chosen before recording; locked while a recording runs")
                        } else {
                            LabelText(strip ?? "", size: 8, color: Palette.whitePrint, tracking: 0.16)
                        }
                    }
                    .offset(y: housingTop)
                RoundedRectangle(cornerRadius: 8).stroke(Palette.edge, lineWidth: 1.5).allowsHitTesting(false)
            }
        }
        .accessibilityElement(children: toggle == nil ? .ignore : .contain)
        .accessibilityLabel("\(label) level")
        .accessibilityValue(active ? "\(Int((level * 100).rounded())) percent" : "off")
    }

    /// The scale, its numbers and the meter's name, for a face `height` tall (its pivot under the strip).
    private static func drawScale(_ context: inout GraphicsContext, width w: CGFloat, height h: CGFloat, label: String) {
        let pivot = CGPoint(x: w / 2, y: h * 0.98)
        let arc = h * 0.72
        func at(_ fraction: Double, _ radius: Double) -> CGPoint {
            let angle = (-48 + 96 * fraction) * .pi / 180
            return CGPoint(x: pivot.x + radius * sin(angle), y: pivot.y - radius * cos(angle))
        }
        var zone = Path()
        zone.addArc(center: pivot, radius: arc, startAngle: .degrees(-138 + 96 * position(-6)), endAngle: .degrees(-42), clockwise: false)
        context.stroke(zone, with: .color(Parts.meterZone), lineWidth: 4)
        var scale = Path()
        scale.addArc(center: pivot, radius: arc, startAngle: .degrees(-138), endAngle: .degrees(-42), clockwise: false)
        context.stroke(scale, with: .color(Parts.meterInk), lineWidth: 1.2)
        for tick in ticks {
            let p = position(tick.db)
            let red = tick.db >= -6
            var line = Path()
            line.move(to: at(p, arc)); line.addLine(to: at(p, arc + 6))
            context.stroke(line, with: .color(red ? Parts.meterTickRed : Parts.meterInk), lineWidth: 1.2)
            context.draw(Text(tick.text).font(Theme.label(8)).foregroundStyle(red ? Parts.meterTickRed : Parts.meterInk), at: at(p, arc + 13))
        }
        context.draw(Text("\(label.uppercased())  dB").font(Theme.label(9)).tracking(1.8).foregroundStyle(Parts.meterInk),
                     at: CGPoint(x: w / 2, y: h * 0.42))
    }

    /// OFF and ON either side of a chrome bushing, with the bat lever thrown towards the setting (VuMeter.drawSwitch).
    private struct BatSwitch: View {
        let on: Bool
        let enabled: Bool

        var body: some View {
            HStack(spacing: 0) {
                LabelText("Off", size: 10, color: on ? Parts.switchOffPrint : Palette.whitePrint, tracking: 0.16)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                Canvas { context, size in Self.draw(&context, size: size, on: on) }
                    .frame(width: 44, height: 36)
                LabelText("On", size: 10, color: on ? Palette.whitePrint : Parts.switchOffPrint, tracking: 0.16)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .opacity(enabled ? 1 : 0.45)
            .animation(.easeOut(duration: 0.12), value: on)
        }

        static func draw(_ context: inout GraphicsContext, size: CGSize, on: Bool) {
            let c = CGPoint(x: size.width / 2, y: size.height / 2 + 2)
            context.fill(Path(ellipseIn: CGRect(x: c.x - 9, y: c.y - 9, width: 18, height: 18)), with: .color(Parts.switchNut[0]))
            context.fill(Path(ellipseIn: CGRect(x: c.x - 5.5, y: c.y - 5.5, width: 11, height: 11)), with: .color(Parts.switchNut[1]))
            let end = CGPoint(x: c.x + (on ? 14 : -14), y: c.y - 3)
            var lever = Path()
            lever.move(to: c)
            lever.addLine(to: end)
            context.stroke(lever, with: .color(Parts.switchLever[0]), style: StrokeStyle(lineWidth: 5, lineCap: .round))
            context.stroke(lever, with: .color(Parts.switchLever[1]), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            context.fill(Path(ellipseIn: CGRect(x: end.x - 3.5, y: end.y - 3.5, width: 7, height: 7)), with: .color(Parts.switchTip))
        }
    }

    /// The needle from its pivot (below the strip) to the scale, at `level` across 96 degrees.
    private struct Needle: Shape {
        var level: Double
        var animatableData: Double { get { level } set { level = newValue } }

        func path(in rect: CGRect) -> Path {
            let pivot = CGPoint(x: rect.width / 2, y: rect.height * 0.98)
            let radius = rect.height * 0.72 * 1.04
            // In steps, which the Simulator's type checker needs; the same arithmetic in the same order.
            let clamped: Double = min(max(level, 0), 1)
            let degrees: Double = -48 + 96 * clamped
            let angle = CGFloat(degrees * .pi / 180)
            var path = Path()
            path.move(to: pivot)
            path.addLine(to: CGPoint(x: pivot.x + radius * sin(angle), y: pivot.y - radius * cos(angle)))
            return path
        }
    }
}

/// A word on a small dark plate: TO TRY, a routine's state, a chip.
public struct Tag: View {
    let text: String
    var color: Color

    public init(text: String, color: Color = Palette.tan) {
        self.text = text
        self.color = color
    }

    public var body: some View {
        LabelText(text, size: 9.5, color: color, tracking: 0.14)
            .lineLimit(1).fixedSize()
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.edge))
    }
}

/// The headset's flat key (Retro.button): its word in capitals in a colour, on the casing, outlined in
/// the same colour; lit with cream while pressed.
public struct KeyStyle: ButtonStyle {
    var color: Color
    var small: Bool
    var fill: Bool
    @Environment(\.isEnabled) private var enabled

    public init(color: Color = Palette.cream, small: Bool = true, fill: Bool = false) {
        self.color = color
        self.small = small
        self.fill = fill
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.label(small ? 11 : 12.5)).tracking((small ? 11 : 12.5) * 0.12)
            .textCase(.uppercase)
            // A key's print is one line, as on the headset: a narrow page squeezes the text beside it instead.
            .lineLimit(1).fixedSize()
            .foregroundStyle(enabled ? color : Palette.hint)
            .padding(.horizontal, small ? 10 : 14).padding(.vertical, small ? 6 : 8)
            .frame(maxWidth: fill ? .infinity : nil)
            .background(RoundedRectangle(cornerRadius: small ? 7 : 9).fill(configuration.isPressed ? Palette.surface : Palette.casing))
            .overlay(RoundedRectangle(cornerRadius: small ? 7 : 9).stroke(enabled ? color : Palette.edge, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: small ? 7 : 9))
    }
}

/// The long keys at the foot of a thread and the list (Reply, Share): a black pill with an edge; `cream`
/// is New thread's, the one cream key on the cabinet.
public struct PillStyle: ButtonStyle {
    var cream: Bool
    @Environment(\.isEnabled) private var enabled

    public init(cream: Bool = false) { self.cream = cream }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.label(12)).tracking(12 * 0.12)
            .textCase(.uppercase)
            .lineLimit(1).fixedSize()
            .foregroundStyle(cream ? Palette.print : enabled ? Palette.cream : Palette.hint)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(Pill().fill(cream ? (configuration.isPressed ? Palette.plateDark : Palette.cream) : (configuration.isPressed ? Palette.surface : Palette.panel)))
            .overlay(Pill().stroke(cream ? Palette.plateEdge : Palette.edge))
            .contentShape(Pill())
    }
}

/// A person as a circle with their initial, in their own colour or the one the headset gives them.
public struct Avatar: View {
    let name: String
    var size: CGFloat
    var initial: String?
    var own: UInt32?

    public init(name: String, size: CGFloat = 22, initial: String? = nil, own: UInt32? = nil) {
        self.name = name
        self.size = size
        self.initial = initial
        self.own = own
    }

    public var body: some View {
        Circle()
            .fill(Self.colour(own: own, key: name))
            .frame(width: size, height: size)
            .overlay(Text(initial ?? RetroLook.initial(name)).font(Theme.label(size * 0.5)).foregroundStyle(.white))
            .accessibilityHidden(true)
    }

    public static func colour(own: UInt32?, key: String) -> Color {
        own.map { Color(hex: $0) } ?? Palette.avatars[RetroLook.avatarIndex(for: key, count: Palette.avatars.count)]
    }
}

/// Who is in a thread, the Gmail way the headset draws it: overlapping circles, each ringed in the panel's
/// colour, the third reading +N when there are more; someone only invited is an outline.
public struct AvatarStack: View {
    let people: [ThreadPerson]
    let total: Int
    var size: CGFloat

    public init(people: [ThreadPerson], total: Int, size: CGFloat = 24) {
        self.people = people
        self.total = total
        self.size = size
    }

    public var body: some View {
        let shown = Array(people.prefix(total > 3 ? 2 : 3))
        HStack(spacing: -size * 0.38) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, person in
                face(person.initial, Avatar.colour(own: person.ownColour, key: person.colourKey), invited: person.invited == true)
            }
            if total > 3 { face("+\(total - 2)", Palette.edge, invited: false) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(people.map(\.name).joined(separator: ", "))
    }

    private func face(_ letter: String, _ colour: Color, invited: Bool) -> some View {
        ZStack {
            Circle().fill(Palette.panel).frame(width: size + 4, height: size + 4)
            if invited { Circle().stroke(colour, lineWidth: 1.5).frame(width: size - 1.5, height: size - 1.5) }
            else { Circle().fill(colour).frame(width: size, height: size) }
            Text(letter).font(Theme.label(size * (letter.count > 1 ? 0.4 : 0.5))).foregroundStyle(invited ? colour : .white)
        }
    }
}

/// A rounded end at each side, drawn as a path (a capsule), for pills and chips.
public struct Pill: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        Path(roundedRect: rect, cornerSize: CGSize(width: rect.height / 2, height: rect.height / 2), style: .circular)
    }
}
