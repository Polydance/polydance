// The main window, "Polydance", opened from the menu's Open Polydance, laid out as the headset's one panel
// (docs/DESIGN-SYSTEM.md): on the wooden cabinet, a black column under two folder tabs, CALLS (every call in
// the library, newest first) and THREADS (the inbox as the headset lists it), with a strip of keys at its
// foot (Settings, the bug key's Report, and New thread), and the selected call's or thread's page on a black
// panel beside it. New thread and the report open as cream plates over the window (Robin's pick D of four
// mockups, 2026-11-16). The column's width is dragged on the wood between them.
import AppKit
import PolydanceCore
import PolydanceShared
import SwiftUI

struct MainWindow: View {
    @Bindable var model: AppModel
    /// The column's width, dragged on the wood between the panels and kept for next time.
    @AppStorage("mainWindow.columnWidth") private var columnWidth = Double(Sidebar.width.ideal)
    /// The title bar's row over the cabinet, read from the window.
    @State private var chrome = WindowChrome()

    var body: some View {
        // The column has a width of its own rather than a split view's: NavigationSplitView opened it at its
        // minimum, too narrow for a thread's title (Robin, 2026-11-07), and ignores its widths off screen.
        HStack(spacing: 0) {
            Sidebar(model: model, chrome: chrome)
                .frame(width: Sidebar.clamp(columnWidth))
            ColumnHandle(width: $columnWidth)
            Group {
                switch model.selection {
                case .call(let id): CallPage(model: model, id: id)
                case .thread(let key): ThreadPage(model: model, key: key)
                case nil: EmptyPage(model: model)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.panel)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
            // The banner's gap only with the banner: an empty inset still kept its 10 points.
            .safeAreaInset(edge: .top, spacing: model.menuBarIconHidden ? 10 : 0) {
                if model.menuBarIconHidden { HiddenIconBanner() }
            }
            .padding([.top, .bottom, .trailing], 10)
        }
        // The cabinet runs to the window's top edge: the page's panel starts 10 points down, as it does at
        // the foot, and the column's header shares the traffic lights' row (WindowChrome). Keeping clear of
        // the title bar instead left a strip of bare wood above everything (Robin, 2026-11-07).
        .ignoresSafeArea(.container, edges: .top)
        // New thread or the report: a cream plate over the dimmed window; a click beside it puts it away.
        .overlay {
            if let plate = model.plate {
                ZStack {
                    Color.black.opacity(0.5).ignoresSafeArea().contentShape(Rectangle()).onTapGesture { model.plate = nil }
                    switch plate {
                    case .newThread: NewThreadPlate(model: model)
                    case .report: ReportPlate(model: model)
                    }
                }
            }
        }
        // One cabinet behind both panels and the traffic lights.
        .background { Wood().ignoresSafeArea() }
        .background(WindowChromeReader(chrome: $chrome))
        .frame(minWidth: 980, minHeight: 640)
        .foregroundStyle(Theme.text)
        .preferredColorScheme(.dark)
        .installsWindowOpeners(model)
        .onAppear {
            DockPresence.windowAppeared()
            model.calls.windowAppeared()
            model.threads.windowAppeared()
            if model.selection == nil, let first = model.calls.calls.first { model.selection = .call(first.id) }
            if case .thread = model.selection { model.windowTab = .threads }
        }
        .onDisappear {
            model.calls.windowDisappeared()
            model.threads.windowDisappeared()
            DockPresence.windowDisappeared()
        }
        .onChange(of: model.calls.calls) { _, calls in
            // The newest call is the page the window opens on.
            if model.selection == nil, let first = calls.first { model.selection = .call(first.id) }
        }
    }
}

struct Sidebar: View {
    @Bindable var model: AppModel
    var chrome = WindowChrome()

    /// Wide enough for a thread's title beside its people and its time: at about 250 pt a title was cut
    /// after a dozen letters ("Aura 2.0 tes…", Robin, 2026-11-07). A longer title takes a second line.
    static let width = (min: CGFloat(320), ideal: CGFloat(390), max: CGFloat(560))

