// The settings window (board 7), SwiftUI's Settings scene: Calls, Walkthroughs (the Mic and Mac sound
// switches a launch's Settings key also shows), Screen, Transcription, When a call is
// ready (the library, the routine's hooks from `polycap hooks list --json`, hooks.json), Open at login,
// and where node and polycap are; beside them, the Permissions panel and the threads receiver. Every
// value goes through SettingsStore's checks. Nothing here asks macOS for a grant unless Request is
// pressed, and hooks.json is created only after the user says yes to the documented example. Both columns
// are black panels set into the wooden cabinet, as the headset lays out its columns (docs/DESIGN-SYSTEM.md).
import AppKit
import PolydanceCore
import PolydanceShared
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    CallsSection(model: model)
                    WalkthroughsSection(model: model)
                    ScreenSection(model: model)
                    TranscriptionSection(model: model)
                    ReadySection(model: model)
                    LoginSection(model: model)
                    PolycapSection(model: model)
                }
                .padding(.horizontal, 28).padding(.vertical, 22)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Palette.panel)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    PermissionsPanel(model: model)
                    ReceiverPanel(model: model)
                }
                .padding(.horizontal, 24).padding(.vertical, 22)
            }
            .frame(width: 390)
            .background(Palette.panel)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
            .padding(.leading, 10)
        }
        .padding(10)
        .frame(width: 1000, height: 720)
        .background(Wood())
        .tint(Palette.amber)
        .foregroundStyle(Theme.text)
        .preferredColorScheme(.dark)
        .installsWindowOpeners(model)
        .onAppear {
            DockPresence.windowAppeared()
            model.permissions.refresh()
            model.calls.loadHooks()
            model.calls.refresh()
            model.threads.refreshListIfStale()
        }
        .onDisappear { DockPresence.windowDisappeared() }
        // A grant changed in System Settings shows when the user comes back.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in model.permissions.refresh() }
    }
}

// MARK: Rows

private struct SettingToggle: View {
    let title: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) { Text(title).font(Theme.sans(14)) }
            .toggleStyle(.switch).controlSize(.small)
    }
}

/// A radio choice drawn as the board draws it, so one option can be shown and not offered.
private struct RadioRow: View {
    let title: String
    var detail: String?
    let selected: Bool
    var enabled = true
    var tag: String?
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Theme.blueText : Theme.muted).font(.system(size: 13)).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(title).font(Theme.sans(14)).foregroundStyle(enabled ? Theme.text : Theme.muted)
                        if let tag { LaterTag(text: tag) }
                    }
                    if let detail { Text(detail).font(Theme.sans(12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct PathLine: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(Theme.sans(13)).foregroundStyle(Theme.soft).frame(width: 64, alignment: .leading)
            Text(value).font(Theme.mono(12)).foregroundStyle(Theme.soft).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
        }
    }
}

// MARK: Calls

private struct CallsSection: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Calls")
            SettingToggle(title: "Record every Google Meet call in Arc", isOn: $model.autoRecordMeet)
            SettingToggle(title: "Show a notification when a recording starts", isOn: $model.notifyOnStart)
            SettingToggle(title: "Tell me when Arc is using the microphone and no Meet call is found", isOn: $model.warnWithoutCall)
            NoteText("Starts when Arc uses the microphone and a tab is in a Meet call. Stops when you leave the call or the microphone has been off for 20 s. The notification offers Stop and Discard, and reminds you to tell the others.")
        }
    }
}

// MARK: Walkthroughs

/// The headset keeps Mic and App sound in its deck's settings as well as under a launch; so does the Mac.
private struct WalkthroughsSection: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Walkthroughs")
            SettingToggle(title: "Record the microphone", isOn: $model.walkthroughMic)
            SettingToggle(title: "Record the Mac's sound", isOn: $model.walkthroughMacSound)
            NoteText("For Record and open, Record a reply and \(Hotkeys.Shortcut.recordOrStop.label) with no call; a launch's Settings key shows the same two switches. A call always records the mic and Arc's sound.")
        }
        .disabled(model.live != nil)
    }
}

// MARK: Screen

