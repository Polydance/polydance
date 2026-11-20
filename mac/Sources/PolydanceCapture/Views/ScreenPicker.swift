// Choosing what a walkthrough records by pointing at it (Robin, 2026-11-16; docs/MAC.md, Choosing the
// screen), as macOS's own screen recording (⇧⌘5) does: after Record, a layer over every display. In Display
// mode the display under the pointer is lit, with an amber edge, and the others dim; in Window mode the
// window under it is lit and everything else dims. A cream card on the display under the pointer says what a
// click records and switches the modes. A click, Return or the card's Record starts it after a 3 s count;
// Esc or Cancel puts it away. The last choice is lit first next time. Calls never come here.
//
// The windows are read once, when the layer opens, from the window list (frontmost first); their titles need
// the screen permission, their frames and apps' names do not. Frames are CoreGraphics' global coordinates
// (top left of the main display, y down); each display's panel draws in its own, which CGDisplayBounds gives.
import AppKit
import PolydanceCore
import PolydanceShared
import SwiftUI

@MainActor
@Observable
final class ScreenPickerState {
    var windowMode = false
    /// What the walkthrough is for, under the card's heading: "New thread in Kitchen Timer".
    var purpose = ""
    /// The display the pointer is on, and what a click would record now.
    var pointerDisplay: UInt32?
    var hovered: ScreenTarget?
    /// The hovered window's frame, in global coordinates.
    var hoveredFrame: CGRect?
    /// Set once chosen, while the count runs.
    var countdown: Int?
    /// The card's frame in global coordinates: the pointer over it does not change what is lit.
    var cardFrame: CGRect?
}

@MainActor
final class ScreenPicker {
    let state = ScreenPickerState()
    private var panels: [NSPanel] = []
    private var displays: [DisplayChoice.Display] = []
    private var names: [UInt32: String] = [:]
    private var windows: [ScreenPick.Window] = []
    private var follow: Timer?
    private var count: Timer?
    private var keys: Any?
    private var done: ((ScreenTarget?) -> Void)?

    var isShowing: Bool { !panels.isEmpty }

    /// Opens the layer; `done` gets what was chosen once the count ends, or nil when it was put away.
    func show(purpose: String, remembered: ScreenTarget?, done: @escaping (ScreenTarget?) -> Void) {
        guard !isShowing else { return }
        self.done = done
        readScreens()
        state.purpose = purpose
        state.windowMode = remembered?.isWindow ?? false
        state.countdown = nil
        state.cardFrame = nil
        for screen in NSScreen.screens {
            guard let id = Self.id(of: screen) else { continue }
            let panel = KeyPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.setFrame(screen.frame, display: false)
            panel.level = .screenSaver
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            panel.contentView = NSHostingView(rootView: PickerLayer(state: state, picker: self, displayID: id, origin: CGDisplayBounds(id).origin))
            panel.orderFrontRegardless()
            panels.append(panel)
        }
        NSApp.activate()
        updatePointer()
        panels.first { $0.frame.contains(NSEvent.mouseLocation) }?.makeKey()
        follow = Timer.scheduledTimer(withTimeInterval: 1 / 30, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.updatePointer() } }
        keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.isShowing else { return event }
            switch event.keyCode {
            case 53: self.cancel(); return nil
            case 36, 76: self.confirm(); return nil
            default: return event
            }
        }
    }

    /// A click, Return or the card's Record: what is lit, after the count.
    func confirm() {
        guard state.countdown == nil, let target = state.hovered else { return }
        state.hovered = target
        state.countdown = 3
        count = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let left = self.state.countdown else { return }
                if left > 1 { self.state.countdown = left - 1 } else { self.finish(target) }
            }
        }
    }

    func cancel() { finish(nil) }

    func setWindowMode(_ on: Bool) {
        guard state.countdown == nil else { return }
        state.windowMode = on
        updatePointer(force: true)
    }

    private func finish(_ target: ScreenTarget?) {
        follow?.invalidate(); follow = nil
        count?.invalidate(); count = nil
        if let keys { NSEvent.removeMonitor(keys) }
        keys = nil
        panels.forEach { $0.orderOut(nil) }
        panels = []
        let done = self.done
        self.done = nil
        done?(target)
    }

    /// The pointer in global coordinates, and what is under it, unless it is on the card or the count runs.
    private func updatePointer(force: Bool = false) {
        guard state.countdown == nil else { return }
        let primary = NSScreen.screens.first?.frame.maxY ?? 0
        let location = NSEvent.mouseLocation
        let point = CGPoint(x: location.x, y: primary - location.y)
        if !force, let card = state.cardFrame, card.contains(point) { return }
        let display = ScreenPick.display(at: point, in: displays)?.id
        if state.pointerDisplay != display { state.pointerDisplay = display }
        let target = ScreenPick.target(at: point, windowMode: state.windowMode, displays: displays, names: names, windows: windows, ownPID: getpid())
        if state.hovered != target {
            state.hovered = target
            if case .window(let id, _, _)? = target { state.hoveredFrame = windows.first { $0.id == id }?.frame } else { state.hoveredFrame = nil }
        }
    }

    private func readScreens() {
        displays = []
        names = [:]
        for screen in NSScreen.screens {
            guard let id = Self.id(of: screen) else { continue }
            displays.append(DisplayChoice.Display(id: id, frame: CGDisplayBounds(id)))
            names[id] = screen.localizedName.isEmpty ? "Display" : screen.localizedName
        }
        windows = ScreenSource.windowList()
    }

    static func id(of screen: NSScreen) -> UInt32? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    /// A borderless panel that takes the keyboard, for Esc and Return.
    private final class KeyPanel: NSPanel {
        override var canBecomeKey: Bool { true }
    }
}

