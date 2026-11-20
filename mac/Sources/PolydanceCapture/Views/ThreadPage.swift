// A thread (board 6), from `polycap thread show KEY --json`: earlier messages one line each (click to
// read one whole), the latest in full with its launches. Each launch has two keys (Robin, 2026-11-07):
// Record and open records a walkthrough (the display, the mic and the Mac's sound) and opens the launch's
// link in Arc, and when it stops it goes to the thread as a reply to that message and launch; Just open
// opens the link and records nothing. Beside them, as on the headset (2026-11-11), a Settings key unfolds
// the Mic and Mac sound switches, and the line under the keys says what will be recorded. Steps for the
// headset (apps, version checks, models) are said to be the headset's. A text reply is `polycap thread reply KEY --text`. The walkthroughs
// recorded here, and how their uploads went, are listed with polycap's own words when one failed.
// Photos (2026-11-07): a message's are drawn from the copies `thread show` saved and open in Preview;
// a reply takes photos chosen with Add photo, dropped on the page or pasted with ⌘V, sent with --photo.
import PolydanceCore
import PolydanceShared
import SwiftUI
import UniformTypeIdentifiers

struct ThreadPage: View {
    @Bindable var model: AppModel
    let key: String
    @State private var expanded: Set<Int> = []
    @State private var dropping = false

    private var threads: ThreadsModel { model.threads }
    private var detail: ThreadDetail? { threads.openKey == key ? threads.thread : nil }
    private var summary: ThreadSummary? { threads.threads.first { $0.key == key } }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.divider).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    RecordingBanner(model: model, key: key)
                    if let problem = threads.startProblem[key] { NoteText(problem, tint: Theme.redText) }
                    ForEach(threads.uploads(for: key).filter(Self.worthShowing)) { upload in UploadRow(model: model, upload: upload) }
                    if let problem = threads.ledgerProblem { NoteText(problem, tint: Theme.redText) }
                    if let problem = threads.openKey == key ? threads.threadProblem : nil { NoteText(problem, tint: Theme.amberText) }
                    if let detail {
                        let messages = detail.ordered
                        ForEach(messages.dropLast()) { message in
                            if expanded.contains(message.id) {
                                FullMessage(model: model, key: key, message: message, latest: false) { expanded.remove(message.id) }
                            } else {
                                CompactMessage(message: message) { expanded.insert(message.id) }
                            }
                        }
                        if let last = messages.last { FullMessage(model: model, key: key, message: last, latest: true) }
                    } else if threads.threadProblem == nil || threads.openKey != key {
                        ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                    }
                }
                .padding(.horizontal, 26).padding(.vertical, 18)
            }
            .defaultScrollAnchor(.bottom)
            Rectangle().fill(Theme.divider).frame(height: 1)
            Footer(model: model, key: key, latest: detail?.ordered.last?.id)
        }
        .background(PasteCatcher { model.threads.paste(into: key) })
        .onDrop(of: [.fileURL, .image], isTargeted: $dropping) { providers in drop(providers) }
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: 10).stroke(Palette.amber, lineWidth: 2).padding(4).allowsHitTesting(false)
            }
        }
        .task(id: key) {
            expanded = []
            threads.pageAppeared(key: key)
            threads.open(key: key)
        }
        // Leaving the page means nobody is reading it: nothing marks it read until it is opened again.
        .onDisappear { threads.pageDisappeared(key: key) }
        .onChange(of: key) { old, _ in threads.pageDisappeared(key: old) }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(key) · \(detail?.project.name ?? summary?.project ?? "")").font(Theme.mono(12)).foregroundStyle(Theme.muted)
                Text(detail?.title ?? summary?.title ?? key).font(Theme.sans(20, .semibold)).lineLimit(2).textSelection(.enabled)
            }
            Spacer()
            if let detail {
                Text("\(detail.messages.count) message\(detail.messages.count == 1 ? "" : "s") · \(detail.state)")
                    .font(Theme.sans(11)).foregroundStyle(Theme.muted)
            }
            Button { threads.reloadOpen() } label: { Image(systemName: "arrow.clockwise").font(.system(size: 12)) }
                .buttonStyle(.plain).foregroundStyle(Theme.muted).help("Read the thread again").accessibilityLabel("Refresh this thread")
                .disabled(threads.loadingThread)
        }
        .padding(.horizontal, 26).padding(.top, 20).padding(.bottom, 14)
    }

    /// Image files, or images without a file (dragged from a browser), go with the reply.
    private func drop(_ providers: [NSItemProvider]) -> Bool {
        let threads = model.threads, key = key
        var taken = false
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                taken = true
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in threads.attach([url], to: key) }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                taken = true
                _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data else { return }
                    Task { @MainActor in threads.attachImage(data, to: key) }
                }
            }
        }
        return taken
    }

    /// Sent walkthroughs stay listed for a day; anything not sent stays until it is.
    static func worthShowing(_ upload: ThreadsModel.Upload) -> Bool {
        guard upload.entry.status == .uploaded else { return true }
        guard let at = MetaTime.parse(upload.entry.at) else { return false }
        return Date().timeIntervalSince(at) < 24 * 3600
    }
}

