// The menu-bar popover, built as the headset's deck (docs/DESIGN-SYSTEM.md) on the wooden cabinet: the
// cream top plate with the logo, the control panel (lamps, counter, meters, the red key: ControlPanel),
// then what the state needs on a black panel: watching, the recent calls and the threads behind two chips;
// recording, the screen, marks and any trouble; building, the pipeline's steps read from session.json and
// the routine from hook-runs.json. A call opens its page in the main window, a thread its page there too.
import AppKit
import PolydanceCore
import PolydanceShared
import SwiftUI

struct MenuBarLabel: View {
    let model: AppModel

    var body: some View {
        Group {
            switch model.phase {
            case .recording:
                HStack(spacing: 4) {
                    Image(nsImage: MenuBarIcons.recording)
                    Text(model.menuBarClock ?? "").monospacedDigit()
                }
            case .building:
                Image(nsImage: MenuBarIcons.building)
            case .watching:
                Image(nsImage: MenuBarIcons.watching)
            }
        }
        // The label exists from launch, drawn or not, so the window can be opened before the menu ever is.
        .installsWindowOpeners(model)
    }
}

struct MenuContent: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            DeckHeader(model: model)
            ControlPanel(readout: model.controlReadout, record: { model.recordNowOrStop() },
                         mark: model.live == nil ? nil : { model.mark() },
                         discard: model.live == nil || model.live?.stopping == true ? nil : { model.stopAndDiscard() })
            if let error = model.lastError {
                Banner(text: error, tone: Theme.redText) { model.dismissError() }
            }
            switch model.phase {
            case .recording: if let live = model.live { RecordingPane(model: model, live: live) }
            case .building: if let building = model.building { BuildingPane(model: model, building: building) }
            case .watching: WatchingPane(model: model)
            }
            Footer(model: model)
        }
        .padding(10)
        .frame(width: 384)
        .background(Wood())
        .foregroundStyle(Theme.text)
        .environment(\.colorScheme, .dark)
        .installsWindowOpeners(model)
        .onAppear { model.refreshRecent() }
    }
}

/// The deck's cream top plate: the ballerina and POLYDANCE printed on brushed metal, the gear at the right.
private struct DeckHeader: View {
    let model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            if let mark = Logo.mark {
                Image(nsImage: mark).resizable().interpolation(.high).scaledToFit().frame(width: 22, height: 22).accessibilityHidden(true)
            }
            LabelText("Polydance", size: 13, color: Palette.print, tracking: 0.2)
            Spacer()
            Button { model.openSettings?() } label: {
                Image(systemName: "gearshape.fill").font(.system(size: 14)).foregroundStyle(Palette.print)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 20).padding(.vertical, 9)
        .background(CreamPlateBackground())
    }
}

/// Along the foot, on the wood: Open Polydance, and the way out a menu-bar app with no Dock icon needs.
/// Quitting while a call records saves it first.
private struct Footer: View {
    let model: AppModel

    var body: some View {
        HStack {
            Button("Open Polydance") { model.openLibrary() }.buttonStyle(PillStyle(cream: true))
            Spacer()
            Button { NSApp.terminate(nil) } label: { LabelText("Quit Polydance", size: 10, color: Palette.burnt, tracking: 0.14) }
                .buttonStyle(.plain)
        }
        .padding(.horizontal, 4)
    }
}

// MARK: Watching

private struct WatchingPane: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            notices
            MenuTabs(model: model)
            VStack(alignment: .leading, spacing: 0) {
                switch model.menuTab {
                case .calls: RecentList(model: model)
                case .threads: ThreadList(model: model)
                }
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 4).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
        }
    }

    @ViewBuilder private var notices: some View {
        if let problem = model.installProblem {
            Banner(text: problem, tone: Theme.amberText, dismiss: nil)
        }
        if let problem = model.libraryProblem {
            Banner(text: problem, tone: Theme.amberText, dismiss: nil)
        }
        if let problem = model.arc.tabsProblem, model.arc.micActive {
            Banner(text: "Arc is using the microphone, but its tabs could not be read: \(problem)", tone: Theme.amberText, dismiss: nil)
        } else if let warning = model.arc.withoutCall {
            Banner(text: warning.text(shortcut: Hotkeys.Shortcut.recordOrStop.label).line, tone: Theme.amberText, dismiss: nil)
        }
        ForEach(model.hotkeyProblems, id: \.self) { Banner(text: $0, tone: Theme.amberText, dismiss: nil) }
        // One outcome per recording (the queue keeps only the latest), so a retry that worked leaves no row.
        ForEach(model.handoff.finished.prefix(3).filter(\.isFailure)) { state in
            FailedRow(title: "\(state.job.files.baseName) was not processed", message: state.message) { model.retryHandoff(state.job.files) }
        }
        ForEach(model.threads.uploads.filter { $0.entry.status == .uploading || $0.entry.status == .failed }.prefix(2)) { upload in
            UploadNotice(upload: upload) {
                if upload.entry.target.kind == .reply, let thread = upload.entry.target.thread { model.showThread(thread) } else { model.showThreads() }
            }
        }
        // Hand-offs an earlier run did not finish, from the ledger.
        ForEach(model.attention.prefix(4)) { entry in
            if entry.running {
                FailedRow(title: entry.item.title, message: "polycap is still working on it (started before the app last quit).", action: nil) {}
            } else {
                FailedRow(title: entry.item.title, message: Self.message(entry.item), action: entry.item.actionTitle) { model.retryHandoff(entry.item.files) }
            }
        }
    }

    static func message(_ item: HandoffAttention) -> String {
        switch item.entry.status {
        case .importing: "polycap import was cut off and its session was not found, so Retry imports it."
        case .imported: "polycap process did not finish (the app quit or the Mac restarted). Finish building runs it."
        case .importFailed, .processFailed, .processed: item.entry.error ?? "No reason was recorded."
        }
    }
}