/// One display's part of the layer.
private struct PickerLayer: View {
    let state: ScreenPickerState
    let picker: ScreenPicker
    let displayID: UInt32
    /// This display's top left in global coordinates.
    let origin: CGPoint

    var body: some View {
        GeometryReader { geo in
            ZStack {
                shade(geo.size)
                    .contentShape(Rectangle())
                    .onTapGesture { picker.confirm() }
                if showsCard {
                    PickerCard(state: state, picker: picker)
                        .background(GeometryReader { card in
                            Color.clear.onAppear { report(card.frame(in: .named("layer"))) }
                                .onChange(of: card.frame(in: .named("layer"))) { _, frame in report(frame) }
                        })
                        .position(x: geo.size.width / 2, y: geo.size.height * 0.72)
                }
            }
            .coordinateSpace(name: "layer")
        }
        .ignoresSafeArea()
    }

    private var showsCard: Bool {
        if state.countdown != nil, case .display(let id, _)? = state.hovered { return id == displayID }
        return state.pointerDisplay == displayID
    }

    private func report(_ local: CGRect) {
        state.cardFrame = local.offsetBy(dx: origin.x, dy: origin.y)
    }

    @ViewBuilder private func shade(_ size: CGSize) -> some View {
        if state.windowMode {
            let lit = state.hoveredFrame.map { $0.offsetBy(dx: -origin.x, dy: -origin.y) }
            Canvas { ctx, canvas in
                ctx.fill(Path(CGRect(origin: .zero, size: canvas)), with: .color(.black.opacity(0.45)))
                guard let lit else { return }
                let shape = Path(roundedRect: lit, cornerRadius: 10)
                ctx.blendMode = .clear
                ctx.fill(shape, with: .color(.black))
                ctx.blendMode = .normal
                ctx.stroke(shape, with: .color(Palette.amber), lineWidth: 5)
            }
        } else if case .display(let id, _)? = state.hovered, id == displayID {
            ZStack {
                Palette.amber.opacity(0.1)
                Rectangle().strokeBorder(Palette.amber, lineWidth: 6)
            }
        } else {
            Color.black.opacity(0.45)
        }
    }
}