// MARK: Messages

private struct CompactMessage: View {
    let message: ThreadMessage
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                Text(message.by.who).font(Theme.sans(13)).foregroundStyle(Theme.soft)
                Text(message.oneLine).font(Theme.sans(13)).foregroundStyle(Theme.muted).lineLimit(1)
                Spacer(minLength: 8)
                Text(Clock.when(message.at)).font(Theme.sans(13)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.divider))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Read #\(message.id) in full")
    }
}

private struct FullMessage: View {
    let model: AppModel
    let key: String
    let message: ThreadMessage
    let latest: Bool
    /// For an earlier message opened from its one line: back to the line.
    var collapse: (() -> Void)?
    private let columns = [GridItem(.flexible(), spacing: 10, alignment: .top), GridItem(.flexible(), spacing: 10, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                HStack(spacing: 8) {
                    Avatar(name: message.by.name, size: 24)
                    Text(message.by.who).font(Theme.sans(13, .semibold))
                }
                Spacer()
                HStack(spacing: 4) {
                    Text("#\(message.id) · \(Clock.when(message.at))").font(Theme.sans(12)).foregroundStyle(Theme.muted)
                    if message.launches?.isEmpty == false {
                        Tag(text: "To try", color: Palette.amber)
                    }
                    if let collapse { LinkButton("Show less", action: collapse).padding(.leading, 6) }
                }
            }
            if let text = message.text, !text.isEmpty {
                Text(text).font(Theme.sans(14)).lineSpacing(3).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if !message.photos.isEmpty { PhotoStrip(model: model, key: key, message: message) }
            if let recording = message.recording { RecordingLine(recording: recording) }
            if let launches = message.launches, !launches.isEmpty {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
                    ForEach(Array(launches.enumerated()), id: \.offset) { index, launch in
                        LaunchCard(model: model, key: key, message: message, index: index, launch: launch, count: launches.count)
                    }
                }
            }
            if !message.reactions.isEmpty {
                Text(message.reactions.map { "\(ThreadMessage.reactionSymbols[$0.reaction] ?? $0.reaction) \($0.by.who)" }.joined(separator: "  "))
                    .font(Theme.sans(12)).foregroundStyle(Theme.soft)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 10).fill(latest ? Theme.sidebar : .clear))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.raised))
    }
}

// MARK: Photos

/// A message's photos in a row, each as wide as its shape at one height; one opens in Preview when clicked.
struct PhotoStrip: View {
    let model: AppModel
    let key: String
    let message: ThreadMessage
    private let height: CGFloat = 150

