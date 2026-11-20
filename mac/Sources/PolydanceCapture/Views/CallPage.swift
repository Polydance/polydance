// A call's page (board 4): its title, times and Meet code, chips (voices, scenes, marks, "Only on this
// Mac"), the scenes grid from frames.json (scene and mark frames, marks outlined), the transcript with
// Me and Others, the routine's card from hook-runs.json (status, times, exit code, the agent's session
// with its resume command, Run again), and the bundle's files. "Send to thread…" is shown as Later: the
// excerpt sheet (board 5) is not in the MVP. Everything shown is read from the session folder; nothing
// here changes the bundle except Run again, which is polycap's `hooks run --force`.
import PolydanceCore
import PolydanceShared
import SwiftUI

struct CallPage: View {
    let model: AppModel
    let id: String

    var body: some View {
        Group {
            if let page = model.calls.page, page.session.id == id || page.dir.lastPathComponent == id {
                CallPageContent(model: model, page: page)
            } else if let problem = model.calls.pageProblem, model.calls.pageID == id {
                VStack(spacing: 8) {
                    Text("This call could not be read").font(Theme.sans(15, .semibold))
                    NoteText(problem, tint: Theme.amberText).frame(maxWidth: 520)
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: id) { model.calls.open(id: id) }
    }
}

private struct CallPageContent: View {
    let model: AppModel
    let page: CallPageData

    var body: some View {
        VStack(spacing: 0) {
            Header(model: model, page: page)
            Rectangle().fill(Theme.divider).frame(height: 1)
            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        Scenes(model: model, page: page)
                        TranscriptSection(page: page)
                    }
                    .padding(.horizontal, 26).padding(.vertical, 18)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Rectangle().fill(Theme.divider).frame(width: 1)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        BuildCard(model: model, page: page)
                        RoutineSection(model: model, page: page)
                        Card(dashed: true) {
                            HStack {
                                SectionLabel("Suggested for threads")
                                Spacer()
                                LaterTag()
                            }
                            NoteText("Later, your routine can suggest the part of a call a thread needs, for you to send. Calls stay on this Mac until then.")
                        }
                        BundleFiles(model: model, page: page)
                    }
                    .padding(18)
                }
                .frame(width: 330)
            }
        }
    }
}

// MARK: Header

private struct Header: View {
    let model: AppModel
    let page: CallPageData

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 4) {
                Text(page.session.pageTitle).font(Theme.sans(22, .semibold)).lineLimit(2).textSelection(.enabled)
                Text(timesLine).font(Theme.sans(13)).foregroundStyle(Theme.muted).textSelection(.enabled)
                HStack(spacing: 6) { chips }.padding(.top, 6)
            }
            Spacer(minLength: 12)
            HStack(spacing: 8) {
                WindowButton("Open folder") { model.calls.openFolder(page.dir) }
                WindowButton("Storyboard") { if let storyboard = page.storyboard { model.calls.openFile(storyboard) } }
                    .disabled(page.storyboard == nil).help(page.storyboard == nil ? "No storyboard.md yet" : "Open storyboard.md")
                HStack(spacing: 6) {
                    WindowButton("Send to thread…") {}.disabled(true)
                    LaterTag()
                }
                .help("Sending part of a call to a thread comes later; calls stay on this Mac.")
            }
        }
        .padding(.horizontal, 26).padding(.top, 22).padding(.bottom, 16)
    }

    private var timesLine: String {
        let call = page.call
        let start = call?.startedAt.flatMap(MetaTime.parse) ?? MetaTime.parse(page.session.recordedAt)
        let end = call?.endedAt.flatMap(MetaTime.parse) ?? start.flatMap { s in page.session.media?.durationMs.map { s.addingTimeInterval(Double($0) / 1000) } }
        var parts = ["\(Clock.day(start)) \(Clock.time(start))" + (end.map { "–\(Clock.time($0))" } ?? "")]
        if let app = CallPageFacts.appLine(call) { parts.append(app) }
        if let code = call?.meetingCode { parts.append(code) }
        if let why = CallPageFacts.stopReason(call?.stopReason) { parts.append("ended: \(why)") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var chips: some View {
        let call = page.call
        if let voices = CallPageFacts.voices(transcript: page.transcript, audioTracks: page.session.source.audioTracks) { ChipView(text: voices) }
        if let scenes = page.frames?.sceneCount, scenes > 0 { ChipView(text: "\(scenes) scene\(scenes == 1 ? "" : "s")") }
        if !page.marks.isEmpty { ChipView(text: "\(page.marks.count) mark\(page.marks.count == 1 ? "" : "s")") }
        if page.session.source.kind != "upload" { ChipView(text: "Only on this Mac", tint: Theme.greenText, edge: Theme.greenEdge) }
        if call?.video == "none" { ChipView(text: "Audio only", tint: Theme.amberText, edge: Theme.greyEdge) }
        if call?.farEnd == "silent" { ChipView(text: "Others not heard", tint: Theme.redText, edge: Theme.redEdge) }
        if call?.short == true { ChipView(text: "Short", tint: Theme.soft, edge: Theme.greyEdge) }
        if call?.cut == true { ChipView(text: "Cut off", tint: Theme.amberText, edge: Theme.greyEdge) }
    }
}

// MARK: Scenes

private struct Scenes: View {
    let model: AppModel
    let page: CallPageData
    private let columns = Array(repeating: GridItem(.flexible(minimum: 110), spacing: 10, alignment: .top), count: 4)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Scenes · when the screen changed")
            if page.call?.video == "none" {
                NoteText("Audio only: the screen was not recorded" + (page.call?.videoNote.map { " (\($0))" } ?? "") + ".", tint: Theme.amberText)
            } else if let problem = page.framesProblem {
                NoteText(problem, tint: Theme.amberText)
            } else if let frames = page.frames {
                let scenes = frames.scenes
                let shown = scenes.isEmpty ? frames.frames : scenes
                if scenes.isEmpty { NoteText(shown.isEmpty ? "No frames were taken." : "No scene changes or marks; these are the bundle's other frames.") }
                LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                    ForEach(shown) { frame in Tile(model: model, page: page, frame: frame) }
                }
            } else {
                NoteText(page.building ? "The frames come when this step of the bundle is built." : "This bundle has no frames.json.")
            }
        }
    }
}