/// What a click records, on the cream plate: Display | Window, the name, the count, Cancel and Record.
struct PickerCard: View {
    let state: ScreenPickerState
    let picker: ScreenPicker

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 0) {
                segment("Display", on: !state.windowMode) { picker.setWindowMode(false) }
                Rectangle().fill(Palette.plateEdge).frame(width: 1)
                segment("Window", on: state.windowMode) { picker.setWindowMode(true) }
            }
            .fixedSize()
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.plateEdge))
            .disabled(state.countdown != nil)
            if let left = state.countdown {
                LabelText("Recording in \(left)", size: 15, color: Parts.tapeFullPrint, tracking: 0.14)
            } else {
                LabelText(state.windowMode ? "Record this window" : "Record this display", size: 13, color: Palette.print, tracking: 0.14)
            }
            Text(state.hovered?.label ?? (state.windowMode ? "Point at the window to record" : "Point at the display to record"))
                .font(Theme.sans(14, .medium)).foregroundStyle(Palette.print).lineLimit(2)
            if !state.purpose.isEmpty { Text("For \(state.purpose).").font(Theme.sans(12)).foregroundStyle(Palette.print.opacity(0.75)) }
            Text(state.windowMode ? "Only this window is recorded. Click it, or press Return, to start after 3 s. Esc cancels."
                 : "Click it, or press Return, to start after 3 s. Esc cancels.")
                .font(Theme.sans(12)).foregroundStyle(Palette.print.opacity(0.75)).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Cancel") { picker.cancel() }.buttonStyle(KeyStyle(color: Palette.tan))
                FilledButton("Record", fill: Theme.red) { picker.confirm() }
                    .frame(width: 120)
                    .disabled(state.hovered == nil || state.countdown != nil)
            }
        }
        .padding(18)
        .frame(width: 300)
        .background(CreamPlateBackground(screws: false))
        .shadow(color: .black.opacity(0.4), radius: 14, y: 6)
        // Clicks on the card's own ground choose nothing.
        .contentShape(Rectangle())
        .onTapGesture {}
    }

    private func segment(_ text: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            LabelText(text, size: 11, color: on ? Palette.casing : Palette.print, tracking: 0.1)
                .padding(.horizontal, 14).padding(.vertical, 6)
                .background(on ? Palette.amber : Palette.plateLight)
        }
        .buttonStyle(.plain)
    }
}

/// While a walkthrough records: a thin red frame round what is recorded, with a REC tab and its clock. It is
/// this app's window, which the display's capture leaves out and a window's capture never holds, so it is
/// never in the video. A recorded window is followed as it moves.
@MainActor
final class RecordingFrame {
    private var panel: NSPanel?
    private var follow: Timer?

    func show(_ target: ScreenTarget, startedAt: Date) {
        hide()
        guard let frame = Self.frame(of: target) else { return }
        let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.setFrame(frame, display: false)
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        let menuBar = target.isWindow ? 0 : Self.menuBarHeight(for: target)
        panel.contentView = NSHostingView(rootView: FrameView(startedAt: startedAt, tabTop: menuBar))
        panel.orderFrontRegardless()
        self.panel = panel
        if target.isWindow {
            follow = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let panel = self.panel else { return }
                    if let next = Self.frame(of: target) { if next != panel.frame { panel.setFrame(next, display: true) } } else { panel.orderOut(nil) }
                }
            }
        }
    }

    func hide() {
        follow?.invalidate()
        follow = nil
        panel?.orderOut(nil)
        panel = nil
    }

    /// In AppKit's coordinates (bottom left of the main display, y up).
    private static func frame(of target: ScreenTarget) -> CGRect? {
        switch target {
        case .display(let id, _):
            return NSScreen.screens.first { ScreenPicker.id(of: $0) == id }?.frame
        case .window(let id, _, _):
            guard let cg = ScreenSource.windowFrame(id) else { return nil }
            let primary = NSScreen.screens.first?.frame.maxY ?? 0
            return CGRect(x: cg.minX, y: primary - cg.maxY, width: cg.width, height: cg.height).insetBy(dx: -4, dy: -4)
        }
    }

    private static func menuBarHeight(for target: ScreenTarget) -> CGFloat {
        guard case .display(let id, _) = target, let screen = NSScreen.screens.first(where: { ScreenPicker.id(of: $0) == id }) else { return 0 }
        return max(0, screen.frame.maxY - screen.visibleFrame.maxY)
    }

    private struct FrameView: View {
        let startedAt: Date
        let tabTop: CGFloat

        var body: some View {
            ZStack(alignment: .top) {
                RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.red, lineWidth: 4)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    LabelText("● REC \(Recorder.clock(context.date.timeIntervalSince(startedAt)))", size: 11, color: Parts.recordKeyPrint, tracking: 0.12)
                        .monospacedDigit()
                        .padding(.horizontal, 10).padding(.vertical, 3)
                        .background(UnevenRoundedRectangle(bottomLeadingRadius: 6, bottomTrailingRadius: 6).fill(Palette.red))
                }
                .padding(.top, tabTop)
            }
            .ignoresSafeArea()
        }
    }
}
