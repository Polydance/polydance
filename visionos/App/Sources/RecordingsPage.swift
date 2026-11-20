// Recordings (InboxPane's page, from the drawer, the tape's list key or "N recordings haven't gone up"): each take on
// this headset with its time, length, size and where it goes, and its state as the headset says it: RECORDING,
// WAITING with the hold's countdown, UPLOADING with the Quest's twenty segments and how much, how fast and how long,
// or that nothing has moved and why (UploadStrip, since 2026-11-15), PROCESSING, ON SERVER, FAILED with the
// reason, CUT OFF, ON THIS HEADSET. Send now (also during the hold), Retry and Delete (refused while it uploads; the
// receiver's copy is not touched). Reports are not listed: they leave the headset once sent.
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct RecordingsPage: View {
    @ObservedObject var model: HeadsetModel
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                IconKey(.close, color: Palette.tan, label: "Close Recordings") { model.detail = nil }
                LabelText("Recordings on this headset", size: 15, color: Palette.whitePrint, tracking: 0.16)
                Spacer()
            }
            if let problem { Text(problem).font(Theme.sans(15)).foregroundStyle(Palette.red) }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                ScrollView {
                    VStack(spacing: 8) {
                        let takes = model.runs.filter { (try? $0.readThread())?.isReport != true }
                        if takes.isEmpty {
                            Text("No recordings on this headset. A take goes to the receiver as soon as it stops, and leaves Polydance's list here when it is deleted.")
                                .font(Theme.sans(16)).foregroundStyle(Palette.tan).fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ForEach(takes) { run in row(run, now: context.date) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .plate(padding: 18)
        .onAppear { model.reloadRuns() }
    }

    private func row(_ run: RunFolder, now: Date) -> some View {
        let meta = model.metas[run.name]
        let state = model.parts?.uploads.states[run.name]
        let progress = model.holds[run.name] == nil ? model.parts?.uploads.progress(run.name, at: now) : nil
        let (word, color) = status(run, meta: meta, state: state, progress: progress, now: now)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text(when(meta)).font(Theme.sans(16, .semibold)).foregroundStyle(Palette.whitePrint)
                Text(details(meta)).font(Theme.sans(14)).foregroundStyle(Palette.tan)
                Spacer()
                LabelText(word, size: 12, color: color, tracking: 0.12)
            }
            if let progress { UploadLines(progress: progress) }
            Text(destination(run)).font(Theme.sans(14)).foregroundStyle(Palette.tan)
            if let error = state?.error, state?.phase == .failed { Text(error).font(Theme.sans(14)).foregroundStyle(Palette.red) }
            HStack(spacing: 10) {
                if state == nil || state?.phase == .failed {
                    Button(state?.phase == .failed ? "Retry" : "Send now") { model.sendNow(run) }
                        .buttonStyle(KeyStyle(color: Palette.amber)).disabled(!model.paired)
                }
                Button("Delete") { problem = model.deleteRun(run) }.buttonStyle(KeyStyle(color: Palette.red))
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.edge))
    }

    private func status(_ run: RunFolder, meta: RunMeta?, state: UploadRunState?, progress: UploadProgress?, now: Date) -> (String, Color) {
        if let until = model.holds[run.name] { return ("Waiting \(max(0, Int(until.timeIntervalSince(now).rounded(.up)))) s", Palette.amber) }
        if let progress { return (UploadLines.word(progress), UploadLines.color(progress)) }
        if let state {
            switch state.phase {
            // A part under way always has progress; this is only if that ever changes.
            case .narration, .content: return ("Uploading", Palette.led)
            case .done:
                let server = model.serverStatus[run.name] ?? state.serverStatus ?? "received"
                if server == "ready" { return ("On server", Palette.green) }
                if server == "failed" { return ("Failed on server", Palette.red) }
                return ("Processing", Palette.processing)
            case .failed: return ("Failed", Palette.red)
            }
        }
        if meta?.cut == true { return ("Cut off", Palette.red) }
        return ("On this headset", Palette.tan)
    }

    private func when(_ meta: RunMeta?) -> String {
        guard let meta, let date = ReportPolicy.date(meta.recordedAt) else { return "A take" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func details(_ meta: RunMeta?) -> String {
        guard let meta else { return "" }
        var parts: [String] = []
        if let ms = meta.durationMs { parts.append(String(format: "%d:%02d", ms / 60_000, (ms / 1000) % 60)) }
        if let bytes = meta.bytes { parts.append(String(format: "%.0f MB", Double(bytes) / 1_000_000)) }
        if meta.width > 0 { parts.append("\(meta.width) × \(meta.height)") }
        parts.append(meta.audioTracks.joined(separator: " + "))
        return parts.joined(separator: " · ")
    }

    private func destination(_ run: RunFolder) -> String {
        switch try? run.readThread() {
        case .reply(let key, let replyTo)?:
            return "→ \(key) · \(model.title(of: key))" + (replyTo?.launch.map { " · option \($0 + 1)" } ?? "")
        case .newThread(let project)?: return "→ New thread · \(model.projectName(project))"
        case .report?: return "→ Report"
        case nil: return "→ Kept on this headset until sent"
        }
    }
}