private struct RecentList: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.recent.isEmpty {
                Text("No calls recorded yet.").font(Theme.sans(12)).foregroundStyle(Theme.muted).padding(.horizontal, 16).padding(.vertical, 8)
            }
            ForEach(groups, id: \.title) { group in
                LabelText(group.title, size: 10, color: Palette.tan, tracking: 0.14)
                    .padding(.horizontal, 8).padding(.top, group.title == groups.first?.title ? 4 : 10).padding(.bottom, 4)
                ForEach(group.items) { item in
                    // A call opens its page; a walkthrough, which has none in the window, its folder.
                    Button { if item.isCall { model.showCall(item.id) } else { model.reveal(item.dir) } } label: { RecentRow(item: item) }.buttonStyle(.plain)
                }
            }
        }
        .padding(.horizontal, 4)
    }

    private var groups: [(title: String, items: [RecentRecording])] {
        var result: [(title: String, items: [RecentRecording])] = []
        for item in model.recent.prefix(6) {
            let title = Self.day(item.recordedAt)
            if result.last?.title == title { result[result.count - 1].items.append(item) } else { result.append((title, [item])) }
        }
        return result
    }

    static func day(_ date: Date?) -> String {
        guard let date else { return "Earlier" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }
}

/// Board 1's tabs: the recent calls, or the threads with a count of those with something new.
private struct MenuTabs: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            tab("Calls", .calls, count: 0)
            tab("Threads", .threads, count: model.threads.newCount)
            Spacer()
        }
        .padding(.horizontal, 2)
    }

    private func tab(_ title: String, _ tab: MenuTab, count: Int) -> some View {
        Button {
            model.menuTab = tab
            if tab == .threads { model.threads.refreshListIfStale() }
        } label: {
            let on = model.menuTab == tab
            HStack(spacing: 6) {
                LabelText((on ? "✓  " : "") + title, size: 11, color: on ? Palette.casing : Palette.tan, tracking: 0.06)
                if count > 0 { LabelText(count > 99 ? "99+" : "\(count)", size: 11, color: on ? Palette.casing : Palette.red, tracking: 0.1) }
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(Pill().fill(on ? Palette.amber : Palette.casing))
            .overlay(Pill().stroke(on ? Palette.amber : Palette.edge))
            .contentShape(Pill())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(model.menuTab == tab ? [.isSelected] : [])
    }
}

/// The threads in the menu: a thread opens its page in the main window.
private struct ThreadList: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let problem = model.threads.listProblem {
                Text(problem).font(Theme.sans(11)).foregroundStyle(Theme.amberText).lineLimit(5).padding(.horizontal, 16).padding(.vertical, 8)
            } else if model.threads.threads.isEmpty {
                Text(model.threads.listCheckedAt == nil ? "Asking the receiver…" : "No open threads.")
                    .font(Theme.sans(12)).foregroundStyle(Theme.muted).padding(.horizontal, 16).padding(.vertical, 8)
            }
            ForEach(model.threads.threads.prefix(6)) { thread in
                Button { model.showThread(thread.key) } label: { ThreadRowView(thread: thread, compact: true).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
            }
        }
        .onAppear { model.threads.refreshListIfStale() }
    }
}

