// Threads on the Mac: the inbox from `polycap thread list --json`, the open thread from `thread show`
// (which marks it read, as on the headset), text replies with `thread reply --text`, and walkthroughs
// recorded from a thread, sent as replies with `polycap upload` when they stop. Calls never come here:
// only a recording started from a thread has a target, and polycap itself refuses a call's metadata.
//
// Every walkthrough for a thread is in the upload ledger from the moment it starts recording, so it is
// never imported as a local session at the next launch (the receiver builds its bundle; `polycap sync`
// brings it down) and an upload that failed or was cut off stays on the page with its error and a
// Send again button. Uploads run one at a time. Nothing is retried by itself. Quitting the app does not
// stop a `polycap upload`, so its pid is kept in the ledger: at the next launch one still running is
// shown as still sending, and watched until it ends, rather than called cut off and raced by Send again.
//
// Only a thread the user is looking at is read with `thread show` (which marks it read for this Mac's
// token); after an upload or a reply to a thread nobody is looking at, only the list is read again.
//
// New thread and the bug key (Robin's pick D of four mockups, 2026-11-16): New thread records a walkthrough
// that opens a thread in a project (`polycap upload --project`), or posts a typed one (`thread new`), in a
// project chosen from `project list --capabilities`, which also says whether the receiver makes projects of
// your own (New project, `project new`) and takes reports. The bug key records a report for the Polydance
// team (`polycap upload --report`). Until they are sent these have no thread page, so the Threads tab lists
// them at its top; a report is never in a thread here, and its recording stays in the recordings folder.
import AppKit
import Foundation
import Observation
import PolydanceCore
import PolydanceShared

@MainActor
@Observable
final class ThreadsModel {
    /// One walkthrough recorded for a thread, as the thread page shows it.
    struct Upload: Identifiable, Equatable {
        var files: RecordingFiles
        var entry: UploadLedger.Entry
        var bytes: Int64?
        /// When this run of `polycap upload` started, while it runs.
        var startedAt: Date?
        var id: String { files.videoName }
    }

    @ObservationIgnored weak var app: AppModel?

    /// The inbox; settable here for the window's pictures (LookSnapshots).
    var threads: [ThreadSummary] = []
    private(set) var listProblem: String?
    private(set) var listCheckedAt: Date?
    private(set) var listing = false

    private(set) var openKey: String?
    private(set) var thread: ThreadDetail?
    private(set) var threadProblem: String?
    private(set) var loadingThread = false

    /// Unsent reply text, by thread.
    var drafts: [String: String] = [:]
    /// Photos waiting to go with the reply, by thread: files chosen or dropped, and pasted copies (2026-11-07).
    private(set) var attachments: [String: [URL]] = [:]
    /// Why a photo could not be added, by thread, until the next one is.
    private(set) var attachProblem: [String: String] = [:]
    private(set) var posting: String?
    private(set) var postProblem: [String: String] = [:]
    /// A launch could not start (a recording is running, the link is not https…), by thread.
    var startProblem: [String: String] = [:]

    // New thread and reports. Settable here for the window's pictures (LookSnapshots), not only by the receiver.
    /// What New thread offers, from `polycap project list --capabilities`.
    var projects: [ThreadProject] = []
    /// Whether the receiver takes reports and makes projects of your own; nil and false until it has said.
    var takesReports: Bool?
    var makesProjects = false
    private(set) var projectsProblem: String?
    private(set) var listingProjects = false
    /// New thread's project, kept while the app runs.
    var chosenProject: String?
    /// New project's name field, open, and what the receiver said when it would not make one.
    var namingProject = false
    var projectName = ""
    private(set) var makingProject = false
    private(set) var makeProblem: String?
    /// A new thread typed rather than recorded; its photos wait in `attachments[Self.draftKey]`.
    var newTitle = ""
    var newText = ""
    private(set) var openingThread = false
    private(set) var openProblem: String?
    /// Why New thread's or the report's recording did not start.
    var recordProblem: String?
    /// Where a typed new thread's photos wait, beside the replies' (never a thread key).
    static let draftKey = "+new"