private struct ScreenSection: View {
    @Bindable var model: AppModel
    @State private var addProblem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Screen")
            RadioRow(title: "The whole display the call is on", selected: true) {}
            RadioRow(title: "Only the window with the call", selected: false, enabled: false, tag: "Later") {}
            Text("Never record these apps").font(Theme.sans(13)).foregroundStyle(Theme.soft).padding(.top, 4)
            FlowLayout(spacing: 6) {
                ForEach(model.excludedApps, id: \.self) { id in
                    Button { model.excludedApps.removeAll { $0 == id } } label: {
                        HStack(spacing: 4) {
                            Text(AppNames.name(id)).font(Theme.sans(12))
                            Image(systemName: "xmark").font(.system(size: 9)).foregroundStyle(Theme.muted)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .overlay(Capsule().stroke(Theme.raised))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help("\(id): click to record it again")
                    .accessibilityLabel("Stop leaving out \(AppNames.name(id))")
                }
                Button { addApps() } label: {
                    Text("+ Add app").font(Theme.sans(12)).foregroundStyle(Theme.soft)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .overlay(Capsule().stroke(Theme.greyEdge, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            if let addProblem { NoteText(addProblem, tint: Theme.amberText) }
            HStack {
                Text("Frames per second").font(Theme.sans(14))
                Spacer()
                Picker("Frames per second", selection: $model.fps) {
                    ForEach(fpsChoices, id: \.self) { fps in
                        Text(fps == SettingsStore.defaultFPS ? "\(fps) (target: under 1 GB an hour)" : "\(fps)").tag(fps)
                    }
                }
                .labelsHidden().frame(width: 240)
            }
            NoteText("Changes here apply from the next recording. Polydance's own windows are always left out.")
        }
    }

    private var fpsChoices: [Int] { Array(Set([2, 5, 10, 15, model.fps])).sorted() }

    /// Chooses apps in /Applications and leaves each out by its bundle id.
    private func addApps() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.prompt = "Leave out"
        panel.message = "Choose the apps to leave out of every recording's screen."
        NSApp.activate()
        guard panel.runModal() == .OK else { return }
        var problems: [String] = []
        for url in panel.urls {
            guard let id = Bundle(url: url)?.bundleIdentifier, BundleIDRule.isValid(id) else {
                problems.append("\(url.lastPathComponent) has no bundle id this app can use")
                continue
            }
            if !model.excludedApps.contains(id) { model.excludedApps.append(id) }
        }
        addProblem = problems.isEmpty ? nil : problems.joined(separator: "; ")
    }
}

/// Lays chips out in rows, wrapping at the edge.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (items: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width, !current.items.isEmpty {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.items + [index], needed, max(current.height, size.height))
            }
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}

// MARK: Transcription

private struct TranscriptionSection: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Transcription")
            RadioRow(title: "On this Mac, with whisper large-v3-turbo",
                     detail: "Nothing leaves the Mac. Me and Others, not each other speaker. About 15–20 min for an hour's call.",
                     selected: model.transcriber == .whisperCpp) { model.transcriber = .whisperCpp }
            RadioRow(title: "Gladia",
                     detail: "Everyone's voice on the call is sent to Gladia, and deleted there after. It does not tell the other speakers apart yet (diarisation is not built). Needs GLADIA_API_KEY in ~/.config/polycap/env.",
                     selected: model.transcriber == .gladia) { model.transcriber = .gladia }
            NoteText("Given to polycap as POLYCAP_TRANSCRIBER for the next call it processes.")
        }
    }
}

// MARK: When a call is ready

private struct ReadySection: View {
    @Bindable var model: AppModel
    @State private var confirmCreate = false
    @State private var fileProblem: String?