    var body: some View {
        if !message.canView {
            NoteText(message.photos.count == 1 ? "A photo only people in this thread can see." : "\(message.photos.count) photos only people in this thread can see.")
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(message.photos, id: \.sha256) { photo in thumbnail(photo) }
                }
            }
        }
    }

    @ViewBuilder private func thumbnail(_ photo: ThreadMessage.Photo) -> some View {
        let width = min(320, max(60, height * CGFloat(photo.width) / CGFloat(max(1, photo.height))))
        let file = photo.file(in: model.layout, thread: key)
        if let file, let image = PhotoThumbnails.image(file) {
            Button { model.threads.open(photo: photo, in: key) } label: {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
                    .frame(width: width, height: height).clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.raised))
            }
            .buttonStyle(.plain)
            .help("\(photo.width)×\(photo.height), \(LaunchLink.megabytes(photo.bytes)): open in Preview")
            .accessibilityLabel("Photo, \(photo.width) by \(photo.height)")
        } else {
            Text("Not fetched yet").font(Theme.sans(11)).foregroundStyle(Theme.muted)
                .frame(width: width, height: height)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.field))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.raised))
                .help("polycap thread show could not save this photo; refresh the thread to try again")
        }
    }
}

/// Thumbnails read once from the saved photos (which never change: each is named by its sha256), not on every redraw.
@MainActor
enum PhotoThumbnails {
    private static let cache = NSCache<NSURL, NSImage>()

    static func image(_ file: URL) -> NSImage? {
        if let image = cache.object(forKey: file as NSURL) { return image }
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 640,
                                                                        kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        let image = NSImage(cgImage: thumb, size: NSSize(width: thumb.width, height: thumb.height))
        cache.setObject(image, forKey: file as NSURL)
        return image
    }
}

/// ⌘V in this page's window: `paste` says whether it took the clipboard as photos; when not, the key goes on
/// to the text field as usual.
private struct PasteCatcher: NSViewRepresentable {
    let paste: () -> Bool

    func makeNSView(context: Context) -> CatcherView { let view = CatcherView(); view.paste = paste; return view }
    func updateNSView(_ view: CatcherView, context: Context) { view.paste = paste }

    final class CatcherView: NSView {
        var paste: () -> Bool = { false }
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, event.charactersIgnoringModifiers?.lowercased() == "v" else { return event }
                // Local monitors run on the main thread; only the window's number crosses into the main actor.
                let number = event.windowNumber
                let took = MainActor.assumeIsolated { () -> Bool in
                    guard let self, let window = self.window, window.windowNumber == number else { return false }
                    return self.paste()
                }
                return took ? nil : event
            }
        }

        override func removeFromSuperview() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            super.removeFromSuperview()
        }
    }
}

private struct RecordingLine: View {
    let recording: ThreadMessage.Recording

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(line).font(Theme.sans(12)).foregroundStyle(recording.status == "failed" ? Theme.redText : Theme.soft)
            if let title = recording.title { Text("\"\(title)\"").font(Theme.sans(13, .medium)) }
            if let summary = recording.summary { NoteText(summary) }
            if let error = recording.error { NoteText(error, tint: Theme.redText) }
        }
    }

    private var line: String {
        var parts = [recording.kindWord, recording.status == "uploading" && recording.sessionId != nil ? "words ready, video still uploading" : recording.status ?? "unknown"]
        if let ms = recording.durationMs { parts.append(SessionClock.format(ms: ms)) }
        if let logs = recording.logsWord { parts.append(logs) }
        if let reply = recording.replyTo { parts.append("answers #\(reply.message)" + (reply.launch.map { ", option \($0 + 1)" } ?? "")) }
        if let session = recording.sessionId { parts.append("session \(session)") }
        return parts.joined(separator: " · ")
    }
}