    private(set) var uploads: [Upload] = []
    private(set) var ledgerProblem: String?
    @ObservationIgnored private var sending = false
    @ObservationIgnored private var listTimer: Timer?
    @ObservationIgnored private var windows = 0
    /// The thread whose page is on screen now, if any.
    @ObservationIgnored private var visibleKey: String?
    /// Uploads a `polycap upload` from an earlier run is still sending, watched until it ends.
    private(set) var stillSending: Set<String> = []
    @ObservationIgnored private var orphanPoll: Timer?

    var newCount: Int { threads.filter(\.isNew).count }

    /// New threads and reports not sent yet (recording, waiting, sending or refused): they have no thread page,
    /// so the Threads tab lists them at its top until they are sent.
    var outbox: [Upload] { uploads.filter { $0.entry.target.kind != .reply && $0.entry.status != .uploaded } }

    var chosen: ThreadProject? { projects.first { $0.key == chosenProject } }

    // MARK: Lifecycle

    /// At launch: what the ledger says, with recordings and uploads the app was in the middle of marked
    /// as not sent.
    func start() {
        guard let app else { return }
        // Drafts do not outlive the app, so neither do the screenshots pasted into them.
        ThreadPhotos.clearPasted(in: app.layout)
        let recordings = app.layout.recordings
        do {
            let loaded = try UploadLedger.load(from: app.layout.uploadLedger)
            let ledger = loaded.afterRestart(at: MetaTime.format(Date())) { name, entry in
                // The ledger's key is the video's name; the polycap sending it has that file among its arguments.
                guard let pid = entry.pid else { return false }
                return PolycapProcess.isRunning(pid: pid, mentioning: recordings.appendingPathComponent(name).standardizedFileURL.path)
            }
            if ledger != loaded { try saveLedger(ledger) }
            reloadUploads(ledger)
            stillSending = Set(ledger.recordings.filter { $0.value.status == .uploading }.keys)
            if !stillSending.isEmpty { watchOrphans() }
        } catch {
            ledgerProblem = "The upload ledger could not be read, so no walkthrough is sent or listed until it is fixed: \(error)"
        }
    }

