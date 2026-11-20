// A thread, in the inbox's right-hand column (InboxPane's thread view): close, Archive and Delete along the top, the
// title with its project and key, earlier messages folded to a line each (one tap reads it whole) and the latest open
// in full, with the sender's circle, the reactions (React adds this headset's; the same again takes it off), a
// recording's title and summary, and the launches: the 3D model a launch names drawn above its keys (ModelViewer),
// the stars (Pick), Record and open (the take begins, then the links open into it, as on the Quest) and Just open.
// This headset's own take still on its way shows how much has gone, how fast and how long, or that nothing has moved
// and why (UploadStrip), in its message or, before the receiver has one, on a card of its own at the foot.
// Reply, with the red camera, is fixed along the foot. Steps that open an Android app or check one are the Quest's
// and are said to be; a launch with only those still records.
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct ThreadPage: View {
    @ObservedObject var model: HeadsetModel
    let key: String
    @State private var expanded: Set<Int> = []
    @State private var deleteAsked = false

    private var detail: ThreadDetail? { model.details[key] }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                IconKey(.close, color: Palette.burnt, label: "Close the thread") { model.detail = nil }
                Spacer()
                IconKey(model.isArchived(key) ? .unarchive : .archive, color: Palette.burnt,
                        label: model.isArchived(key) ? "Move to the inbox" : "Archive") { model.archive(key) }
                IconKey(.trash, color: Palette.red, label: "Delete from this inbox") { deleteAsked = true }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    LabelText("\(detail?.project.name ?? "") · \(key)", size: 12, color: Palette.tan, tracking: 0.14)
                    if model.isArchived(key) { Tag(text: "Archived") }
                    if detail?.hidden == true { Tag(text: "Not in your inbox") }
                }
                Text(model.title(of: key)).font(Theme.sans(26, .semibold)).foregroundStyle(Palette.whitePrint)
                    .fixedSize(horizontal: false, vertical: true)
                if let problem = model.threadProblems[key] {
                    Text(problem).font(Theme.sans(15)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .plate(screws: false, padding: 16)
            .padding(.bottom, 6)
            ScrollViewReader { scroll in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if let detail {
                            let messages = detail.ordered
                            ForEach(messages.dropLast()) { message in
                                if expanded.contains(message.id) {
                                    MessageCard(model: model, key: key, message: message, latest: false)
                                        .onTapGesture { expanded.remove(message.id) }
                                } else {
                                    FoldedMessage(message: message) { expanded.insert(message.id) }
                                }
                            }
                            if let last = messages.last {
                                MessageCard(model: model, key: key, message: last, latest: true).id("latest")
                            }
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                VStack(alignment: .leading, spacing: 10) {
                                    ForEach(model.takesOnTheirWay(to: key, at: context.date)) { take in PendingCard(model: model, take: take) }
                                }
                            }
                        } else {
                            Text(model.paired ? (model.threadProblems[key] == nil ? "Reading the thread…" : "The thread could not be read. Pull down to try again.")
                                              : "This thread's messages come from the receiver once the headset is paired.")
                                .font(Theme.sans(16)).foregroundStyle(Palette.burnt).padding(8)
                        }
                    }
                    .padding(.vertical, 10)
                }
                .defaultScrollAnchor(.bottom)
                .refreshable { await model.loadThread(key, markRead: true) }
            }
            Button { model.reply(to: key) } label: {
                HStack(spacing: 12) {
                    Glyph(.reply, color: Palette.cream, size: 24)
                    Text("Reply").font(Theme.label(17)).tracking(1.5).textCase(.uppercase)
                    Glyph(.camera, color: Palette.red, size: 24)
                }
                .foregroundStyle(Palette.cream)
                .frame(maxWidth: .infinity).padding(.vertical, 15)
                .background(Pill().fill(Palette.panel))
                .overlay(Pill().stroke(Palette.edge, lineWidth: 1.5))
                .contentShape(Pill())
            }
            .buttonStyle(.plain)
            .hoverEffect(.lift)
            .disabled(model.isRecording || model.isBusy)
            .padding(.top, 8)
            .accessibilityLabel("Reply: record a reply to this thread")
        }
        .overlay {
            if deleteAsked {
                PlateDialog(title: "Delete \(key) from this inbox?",
                            text: "It goes from this headset's list. The thread stays on the receiver for everyone else in it, and comes back when someone adds to it.",
                            keys: [.init(title: "Keep it", action: { deleteAsked = false }),
                                   .init(title: "Delete", color: Palette.red, action: { deleteAsked = false; model.delete(key) })],
                            dismiss: { deleteAsked = false })
            }
        }
    }
}