/// A launch as the headset draws one (InboxPane.launchRow): its title and what it opens, the two keys with a
/// Settings key beside them, and under them what Record and open records, naming a sound left out so the
/// fold never hides it. Settings unfolds the RECORD panel (SoundSwitches); the key is amber with a dot
/// while a sound is off. The switches are every walkthrough's, so one switched here is switched for all.
struct LaunchCard: View {
    let model: AppModel
    let key: String
    let message: ThreadMessage
    let index: Int
    let launch: Launch
    let count: Int
    /// Folded by default, as on the headset; only this page's own state.
    @State var settingsShown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(launch.title(index: index, of: count)).font(Theme.sans(13, .medium))
            ForEach(Array(launch.steps.enumerated()), id: \.offset) { _, step in
                Text(stepText(step)).font(Theme.sans(12)).foregroundStyle(step.isMacStep ? Theme.muted : Theme.soft)
                    .lineLimit(2).truncationMode(.middle)
            }
            let stars = message.picks.filter { $0.launch == index }.map(\.by.who)
            if !stars.isEmpty { Text("★ " + stars.joined(separator: ", ")).font(Theme.sans(12)).foregroundStyle(Theme.amberText) }
            if launch.isHeadsetOnly {
                NoteText("For the headset: start it from the headset's inbox.")
            } else {
                let sounds = model.walkthroughSounds
                HStack(spacing: 8) {
                    FilledButton("Record and open", fill: Theme.redButton) {
                        model.threads.start(thread: key, message: message, launchIndex: index)
                    }
                    .disabled(model.live != nil)
                    .help(model.live != nil ? "Something is being recorded; stop it first." : "Records a walkthrough, opens the link, and sends it to \(key) when you stop.")
                    WindowButton("Just open") { model.threads.justOpen(message: message, launchIndex: index) }
                        .help("Opens the link without recording.")
                    Button("\(settingsShown ? "▴" : "▾")  Settings\(sounds.anyOff ? "  •" : "")") { settingsShown.toggle() }
                        .buttonStyle(KeyStyle(color: sounds.anyOff ? Palette.amber : Palette.tan))
                        .help(settingsShown ? "Fold the sounds away" : "Choose the sounds a walkthrough records: the mic and the Mac's sound")
                        .accessibilityLabel(sounds.anyOff ? "Settings: a sound is switched off" : "Settings")
                }
                Text(sounds.records(leftOut: Recorder.leftOut(model.excludedApps)))
                    .font(Theme.sans(12)).foregroundStyle(Palette.tan).fixedSize(horizontal: false, vertical: true)
                if settingsShown { SoundSwitches(model: model) }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.raised))
    }

    private func stepText(_ step: LaunchStep) -> String {
        guard case .open(let url) = step, let link = LaunchLink.https(url) else { return step.macText }
        let arc = NSWorkspace.shared.urlForApplication(withBundleIdentifier: ArcBrowser.bundleID) != nil
        return "Opens \(LaunchLink.short(link)) in \(arc ? "Arc" : "your browser")"
    }
}

/// The RECORD panel under a launch's Settings key: the headset's Mic and App sound chips, here Mic and Mac
/// sound, amber with a tick when on. Sounds are chosen before recording, so they are locked while one runs.
/// `onPlate`: printed straight on New thread's and the report's cream plates, without the black panel.
struct SoundSwitches: View {
    @Bindable var model: AppModel
    var onPlate = false

    var body: some View {
        let locked = model.live != nil
        HStack(spacing: 8) {
            LabelText("Record", size: 10.5, color: onPlate ? Palette.print : Palette.tan, tracking: 0.16).frame(width: onPlate ? 56 : 64, alignment: .leading)
            SoundSwitch(label: "Mic", on: $model.walkthroughMic)
            SoundSwitch(label: "Mac sound", on: $model.walkthroughMacSound)
            Spacer(minLength: 0)
        }
        .disabled(locked)
        .padding(.horizontal, onPlate ? 0 : 12).padding(.vertical, onPlate ? 0 : 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(onPlate ? .clear : Palette.casing))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(onPlate ? .clear : Palette.edge))
        .help(locked ? "Sounds are chosen before recording; this recording keeps the ones it started with."
            : "For every walkthrough: Record and open, Record a reply and \(Hotkeys.Shortcut.recordOrStop.label). A call always records the mic and Arc's sound.")
    }
}

/// One switch: lit amber with a tick when on, as the headset's chip.
private struct SoundSwitch: View {
    let label: String
    @Binding var on: Bool
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button { on.toggle() } label: {
            LabelText(on ? "✓  \(label)" : label, size: 11, color: on ? Palette.casing : Palette.tan, tracking: 0.06)
                .lineLimit(1).fixedSize()
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 12).fill(on ? Palette.amber : Palette.casing))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(on ? Palette.amber : Palette.edge, lineWidth: 1))
                .opacity(enabled ? 1 : 0.45)
                .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(on ? "on" : "off")
    }
}

// MARK: Recording and sending