private struct RecentRow: View {
    let item: RecentRecording
    @State private var hover = false

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(Theme.sans(13, .medium)).foregroundStyle(item.short ? Theme.soft : Theme.text).lineLimit(1)
                Text(subline).font(Theme.sans(11)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 8)
            Chip(chip: item.chip)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 3).fill(hover ? Palette.surface : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }

    private var subline: String {
        var parts: [String] = []
        if let at = item.recordedAt { parts.append(at.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))) }
        if let ms = item.durationMs { parts.append(Self.minutes(ms)) }
        if item.videoNone { parts.append("audio only, screen not recorded") }
        else if let frames = item.frameCount { parts.append("\(frames) frames") }
        if item.marks > 0 { parts.append("\(item.marks) mark\(item.marks == 1 ? "" : "s")") }
        if item.short { parts.append("short") }
        return parts.joined(separator: " · ")
    }

    static func minutes(_ ms: Int) -> String {
        let minutes = Int((Double(ms) / 60_000).rounded())
        return minutes < 1 ? "under 1 min" : "\(minutes) min"
    }
}

private struct Chip: View {
    let chip: RecentRecording.Chip

    var body: some View {
        if let (text, tint, _) = style { Tag(text: text, color: tint) }
    }

    private var style: (String, Color, Color)? {
        switch chip {
        case .routineDone: ("Routine done", Theme.greenText, Theme.greenEdge)
        case .routineFailed: ("Routine failed", Theme.redText, Theme.redEdge)
        case .routineRunning: ("Routine running", Theme.amberText, Theme.greyEdge)
        case .routineSkipped: ("Routine skipped", Theme.soft, Theme.greyEdge)
        case .short: ("Short, not sent", Theme.soft, Theme.greyEdge)
        case .notBuilt: ("Not built", Theme.amberText, Theme.greyEdge)
        case .none: nil
        }
    }
}

/// A walkthrough on its way to a thread (a reply, a new thread or a report), or one that did not get there.
private struct UploadNotice: View {
    let upload: ThreadsModel.Upload
    let open: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                let target = upload.entry.target
                Text(upload.entry.status == .failed ? "\(target.title) was not sent" : "Sending \(target.what)…")
                    .font(Theme.sans(12, .medium))
                if upload.entry.status == .failed, let error = upload.entry.error {
                    Text(error).font(Theme.sans(11)).foregroundStyle(Theme.redText).lineLimit(3)
                }
            }
            Spacer()
            Button("Open", action: open).buttonStyle(.plain).font(Theme.sans(12, .medium)).foregroundStyle(Theme.text)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface))
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 4).fill(Palette.panel))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
    }
}

private struct FailedRow: View {
    let title: String
    let message: String
    /// The button's title; nil for a row with nothing to press yet.
    var action: String? = "Retry"
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Theme.sans(12, .medium))
                Text(message).font(Theme.sans(11)).foregroundStyle(action == nil ? Theme.amberText : Theme.redText).lineLimit(3)
            }
            Spacer()
            if let action {
                Button(action, action: retry).buttonStyle(.plain).font(Theme.sans(12, .medium)).foregroundStyle(Theme.text)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface))
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 4).fill(Palette.panel))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
    }
}

// MARK: Recording

private struct RecordingPane: View {
    let model: AppModel
    let live: AppModel.LiveRecording

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                LineRow(label: "Recording") { Text(subtitle).font(Theme.sans(12)) }
                LineRow(label: "Me") { Text(live.status.micOff ? "off: the mic was switched off" : live.status.micNote == nil ? "the mic, raw" : "no mic").font(Theme.sans(12)) }
                if let note = live.status.micNote { Detail(text: note, tint: Theme.amberText) }
                LineRow(label: "Others") {
                    Text(live.status.appOff ? "off: the Mac's sound was switched off" : live.status.appNote == nil ? (isCall ? "Arc's sound" : "the Mac's sound") : "no sound").font(Theme.sans(12))
                }
                if let note = live.status.appNote { Detail(text: note, tint: Theme.amberText) }
                if live.farEndSilent { Detail(text: "Arc is playing but nothing is heard: check Screen & System Audio Recording in System Settings.", tint: Theme.redText) }
                LineRow(label: "Screen") {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(live.status.screenLine).font(Theme.sans(12))
                        if let detail = live.status.screenDetail { Text(detail).font(Theme.sans(12)).foregroundStyle(Theme.muted) }
                    }
                }
                if let warning = live.diskWarning { Detail(text: warning, tint: Theme.amberText) }
                LineRow(label: "Marks") {
                    Text(marksText).font(Theme.sans(12))
                }
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 4).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
        }
    }

    private var isCall: Bool { live.mode != .walkthrough }

    private var subtitle: String {
        let started = live.startedAt.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        switch live.mode {
        case .call(let code): return "Google Meet · \(code) · Arc · started \(started)\(live.automatic ? " when you joined" : "")"
        case .walkthrough:
            if let thread = live.thread { return "\(thread.title)\(thread.label.map { ", \($0)" } ?? "") · started \(started)" }
            return "Walkthrough · started \(started)"
        }
    }

    private var marksText: String {
        guard !live.marks.isEmpty else { return "none yet" }
        let clocks = live.marks.suffix(4).map { Recorder.clock(Double($0) / 1000) }
        return "\(live.marks.count) · " + clocks.joined(separator: ", ")
    }

}

