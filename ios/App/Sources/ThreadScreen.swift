// A thread (docs/IPHONE.md S4), opened over the deck and inbox: back, Archive and Delete (from this inbox)
// along the top on the wood, the title with its project and key on a black plate, earlier messages folded
// to a line each (tap one to read it whole) and the latest open in full, with the sender's circle, its
// reactions (React adds this phone's, the same again takes it off), and its launches with their stars
// (Pick) and Just open for a link (L1: open only; the headset's steps are said to be the headset's).
// Record and open, the main key on the headset and the Mac, is not drawn: iOS stops the camera once Safari
// is in front, so it waits for screen recording (I4). Reply, with the red camera, is fixed along the foot
// and opens the camera aimed at the thread, on Photo with Video beside it (Robin, 2026-11-13). A message's
// photos are drawn as tiles, fetched through the thread and checked against their sha256, and open large when
// pressed. Since I3 everything here is the receiver's (DeckModel), and pulling down reads it again. No typed
// reply without a photo, player or 3D (Robin, 2026-11-06).
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct ThreadScreen: View {
    @ObservedObject var deck: DeckModel
    let key: String
    @State private var expanded: Set<Int> = []
    @State private var deleteAsked = false

    private var detail: ThreadDetail? { deck.details[key] }
    private var summary: ThreadSummary? { deck.threads.first { $0.key == key } }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                // On the wood, the keys are printed in burnt brown, as lettering on the cabinet is.
                IconKey(.back, color: Palette.burnt, label: "Back to the inbox") { deck.path.removeLast() }
                Spacer()
                IconKey(.archive, color: Palette.burnt, label: deck.isArchived(key) ? "Back to the inbox" : "Archive") { deck.archive(key) }
                IconKey(.trash, color: Palette.red, label: "Delete from this inbox") { deleteAsked = true }
            }
            .padding(.horizontal, 6)
            VStack(alignment: .leading, spacing: 4) {
                LabelText("\(key) · \(detail?.project.name ?? summary?.project ?? "")", size: 10, color: Palette.tan, tracking: 0.14)
                Text(deck.title(of: key)).font(Theme.sans(20, .semibold)).foregroundStyle(Palette.whitePrint)
                    .fixedSize(horizontal: false, vertical: true)
                if let problem = deck.threadProblems[key] {
                    Text(problem).font(Theme.sans(13)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .plate(screws: false, padding: 14)
            .padding(.horizontal, 10).padding(.bottom, 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if let detail {
                        let messages = detail.ordered
                        ForEach(messages.dropLast()) { message in
                            if expanded.contains(message.id) {
                                MessageCard(deck: deck, key: key, message: message, latest: false)
                                    .onTapGesture { expanded.remove(message.id) }
                            } else {
                                FoldedMessage(message: message) { expanded.insert(message.id) }
                            }
                        }
                        if let last = messages.last { MessageCard(deck: deck, key: key, message: last, latest: true) }
                        // A take on its way here whose message is not shown open (not read yet, or folded).
                        let open = Set(messages.filter { $0.id == messages.last?.id || expanded.contains($0.id) }.compactMap { $0.recording?.uploadId })
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            ForEach(deck.uploads(at: context.date).filter { $0.threadKey == key && !open.contains($0.uploadId ?? "") }, id: \.runName) { upload in
                                UploadPendingCard(shown: upload)
                            }
                        }
                    } else {
                        Text(deck.paired ? (deck.threadProblems[key] == nil ? "Reading the thread…" : "The thread could not be read. Pull down to try again.")
                                         : "This thread's messages come from the receiver once the phone is paired.")
                            .font(Theme.sans(14)).foregroundStyle(Palette.burnt).padding(8)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 10)
            }
            .defaultScrollAnchor(.bottom)
            .refreshable { await deck.loadThread(key) }
            HStack(spacing: 10) {
                Button { deck.reply(to: key) } label: {
                    HStack(spacing: 10) {
                        Glyph(.reply, color: Palette.cream, size: 22)
                        Text("Reply").font(Theme.label(15)).tracking(1.5).textCase(.uppercase)
                        Glyph(.camera, color: Palette.red, size: 22)
                    }
                    .foregroundStyle(Palette.cream)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(Pill().fill(Palette.panel))
                    .overlay(Pill().stroke(Palette.edge, lineWidth: 1.5))
                    .contentShape(Pill())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Reply: a photo or a recording for this thread")
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
        }
        .background(Wood().ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .overlay {
            if deleteAsked {
                PlateDialog(title: "Delete \(key) from this inbox?",
                            text: "It goes from this phone's list. The thread stays on the receiver for everyone else in it.",
                            keys: [.init(title: "Keep it", action: { deleteAsked = false }),
                                   .init(title: "Delete", color: Palette.red, action: { deleteAsked = false; deck.delete(key) })],
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
                Avatar(name: message.by.name, size: 20)
                Text(message.by.who).font(Theme.sans(13, .semibold)).foregroundStyle(Palette.cream).lineLimit(1).layoutPriority(1)
                Text(message.oneLine).font(Theme.sans(13)).foregroundStyle(Palette.tan).lineLimit(1)
                Spacer(minLength: 6)
                Text(Clock.when(message.at)).font(Theme.sans(12)).foregroundStyle(Palette.tan)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 3).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Palette.edge))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Read it in full")
    }
}

/// A message in full on a black plate: the sender, the words, a recording's title and summary, the
/// reactions, and the launches.
private struct MessageCard: View {
    @ObservedObject var deck: DeckModel
    let key: String
    let message: ThreadMessage
    let latest: Bool
    @State private var reacting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Avatar(name: message.by.name, size: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(message.by.who).font(Theme.sans(14, .semibold)).foregroundStyle(Palette.whitePrint)
                    Text("#\(message.id) · \(Clock.when(message.at))").font(Theme.sans(12)).foregroundStyle(Palette.tan)
                }
                Spacer()
                if message.launches?.isEmpty == false { Tag(text: "To try", color: Palette.amber) }
                if !deck.samples {
                    Button(reacting ? "Close" : "React") { reacting.toggle() }.buttonStyle(KeyStyle(color: Palette.tan))
                        .accessibilityLabel(reacting ? "Close the reactions" : "React to this message")
                }
            }
            if reacting {
                // The six reactions (src/threads.ts REACTIONS); this phone's own is ringed, and pressing it again takes it off.
                HStack(spacing: 6) {
                    ForEach(ThreadRequests.reactions, id: \.self) { name in
                        let mine = deck.myReaction(key, on: message) == name
                        Button {
                            reacting = false
                            deck.react(key, message: message.id, reaction: name)
                        } label: {
                            Text(ThreadMessage.reactionSymbols[name] ?? name).font(.system(size: 22))
                                .frame(width: 44, height: 40)
                                .background(RoundedRectangle(cornerRadius: 8).fill(mine ? Palette.surface : Color.clear))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(mine ? Palette.amber : Palette.edge, lineWidth: mine ? 2 : 1))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(mine ? "\(name), yours; press to take it off" : name)
                    }
                }
            }
            if let text = message.text, !text.isEmpty {
                Text(text).font(Theme.sans(15)).foregroundStyle(Palette.cream).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
            }
            if !message.photos.isEmpty { MessagePhotos(deck: deck, key: key, message: message) }
            if let recording = message.recording {
                RecordingLine(recording: recording)
                // This phone's take, still on its way: how far it has got (UploadViews).
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if let upload = deck.uploads(at: context.date).first(where: { $0.uploadId == recording.uploadId }) {
                        UploadOnMessage(progress: upload.progress)
                    }
                }
            }
            if let launches = message.launches, !launches.isEmpty {
                ForEach(Array(launches.enumerated()), id: \.offset) { index, launch in
                    LaunchCard(deck: deck, key: key, message: message, index: index, launch: launch, count: launches.count, latest: latest)
                }
            }
            if !message.reactions.isEmpty {
                // The symbol in the system font, which carries the emoji; the name in the deck's condensed face.
                HStack(spacing: 12) {
                    ForEach(Array(message.reactions.enumerated()), id: \.offset) { _, reaction in
                        HStack(spacing: 4) {
                            Text(ThreadMessage.reactionSymbols[reaction.reaction] ?? reaction.reaction).font(.system(size: 14))
                            Text(reaction.by.who).font(Theme.sans(13)).foregroundStyle(Palette.tan)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .plate(screws: latest, padding: 14)
    }
}

/// A message's photos as tiles, in the order sent; one pressed opens large over the thread.
private struct MessagePhotos: View {
    @ObservedObject var deck: DeckModel
    let key: String
    let message: ThreadMessage
    @State private var large: String?

    var body: some View {
        if !message.canView {
            Text(message.photos.count == 1 ? "A photo, which only people in this thread can see." : "\(message.photos.count) photos, which only people in this thread can see.")
                .font(Theme.sans(14)).foregroundStyle(Palette.tan)
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 6)], alignment: .leading, spacing: 6) {
                ForEach(message.photos, id: \.sha256) { photo in
                    Button { large = photo.sha256 } label: {
                        Color.clear
                            .aspectRatio(1, contentMode: .fit)
                            .overlay {
                                if let image = deck.photos[photo.sha256] {
                                    Image(uiImage: image).resizable().scaledToFill()
                                } else {
                                    ZStack { Palette.surface; ProgressView().tint(Palette.tan) }
                                }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.edge))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Photo, \(photo.width) by \(photo.height); open it large")
                    .task { await deck.loadPhoto(key, sha256: photo.sha256) }
                }
            }
            .fullScreenCover(item: Binding(get: { large.map(Large.init) }, set: { large = $0?.id })) { shown in
                ZStack(alignment: .topLeading) {
                    Color.black.ignoresSafeArea()
                    if let image = deck.photos[shown.id] {
                        Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    IconKey(.close, color: Palette.cream, label: "Close the photo") { large = nil }.padding(10)
                }
            }
        }
    }

    private struct Large: Identifiable { let id: String }
}

private struct RecordingLine: View {
    let recording: ThreadMessage.Recording

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Glyph(.camera, color: Palette.red, size: 16)
                LabelText(line, size: 10, color: recording.status == "failed" ? Palette.red : Palette.tan, tracking: 0.12)
            }
            if let title = recording.title { Text("“\(title)”").font(Theme.sans(15, .medium)).foregroundStyle(Palette.whitePrint) }
            if let summary = recording.summary {
                Text(summary).font(Theme.sans(13)).foregroundStyle(Palette.cream).fixedSize(horizontal: false, vertical: true)
            }
            if let error = recording.error { Text(error).font(Theme.sans(13)).foregroundStyle(Palette.red) }
        }
    }

    private var line: String {
        var parts = [recording.kindWord]
        if let ms = recording.durationMs { parts.append(String(format: "%d:%02d", ms / 60_000, (ms / 1000) % 60)) }
        if let logs = recording.logsWord { parts.append(logs) }
        if let status = recording.status, status != "ready" { parts.append(status) }
        return parts.joined(separator: " · ")
    }
}