    static func clamp(_ width: Double) -> CGFloat { min(max(CGFloat(width), Self.width.min), Self.width.max) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            // Calls and Threads as folder tabs rising out of the column's panel (Robin's pick D, 2026-11-16).
            HStack(alignment: .bottom, spacing: 4) {
                FolderTab(title: "Calls", count: 0, on: model.windowTab == .calls) { model.windowTab = .calls }
                    .zIndex(model.windowTab == .calls ? 1 : 0)
                FolderTab(title: "Threads", count: model.threads.newCount, on: model.windowTab == .threads) {
                    model.windowTab = .threads
                    model.threads.refreshListIfStale()
                }
                .zIndex(model.windowTab == .threads ? 1 : 0)
                Spacer()
            }
            .padding(.leading, 8).padding(.top, 8)
            .zIndex(1)
            Group {
                switch model.windowTab {
                case .calls: callList
                case .threads: threadList
                }
            }
            .background(Palette.panel)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
            keys.padding(.top, 8)
        }
        .padding(.top, chrome.showsButtons ? 0 : 10)
        .padding([.bottom, .leading], 10)
    }

    /// The logo, the name and Refresh. With the traffic lights showing, the header is their row: centred on
    /// them and starting just past them, its wood a handle for moving the window.
    private var header: some View {
        HStack(spacing: 8) {
            if let mark = Logo.mark {
                Image(nsImage: mark).resizable().interpolation(.high).scaledToFit().frame(width: 22, height: 22).accessibilityHidden(true)
            }
            LabelText("Polydance", size: 13, color: Palette.burnt, tracking: 0.2)
            Spacer()
            Button { model.threads.refreshList() } label: { Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .bold)) }
                .buttonStyle(.plain).foregroundStyle(Palette.burnt).help("Ask the receiver again").accessibilityLabel("Refresh threads")
                .disabled(model.threads.listing)
        }
        .padding(.horizontal, 6)
        // Past the buttons, less the column's own 10 points of padding, with a gap of 12.
        .padding(.leading, chrome.showsButtons ? max(0, chrome.buttonsTrailing + 12 - 10 - 6) : 0)
        .frame(height: chrome.showsButtons ? chrome.buttonsMidY * 2 : nil)
        .padding(.top, chrome.showsButtons ? 0 : 4)
        .background(Color.clear.contentShape(Rectangle()).gesture(WindowDragGesture()))
        .allowsWindowActivationEvents(true)
    }

    /// The strip at the column's foot: Settings, the bug key's Report, and New thread, the one cream key.
    private var keys: some View {
        HStack(spacing: 6) {
            SettingsLink { Image(systemName: "gearshape.fill") }.buttonStyle(KeyStyle()).help("Settings").accessibilityLabel("Settings")
            Button { open(.report) } label: {
                HStack(spacing: 6) {
                    BugIcon(ink: model.plate == .report ? Palette.amber : Palette.cream, hole: Palette.casing).frame(width: 15, height: 15)
                    Text("Report")
                }
            }
            .buttonStyle(KeyStyle(color: model.plate == .report ? Palette.amber : Palette.cream))
            .help("Report a bug or suggest a feature: a recording that goes only to the Polydance team")
            .accessibilityLabel("Report a bug or suggest a feature")
            Spacer()
            Button { open(.newThread) } label: {
                HStack(spacing: 8) {
                    Glyph(.camera, color: Palette.red, size: 16)
                    Text("New thread")
                }
            }
            .buttonStyle(PillStyle(cream: true))
            .help("Open a thread: record a walkthrough of it, or write it")
        }
    }

    private func open(_ plate: WindowPlate) {
        model.threads.recordProblem = nil
        model.threads.refreshProjects()
        if plate == .newThread { model.windowTab = .threads }
        model.plate = plate
    }

    private var callList: some View {
        List {
            if model.calls.calls.isEmpty {
                Text(model.calls.listedOnce ? "No calls recorded yet." : "Reading the library…")
                    .font(Theme.sans(12)).foregroundStyle(Theme.muted)
            }
            ForEach(model.calls.calls) { call in
                Button { model.selection = .call(call.id) } label: { CallRow(call: call).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .listRowBackground(RoundedRectangle(cornerRadius: 3).fill(model.selection == .call(call.id) ? Palette.surface : .clear).padding(.horizontal, 6))
                    .accessibilityAddTraits(model.selection == .call(call.id) ? [.isSelected] : [])
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
    }

    private var threadList: some View {
        List {
            // A new thread or a report being recorded, and those not sent yet: they have no thread page.
            if let live = model.live, let target = live.thread, target.kind != .reply {
                OutboxRecording(model: model, live: live, target: target)
                    .listRowBackground(Color.clear)
            }
            ForEach(model.threads.outbox.filter { $0.entry.status != .recording }) { upload in
                UploadRow(model: model, upload: upload, compact: true)
                    .listRowBackground(Color.clear)
            }
            if let problem = model.threads.listProblem {
                Text(problem).font(Theme.sans(11)).foregroundStyle(Theme.amberText).lineLimit(6).textSelection(.enabled)
            } else if model.threads.threads.isEmpty {
                Text(model.threads.listCheckedAt == nil ? "Asking the receiver…" : "No open threads.")
                    .font(Theme.sans(12)).foregroundStyle(Theme.muted)
            }
            ForEach(model.threads.threads) { thread in
                Button { model.selection = .thread(thread.key) } label: {
                    ThreadRowView(thread: thread, open: model.selection == .thread(thread.key)).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                .listRowBackground(Color.clear)
                .accessibilityAddTraits(model.selection == .thread(thread.key) ? [.isSelected] : [])
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
    }
}

/// The microphone has given only silence since the recording began: said where the recording is shown.
struct MicSilentNote: View {
    let device: String?

    var body: some View {
        Text("Nothing heard from \(device ?? "the microphone") yet. If it is not your microphone, stop, choose yours in System Settings → Sound → Input, and record again.")
            .font(Theme.sans(12)).foregroundStyle(Theme.redText).fixedSize(horizontal: false, vertical: true)
    }
}

/// One of the column's two folder tabs: the chosen one is the panel's own black, joined to it; the other
/// sits behind in the casing's colour. Threads carries the count of threads with something new, in red.
private struct FolderTab: View {
    let title: String
    let count: Int
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                LabelText(title, size: 12, color: on ? Palette.cream : Palette.tan, tracking: 0.14)
                if count > 0 { LabelText(count > 99 ? "99+" : "\(count)", size: 12, color: Palette.red, tracking: 0.1) }
            }
            .padding(.horizontal, 18)
            .frame(height: on ? 32 : 27)
            .background(TopRounded().fill(on ? Palette.panel : Palette.casing))
            .overlay(TopRounded(open: true).stroke(Palette.edge, lineWidth: 1.5))
            .contentShape(TopRounded())
        }
        .buttonStyle(.plain)
        // Over the panel's top edge, so the chosen tab and the panel are one piece.
        .offset(y: on ? 1.5 : 0)
        .accessibilityLabel(count > 0 ? "\(title), \(count) with something new" : title)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }
}

/// A folder tab's outline: rounded at the top, open at the foot where it meets the panel.
private struct TopRounded: Shape {
    var open = false

    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 6
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        p.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        if !open { p.closeSubpath() }
        return p
    }
}

/// A new thread or a report being recorded, at the top of the Threads tab: it has no page to show it on.
private struct OutboxRecording: View {
    let model: AppModel
    let live: AppModel.LiveRecording
    let target: WalkthroughTarget

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(Theme.red).frame(width: 9, height: 9)
                Text("Recording \(target.what) · \(Recorder.clock(live.elapsed))").font(Theme.sans(13, .semibold)).monospacedDigit().lineLimit(2)
            }
            Text(live.stopping ? "Saving…" : "Stop with \(Hotkeys.Shortcut.recordOrStop.label) or here; it is \(target.whenStopped) when it stops.")
                .font(Theme.sans(12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if live.micSilent { MicSilentNote(device: live.micDevice) }
            HStack(spacing: 8) {
                WindowButton("Stop and send") { model.stopAndSave() }.disabled(live.stopping)
                WindowButton("Discard") { model.stopAndDiscard() }.disabled(live.stopping)
            }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.redEdge))
        .padding(.vertical, 4)
    }
}