    private var hooksFile: URL {
        model.calls.hooks.map { URL(fileURLWithPath: $0.file) } ?? model.hooksFile
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("When a call is ready")
            HStack {
                Text("Library").font(Theme.sans(14))
                Text(Clock.path(model.layout.root.path)).font(Theme.mono(12)).foregroundStyle(Theme.soft).lineLimit(1).truncationMode(.middle)
                Spacer()
                WindowButton("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([model.layout.root]) }
                    .disabled(!FileManager.default.fileExists(atPath: model.layout.root.path))
            }
            hooks
            HStack {
                Text(Clock.path(hooksFile.path)).font(Theme.mono(11)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                Spacer()
                WindowButton("Edit hooks.json") { editHooks() }
            }
            if let fileProblem { NoteText(fileProblem, tint: Theme.redText) }
        }
        .alert("Create hooks.json?", isPresented: $confirmCreate) {
            Button("Create and open") { createHooks() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(Clock.path(hooksFile.path)) does not exist. Polydance can write the example from docs/MAC.md: after every call of 2 minutes or more, polycap runs Claude Code headless in ~/Code/calls with your process-call skill, allowed only to read the bundle (polycap show, transcript and frames), write notes/ and git add, commit and push. Add your Slack draft tool by its /mcp name. Edit it before your next call if that is not what you want.")
        }
    }

    @ViewBuilder private var hooks: some View {
        if let problem = model.calls.hooksProblem {
            NoteText("The hooks could not be listed: \(problem)", tint: Theme.amberText)
        } else if let listing = model.calls.hooks {
            if listing.hooks.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No routine set up").font(Theme.sans(14, .medium))
                    NoteText(listing.found ? "hooks.json has no hooks, so nothing runs when a call is ready."
                             : "Nothing runs when a call is ready. A routine is your own command, such as Claude Code headless in a folder of yours.")
                    let docs = HooksFileExample.docs(polycapJS: model.install?.polycapJS)
                    WindowButton("How to set one up") { if let docs { NSWorkspace.shared.open(docs) } }
                        .disabled(docs == nil)
                        .help(docs == nil ? "docs/MAC.md was not found beside polycap" : "Opens docs/MAC.md; see \"Starting Robin's routine\"")
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.divider))
            } else {
                ForEach(listing.hooks) { hook in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(hook.name) · in \(hook.cwd ?? "~")\n\(hook.commandText)")
                            .font(Theme.mono(12)).foregroundStyle(Theme.soft).lineSpacing(3).lineLimit(4).truncationMode(.tail).textSelection(.enabled)
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.field))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.divider))
                        let timeout = hook.timeoutMinutes == hook.timeoutMinutes.rounded() ? "\(Int(hook.timeoutMinutes))" : "\(hook.timeoutMinutes)"
                        Text("\(hook.filterText). Stopped after \(timeout) min." + ((hook.envNames ?? []).isEmpty ? "" : " Sets \((hook.envNames ?? []).joined(separator: ", "))."))
                            .font(Theme.sans(13)).foregroundStyle(Theme.soft)
                    }
                }
            }
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private func editHooks() {
        fileProblem = nil
        if FileManager.default.fileExists(atPath: hooksFile.path) {
            if !NSWorkspace.shared.open(hooksFile) { fileProblem = "No app opens \(hooksFile.lastPathComponent); open it in your editor." }
        } else {
            confirmCreate = true
        }
    }

    private func createHooks() {
        do {
            try HooksFileExample.create(at: hooksFile, home: FileManager.default.homeDirectoryForCurrentUser)
            NSWorkspace.shared.open(hooksFile)
            model.calls.loadHooks()
        } catch {
            fileProblem = "\(error)"
        }
    }
}

// MARK: Open at login

private struct LoginSection: View {
    let model: AppModel
    @State private var on = LoginItem.isEnabled
    @State private var status = LoginItem.statusText

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Open at login")
            Toggle(isOn: Binding(get: { on }, set: { value in
                model.setLaunchAtLogin(value)
                on = LoginItem.isEnabled
                status = LoginItem.statusText
            })) { Text("Open Polydance when you log in").font(Theme.sans(14)) }
                .toggleStyle(.switch).controlSize(.small)
            HStack(spacing: 8) {
                NoteText("Now: \(status).")
                LinkButton("Open System Settings") { NSWorkspace.shared.open(SystemSettingsPane.loginItems.url) }
            }
        }
        .onAppear {
            on = LoginItem.isEnabled
            status = LoginItem.statusText
        }
    }
}

// MARK: polycap

private struct PolycapSection: View {
    let model: AppModel
    @State private var chooseProblem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("polycap")
            PathLine(label: "node", value: model.install?.node ?? "not found")
            PathLine(label: "polycap", value: model.install?.polycapJS ?? "not found")
            if let problem = model.installProblem { NoteText(problem, tint: Theme.amberText) }
            if let chooseProblem { NoteText(chooseProblem, tint: Theme.amberText) }
            HStack(spacing: 8) {
                WindowButton(model.locatingPolycap ? "Detecting…" : "Detect again") { model.redetectPolycap() }.disabled(model.locatingPolycap)
                WindowButton("Choose…") { choose() }.disabled(model.locatingPolycap)
            }
            NoteText("An app opened from the Finder has neither on its PATH, so they are found once from your login shell and kept. Every polycap command runs as node polycap.js with its arguments, never through a shell.")
        }
    }

    private func choose() {
        chooseProblem = nil
        let node = NSOpenPanel()
        node.message = "Choose node (Node 22), for example in ~/.nvm/versions/node/…/bin."
        node.prompt = "Use this node"
        node.canChooseDirectories = false
        node.treatsFilePackagesAsDirectories = true
        node.showsHiddenFiles = true
        if let current = model.install?.node { node.directoryURL = URL(fileURLWithPath: current).deletingLastPathComponent() }
        NSApp.activate()
        guard node.runModal() == .OK, let nodeURL = node.url else { return }
        let script = NSOpenPanel()
        script.message = "Choose polycap.js: bin/polycap.js in the Polydance repository."
        script.prompt = "Use this polycap"
        script.canChooseDirectories = false
        script.showsHiddenFiles = true
        script.allowedContentTypes = [UTType(filenameExtension: "js") ?? .sourceCode]
        if let current = model.install?.polycapJS { script.directoryURL = URL(fileURLWithPath: current).deletingLastPathComponent() }
        guard script.runModal() == .OK, let scriptURL = script.url else { return }
        model.usePolycap(node: nodeURL.path, polycap: scriptURL.path)
    }
}