private struct RecordingBanner: View {
    let model: AppModel
    let key: String

    var body: some View {
        if let live = model.live {
            if live.thread?.thread == key {
                HStack(spacing: 10) {
                    Circle().fill(Theme.red).frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Recording your reply" + (live.thread?.label.map { ", \($0)" } ?? "") + " · " + Recorder.clock(live.elapsed))
                            .font(Theme.sans(13, .semibold)).monospacedDigit()
                        Text(live.stopping ? "Saving…" : "Stop with \(Hotkeys.Shortcut.recordOrStop.label) or here; it is sent to \(key) when it stops.")
                            .font(Theme.sans(12)).foregroundStyle(Theme.muted)
                        if live.micSilent { MicSilentNote(device: live.micDevice) }
                    }
                    Spacer()
                    WindowButton("Stop and send") { model.stopAndSave() }.disabled(live.stopping)
                    WindowButton("Discard") { model.stopAndDiscard() }.disabled(live.stopping)
                }
                .padding(12)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.redEdge))
            } else {
                NoteText(live.mode == .walkthrough ? "A walkthrough is being recorded; stop it before starting one here." : "A call is being recorded; a reply can be recorded when it ends.",
                         tint: Theme.amberText)
            }
        }
    }
}

/// A walkthrough and its upload: on its thread's page, or (`compact`, its keys under it) at the top of the
/// column's Threads tab for a new thread or a report not sent yet.
struct UploadRow: View {
    let model: AppModel
    let upload: ThreadsModel.Upload
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(tint).frame(width: 16)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(Theme.sans(13, .medium)).fixedSize(horizontal: false, vertical: true)
                status
                if upload.entry.status == .failed || upload.entry.status == .saved, let error = upload.entry.error {
                    NoteText(error, tint: upload.entry.status == .failed ? Theme.redText : Theme.amberText)
                }
                if compact { HStack(spacing: 8) { keys }.padding(.top, 2) }
            }
            Spacer(minLength: 8)
            if !compact { keys }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(upload.entry.status == .failed ? Theme.redEdge : Theme.divider))
        .padding(.vertical, compact ? 4 : 0)
    }

    @ViewBuilder private var keys: some View {
        if upload.entry.status == .saved || upload.entry.status == .failed {
            WindowButton(upload.entry.status == .failed ? "Send again" : upload.entry.error != nil ? "Send anyway" : "Send") { model.threads.send(upload) }
        }
        WindowButton("Show file") { model.threads.reveal(upload) }
    }

    private var title: String {
        let at = MetaTime.parse(upload.entry.at)
        let target = upload.entry.target
        let name: String
        switch target.kind {
        case .reply: name = (target.label.map { "Walkthrough for \($0)" } ?? "Walkthrough") + (target.replyTo.map { " · answers #\($0)" } ?? "")
        case .newThread: name = target.thread.map { "Walkthrough that opened \($0)" } ?? target.title
        case .report: name = "Report for the Polydance team"
        }
        return "\(name) · \(Clock.size(upload.bytes) ?? upload.files.baseName)" + (upload.entry.status == .uploading ? "" : " · \(Clock.day(at)) \(Clock.time(at))")
    }

    @ViewBuilder private var status: some View {
        switch upload.entry.status {
        case .recording:
            Text("Recording…").font(Theme.sans(12)).foregroundStyle(Theme.muted)
        case .saved:
            Text("Not sent yet. It is kept on this Mac either way.").font(Theme.sans(12)).foregroundStyle(Theme.muted)
        case .uploading where model.threads.stillSending.contains(upload.id):
            Text("Still sending: polycap upload was started before the app last quit and is still running.")
                .font(Theme.sans(12)).foregroundStyle(Theme.amberText)
        case .uploading:
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text("Sending to the receiver with polycap upload… \(Recorder.clock(context.date.timeIntervalSince(upload.startedAt ?? context.date)))")
                    .font(Theme.sans(12)).foregroundStyle(Theme.amberText).monospacedDigit()
            }
        case .uploaded:
            Text("Sent as \(upload.entry.uploadId ?? "an upload")" + (upload.entry.receiverStatus.map { " · the receiver says \($0)" } ?? "") + ". Kept on this Mac too.")
                .font(Theme.sans(12)).foregroundStyle(Theme.greenText)
        case .failed:
            Text("Not sent. polycap said:").font(Theme.sans(12)).foregroundStyle(Theme.redText)
        }
    }

    private var icon: String {
        switch upload.entry.status {
        case .recording: "record.circle"
        case .saved: "tray.and.arrow.up"
        case .uploading: "arrow.up.circle"
        case .uploaded: "checkmark.circle"
        case .failed: "exclamationmark.triangle"
        }
    }

    private var tint: Color {
        switch upload.entry.status {
        case .recording: Theme.red
        case .saved: Theme.soft
        case .uploading: Theme.amberText
        case .uploaded: Theme.green
        case .failed: Theme.redText
        }
    }
}