private struct Tile: View {
    let model: AppModel
    let page: CallPageData
    let frame: FramesFile.Frame

    var body: some View {
        Button { model.calls.openFile(FramesFile.largest(frame, in: page.dir)) } label: {
            VStack(alignment: .leading, spacing: 5) {
                ThumbnailView(url: FramesFile.thumbnail(frame, in: page.dir))
                    .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(frame.isMark ? Theme.amber : Theme.raised, lineWidth: frame.isMark ? 2 : 1))
                Text(label).font(Theme.mono(11)).foregroundStyle(frame.isMark ? Theme.amberText : Theme.soft).lineLimit(1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(frame.full == nil ? "Open this frame" : "Open the full-size frame")
        .accessibilityLabel("Frame at \(label)")
    }

    private var label: String {
        let clock = SessionClock.format(ms: frame.atMs)
        if frame.isMark {
            let note = page.marks.first { abs($0.atMs - frame.atMs) <= 1500 }?.note
            return "\(clock) · marked" + (note.map { ": \($0)" } ?? "")
        }
        return frame.word.map { "\(clock) · \($0)" } ?? clock
    }
}

// MARK: Transcript

private struct TranscriptSection: View {
    let page: CallPageData

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Transcript")
            if let problem = page.transcriptProblem {
                NoteText(problem, tint: Theme.amberText)
            } else if let transcript = page.transcript {
                if transcript.segments.isEmpty { NoteText("No speech was transcribed.") }
                let marked = CallPageFacts.markedLines(transcript.segments, marks: page.marks)
                LazyVStack(alignment: .leading, spacing: 9) {
                    ForEach(Array(transcript.segments.enumerated()), id: \.offset) { index, segment in
                        Line(segment: segment, marked: marked.contains(index))
                    }
                }
                if let dropped = transcript.bleedDropped, dropped > 0 {
                    NoteText("\(dropped) line\(dropped == 1 ? " was" : "s were") left out of Me: the others heard through the speakers.").padding(.top, 6)
                }
            } else {
                NoteText(page.building ? "The transcript comes when this step of the bundle is built." : "This bundle has no transcript.json.")
            }
        }
    }
}

