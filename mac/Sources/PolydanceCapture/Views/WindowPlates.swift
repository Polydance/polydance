// New thread and the bug key's report, as cream plates over the main window: Robin's pick D of four mockups
// (2026-11-16; docs/MAC.md, New thread and reports). New thread chooses a project from chips, the team's and
// your own, with + New project last (it becomes a name field with Make, only where the receiver makes
// projects), then records a walkthrough that opens the thread when it stops, as on the headset, or, with
// Write it instead, posts a title with words and photos at once. The report records a walkthrough for the
// Polydance team only, in the headset's words. Both record with the Mic and Mac sound switches every
// walkthrough uses, and neither starts while something is being recorded or a Meet call is live.
import AppKit
import PolydanceCore
import PolydanceShared
import SwiftUI

struct NewThreadPlate: View {
    @Bindable var model: AppModel
    @State private var writing: Bool
    private var threads: ThreadsModel { model.threads }

    /// `writing`: open on Write it instead (the window's pictures).
    init(model: AppModel, writing: Bool = false) {
        self.model = model
        _writing = State(initialValue: writing)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Glyph(.camera, color: Palette.red, size: 24)
                LabelText("New thread", size: 16, color: Palette.print, tracking: 0.16)
            }
            LabelText("In", size: 11, color: Palette.print, tracking: 0.18)
            ProjectChips(model: model)
            Rectangle().fill(Palette.plateEdge).frame(height: 1)
            if writing { WriteForm(model: model) } else {
                PlateText("Show it on screen and say what you want, as on the headset. The thread's title comes from what you say.")
                SoundSwitches(model: model, onPlate: true)
                if model.walkthroughMic { MicLine() }
            }
            if let problem = writing ? threads.openProblem : threads.recordProblem ?? busy { PlateText(problem, problem: true) }
            HStack(spacing: 10) {
                Button("Cancel") { model.plate = nil }
                    .buttonStyle(KeyStyle(color: Palette.tan, small: false))
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button(writing ? "Record it instead" : "Write it instead") { writing.toggle() }
                    .buttonStyle(KeyStyle(small: false))
                if writing {
                    Button(threads.openingThread ? "Posting…" : "Post") { threads.postNewThread() }
                        .buttonStyle(KeyStyle(color: Palette.amber, small: false))
                        .disabled(!canPost)
                } else {
                    FilledButton("Record a new thread", fill: Theme.red) { threads.recordNewThread() }
                        .frame(width: 210)
                        .disabled(threads.chosen == nil || model.live != nil)
                        .help("\(model.walkthroughSounds.records()), and opens the thread in \(threads.chosen?.name ?? "the project") when you stop.")
                }
            }
        }
        .padding(.horizontal, 30).padding(.vertical, 26)
        .frame(width: 600)
        .background(CreamPlateBackground())
        .dropDestination(for: URL.self) { urls, _ in
            guard writing else { return false }
            threads.attach(urls, to: ThreadsModel.draftKey)
            return true
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("New thread")
    }

    /// Why the Record key is greyed, when it is.
    private var busy: String? { model.live != nil ? "Something is being recorded; stop it first." : nil }

    private var canPost: Bool {
        let words = !threads.newText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(threads.attachments[ThreadsModel.draftKey] ?? []).isEmpty
        return threads.chosen != nil && !threads.openingThread && words && !threads.newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Write it instead: a title, the first message, and photos chosen or dropped on the plate.
private struct WriteForm: View {
    @Bindable var model: AppModel
    private var threads: ThreadsModel { model.threads }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PlateField(prompt: "Title", text: Bindable(model.threads).newTitle)
            PlateField(prompt: "What it is about", text: Bindable(model.threads).newText, lines: 3...8)
            let photos = threads.attachments[ThreadsModel.draftKey] ?? []
            if !photos.isEmpty {
                Attachments(model: model, key: ThreadsModel.draftKey, photos: photos)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Palette.panel))
            }
            HStack(spacing: 10) {
                Button("Add photo") { choose() }.buttonStyle(KeyStyle())
                PlateText("or drop them here. The receiver needs a title, and words or a photo.")
            }
            if let problem = threads.attachProblem[ThreadsModel.draftKey] { PlateText(problem, problem: true) }
        }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.prompt = "Add"
        panel.message = "Photos for the new thread: polycap turns them upright, scales them to 4096 px and removes their location before sending."
        if panel.runModal() == .OK { threads.attach(panel.urls, to: ThreadsModel.draftKey) }
    }
}

/// The projects as chips, the chosen one amber with a tick, and + New project last where the receiver makes
/// them; it becomes a name field with Make.
private struct ProjectChips: View {
    @Bindable var model: AppModel
    private var threads: ThreadsModel { model.threads }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if threads.projects.isEmpty {
                if let problem = threads.projectsProblem {
                    PlateText("The projects could not be read: \(problem)", problem: true)
                    Button("Try again") { threads.refreshProjects() }.buttonStyle(KeyStyle())
                } else {
                    PlateText(threads.listingProjects ? "Asking the receiver for your projects…" : "This Mac's token sees no projects.")
                }
            }
            Flow(spacing: 8) {
                ForEach(threads.projects) { project in
                    let on = project.key == threads.chosenProject
                    Button { threads.chosenProject = project.key } label: {
                        Chip(text: (on ? "✓  " : "") + project.name + (project.mine ? " · yours" : ""), on: on)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(project.name), \(project.mine ? "your own project" : "the team's project")")
                    .accessibilityAddTraits(on ? [.isSelected] : [])
                }
                if threads.makesProjects {
                    if threads.namingProject { naming } else {
                        Button { threads.namingProject = true } label: { Chip(text: "+  New project", on: false, dashed: true) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("New project: make a project of your own")
                    }
                }
            }
            if threads.namingProject {
                PlateText(threads.makeProblem ?? "Only you see it, and whoever you add to one of its threads.", problem: threads.makeProblem != nil)
            }
        }
    }