// MARK: Permissions

private struct PermissionsPanel: View {
    let model: AppModel
    private var grants: PermissionsModel { model.permissions }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Permissions")
            VStack(spacing: 0) {
                PermissionRow(title: "Microphone", status: grants.microphoneText, good: grants.microphone == .authorized,
                              detail: "Your voice, on its own track.",
                              request: grants.microphone == .notDetermined ? { grants.requestMicrophone() } : nil,
                              pane: .microphone, open: grants.open)
                PermissionRow(title: "Screen recording", status: grants.screen ? "Allowed" : "Not allowed", good: grants.screen,
                              detail: "macOS asks again about once a month. If it asks during a call, the sound still records."
                                + (grants.screenAsked && !grants.screen ? " Once it is allowed in System Settings, quit and reopen Polydance." : ""),
                              request: grants.screen ? nil : { grants.requestScreen() },
                              pane: .screenAndSystemAudio, open: grants.open)
                PermissionRow(title: "System audio", status: systemAudio.text, good: systemAudio.good,
                              detail: "macOS can't say if this is allowed; Polydance checks for silence while Arc plays during a call.",
                              request: nil, pane: .screenAndSystemAudio, open: grants.open)
                PermissionRow(title: "Arc (read its tabs)", status: grants.askingArc ? "Checking…" : grants.automation?.text ?? "Checking…",
                              good: grants.automation == .allowed,
                              detail: "Only the tabs' addresses, only while Arc uses the microphone.",
                              request: grants.automation == .notAsked ? { grants.requestArc() } : nil,
                              pane: .automation, open: grants.open)
                PermissionRow(title: "Notifications", status: grants.notificationsText, good: grants.notificationsAllowed,
                              detail: "One when a call starts recording, with Stop and Discard.",
                              request: grants.notifications == .notDetermined ? { grants.requestNotifications() } : nil,
                              pane: .notifications, open: grants.open, last: true)
            }
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.divider))
        }
    }

    private var systemAudio: (text: String, good: Bool?) {
        guard let last = model.calls.lastFarEnd else { return ("Checked during calls", nil) }
        return last.heard ? ("Heard on the last call", true) : ("Silent on the last call", false)
    }
}

private struct PermissionRow: View {
    let title: String
    let status: String
    /// Nil when there is nothing to judge (system audio before any call).
    let good: Bool?
    let detail: String
    let request: (() -> Void)?
    let pane: SystemSettingsPane
    let open: (SystemSettingsPane) -> Void
    var last = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(Theme.sans(13))
                Spacer()
                Text(status).font(Theme.sans(13)).foregroundStyle(good == true ? Theme.greenText : good == false ? Theme.amberText : Theme.soft)
            }
            Text(detail).font(Theme.sans(11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                if let request { LinkButton("Request") { request() } }
                LinkButton("Open System Settings") { open(pane) }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .overlay(alignment: .bottom) { if !last { Rectangle().fill(Theme.rule).frame(height: 1) } }
    }
}

// MARK: Threads

private struct ReceiverPanel: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("Threads").padding(.top, 12)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Receiver").font(Theme.sans(13))
                    Spacer()
                    Text(state.text).font(Theme.sans(13)).foregroundStyle(state.good == true ? Theme.greenText : state.good == false ? Theme.amberText : Theme.soft)
                }
                NoteText(model.threads.listProblem ?? (model.threads.listCheckedAt == nil ? "Asking with polycap thread list…"
                    : "polycap thread list answered: \(model.threads.threads.count) open thread\(model.threads.threads.count == 1 ? "" : "s"). Only walkthroughs upload; calls stay here."),
                         tint: model.threads.listProblem == nil ? Theme.muted : Theme.amberText)
                LinkButton(model.threads.listing ? "Checking…" : "Check again") { model.threads.refreshList() }.disabled(model.threads.listing)
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.divider))
        }
    }

    private var state: (text: String, good: Bool?) {
        if model.threads.listProblem != nil { return ("Not connected", false) }
        if model.threads.listCheckedAt == nil { return ("Checking…", nil) }
        return ("Connected", true)
    }
}