private struct Line: View {
    let segment: TranscriptFile.Segment
    let marked: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(SessionClock.format(ms: segment.startMs)).font(Theme.mono(12)).foregroundStyle(marked ? Theme.amberText : Theme.muted)
                .frame(width: 56, alignment: .leading)
            Text(who).font(Theme.sans(12)).foregroundStyle(segment.speaker?.isMe == false ? Theme.blueText : Theme.amberText)
                .frame(width: 76, alignment: .leading)
            Text(segment.text.trimmingCharacters(in: .whitespacesAndNewlines)).font(Theme.sans(13)).lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        }
        .padding(.vertical, marked ? 4 : 0).padding(.horizontal, marked ? 4 : 0)
        .background(RoundedRectangle(cornerRadius: 6).fill(marked ? Theme.markFill : .clear))
    }

    private var who: String {
        let name = segment.who
        return marked ? (name.isEmpty ? "mark" : "\(name) · mark") : name
    }
}

// MARK: The bundle being built

private struct BuildCard: View {
    let model: AppModel
    let page: CallPageData

    var body: some View {
        let failed = page.session.failedSteps
        if page.building || !failed.isEmpty {
            Card {
                HStack {
                    SectionLabel("The bundle")
                    Spacer()
                    if page.building { StatusChip(text: processing ? "Building" : "Not finished", tone: .busy) }
                    else { StatusChip(text: "\(failed.count) step\(failed.count == 1 ? "" : "s") failed", tone: .bad) }
                }
                ForEach(BuildProgress.rows(session: page.session, processing: processing)) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(symbol(row.state)).foregroundStyle(tint(row.state)).frame(width: 14)
                        Text(row.label).font(Theme.sans(12)).foregroundStyle(row.state == .pending || row.state == .skipped ? Theme.soft : Theme.text)
                        Spacer(minLength: 4)
                    }
                    if row.state == .failed, let detail = row.detail { NoteText(detail, tint: Theme.redText).padding(.leading, 22) }
                }
                if page.building && !processing {
                    // Finish building runs process for the recording this session came from, unless polycap
                    // is already at it (a run the app left going when it quit, or a hook still running).
                    let busy = model.isStillRunning(session: page.session.id) || page.hookRuns?.runs.values.contains { $0.status == .running } == true
                    if let files = model.recording(forSession: page.session.id), !busy {
                        NoteText("Not being built now.")
                        WindowButton("Finish building") { model.retryHandoff(files) }
                    } else if busy {
                        NoteText("polycap is still working on it.")
                    } else {
                        NoteText("Not being built now. polycap process \(page.session.id) finishes it.")
                    }
                }
            }
        }
    }

    /// Whether the app's hand-off is running polycap process on this session right now.
    private var processing: Bool {
        if case .processing(let id, _)? = model.handoff.current?.stage { return id == page.session.id }
        return false
    }

    private func symbol(_ state: StepRow.State) -> String {
        switch state { case .done: "✓"; case .running: "◐"; case .pending: "○"; case .failed: "✕"; case .skipped: "–" }
    }

    private func tint(_ state: StepRow.State) -> Color {
        switch state { case .done: Theme.green; case .running: Theme.amberText; case .failed: Theme.redText; case .pending, .skipped: Theme.muted }
    }
}

// MARK: The routine

private struct RoutineSection: View {
    let model: AppModel
    let page: CallPageData

    var body: some View {
        let id = page.session.id
        let runs = (page.hookRuns?.runs ?? [:]).sorted { $0.key < $1.key }
        VStack(alignment: .leading, spacing: 10) {
            if let problem = page.hookRunsProblem {
                Card {
                    SectionLabel("Your routine")
                    NoteText(problem, tint: Theme.amberText)
                }
            } else if runs.isEmpty {
                Card {
                    HStack {
                        SectionLabel("Your routine")
                        Spacer()
                        StatusChip(text: page.building ? "Waiting" : "None ran", tone: .quiet)
                    }
                    NoteText(emptyText)
                    if !page.building, model.calls.hooks?.hooks.isEmpty == false {
                        WindowButton(model.calls.isRerunning(id, hook: nil) ? "Running…" : "Run routine") { model.calls.runAgain(id: id, hook: nil) }
                            .disabled(model.calls.isRerunning(id, hook: nil))
                    }
                }
            } else {
                ForEach(runs, id: \.key) { name, run in
                    RoutineCard(model: model, page: page, name: name, run: run)
                }
            }
            if let note = model.calls.rerunNote[id] { NoteText(note, tint: Theme.amberText) }
        }
    }

    private var emptyText: String {
        if page.building { return "Runs when the bundle is ready." }
        if page.call?.short == true { return "Not run: the call is marked short (under 2 minutes, most likely a lobby preview)." }
        if let problem = model.calls.hooksProblem { return "The hooks could not be listed: \(problem)" }
        if let hooks = model.calls.hooks, hooks.hooks.isEmpty { return "No routine set up. Settings, When a call is ready, says how." }
        return "No routine ran for this call."
    }
}

