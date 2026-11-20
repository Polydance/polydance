// The one panel (the Quest's since 2026-10-20, app/PLATFORMS.md "One panel"): the deck on the left, 420 points (the
// settings take its place behind the gear), and the inbox's two columns beside it: the threads, full width until
// something opens, then 400 points beside the open thread, Recordings or the New thread draft. Below 820 points of
// inbox the open item takes the list's place, as on the headset. All of it on the wooden cabinet, with the drawer
// and the pop-ups (the bug key's report, Cancel's question) over it.
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct PanelScreen: View {
    @ObservedObject var model: HeadsetModel

    var body: some View {
        Group {
            if model.parts == nil {
                setupFailed
            } else {
                HStack(alignment: .top, spacing: 14) {
                    Group {
                        if model.settingsShown { SettingsPage(model: model) } else { DeckColumn(model: model) }
                    }
                    .frame(width: 420)
                    .frame(maxHeight: .infinity)
                    GeometryReader { geo in
                        InboxColumns(model: model, width: geo.size.width)
                    }
                }
                .padding(18)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Wood())
        .clipShape(RoundedRectangle(cornerRadius: 28))
        .environment(\.colorScheme, .dark)
        .tint(Palette.amber)
        .overlay {
            if model.drawerOpen { InboxDrawer(model: model) }
        }
        .animation(.easeOut(duration: 0.2), value: model.drawerOpen)
        .overlay { dialogs }
    }

    @ViewBuilder private var dialogs: some View {
        if model.reportAsked {
            PlateDialog(
                title: "Report a bug or suggest a feature",
                text: "Use this for Polydance itself: something broken, confusing or slow, or a feature you would like. Feedback on an app "
                    + "you are testing belongs in its thread.\n\n"
                    + "Start recording, then show us what happened and say what you expected. Press STOP when you are done; Cancel "
                    + "under it throws the recording away.\n\n"
                    + "A report goes only to the Polydance team, never to your inbox, and is deleted from this headset once it is sent."
                    + (model.paired ? "" : "\n\nThis headset is not paired yet, so the report stays on it and goes once it is paired.")
                    + (model.reportRefused ? "\n\nThis receiver takes no reports (it has no reports project)." : ""),
                keys: [.init(title: "Cancel", color: Palette.tan, action: { model.reportAsked = false })]
                    + (model.reportRefused ? [] : [.init(title: "Start recording", color: Palette.red, action: model.startReport)]),
                dismiss: { model.reportAsked = false })
            .frame(maxWidth: 640)
        } else if model.cancelAsked {
            PlateDialog(title: "Discard this recording?",
                        text: "It stops now and nothing of it is kept or sent.",
                        keys: [.init(title: "Keep recording", action: { model.cancelAsked = false }),
                               .init(title: "Discard", color: Palette.red, action: model.cancelTake)],
                        dismiss: { model.cancelAsked = false })
            .frame(maxWidth: 560)
        }
    }

    private var setupFailed: some View {
        VStack(alignment: .leading, spacing: 12) {
            LabelText("Polydance could not set up its files", size: 15, color: Palette.whitePrint)
            Text(model.setupError ?? "No reason was given.").font(Theme.sans(17)).foregroundStyle(Palette.cream)
            Text("Nothing records or uploads until this is fixed.").font(Theme.sans(16)).foregroundStyle(Palette.tan)
        }
        .plate(padding: 24)
        .frame(maxWidth: 640)
        .padding(40)
    }
}

/// The inbox's two columns.
struct InboxColumns: View {
    @ObservedObject var model: HeadsetModel
    let width: CGFloat

    var body: some View {
        let wide = width >= 820
        HStack(alignment: .top, spacing: 12) {
            if model.detail == nil || wide {
                ThreadList(model: model)
                    .frame(width: model.detail == nil ? nil : 400)
                    .frame(maxWidth: model.detail == nil ? .infinity : 400)
            }
            if let detail = model.detail {
                Group {
                    switch detail {
                    case .thread(let key): ThreadPage(model: model, key: key)
                    case .recordings: RecordingsPage(model: model)
                    case .newThread: NewThreadDraft(model: model)
                    case .agents: AgentsPage(model: model)
                    }
                }
                .frame(maxWidth: 960)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

/// The threads: the search bar with the drawer, the line saying what shows, a flash with Undo, takes still on the
/// headset, the rows, and New thread with its red camera.
struct ThreadList: View {
    @ObservedObject var model: HeadsetModel

    var body: some View {
        VStack(spacing: 0) {
            searchBar
            HStack(spacing: 8) {
                LabelText(model.sectionLine, size: 12, color: Palette.burnt, tracking: 0.16).lineLimit(1)
                Spacer(minLength: 4)
                if model.box == .archived {
                    Button("Inbox") { model.box = .inbox }.buttonStyle(KeyStyle())
                } else if !model.projects.isEmpty {
                    Button("Show all") { model.projects = [] }.buttonStyle(KeyStyle())
                }
            }
            .padding(.horizontal, 8).padding(.top, 10).padding(.bottom, 6)
            if let problem = model.inboxProblem {
                Text("The receiver could not be read: \(problem)").font(Theme.sans(15)).foregroundStyle(Palette.red)
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8).padding(.bottom, 6)
            }
            if let flash = model.flash {
                HStack(spacing: 8) {
                    Text(flash.text).font(Theme.sans(15)).foregroundStyle(Palette.burnt).lineLimit(2)
                    Spacer(minLength: 4)
                    if let undo = flash.undo { Button("Undo") { model.undo(undo) }.buttonStyle(KeyStyle()) }
                }
                .padding(.horizontal, 8).padding(.bottom, 6)
            }
            if model.waitingTakes > 0 {
                HStack {
                    Text(model.waitingTakes == 1 ? "1 recording on this headset hasn't gone up." : "\(model.waitingTakes) recordings on this headset haven't gone up.")
                        .font(Theme.sans(15)).foregroundStyle(Palette.burnt)
                    Spacer()
                    Button("Recordings ›") { model.detail = .recordings }.buttonStyle(KeyStyle())
                }
                .padding(.horizontal, 8).padding(.bottom, 6)
            }
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        // Until an agent is connected, a card at the top of the inbox offers it (Robin's pick D, 2026-11-20).
                        if model.offersAgent { AgentOffer(model: model).padding(.horizontal, 10).padding(.top, 4).padding(.bottom, 10) }
                        let rows = model.visibleThreads
                        if rows.isEmpty {
                            Text(model.emptyLine).font(Theme.sans(16)).foregroundStyle(Palette.tan)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(18)
                        }
                        ForEach(rows) { thread in
                            Button { model.open(thread.key) } label: {
                                ThreadRowView(thread: thread)
                                    .background(model.detail == .thread(thread.key) ? Palette.surface : Color.clear)
                            }
                            .buttonStyle(.plain)
                            .hoverEffect(.highlight)
                            if thread.key != rows.last?.key { Rectangle().fill(Theme.rule).frame(height: 1).padding(.leading, 52) }
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.bottom, 72)
                }
                .refreshable { await model.refresh() }
                NewThreadKey(action: model.newThread).padding(14)
            }
            .background(RoundedRectangle(cornerRadius: 3).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Palette.edge, lineWidth: 2))
            .clipShape(RoundedRectangle(cornerRadius: 3))
        }
    }

    private var searchBar: some View {
        HStack(spacing: 0) {
            IconKey(.menu, label: "Menu: inbox, archived, projects and recordings") { model.drawerOpen = true }
            TextField("", text: $model.query, prompt: Text("Search threads").foregroundStyle(Palette.tan))
                .font(Theme.sans(18)).foregroundStyle(Palette.cream)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search)
            if !model.query.isEmpty {
                IconKey(.close, color: Palette.tan, label: "Clear the search") { model.query = "" }
            } else {
                Glyph(.search, color: Palette.tan, size: 22).frame(width: 44, height: 44)
            }
            if let who = model.who {
                Avatar(name: who, size: 30).padding(.trailing, 8).accessibilityLabel("Signed in as \(who)")
            }
        }
        .padding(.horizontal, 4)
        .background(Capsule().fill(Palette.panel))
        .overlay(Capsule().stroke(Palette.edge, lineWidth: 1.5))
    }
}

