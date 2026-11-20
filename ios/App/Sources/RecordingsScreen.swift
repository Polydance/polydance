// Recordings (docs/IPHONE.md S5), from the drawer or the tape's list key: each take on this phone with its
// size and its state in words: RECORDING, UPLOADING with the transfer strip and how much, how fast and how
// long (or that nothing has moved, and why: UploadProgress), ON SERVER, FAILED with the
// reason, CUT OFF for one the app did not finish, or ON THIS PHONE when it has not been sent. Send now,
// Retry and Delete (this phone's copy, after a confirmation). The states are the I0 probe's uploads to its
// configured receiver; the hold after Stop (WAITING) and PROCESSING come with I2.
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct RecordingsScreen: View {
    @ObservedObject var deck: DeckModel
    @State private var deleting: Row?
    @State private var problem: String?

    /// A take as the page shows it, from the probe's runs and uploads or from samples.
    struct Row: Identifiable, Equatable {
        enum State: Equatable { case recording, uploading(UploadProgress), onServer(String), failed(String), cutOff, onPhone }
        let id: String
        let when: String
        let bytes: Int64
        let state: State
        let canSend: Bool
        let canDelete: Bool
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                IconKey(.back, color: Palette.burnt, label: "Back") { deck.path.removeLast() }
                LabelText("Recordings", size: 14, color: Palette.burnt, tracking: 0.2)
                Spacer()
            }
            .padding(.horizontal, 6)
            ScrollView {
                VStack(spacing: 8) {
                    if let problem { Text(problem).font(Theme.sans(13)).foregroundStyle(Palette.burnt).frame(maxWidth: .infinity, alignment: .leading) }
                    // Once a second, so an upload's strip, rate and time left move while the page is open.
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let rows = self.rows(at: context.date)
                        VStack(spacing: 8) {
                            if rows.isEmpty {
                                Text("No takes on this phone yet. Press REC on the deck to record one.")
                                    .font(Theme.sans(14)).foregroundStyle(Palette.burnt).frame(maxWidth: .infinity, alignment: .leading).padding(8)
                            }
                            ForEach(rows) { row in card(row) }
                        }
                    }
                    if deck.probe.parts?.uploads.configured != true, !deck.samples {
                        Text("This phone is not paired, so Send now has nowhere to send. Pair it behind the gear: Pair with the Mac.")
                            .font(Theme.sans(13)).foregroundStyle(Palette.burnt).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
                    }
                }
                .padding(10)
            }
        }
        .background(Wood().ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .overlay {
            if let row = deleting {
                PlateDialog(title: "Delete this take from the phone?",
                            text: "\(row.when), \(Self.megabytes(row.bytes)). It cannot be undone. A copy already on the receiver stays there.",
                            keys: [.init(title: "Keep it", action: { deleting = nil }),
                                   .init(title: "Delete", color: Palette.red, action: { delete(row) })],
                            dismiss: { deleting = nil })
            }
        }
    }

    private func card(_ row: Row) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.when).font(Theme.sans(15, .semibold)).foregroundStyle(Palette.whitePrint)
                Spacer()
                Text(Self.megabytes(row.bytes)).font(Theme.sans(13)).foregroundStyle(Palette.tan)
            }
            HStack(spacing: 8) {
                tag(row.state)
                if case .uploading(let p) = row.state, p.stage == .video {
                    LabelText(p.percent, size: 13, color: p.isStuck ? Palette.amber : Palette.led, tracking: 0.1)
                }
                Text(detail(row.state)).font(Theme.sans(13)).foregroundStyle(Palette.tan).lineLimit(2)
            }
            if case .uploading(let p) = row.state {
                TransferStrip(fraction: p.fraction, stuck: p.isStuck)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(p.line)
                if let pace = p.pace {
                    Text(pace).font(Theme.sans(13)).foregroundStyle(p.isStuck ? Palette.amber : Palette.cream)
                }
            }
            HStack(spacing: 10) {
                Spacer()
                if row.canSend {
                    let retry = { if case .failed = row.state { return true } else { return false } }()
                    Button(retry ? "Retry" : "Send now") { send(row) }.buttonStyle(KeyStyle(color: Palette.amber))
                }
                if row.canDelete { Button("Delete") { deleting = row }.buttonStyle(KeyStyle(color: Palette.red)) }
            }
        }
        .plate(screws: false, padding: 14)
    }

    private func tag(_ state: Row.State) -> Tag {
        switch state {
        case .recording: Tag(text: "Recording", color: Palette.red)
        case .uploading: Tag(text: "Uploading", color: Palette.led)
        case .onServer: Tag(text: "On server", color: Palette.green)
        case .failed: Tag(text: "Failed", color: Palette.red)
        case .cutOff: Tag(text: "Cut off", color: Palette.amber)
        case .onPhone: Tag(text: "On this phone", color: Palette.tan)
        }
    }

    private func detail(_ state: Row.State) -> String {
        switch state {
        case .recording: "being recorded now"
        case .uploading(let p): p.stage == .video ? p.amount : p.line
        case .onServer(let status): "the receiver has it (\(status))"
        case .failed(let why): why
        case .cutOff: "not finished by the app; it plays to its last 10 s"
        case .onPhone: "not sent yet"
        }
    }

    // MARK: The rows

    private func rows(at now: Date) -> [Row] {
        if deck.samples { return Self.samples(stuck: deck.look.stuck) }
        guard let parts = deck.probe.parts else { return [] }
        let configured = parts.uploads.configured
        return deck.probe.runs.map { run in
            let name = run.run.name
            let live = name == parts.recorder.currentRunName
            let upload = parts.uploads.states[name]
            let state: Row.State
            if live { state = .recording }
            else if let progress = parts.uploads.progress(name, at: now) { state = .uploading(progress) }
            else if let upload {
                switch upload.phase {
                case .done: state = .onServer(upload.serverStatus ?? "received")
                case .failed: state = .failed(upload.error ?? "the reason was not kept")
                // A part under way always has progress; this is only if that ever changes.
                case .narration, .content: state = .uploading(UploadProgress(stage: .preparing))
                }
            } else if let status = parts.uploads.statuses[name], status.hasPrefix("failed: ") {
                state = .failed(String(status.dropFirst(8)))
            } else { state = run.cut ? .cutOff : .onPhone }
            let busy: Bool = { switch state { case .recording, .uploading: true; default: false } }()
            let sent: Bool = { if case .onServer = state { return true } else { return false } }()
            return Row(id: name, when: Self.when(name) + (run.isReport ? " · report" : run.thread?.key.map { " · \($0)" } ?? ""), bytes: run.bytes, state: state,
                       canSend: configured && !busy && !sent, canDelete: !busy)
        }
    }

    private func send(_ row: Row) {
        problem = nil
        guard !deck.samples, let run = deck.probe.runs.first(where: { $0.run.name == row.id })?.run else { return }
        deck.probe.parts?.uploads.upload(run)
    }

    private func delete(_ row: Row) {
        deleting = nil
        guard !deck.samples, let found = deck.probe.runs.first(where: { $0.run.name == row.id }) else { return }
        problem = deck.probe.delete(found)
    }

    /// "Sat 7 Nov, 14:05" from a run's name (yyyyMMdd-HHmmss in the phone's local time, docs/IPHONE.md U6).
    static func when(_ runName: String) -> String {
        let parse = DateFormatter()
        parse.locale = Locale(identifier: "en_US_POSIX")
        parse.dateFormat = "yyyyMMdd-HHmmss"
        let stamp = runName.split(separator: "-").suffix(2).joined(separator: "-")
        guard let date = parse.date(from: stamp) else { return runName }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) + ", " + Clock.time(date)
    }

    static func megabytes(_ bytes: Int64) -> String { String(format: "%.1f MB", Double(bytes) / 1_000_000) }

    static func samples(stuck: Bool) -> [Row] { [
        Row(id: "s1", when: "Sat 7 Nov, 15:51 · CAP-12", bytes: 1_087_200_000,
            state: .uploading((stuck ? Samples.stuckUpload : Samples.upload).progress), canSend: false, canDelete: false),
        Row(id: "s2", when: "Sat 7 Nov, 14:05", bytes: 118_200_000, state: .onServer("ready"), canSend: false, canDelete: true),
        Row(id: "s3", when: "Sat 7 Nov, 11:40", bytes: 9_800_000, state: .failed("the receiver was not reachable"), canSend: true, canDelete: true),
        Row(id: "s4", when: "Fri 6 Nov, 22:12", bytes: 33_000_000, state: .cutOff, canSend: true, canDelete: true),
        Row(id: "s5", when: "Fri 6 Nov, 18:30", bytes: 24_500_000, state: .onPhone, canSend: true, canDelete: true),
    ] }
}