private struct RoutineCard: View {
    let model: AppModel
    let page: CallPageData
    let name: String
    let run: HookRuns.Run
    @State private var copied = false

    var body: some View {
        let hook = model.calls.hooks?.hook(named: name)
        let resume = ResumeCommand.make(agentSessionId: run.agentSessionId, hookCwd: hook?.cwd)
        let id = page.session.id
        Card {
            HStack {
                SectionLabel("Your routine")
                Spacer()
                StatusChip(text: run.statusLabel, tone: tone)
            }
            HStack(spacing: 4) {
                Text(name).font(Theme.sans(13))
                if let cwd = hook?.cwd {
                    Text("in").font(Theme.sans(13)).foregroundStyle(Theme.muted)
                    Text(cwd).font(Theme.mono(12)).lineLimit(1).truncationMode(.middle)
                }
            }
            Text(timing).font(Theme.sans(12)).foregroundStyle(Theme.muted)
            if let note = run.note { NoteText(note) }
            if let resume {
                Text(resume).font(Theme.mono(11)).foregroundStyle(Theme.soft).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.field))
                if model.calls.hooks == nil { NoteText("Run it in the hook's folder; the hooks could not be listed to say which.") }
            }
            HStack(spacing: 8) {
                if let resume {
                    FilledButton(copied ? "Copied" : "Copy resume command") {
                        model.calls.copy(resume)
                        copied = true
                        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
                    }
                }
                WindowButton(model.calls.isRerunning(id, hook: name) ? "Running…" : "Run again") { model.calls.runAgain(id: id, hook: name) }
                    .disabled(model.calls.isRerunning(id, hook: name) || run.status == .running)
                    .help("polycap hooks run \(id) --hook \(name) --force")
            }
            if let log = run.log, BundlePath.isSafe(log, maxComponents: 2) {
                LinkButton("Open the log") { model.calls.openFile(page.dir.appendingPathComponent(log)) }
            }
        }
    }

    private var tone: StatusChip.Tone {
        switch run.status {
        case .done: .good
        case .running: .busy
        case .failed, .timeout: .bad
        case .skipped: .quiet
        }
    }

    private var timing: String {
        let started = MetaTime.parse(run.startedAt)
        var parts = ["Started \(Clock.time(started))"]
        if let duration = run.duration { parts.append("took \(durationText(duration))") }
        else if run.status == .running, let started { parts.append("running for \(durationText(Date().timeIntervalSince(started)))") }
        if let code = run.exitCode { parts.append("exit \(code)") }
        if let signal = run.signal { parts.append(signal) }
        return parts.joined(separator: " · ")
    }
}

// MARK: Files

private struct BundleFiles: View {
    let model: AppModel
    let page: CallPageData

    var body: some View {
        Card {
            SectionLabel("In the bundle")
            if let storyboard = page.storyboard { FileRow(name: "storyboard.md", detail: "reading order") { model.calls.openFile(storyboard) } }
            if let lines = page.transcriptLines {
                FileRow(name: "transcript.md", detail: "\(lines) lines") { model.calls.openFile(page.dir.appendingPathComponent("transcript.md")) }
            }
            if let frames = page.frames {
                let scenes = frames.sceneCount
                FileRow(name: "frames/", detail: scenes > 0 ? "\(scenes) scenes, \(frames.frames.count) frames" : "\(frames.frames.count) frames") {
                    model.calls.openFolder(page.dir.appendingPathComponent("frames"))
                }
            }
            if let video = page.session.media?.video, BundlePath.isSafe(video) {
                FileRow(name: video, detail: Clock.size(page.videoBytes) ?? "") { model.calls.openFile(page.dir.appendingPathComponent(video)) }
            }
            HStack(spacing: 8) {
                WindowButton("Open folder") { model.calls.openFolder(page.dir) }
                WindowButton("Open storyboard.md") { if let storyboard = page.storyboard { model.calls.openFile(storyboard) } }.disabled(page.storyboard == nil)
            }
            .padding(.top, 4)
            Text(page.session.id).font(Theme.mono(10)).foregroundStyle(Theme.muted).textSelection(.enabled)
        }
    }
}

private struct FileRow: View {
    let name: String
    let detail: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack {
                Text(name).font(Theme.sans(12)).foregroundStyle(Theme.text)
                Spacer()
                Text(detail).font(Theme.sans(12)).foregroundStyle(Theme.muted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