/// An earlier message in one line: who, what, when.
private struct FoldedMessage: View {
    let message: ThreadMessage
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Avatar(name: message.by.name, size: 24)
                Text(message.by.who).font(Theme.sans(15, .semibold)).foregroundStyle(Palette.cream).lineLimit(1).layoutPriority(1)
                Text(message.oneLine).font(Theme.sans(15)).foregroundStyle(Palette.tan).lineLimit(1)
                if message.launches?.contains(where: { $0.steps.contains { if case .model = $0 { true } else { false } } }) == true { Tag(text: "3D") }
                if message.recording != nil { Tag(text: "● Rec", color: Palette.red) }
                if (message.launches?.count ?? 0) > 1 { Tag(text: "\(message.launches!.count) options", color: Palette.amber) }
                Spacer(minLength: 6)
                Text(Clock.when(message.at)).font(Theme.sans(14)).foregroundStyle(Palette.tan)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 3).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Palette.edge))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityHint("Read it in full")
    }
}

private struct MessageCard: View {
    @ObservedObject var model: HeadsetModel
    let key: String
    let message: ThreadMessage
    let latest: Bool
    @State private var reacting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Avatar(name: message.by.name, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(message.by.who).font(Theme.sans(16, .semibold)).foregroundStyle(Palette.whitePrint)
                    Text("#\(message.id) · \(Clock.when(message.at))").font(Theme.sans(14)).foregroundStyle(Palette.tan)
                }
                Spacer()
                if message.launches?.isEmpty == false { Tag(text: "To try", color: Palette.amber) }
                Button { reacting.toggle() } label: { Glyph(.smile, color: Palette.tan, size: 24).frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .accessibilityLabel(reacting ? "Close the reactions" : "React to this message")
            }
            if reacting {
                HStack(spacing: 8) {
                    ForEach(ThreadRequests.reactions, id: \.self) { name in
                        let mine = model.myReaction(key, on: message) == name
                        Button {
                            reacting = false
                            model.react(key, message: message.id, reaction: name)
                        } label: {
                            Text(ThreadMessage.reactionSymbols[name] ?? name).font(.system(size: 26))
                                .frame(width: 52, height: 46)
                                .background(RoundedRectangle(cornerRadius: 10).fill(mine ? Palette.surface : Color.clear))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(mine ? Palette.amber : Palette.edge, lineWidth: mine ? 2 : 1))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                        .accessibilityLabel(mine ? "\(name), yours; press to take it off" : name)
                    }
                    Button("Close") { reacting = false }.buttonStyle(KeyStyle(color: Palette.tan))
                }
            }
            if let text = message.text, !text.isEmpty {
                Text(text).font(Theme.sans(17)).foregroundStyle(Palette.cream).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
            }
            if !message.photos.isEmpty {
                Text(message.canView ? (message.photos.count == 1 ? "A photo, not shown on this headset yet." : "\(message.photos.count) photos, not shown on this headset yet.")
                                     : "Only members of this thread can see its photos.")
                    .font(Theme.sans(14)).foregroundStyle(Palette.hint)
            }
            // The Welcome's answer says an agent can read all this; here is where one is connected (pick D, 2026-11-20).
            if model.agentsOn, AgentWords.isWelcomeAnswer(message) { AgentInline(model: model) }
            if let recording = message.recording { RecordingLine(model: model, recording: recording) }
            if let launches = message.launches, !launches.isEmpty {
                ForEach(Array(launches.enumerated()), id: \.offset) { index, launch in
                    LaunchCard(model: model, key: key, message: message, index: index, launch: launch, count: launches.count, latest: latest)
                }
            }
            if !message.reactions.isEmpty {
                HStack(spacing: 14) {
                    ForEach(Array(message.reactions.enumerated()), id: \.offset) { _, reaction in
                        HStack(spacing: 4) {
                            Text(ThreadMessage.reactionSymbols[reaction.reaction] ?? reaction.reaction).font(.system(size: 16))
                            Text(reaction.by.who).font(Theme.sans(14)).foregroundStyle(Palette.tan)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .plate(screws: latest, padding: 16)
    }
}

private struct RecordingLine: View {
    @ObservedObject var model: HeadsetModel
    let recording: ThreadMessage.Recording

    var body: some View {
        // This headset's own take still being sent: its share and pace, each second, as the Quest's message shows them.
        if let run = model.sending(uploadId: recording.uploadId) {
            TimelineView(.periodic(from: .now, by: 1)) { context in content(model.parts?.uploads.progress(run, at: context.date)) }
        } else {
            content(nil)
        }
    }

    private func content(_ progress: UploadProgress?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Glyph(.camera, color: Palette.red, size: 18)
                LabelText(line(progress), size: 12,
                          color: progress.map(UploadLines.color) ?? (recording.status == "failed" ? Palette.red : Palette.tan), tracking: 0.12)
            }
            if let progress { UploadLines(progress: progress) }
            if let title = recording.title { Text("“\(title)”").font(Theme.sans(17, .medium)).foregroundStyle(Palette.whitePrint) }
            if let summary = recording.summary {
                Text(summary).font(Theme.sans(15)).foregroundStyle(Palette.cream).fixedSize(horizontal: false, vertical: true)
            }
            if let error = recording.error { Text(error).font(Theme.sans(15)).foregroundStyle(Palette.red) }
        }
    }

    private func line(_ progress: UploadProgress?) -> String {
        var parts = [recording.kindWord]
        if let ms = recording.durationMs { parts.append(String(format: "%d:%02d", ms / 60_000, (ms / 1000) % 60)) }
        if let logs = recording.logsWord { parts.append(logs) }
        if let progress { parts.append(UploadLines.word(progress)) }
        else if let status = recording.status, status != "ready" { parts.append(status) }
        if let replyTo = recording.replyTo, let launch = replyTo.launch { parts.append("answers option \(launch + 1)") }
        return parts.joined(separator: " · ")
    }
}

/// A reply of this headset's that the receiver has no message for yet (InboxPane's pendingCard): the hold's countdown
/// with Send now, or how its upload is going.
private struct PendingCard: View {
    @ObservedObject var model: HeadsetModel
    let take: HeadsetModel.TakeOnItsWay

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Avatar(name: "You", size: 24)
                Text("You · not on the receiver yet").font(Theme.sans(15, .semibold)).foregroundStyle(Palette.cream)
            }
            HStack(spacing: 6) {
                Glyph(.camera, color: Palette.red, size: 18)
                LabelText(line, size: 12, color: take.progress.map(UploadLines.color) ?? Palette.amber, tracking: 0.12)
            }
            if let progress = take.progress { UploadLines(progress: progress) }
            if take.held != nil {
                Button("Send now") { model.sendNow(take.run) }.buttonStyle(KeyStyle(color: Palette.amber)).disabled(!model.paired)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .plate(screws: false, padding: 16)
    }