private struct LineRow<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            LabelText(label, size: 9.5, color: Palette.tan, tracking: 0.14).frame(width: 74, alignment: .leading).padding(.top, 2)
            content
            Spacer(minLength: 0)
        }
    }
}

private struct Detail: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text).font(Theme.sans(11)).foregroundStyle(tint).padding(.leading, 84).fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: Building

private struct BuildingPane: View {
    let model: AppModel
    let building: AppModel.Building

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Theme.sans(15, .semibold))
                Text(subtitle).font(Theme.sans(12)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)

            VStack(spacing: 0) {
                StepLine(row: StepRow(id: "saved", label: "Saved", state: .done, detail: savedDetail))
                if case .importing = building.job.stage {
                    StepLine(row: StepRow(id: "import", label: "Import", state: .running, detail: "into the library"))
                }
                ForEach(BuildProgress.rows(session: building.session, processing: isProcessing)) { StepLine(row: $0) }
                StepLine(row: BuildProgress.routine(building.hookRuns, processing: isProcessing), last: true)
            }
            .padding(.horizontal, 14).padding(.vertical, 4)

            if let problem = building.readProblem { Detail(text: problem, tint: Theme.amberText).padding(.top, 6) }
            HStack(alignment: .center, spacing: 8) {
                Text(footnote).font(Theme.sans(11)).foregroundStyle(Theme.muted)
                Spacer()
                Button("Open folder") {
                    if case .processing(_, let dir) = building.job.stage { model.reveal(URL(fileURLWithPath: dir)) }
                    else { model.reveal(building.job.job.files.video) }
                }
                .buttonStyle(KeyStyle())
            }
            .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 12)
        }
        .background(RoundedRectangle(cornerRadius: 4).fill(Palette.panel))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
    }

    private var isProcessing: Bool { if case .processing = building.job.stage { return true } else { return false } }

    private var title: String {
        guard let saved = building.saved else { return building.job.job.files.baseName }
        let at = saved.startedAt.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        let length = RecentRow.minutes(Int(saved.seconds * 1000))
        return saved.mode == .walkthrough ? "Walkthrough at \(at) · \(length)" : "Call at \(at) · \(length)"
    }

    private var subtitle: String {
        guard let saved = building.saved else { return "Found after the app last quit. Still watching for the next call." }
        let ended = saved.startedAt.addingTimeInterval(saved.seconds).formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        let why: String
        switch saved.stopReason {
        case .leftCall: why = "You left the call at \(ended)."
        case .micReleased: why = "Arc let go of the microphone at \(ended)."
        case .user: why = "You stopped it at \(ended)."
        case .cap: why = "It reached the 4-hour cap at \(ended)."
        case .appQuit: why = "The app quit at \(ended)."
        case nil: why = "Stopped at \(ended)."
        }
        return why + " Still watching for the next one."
    }

    private var savedDetail: String {
        guard let saved = building.saved else { return "on this Mac" }
        let size = ByteCountFormatter.string(fromByteCount: saved.bytes, countStyle: .file)
        return "\(size) · \(saved.tracks) track\(saved.tracks == 1 ? "" : "s")"
    }

    private var footnote: String {
        let waiting = model.handoff.queued.count
        return "Runs in the background; a new call still records." + (waiting > 0 ? " \(waiting) more waiting." : "")
    }
}

private struct StepLine: View {
    let row: StepRow
    var last = false

    var body: some View {
        HStack(spacing: 10) {
            Text(symbol).font(Theme.sans(13)).foregroundStyle(tint).frame(width: 18)
            Text(row.label).font(Theme.sans(13)).foregroundStyle(row.state == .pending || row.state == .skipped ? Theme.soft : Theme.text)
            Spacer(minLength: 8)
            if let detail = row.detail { Text(detail).font(Theme.sans(11)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle) }
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { if !last { Rectangle().fill(Theme.rule).frame(height: 1) } }
    }

    private var symbol: String {
        switch row.state {
        case .done: "✓"
        case .running: "◐"
        case .pending: "○"
        case .failed: "✕"
        case .skipped: "–"
        }
    }

    private var tint: Color {
        switch row.state {
        case .done: Theme.green
        case .running: Theme.amberText
        case .failed: Theme.redText
        case .pending, .skipped: Theme.muted
        }
    }
}

// MARK: Shared

private struct Banner: View {
    let text: String
    let tone: Color
    let dismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(text).font(Theme.sans(11)).foregroundStyle(tone).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let dismiss {
                Button(action: dismiss) { Image(systemName: "xmark").font(.system(size: 10)) }.buttonStyle(.plain).foregroundStyle(Theme.muted)
                    .accessibilityLabel("Dismiss")
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 4).fill(Palette.panel))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Palette.edge, lineWidth: 1.5))
    }
}