/// New thread, where Gmail has Compose: the one cream key on the cabinet, with the red camera.
struct NewThreadKey: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Glyph(.camera, color: Palette.red, size: 26)
                LabelText("New thread", size: 15, color: Palette.print, tracking: 0.06)
            }
            .padding(.leading, 18).padding(.trailing, 22).padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 18).fill(Palette.plateLight))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Palette.plateEdge, lineWidth: 1.5))
            .shadow(color: Parts.keyShadow.opacity(0.6), radius: 6, y: 3)
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
        .hoverEffect(.lift)
        .accessibilityLabel("New thread: record to start one")
    }
}

/// The New thread draft (InboxPane's): which project, then Record the first message; the receiver names the thread
/// from what is said.
struct NewThreadDraft: View {
    @ObservedObject var model: HeadsetModel
    /// The IN selector's list is down (Robin's pick of four mockups, 2026-11-13: one selector, a list ending in New project).
    @State private var listing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                IconKey(.close, color: Palette.tan, label: "Discard the draft") { model.detail = nil }
                LabelText("New thread", size: 15, color: Palette.whitePrint, tracking: 0.16)
                Spacer()
            }
            if !model.paired {
                Text("A new thread starts with a recording sent to the receiver, so this headset needs pairing first (the gear says how). "
                     + "Until then, REC on the deck records a take that stays on this headset.")
                    .font(Theme.sans(16)).foregroundStyle(Palette.cream).fixedSize(horizontal: false, vertical: true)
            } else if model.projectNames.isEmpty {
                Text("The receiver lists no project for this headset's token, so there is nowhere to open a thread.")
                    .font(Theme.sans(16)).foregroundStyle(Palette.cream).fixedSize(horizontal: false, vertical: true)
            } else {
                LabelText("In", size: 12, color: Palette.tan, tracking: 0.16)
                let chosen = model.newThreadProject ?? model.currentProject
                Button { listing.toggle() } label: {
                    LabelText("\(chosen.map(model.projectName) ?? "Choose")  \(listing ? "▴" : "▾")", size: 13, color: Palette.casing, tracking: 0.06)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Palette.amber))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Project: \(chosen.map(model.projectName) ?? "none chosen"). \(listing ? "Close the list" : "Choose another")")
                if listing {
                    ProjectList(projects: model.projectRefs, chosen: chosen, canMake: model.newProjects,
                                choose: { model.newThreadProject = $0; listing = false },
                                make: { name in
                                    let refused = await model.makeProject(name)
                                    if refused == nil { listing = false }
                                    return refused
                                })
                        .frame(maxWidth: 420)
                }
                Text("Record what it is about: the receiver names the thread from what you say.")
                    .font(Theme.sans(16)).foregroundStyle(Palette.cream).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Button { model.recordNewThread() } label: {
                        HStack(spacing: 8) {
                            Glyph(.camera, color: Palette.red, size: 22)
                            Text("Record the first message").font(Theme.label(15)).textCase(.uppercase)
                        }
                    }
                    .buttonStyle(KeyStyle(small: false, fill: true))
                    .disabled(model.isRecording || model.isBusy)
                    Button("Discard") { model.detail = nil }.buttonStyle(KeyStyle(color: Palette.tan, small: false))
                }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .plate(padding: 20)
    }
}