    private var naming: some View {
        HStack(spacing: 6) {
            TextField("", text: Bindable(model.threads).projectName, prompt: Text("Project name").foregroundStyle(Palette.hint))
                .textFieldStyle(.plain).font(Theme.sans(13.5)).foregroundStyle(Palette.print)
                .frame(width: 170)
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 6).fill(Palette.plateLight))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.plateEdge))
                .onSubmit { threads.makeProject() }
                .disabled(threads.makingProject)
            Button(threads.makingProject ? "Making…" : "Make") { threads.makeProject() }
                .buttonStyle(KeyStyle(color: Palette.amber))
                .disabled(threads.makingProject || threads.projectName.trimmingCharacters(in: .whitespaces).isEmpty)
            Button { threads.cancelNaming() } label: { Glyph(.close, color: Palette.print, size: 16) }
                .buttonStyle(.plain)
                .accessibilityLabel("Do not make a project")
                .disabled(threads.makingProject)
        }
    }
}

struct ReportPlate: View {
    @Bindable var model: AppModel
    private var threads: ThreadsModel { model.threads }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                BugIcon(ink: Palette.print, hole: Palette.plateLight).frame(width: 24, height: 24)
                LabelText("Report a bug or suggest a feature", size: 14, color: Palette.print, tracking: 0.12)
            }
            PlateText(Self.text)
            if threads.takesReports == false {
                PlateText("This receiver takes no reports (it has no reports project), so the bug key cannot send one.", problem: true)
            }
            SoundSwitches(model: model, onPlate: true)
            if model.walkthroughMic { MicLine() }
            if let problem = threads.recordProblem ?? (model.live != nil ? "Something is being recorded; stop it first." : nil) {
                PlateText(problem, problem: true)
            }
            HStack(spacing: 10) {
                Spacer()
                Button("Cancel") { model.plate = nil }
                    .buttonStyle(KeyStyle(color: Palette.tan, small: false))
                    .keyboardShortcut(.cancelAction)
                FilledButton("Start recording", fill: Theme.red) { threads.recordReport() }
                    .frame(width: 190)
                    .disabled(threads.takesReports == false || model.live != nil)
            }
        }
        .padding(.horizontal, 30).padding(.vertical, 26)
        .frame(width: 540)
        .background(CreamPlateBackground())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Report a bug or suggest a feature")
    }

    /// The headset's words for the bug key (THREADS.md, Reports), for a Mac.
    static let text = "Use this for Polydance itself: something broken, confusing or slow, or a feature you would like. "
        + "Feedback on an app you are testing belongs in its thread.\n\n"
        + "Start recording, then show us on screen what happened and say what you expected. Stop with "
        + "\(Hotkeys.Shortcut.recordOrStop.label) or from the menu bar when you are done; Discard throws it away.\n\n"
        + "A report goes only to the Polydance team, never to your threads. Its recording stays in Polydance's "
        + "recordings folder on this Mac, as a reply's does."
}

/// Which microphone will record, read again every two seconds while the plate is open (a device plugged in
/// or chosen in System Settings shows at once), in red when it is a virtual device or there is none.
private struct MicLine: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { _ in
            let line = MicDescription.line(InputDevice.current())
            PlateText(line.text, problem: line.warning)
        }
    }
}

/// Words printed on a cream plate: the deck's dark print, or red for what went wrong.
private struct PlateText: View {
    let text: String
    var problem = false

    init(_ text: String, problem: Bool = false) {
        self.text = text
        self.problem = problem
    }

    var body: some View {
        Text(text).font(Theme.sans(13.5)).foregroundStyle(problem ? Parts.tapeFullPrint : Palette.print)
            .lineSpacing(2).fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

/// A field on a cream plate: the light plate's colour with an edge, dark print.
private struct PlateField: View {
    let prompt: String
    @Binding var text: String
    var lines: ClosedRange<Int> = 1...1

    var body: some View {
        TextField("", text: $text, prompt: Text(prompt).foregroundStyle(Palette.hint), axis: lines.upperBound > 1 ? .vertical : .horizontal)
            .textFieldStyle(.plain).font(Theme.sans(14)).foregroundStyle(Palette.print)
            .lineLimit(lines)
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 6).fill(Palette.plateLight))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.plateEdge))
            .accessibilityLabel(prompt)
    }
}

/// A project as a chip on the cream plate: amber when chosen, dashed for New project.
private struct Chip: View {
    let text: String
    let on: Bool
    var dashed = false

    var body: some View {
        Text(text).font(Theme.sans(13.5, .medium)).foregroundStyle(Palette.print).lineLimit(1)
            .padding(.horizontal, 13).padding(.vertical, 6)
            .background(Pill().fill(on ? Palette.amber : Palette.plateLight))
            .overlay(Pill().stroke(on ? Palette.amber : Palette.plateEdge, style: StrokeStyle(lineWidth: 1.2, dash: dashed ? [4, 3] : [])))
            .contentShape(Pill())
    }
}

/// Lays its views out in rows, left to right, starting a new row when one is full: the chips.
private struct Flow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += row + spacing; row = 0 }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += row + spacing; row = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}