// MARK: Replying

private struct Footer: View {
    @Bindable var model: AppModel
    let key: String
    let latest: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            let photos = model.threads.attachments[key] ?? []
            if !photos.isEmpty { Attachments(model: model, key: key, photos: photos) }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Write a reply, or record one", text: draft, axis: .vertical)
                    .textFieldStyle(.plain).font(Theme.sans(13)).lineLimit(1...6)
                    .padding(.horizontal, 10).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.field))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.raised))
                    .onSubmit { model.threads.reply(key: key) }
                    .accessibilityLabel("Reply")
                WindowButton("Add photo") { choose() }
                    .disabled(model.threads.posting != nil)
                    .help("Choose images to send with the reply. You can also drop them on the thread, or paste a screenshot with ⌘V.")
                WindowButton(model.threads.posting == key ? "Sending…" : "Send") { model.threads.reply(key: key) }
                    .disabled(model.threads.posting != nil || ((model.threads.drafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty))
                WindowButton("Record a reply") { model.threads.recordReply(thread: key, to: latest) }
                    .disabled(model.live != nil)
                    .help("\(model.walkthroughSounds.records()), opens nothing, and sends it to \(key) when you stop.")
            }
            if let problem = model.threads.attachProblem[key] { NoteText(problem, tint: Theme.amberText) }
            if let problem = model.threads.postProblem[key] { NoteText(problem, tint: Theme.redText) }
        }
        .padding(.horizontal, 26).padding(.vertical, 12)
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.prompt = "Add"
        panel.message = "Photos for \(key): polycap turns them upright, scales them to 4096 px and removes their location before sending."
        if panel.runModal() == .OK { model.threads.attach(panel.urls, to: key) }
    }

    private var draft: Binding<String> {
        Binding(get: { model.threads.drafts[key] ?? "" }, set: { model.threads.drafts[key] = $0 })
    }
}

/// The photos waiting to go with the reply, small, each with a key to take it out.
struct Attachments: View {
    let model: AppModel
    let key: String
    let photos: [URL]

    var body: some View {
        HStack(spacing: 8) {
            ForEach(photos, id: \.self) { photo in
                ZStack(alignment: .topTrailing) {
                    Group {
                        if let image = PhotoThumbnails.image(photo) {
                            Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
                        } else {
                            Text(photo.pathExtension.uppercased()).font(Theme.mono(10)).foregroundStyle(Theme.muted)
                        }
                    }
                    .frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 5))
                    .background(RoundedRectangle(cornerRadius: 5).fill(Theme.field))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Theme.raised))
                    .help(ThreadPhotos.isPasted(photo, in: model.layout) ? "Pasted image" : photo.lastPathComponent)
                    Button { model.threads.detach(photo, from: key) } label: {
                        Image(systemName: "xmark.circle.fill").font(.system(size: 13)).foregroundStyle(Theme.soft)
                    }
                    .buttonStyle(.plain).offset(x: 5, y: -5)
                    .accessibilityLabel("Take this photo out of the reply")
                    .disabled(model.threads.posting == key)
                }
            }
            Text(photos.count == 1 ? "1 photo to send" : "\(photos.count) photos to send").font(Theme.sans(12)).foregroundStyle(Theme.muted)
            Spacer()
        }
    }
}