/// The wood between the column and the page: drag it to widen or narrow the column, or double-click it to
/// put the column back to its usual width.
private struct ColumnHandle: View {
    @Binding var width: Double
    @State private var start: Double?

    var body: some View {
        Color.clear
            .frame(width: 10)
            .contentShape(Rectangle())
            .onHover { inside in if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { drag in
                    let from = start ?? Double(Sidebar.clamp(width))
                    start = from
                    width = Double(Sidebar.clamp(from + drag.translation.width))
                }
                .onEnded { _ in start = nil })
            .onTapGesture(count: 2) { width = Double(Sidebar.width.ideal) }
            .accessibilityElement()
            .accessibilityLabel("Column width")
            .accessibilityValue("\(Int(Sidebar.clamp(width))) points")
            .accessibilityAdjustableAction { direction in
                let step: Double = direction == .increment ? 30 : -30
                width = Double(Sidebar.clamp(Double(Sidebar.clamp(width)) + step))
            }
    }
}

private struct CallRow: View {
    let call: RecentRecording

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(call.title).font(Theme.sans(13)).foregroundStyle(call.short ? Theme.soft : Theme.text).lineLimit(2)
            HStack(spacing: 4) {
                Text(subline).font(Theme.sans(11)).foregroundStyle(Theme.muted).lineLimit(1)
                if call.building { Text("· building").font(Theme.sans(11)).foregroundStyle(Theme.amberText) }
                if call.chip == .routineFailed { Text("· routine failed").font(Theme.sans(11)).foregroundStyle(Theme.redText) }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var subline: String {
        [Clock.day(call.recordedAt) + " " + Clock.time(call.recordedAt), Clock.minutes(call.durationMs), call.short ? "short" : nil]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

/// C5: while macOS hides the menu-bar icon, nothing on screen says a call is recording.
private struct HiddenIconBanner: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "menubar.rectangle").foregroundStyle(Theme.amberText)
            VStack(alignment: .leading, spacing: 3) {
                Text("macOS is hiding Polydance's menu-bar icon").font(Theme.sans(12, .semibold))
                Text("The menu bar is full, so you won't see when a call is recording or be able to stop it from there. "
                     + "Make room: hold ⌘ and drag Apple's icons off the menu bar, or turn other apps' icons off in their settings. "
                     + "Until then, open Polydance again from Spotlight or Finder to come back to this window, and ⌃⌥R stops a recording.")
                    // No fixedSize here: outside a scroll view, text that insists on its full height is asked
                    // for it at the split view's narrowest, a word a line, and the window's content grew to
                    // 3,795 points with everything off screen (MainWindowLayoutTests).
                    .font(Theme.sans(11)).foregroundStyle(Theme.soft)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 4).fill(Palette.panel))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.amber.opacity(0.6), lineWidth: 1.5))
        .accessibilityElement(children: .combine)
    }
}

private struct EmptyPage: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 10) {
            if let mark = Logo.mark { Image(nsImage: mark).resizable().interpolation(.high).scaledToFit().frame(width: 72, height: 72).opacity(0.9) }
            LabelText("Nothing selected", size: 14, color: Palette.cream, tracking: 0.14)
            Text("Calls appear here when Polydance has recorded and built them. Threads come from the hosted receiver.")
                .font(Theme.sans(12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(maxWidth: 380)
        }
    }
}