/// Chips that wrap onto as many lines as they need.
struct FlowRow<Item: Hashable, Content: View>: View {
    let items: [Item]
    let content: (Item) -> Content
    init(_ items: [Item], @ViewBuilder content: @escaping (Item) -> Content) {
        self.items = items
        self.content = content
    }

    var body: some View {
        FlowLayout(spacing: 8) { ForEach(items, id: \.self) { content($0) } }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 600
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += line + spacing; line = 0 }
            x += size.width + spacing
            line = max(line, size.height)
        }
        return CGSize(width: width, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// The drawer behind the three lines: Inbox with its unread count, Archived, the projects to show, Recordings.
struct InboxDrawer: View {
    @ObservedObject var model: HeadsetModel

    var body: some View {
        ZStack(alignment: .leading) {
            Color.black.opacity(0.5).onTapGesture { model.drawerOpen = false }
                .accessibilityAddTraits(.isButton).accessibilityLabel("Close the menu")
            VStack(alignment: .leading, spacing: 2) {
                LabelText("Polydance", size: 19, color: Palette.whitePrint, tracking: 0.3).padding(.leading, 14).padding(.bottom, 14)
                entry("Inbox", on: model.box == .inbox, count: model.unread) { model.box = .inbox; model.drawerOpen = false }
                entry("Archived", on: model.box == .archived) { model.box = .archived; model.drawerOpen = false }
                if model.agentsOn { entry("Agents", on: model.detail == .agents) { model.openAgents(withCode: false) } }
                if model.projectNames.count > 1 {
                    heading("Projects")
                    entry("All projects", on: model.projects.isEmpty, tick: true) { model.projects = [] }
                    ForEach(model.projectNames, id: \.key) { project in
                        entry(project.name, on: model.projects.contains(project.key), tick: true) {
                            if model.projects.contains(project.key) { model.projects.remove(project.key) } else { model.projects.insert(project.key) }
                        }
                    }
                }
                heading("This headset")
                entry("Recordings", on: false) { model.drawerOpen = false; model.detail = .recordings }
                Spacer()
            }
            .padding(.vertical, 24).padding(.horizontal, 12)
            .frame(width: 320)
            .frame(maxHeight: .infinity)
            .background(Palette.panel)
            .overlay(alignment: .trailing) { Rectangle().fill(Palette.edge).frame(width: 2) }
            .transition(.move(edge: .leading))
        }
        .clipShape(RoundedRectangle(cornerRadius: 28))
    }

    private func heading(_ text: String) -> some View {
        LabelText(text, size: 12, color: Palette.tan, tracking: 0.16).padding(.leading, 14).padding(.top, 18).padding(.bottom, 6)
    }

    private func entry(_ name: String, on: Bool, count: Int = 0, tick: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if tick { Text(on ? "✓" : " ").font(Theme.label(16)).foregroundStyle(Palette.amber).frame(width: 16) }
                Text(name).font(on && !tick ? Theme.label(18) : Theme.sans(18)).foregroundStyle(on && !tick ? Palette.whitePrint : Palette.cream)
                Spacer()
                if count > 0 { LabelText(count > 99 ? "99+" : "\(count)", size: 15, color: Palette.red, tracking: 0.1) }
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 24).fill(on && !tick ? Palette.surface : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