    func windowAppeared() {
        windows += 1
        guard windows == 1 else { return }
        refreshList()
        listTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshList() }
        }
        listTimer?.tolerance = 5
    }

    func windowDisappeared() {
        windows = max(0, windows - 1)
        guard windows == 0 else { return }
        listTimer?.invalidate()
        listTimer = nil
        visibleKey = nil
        openKey = nil
        thread = nil
        threadProblem = nil
    }

    /// The thread page is on screen (ThreadPage's onAppear), or left it (onDisappear).
    func pageAppeared(key: String) { visibleKey = key }

    func pageDisappeared(key: String) {
        guard visibleKey == key else { return }
        visibleKey = nil
        close(key: key)
    }

    /// Nobody is reading this thread now: nothing reads it with `thread show` until it is opened again.
    func close(key: String) {
        guard openKey == key else { return }
        openKey = nil
        thread = nil
        threadProblem = nil
        loadingThread = false
    }

    /// Reads the open thread again only when it is the one on screen (which marks it read); otherwise only the list.
    private func refreshAfterPosting(to key: String) {
        if openKey == key, visibleKey == key { open(key: key) }
        refreshList()
    }

    // MARK: The inbox

    func refreshList() {
        guard let app, !listing else { return }
        listing = true
        let runner = app.runner
        Task {
            do {
                let found = try await runner.threadList()
                if found != threads { threads = found }
                listProblem = nil
            } catch {
                listProblem = "\(error)"
            }
            listCheckedAt = Date()
            listing = false
        }
    }

    /// The menu's Threads tab refreshes when it is shown, at most once a minute.
    func refreshListIfStale() {
        if let at = listCheckedAt, Date().timeIntervalSince(at) < 60 { return }
        refreshList()
    }

    /// Opens a thread (and marks it read for this Mac's token, as `polycap thread show` does).
    func open(key: String) {
        guard ThreadKey.isValid(key), let app else { return }
        if openKey != key {
            openKey = key
            thread = nil
            threadProblem = nil
        }
        loadingThread = true
        let runner = app.runner
        Task {
            do {
                let found = try await runner.threadShow(key: key)
                guard openKey == key else { return }
                thread = found
                threadProblem = nil
                // It is read now: the dot goes without waiting for the next list.
                if let index = threads.firstIndex(where: { $0.key == key }) { threads[index].unread = false; threads[index].fresh = 0 }
            } catch {
                guard openKey == key else { return }
                threadProblem = "\(error)"
            }
            if openKey == key { loadingThread = false }
        }
    }

    func reloadOpen() {
        if let openKey { open(key: openKey) }
    }

    func reply(key: String) {
        guard let app, posting == nil else { return }
        let text = (drafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let photos = attachments[key] ?? []
        guard !text.isEmpty || !photos.isEmpty else { return }
        posting = key
        postProblem[key] = nil
        let runner = app.runner
        let layout = app.layout
        Task {
            do {
                _ = try await runner.threadReply(key: key, text: text, photos: photos)
                drafts[key] = nil
                attachments[key] = nil
                attachProblem[key] = nil
                for photo in photos where ThreadPhotos.isPasted(photo, in: layout) { try? FileManager.default.removeItem(at: photo) }
                refreshAfterPosting(to: key)
            } catch {
                postProblem[key] = "\(error)"
            }
            posting = nil
        }
    }

    // MARK: New thread, New project and the report

    /// The projects and what the receiver offers, read when a plate opens.
    func refreshProjects() {
        guard let app, !listingProjects else { return }
        listingProjects = true
        let runner = app.runner
        Task {
            do {
                let listing = try await runner.projectList()
                projects = listing.projects
                takesReports = listing.takesReports
                makesProjects = listing.makesProjects
                projectsProblem = nil
                // The project chosen last, while it is still there; else the token's first, where a recording with no project goes.
                if chosen == nil { chosenProject = listing.projects.first?.key }
            } catch {
                projectsProblem = "\(error)"
            }
            listingProjects = false
        }
    }

    /// New project's Make: a project of this Mac's person's own, chosen for the thread about to be opened.
    func makeProject() {
        guard let app, !makingProject else { return }
        let name = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        makingProject = true
        makeProblem = nil
        let runner = app.runner
        Task {
            do {
                let made = try await runner.projectNew(name: name)
                if !projects.contains(where: { $0.key == made.key }) { projects.append(made) }
                chosenProject = made.key
                namingProject = false
                projectName = ""
            } catch {
                makeProblem = "\(error)"
            }
            makingProject = false
        }
    }

    func cancelNaming() {
        namingProject = false
        projectName = ""
        makeProblem = nil
    }

    /// Record a new thread: a walkthrough that opens a thread in the chosen project when it stops.
    func recordNewThread() {
        guard let app, let project = chosen else { return }
        recordProblem = app.startThreadReply(.newThread(in: project), opening: [])
        if recordProblem == nil { app.plate = nil }
    }

    /// The bug key's Start recording: a walkthrough sent to the Polydance team when it stops.
    func recordReport() {
        guard let app else { return }
        recordProblem = app.startThreadReply(.report, opening: [])
        if recordProblem == nil { app.plate = nil }
    }

    /// Write it instead's Post: a title and words, photos or both, opened at once; the window then shows it.
    func postNewThread() {
        guard let app, !openingThread, let project = chosen else { return }
        let title = newTitle, text = newText, photos = attachments[Self.draftKey] ?? []
        openingThread = true
        openProblem = nil
        let runner = app.runner
        let layout = app.layout
        Task {
            do {
                let opened = try await runner.threadNew(project: project.key, title: title, text: text, photos: photos)
                newTitle = ""
                newText = ""
                attachments[Self.draftKey] = nil
                attachProblem[Self.draftKey] = nil
                for photo in photos where ThreadPhotos.isPasted(photo, in: layout) { try? FileManager.default.removeItem(at: photo) }
                app.plate = nil
                app.windowTab = .threads
                app.selection = .thread(opened.key)
                refreshList()
            } catch {
                openProblem = "\(error)"
            }
            openingThread = false
        }
    }

    // MARK: Photos in a reply

    /// Files chosen with Add photo or dropped on the page.
    func attach(_ urls: [URL], to key: String) {
        let (photos, refused) = ThreadPhotos.adding(urls, to: attachments[key] ?? [])
        attachments[key] = photos
        attachProblem[key] = refused == 0 ? nil
            : photos.count >= ThreadPhotos.maxPerMessage ? "A message holds at most \(ThreadPhotos.maxPerMessage) photos."
            : "Only image files can go in a reply: JPEG, PNG, HEIC, WebP, GIF or TIFF."
    }

    /// Image data pasted or dropped without a file (a screenshot on the clipboard): kept as a private PNG until sent.
    func attachImage(_ data: Data, to key: String) {
        guard let app else { return }
        guard let png = NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) else {
            attachProblem[key] = "That image could not be read."
            return
        }
        do { attach([try ThreadPhotos.savePasted(png, in: app.layout)], to: key) } catch { attachProblem[key] = "\(error)" }
    }

    /// ⌘V on the thread page: image files copied in the Finder, else an image on the clipboard. False when
    /// the clipboard holds neither, so the key goes on to the reply's text field.
    func paste(into key: String) -> Bool {
        let board = NSPasteboard.general
        let files = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        if !files.isEmpty {
            guard files.contains(where: ThreadPhotos.isPhoto) else { return false }
            attach(files, to: key)
            return true
        }
        // Text first: a copied sentence goes in the reply, even when the app that copied it added a picture of it.
        if board.string(forType: .string) != nil { return false }
        guard let data = board.data(forType: .png) ?? board.data(forType: .tiff) else { return false }
        attachImage(data, to: key)
        return true
    }

    /// Takes a photo back out of the reply; a pasted copy is removed with it.
    func detach(_ url: URL, from key: String) {
        attachments[key]?.removeAll { $0 == url }
        if let app, ThreadPhotos.isPasted(url, in: app.layout) { try? FileManager.default.removeItem(at: url) }
    }

    /// Opens a saved photo in the Mac's viewer (Preview, by default).
    func open(photo: ThreadMessage.Photo, in key: String) {
        guard let app, let file = photo.file(in: app.layout, thread: key) else { return }
        NSWorkspace.shared.open(file)
    }

    // MARK: Recording a reply

    /// "Record and open": a walkthrough for this message and launch, then its links in Arc.
    func start(thread key: String, message: ThreadMessage, launchIndex: Int) {
        guard let app, let launch = message.launches?[safe: launchIndex] else { return }
        let target = WalkthroughTarget(thread: key, replyTo: message.id, launch: launchIndex,
                                       label: launch.title(index: launchIndex, of: message.launches?.count ?? 1))
        startProblem[key] = app.startThreadReply(target, opening: launch.macLinks)
    }

    /// "Just open": the launch's links in Arc, with nothing recorded and nothing sent.
    func justOpen(message: ThreadMessage, launchIndex: Int) {
        guard let app, let launch = message.launches?[safe: launchIndex] else { return }
        app.open(launch.macLinks)
    }

    /// "Record a reply": a walkthrough answering the latest message, opening nothing.
    func recordReply(thread key: String, to message: Int?) {
        guard let app else { return }
        startProblem[key] = app.startThreadReply(WalkthroughTarget(thread: key, replyTo: message), opening: [])
    }

    // MARK: Called by AppModel as the recording goes

    /// Written before the recording starts: from now on the walkthrough belongs to the thread.
    func recordingStarting(_ files: RecordingFiles, _ target: WalkthroughTarget) -> String? {
        if let ledgerProblem { return ledgerProblem }
        return update(files) { $0[files.videoName] = .init(status: .recording, target: target, at: MetaTime.format(Date())) }
    }

    /// The recording never started, or was discarded: it is nobody's walkthrough.
    func recordingGone(_ files: RecordingFiles) {
        _ = update(files) { $0[files.videoName] = nil }
    }

    /// Saved: sent now, or (while quitting, or with a `note` saying why not) left for the Send button.
    func recordingSaved(_ files: RecordingFiles, _ target: WalkthroughTarget, send: Bool, note: String? = nil) {
        _ = update(files) { $0[files.videoName] = .init(status: .saved, target: target, at: MetaTime.format(Date()), error: note) }
        if send { sendNext() }
    }

    // MARK: Uploads

    /// "Send" or "Send again": polycap resumes from what the receiver already has. Also the user's own Send
    /// for a reply that was kept back with a note (it caught a call), which the note is cleared for.
    func send(_ upload: Upload) {
        guard upload.entry.status == .saved || upload.entry.status == .failed, !stillSending.contains(upload.id) else { return }
        _ = update(upload.files) { ledger in
            ledger[upload.files.videoName]?.status = .saved
            ledger[upload.files.videoName]?.error = nil
        }
        sendNext()
    }

    func reveal(_ upload: Upload) {
        NSWorkspace.shared.activateFileViewerSelecting([upload.files.video])
    }

    func uploads(for key: String) -> [Upload] { uploads.filter { $0.entry.target.thread == key } }

    private func sendNext() {
        // A saved reply with a note (one that caught a call) waits for the user's own Send.
        guard let app, !sending, let next = uploads.filter({ $0.entry.status == .saved && $0.entry.error == nil }).sorted(by: { $0.id < $1.id }).first else { return }
        startSending(next, app: app)
    }

    private func startSending(_ next: Upload, app: AppModel) {
        sending = true
        let files = next.files
        let target = next.entry.target
        _ = update(files) { $0[files.videoName]?.status = .uploading; $0[files.videoName]?.error = nil; $0[files.videoName]?.at = MetaTime.format(Date()) }
        if let index = uploads.firstIndex(where: { $0.id == files.videoName }) { uploads[index].startedAt = Date() }
        let runner = app.runner
        // The pid, so the next launch can tell this upload is still going if the app quits first.
        let started: @Sendable (Int32) -> Void = { pid in
            Task { @MainActor [weak self] in
                _ = self?.update(files) { ledger in if ledger[files.videoName]?.status == .uploading { ledger[files.videoName]?.pid = pid } }
            }
        }
        Task {
            do {
                let sent = try await runner.upload(files, to: target, onStart: started)
                _ = update(files) { ledger in
                    ledger[files.videoName]?.status = .uploaded
                    ledger[files.videoName]?.uploadId = sent.uploadId
                    ledger[files.videoName]?.receiverStatus = sent.status
                    ledger[files.videoName]?.pid = nil
                    ledger[files.videoName]?.at = MetaTime.format(Date())
                    // The thread it opened, so its page lists it; a report's thread is the team's, never shown here.
                    if target.kind == .newThread { ledger[files.videoName]?.target.thread = sent.thread }
                }
                switch target.kind {
                case .reply:
                    app.notifier.notice(id: "upload-\(files.baseName)", title: "Sent to \(sent.thread)",
                                        body: "Your walkthrough is a reply in \(sent.thread). The receiver builds its bundle.")
                    refreshAfterPosting(to: sent.thread)
                case .newThread:
                    app.notifier.notice(id: "upload-\(files.baseName)", title: "Your new thread is open: \(sent.thread)",
                                        body: "In \(target.projectName ?? target.project ?? "its project"). Its title comes from what you said once the receiver has built it.")
                    refreshList()
                case .report:
                    app.notifier.notice(id: "upload-\(files.baseName)", title: "Thank you",
                                        body: "Your report is on its way to the Polydance team.")
                }
            } catch {
                _ = update(files) { ledger in
                    ledger[files.videoName]?.status = .failed
                    ledger[files.videoName]?.error = "\(error)"
                    ledger[files.videoName]?.pid = nil
                    ledger[files.videoName]?.at = MetaTime.format(Date())
                }
                app.notifier.notice(id: "upload-\(files.baseName)", title: "\(target.title) was not sent",
                                    body: "The recording is kept on this Mac. Open \(target.kind == .reply ? "the thread" : "Threads") in Polydance to see why and send it again.")
            }
            sending = false
            sendNext()
        }
    }

    /// Every 5 s while an earlier run's `polycap upload` is still going; when it ends, how it ended is not
    /// known here, so it is shown as not sent, with Send again (which asks the receiver and resumes).
    private func watchOrphans() {
        guard orphanPoll == nil else { return }
        orphanPoll = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkOrphans() }
        }
    }

    private func checkOrphans() {
        guard let app else { return }
        for name in stillSending {
            let path = app.layout.recordings.appendingPathComponent(name).standardizedFileURL.path
            guard let entry = uploads.first(where: { $0.id == name })?.entry, entry.status == .uploading else { stillSending.remove(name); continue }
            if let pid = entry.pid, PolycapProcess.isRunning(pid: pid, mentioning: path) { continue }
            stillSending.remove(name)
            guard let files = RecordingFiles.forVideo(app.layout.recordings.appendingPathComponent(name), in: app.layout.recordings) else { continue }
            _ = update(files) { ledger in
                if let current = ledger[name], current.status == .uploading { ledger[name] = UploadLedger.cutOff(current, at: MetaTime.format(Date())) }
            }
        }
        if stillSending.isEmpty { orphanPoll?.invalidate(); orphanPoll = nil; refreshList() }
    }

    // MARK: The ledger

    private func update(_ files: RecordingFiles, _ change: (inout [String: UploadLedger.Entry]) -> Void) -> String? {
        guard let app else { return "the app is not ready" }
        do {
            var ledger = try UploadLedger.load(from: app.layout.uploadLedger)
            change(&ledger.recordings)
            try saveLedger(ledger)
            reloadUploads(ledger)
            ledgerProblem = nil
            return nil
        } catch {
            ledgerProblem = "The upload ledger could not be written: \(error)"
            return ledgerProblem
        }
    }

    private func saveLedger(_ ledger: UploadLedger) throws {
        guard let app else { return }
        try PrivateFiles.makeDirectory(app.layout.mac, within: app.layout.root)
        try ledger.save(to: app.layout.uploadLedger)
    }

    private func reloadUploads(_ ledger: UploadLedger) {
        guard let app else { return }
        let started = Dictionary(uniqueKeysWithValues: uploads.compactMap { upload in upload.startedAt.map { (upload.id, $0) } })
        uploads = ledger.recordings.sorted { $0.key > $1.key }.compactMap { name, entry in
            guard let files = RecordingFiles.forVideo(app.layout.recordings.appendingPathComponent(name), in: app.layout.recordings) else { return nil }
            let bytes = (try? FileManager.default.attributesOfItem(atPath: files.video.path)[.size] as? NSNumber)?.int64Value
            return Upload(files: files, entry: entry, bytes: bytes, startedAt: entry.status == .uploading ? started[name] ?? Date() : nil)
        }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