/// One of a message's launches: its title, its steps in words, the stars, and Just open when it has a link.
private struct LaunchCard: View {
    @ObservedObject var deck: DeckModel
    let key: String
    let message: ThreadMessage
    let index: Int
    let launch: Launch
    let count: Int
    let latest: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(launch.title(index: index, of: count)).font(Theme.sans(15, .semibold)).foregroundStyle(Palette.whitePrint)
                Spacer()
                if latest {
                    let mine = deck.isPicked(key, message: message, launch: index)
                    Button { deck.togglePick(key, message: message.id, launch: index) } label: {
                        Glyph(mine ? .starFilled : .star, color: Palette.amber, size: 22).frame(width: 40, height: 36).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(mine ? "Picked; tap to take the star off" : "Pick this one")
                }
            }
            ForEach(Array(launch.steps.enumerated()), id: \.offset) { _, step in
                Text(Self.phoneText(step)).font(Theme.sans(13)).foregroundStyle(Palette.tan).lineLimit(2).truncationMode(.middle)
            }
            let stars = message.picks.filter { $0.launch == index }.map(\.by.who)
            if !stars.isEmpty { Text("★ " + stars.joined(separator: ", ")).font(Theme.sans(13)).foregroundStyle(Palette.amber) }
            if let link = launch.macLinks.first {
                // The headset's and the Mac's second key: the phone cannot record while Safari is in front.
                Button("Just open") { deck.openLink(link) }
                    .buttonStyle(KeyStyle(small: false, fill: true))
                    .accessibilityLabel("Just open \(LaunchLink.short(link)), without recording")
                Text("Record and open needs screen recording, which the phone does not have yet. Reply records with the camera.")
                    .font(Theme.sans(12)).foregroundStyle(Palette.hint).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("For the headset: start it from the headset's inbox.").font(Theme.sans(13)).foregroundStyle(Palette.hint)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.edge))
    }

    /// A step in words on the phone: a link opens here; the rest is the headset's (L1).
    static func phoneText(_ step: LaunchStep) -> String {
        switch step {
        case .open(let url):
            guard let link = LaunchLink.https(url) else { return "Not opened: \(url) is not an https link" }
            return "Opens \(LaunchLink.short(link)) in your browser"
        case .unknown(let kind):
            return "Not on the phone: a \(kind) step"
        default:
            return step.macText
        }
    }
}