    private var line: String {
        var parts = ["Recording"]
        if let ms = model.metas[take.run.name]?.durationMs { parts.append(String(format: "%d:%02d", ms / 60_000, (ms / 1000) % 60)) }
        if let held = take.held { parts.append("sends in \(held) s") }
        else if let progress = take.progress { parts.append(UploadLines.word(progress)) }
        return parts.joined(separator: " · ")
    }
}

/// One of a message's launches: its title, the model it shows, its steps in words, the stars, Record and open, Just open,
/// and Settings with the take's Mic and App sound.
private struct LaunchCard: View {
    @ObservedObject var model: HeadsetModel
    let key: String
    let message: ThreadMessage
    let index: Int
    let launch: Launch
    let count: Int
    let latest: Bool
    /// Settings folded away by default (InboxPane.launchRow); open, it holds Mic and App sound.
    @State private var settings = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(launch.title(index: index, of: count)).font(Theme.sans(17, .semibold)).foregroundStyle(Palette.whitePrint)
                Spacer()
                if latest {
                    let mine = model.isPicked(key, message: message, launch: index)
                    Button { model.togglePick(key, message: message.id, launch: index) } label: {
                        HStack(spacing: 6) {
                            Glyph(mine ? .starFilled : .star, color: Palette.amber, size: 24)
                            LabelText(mine ? "Picked" : "Pick", size: 12, color: Palette.amber, tracking: 0.1)
                        }
                        .frame(height: 44).padding(.horizontal, 6).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .accessibilityLabel(mine ? "Picked; press to take the star off" : "Pick this one")
                }
            }
            ForEach(Array(launch.steps.enumerated()), id: \.offset) { _, step in
                if case .model(let name, let bytes, let sha256) = step, let sha256 {
                    ModelViewer(model: model, key: key, name: name, bytes: bytes, sha256: sha256)
                }
            }
            ForEach(Array(launch.steps.enumerated()), id: \.offset) { _, step in
                Text(Self.visionText(step)).font(Theme.sans(15)).foregroundStyle(Palette.tan).lineLimit(2).truncationMode(.middle)
            }
            let stars = message.picks.filter { $0.launch == index }.map(\.by.who)
            if !stars.isEmpty { Text("★ " + stars.joined(separator: ", ")).font(Theme.sans(15)).foregroundStyle(Palette.amber) }
            HStack(spacing: 12) {
                Button { model.recordAndOpen(key, message: message, index: count > 1 ? index : nil, launch: launch) } label: {
                    HStack(spacing: 8) {
                        Glyph(.camera, color: Palette.red, size: 22)
                        Text(launch.macLinks.isEmpty ? "Record" : "Record and open").font(Theme.label(15)).textCase(.uppercase)
                    }
                }
                .buttonStyle(KeyStyle(small: false, fill: true))
                .disabled(model.isBusy || (model.isRecording && model.target == .report))
                .accessibilityLabel(launch.macLinks.isEmpty ? "Record a reply to this" : "Record, then open \(launch.macLinks.first.map(LaunchLink.short) ?? "")")
                if !launch.macLinks.isEmpty {
                    Button("Just open") { model.justOpen(key, message: message, index: count > 1 ? index : nil, launch: launch) }
                        .buttonStyle(KeyStyle(small: false))
                        .accessibilityLabel("Just open \(launch.macLinks.first.map(LaunchLink.short) ?? ""), without recording")
                }
                // A dot marks a sound switched off, as on the headset.
                let changed = !model.mic || !model.appSound
                Button("\(settings ? "▴" : "▾")  Settings\(changed ? "  •" : "")") { settings.toggle() }
                    .buttonStyle(KeyStyle(color: changed ? Palette.amber : Palette.tan))
                    .accessibilityLabel(settings ? "Close the recording settings" : "Recording settings: the microphone and the app's sound")
            }
            Text(describe).font(Theme.sans(14)).foregroundStyle(Palette.hint).fixedSize(horizontal: false, vertical: true)
            if settings {
                // The deck's own meter switches: changed here, they change there too, for every launch.
                HStack(spacing: 8) {
                    LabelText("Record", size: 12, color: Palette.tan, tracking: 0.16).frame(width: 76, alignment: .leading)
                    SoundChip(label: "Mic", on: $model.mic)
                    SoundChip(label: "App sound", on: $model.appSound)
                    Spacer(minLength: 0)
                }
                .disabled(model.isRecording || model.isBusy)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Palette.casing))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.edge))
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.edge))
    }

    /// The describe line under the keys, as the headset's Threads.describe says it, with the sounds the take records.
    private var describe: String {
        let hosts = launch.macLinks.map { "\($0.host ?? LaunchLink.short($0)) in Safari" }
        let models = launch.steps.compactMap { if case .model(let name, _, let sha) = $0, sha != nil { "\(name) in 3D" } else { nil } }
        let goes = hosts + models
        if model.isRecording, !hosts.isEmpty { return "Opens \(hosts.joined(separator: ", then ")) into the recording that is running." }
        let records = switch (model.mic, model.appSound) {
        case (true, true): "records"
        case (true, false): "records without the app's sound"
        case (false, true): "records without the mic"
        case (false, false): "records the picture only"
        }
        let does = goes.isEmpty ? "\(records) here; nothing else opens" : "\(records), then opens \(goes.joined(separator: ", then "))"
        return (launch.label.map { "\($0): " } ?? "") + does.prefix(1).uppercased() + does.dropFirst()
    }

    /// A step in words on the Vision Pro: links open in Safari and models show above; Android steps are the Quest's.
    static func visionText(_ step: LaunchStep) -> String {
        switch step {
        case .open(let url):
            guard let link = LaunchLink.https(url) else { return "Not opened: \(url) is not an https link" }
            return "Opens \(LaunchLink.short(link))"
        case .app(let package, let activity, _):
            return "Quest and Android XR only: opens the app \(package)\(activity.map { "/\($0)" } ?? "")"
        case .require(let package, _, _, _):
            return "Quest and Android XR only: needs \(package)"
        case .model(let name, let bytes, let sha256):
            return sha256 == nil ? "A 3D model the receiver did not name properly: \(name)" : "Shows the 3D model \(name) (\(LaunchLink.megabytes(bytes))) above"
        case .unknown(let kind):
            return "Not on this Polydance: a \(kind) step (a newer Polydance may know it)"
        }
    }
}

/// One of the launch's sound switches: lit amber with a tick when on, as the headset's chip.
private struct SoundChip: View {
    let label: String
    @Binding var on: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button { on.toggle() } label: {
            LabelText(on ? "✓  \(label)" : label, size: 13, color: on ? Palette.casing : Palette.tan, tracking: 0.06)
                .lineLimit(1).fixedSize()
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 16).fill(on ? Palette.amber : Palette.casing))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(on ? Palette.amber : Palette.edge, lineWidth: 1))
                .opacity(enabled ? 1 : 0.45)
                .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(label)
        .accessibilityValue(on ? "on" : "off")
    }
}
