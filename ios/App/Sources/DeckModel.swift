// What the deck's screens show and do (docs/IPHONE.md S1 to S6), on top of the I0 probe's parts: the
// recorder, the uploads and the refresh stay ProbeModel's. This model holds what is only the screens':
// which page is open, where the next take goes, the inbox (its box, search and projects) and the control
// panel's readout, worked out as plain values (PhonePanel.Readout) so a picture can be drawn from samples.
//
// Since I3 the inbox is the receiver's, read with the phone's pairing over the headset's routes
// (ReceiverClient, PolydancePhoneCore's ThreadRequests): the list when the app comes to the front and every
// 30 s while it stays there, a thread when it is opened (and marked read, which takes its notice away),
// reactions, stars, Archive (the thread closed) and Delete from this inbox (hidden for this token), each
// with Undo. A take goes where the line under the red key says: a reply in the thread Reply came from, a
// new thread in the project chosen (or the only one), or a report; it is sent as soon as it finishes.
// Unpaired, the inbox says how to pair and a take stays on the phone. -lookSamples fills everything with
// Samples for pictures of the look, and then nothing reaches a receiver.
//
// The camera, then choose (Robin's pick of 2026-11-13): New thread and Reply open the camera without
// recording, on Photo, with a Photo · Video switch over the shutter. A photo, or photos from the library, wait
// in the draft (the photo message screen) with optional words until Send: each is sent to the project (a new
// thread) or the thread, then named in one message, with a delivery id so a retry is the same message. The
// deck's red REC key still records at once, and so does the bug key's report. A draft is kept only in memory.
//
// Screen (I4, Robin 2026-11-20: "the option of recording the screen and microphone (no camera)"): the camera's
// third mode. The camera stops, and the red key is the system's broadcast picker (BroadcastLink, shared with the
// Vision Pro), so iOS's own sheet asks before each take; the take is the phone's whole screen and the microphone,
// written by the broadcast extension while Polydance is in the background. STOP and Cancel here, or the system's own
// stop, end it; the link takes it in and it goes where the line under the key said, as a camera take does.
import AVFoundation
import Combine
import PhotosUI
import PolydancePhoneCore
import PolydanceShared
import SwiftUI
import UIKit

@MainActor
final class DeckModel: ObservableObject {
    enum Page: Hashable { case thread(String), recordings, settings, probe }
    enum Box: Equatable { case inbox, archived }
    /// Where the next take goes, said under the red key.
    enum Target: Equatable {
        case newThread
        case thread(key: String, title: String)
        case report
    }

    /// What the camera's shutter does: Photo first, as Robin picked; Video starts a take; Screen a take of the
    /// screen and the microphone, with the camera off (I4).
    enum CameraMode: Equatable { case photo, video, screen }

    /// A photo waiting in the draft, made ready to send, with a small picture of it for the screen.
    struct DraftPhoto: Identifiable {
        let id = UUID()
        let photo: PreparedPhoto
        let thumbnail: UIImage?
    }

    /// The photo message being made: photos, words, and the last Send's delivery so a retry is the same message.
    struct PhotoDraft {
        var photos: [DraftPhoto] = []
        var words = ""
        var startedAt = Date()
        var sending = false
        var problem: String?
        var attempt: (signature: String, deliveryId: String)?
        var isEmpty: Bool { photos.isEmpty }
    }

    let probe: ProbeModel
    let look: LookPlan
    let lookError: String?
    var samples: Bool { look.samples }

    @Published var path: [Page] = []
    @Published var recordingShown = false
    @Published var drawerOpen = false
    @Published var reportAsked = false
    @Published var cancelAsked = false
    /// New thread while unpaired: the note saying it needs pairing.
    @Published var newThreadNote = false
    /// New thread with several projects: which one.
    @Published var projectAsked = false
    @Published var pairingShown = false
    @Published var target: Target = .newThread { didSet { if target != oldValue { writeNext() } } }
    @Published var cameraMode: CameraMode = .photo { didSet { cameraModeChanged(from: oldValue) } }
    @Published var draft = PhotoDraft()
    /// The photo message screen shows over the camera.
    @Published var composing = false
    /// A photo is being taken or made ready, or the library's are being read.
    @Published private(set) var preparing = false
    /// Why the last photo could not be taken or read, shown on the camera until the next one.
    @Published var photoProblem: String?
    /// Photos fetched for the threads shown, by sha256, checked against it, kept in memory only.
    @Published private(set) var photos: [String: UIImage] = [:]
    @Published var box: Box = .inbox {
        didSet { if box == .archived, oldValue != .archived { Task { await loadArchived() } } }
    }
    @Published var query = ""
    /// Projects chosen in the drawer; none chosen shows them all.
    @Published var projects: Set<String> = []
    @Published private(set) var threads: [ThreadSummary]
    @Published private(set) var archivedThreads: [ThreadSummary] = []
    @Published private(set) var details: [String: ThreadDetail]
    @Published private(set) var projectNames: [(key: String, name: String)]
    /// The same projects as the receiver lists them, each saying whether it is this person's own (2026-11-13).
    @Published private(set) var projectRefs: [ProjectRef]
    /// Whether the receiver makes a project of your own, so New thread's list ends in New project.
    @Published private(set) var newProjects = false
    /// Whether the receiver takes reports from the bug key; nil until it has said.
    @Published private(set) var reportsOn: Bool?
    /// Why the inbox could not be read, shown over the list until a read works.
    @Published private(set) var inboxProblem: String?
    @Published private(set) var loading = false
    @Published private(set) var account: AccountReply?
    /// "Robin · iPhone": who this phone's messages are from, once the receiver has said.
    @Published private(set) var who: String?
    /// Why a thread could not be loaded or changed, by key, shown on the thread.
    @Published private(set) var threadProblems: [String: String] = [:]
    /// A line over the list after Archive, Delete or a report, with Undo while it shows.
    @Published var flash: Flash?
    /// The samples' own inbox state; with the receiver it is the receiver's.
    @Published private(set) var archived: Set<String> = []
    @Published private(set) var read: Set<String> = []
    @Published private(set) var picks: [String: Set<Int>] = [:]

    struct Flash: Equatable {
        let text: String
        let undo: Undo?
        enum Undo: Equatable { case archive(String), delete(String), sampleDelete(ThreadSummary) }
    }

    private var cancellables: Set<AnyCancellable> = []
    private var chosenProject: String?
    private var wasRecording = false
    private var poll: Task<Void, Never>?
    /// The pairing reports were last swept for: a report kept while unpaired goes once, not every 30 s.
    private var sweptFor: Pairing?

    init(probe: ProbeModel, look: (plan: LookPlan, error: String?) = LookPlan.current) {
        self.probe = probe
        self.look = look.plan
        lookError = look.error
        threads = look.plan.samples ? Samples.threads : []
        details = look.plan.samples ? Samples.details : [:]
        projectNames = look.plan.samples ? Samples.projects : []
        projectRefs = look.plan.samples ? Samples.projects.map { ProjectRef(key: $0.key, name: $0.name) } : []
        switch look.plan.screen {
        case .deck: break
        case .rec: recordingShown = true; cameraMode = .video; target = .thread(key: "MUS-26", title: "Aura 2.0 test builds: welcome menu, taiko, piano")
        case .camera: recordingShown = true; target = .newThread
        case .screen: recordingShown = true; cameraMode = .screen; target = .thread(key: "MUS-26", title: "Aura 2.0 test builds: welcome menu, taiko, piano")
        case .photo:
            recordingShown = true
            composing = true
            target = .thread(key: "MUS-26", title: "Aura 2.0 test builds: welcome menu, taiko, piano")
            draft.photos = Samples.photos.map { DraftPhoto(photo: $0, thumbnail: UIImage(data: $0.jpeg)) }
            draft.words = "The piano's lid, from the left"
        case .thread: path = [.thread("MUS-26")]
        case .recordings: path = [.recordings]
        case .settings: path = [.settings]
        case .report: reportAsked = true
        case .drawer: drawerOpen = true
        case .newThread: newThreadNote = true
        }
        // The REC screen follows the take: it closes once the take has ended, by STOP, Cancel or leaving.
        probe.parts?.recorder.$state
            .removeDuplicates()
            .sink { [weak self] state in self?.recorderChanged(state) }
            .store(in: &cancellables)
        // The probe's own changes (the camera, runs, the take, uploads) redraw the deck too: the reels turn
        // with the recorder's state, which nothing of this model's own changes when a take starts.
        probe.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &cancellables)
        probe.parts?.recorder.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &cancellables)
        probe.parts?.uploads.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &cancellables)
        probe.parts?.pairing.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &cancellables)
        probe.parts?.notifier.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &cancellables)
        probe.parts?.link.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &cancellables)
        guard !look.plan.samples else { return }
        // A screen take follows the link: the camera screen shows its STOP while it runs and closes when it ends.
        probe.parts?.link.$state
            .removeDuplicates()
            .sink { [weak self] state in self?.linkChanged(state) }
            .store(in: &cancellables)
        probe.parts?.link.beforeAsking = { [weak self] in self?.writeNext() }
        probe.parts?.notifier.onOpen = { [weak self] key in self?.openFromNotice(key) }
        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in self?.cameToFront() }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .sink { [weak self] _ in self?.poll?.cancel(); self?.poll = nil }
            .store(in: &cancellables)
    }

    private var recorder: CaptureRecorder? { probe.parts?.recorder }
    private var pairing: Pairing? { samples ? nil : probe.parts?.pairing.pairing }
    var paired: Bool { samples || pairing != nil }
    private var client: ReceiverClient? { pairing.map(ReceiverClient.init(pairing:)) }

    private func recorderChanged(_ state: CaptureRecorder.State) {
        switch state {
        case .idle, .failed:
            cancelAsked = false
            // The camera stays open when a take never began (its reason shows there); one that ran returns to the deck.
            if wasRecording {
                if !samples { recordingShown = false }
                wasRecording = false
                if target == .report, case .idle = state, !samples {
                    flash = Flash(text: paired ? "Thank you. Your report is on its way to the Polydance team."
                                               : "Your report is kept on this phone and goes once the phone is paired.", undo: nil)
                }
                // The next take goes to a new thread again, as the line under the key says.
                target = .newThread
                // The take's upload makes or joins a thread: the inbox shows it once the receiver has it.
                Task { try? await Task.sleep(for: .seconds(3)); await self.refresh() }
            }
        case .recording:
            wasRecording = true
        default:
            break
        }
    }

    // MARK: Recording

    var cameraReady: Bool { probe.camera == .ready }

    /// A take of either kind is recording: the camera's, or the screen's.
    var isRecording: Bool {
        if case .recording = recorder?.state { return true }
        return link?.isRecording ?? false
    }

    /// A take of either kind is starting or being finished. The screen's sheet being up is not busy: a press of the
    /// picker then asks again, and the link gives up waiting after 45 s.
    var isBusy: Bool {
        switch recorder?.state {
        case .starting, .stopping: return true
        default: break
        }
        switch link?.state {
        case .starting?, .finishing?: return true
        default: return false
        }
    }

    /// The receiver's allowance is used up: REC reads FULL (R8), except for a report, which is not on the tape.
    var tapeFull: Bool { !samples && account?.full == true }

    /// The red key on the deck: REC opens the camera full screen and starts the take, aimed where the line
    /// under the key says; while a take runs (the REC screen closed by leaving and coming back) it stops it.
    func pressRecord() {
        if screenTaking { link?.stop(); return }
        guard let recorder else { return }
        if isRecording {
            recorder.stop(reason: "STOP was pressed")
            return
        }
        guard cameraReady, !isBusy, !pairingShown else { return }
        if tapeFull, target != .report { return }
        cameraMode = .video
        recordingShown = true
        recorder.start(thread: runThread())
    }

    /// New thread and Reply: the camera, not recording, on Photo (a report has only Video).
    func openCamera() {
        cameraMode = target == .report ? .video : .photo
        photoProblem = nil
        composing = !draft.isEmpty
        recordingShown = true
    }

    /// Photo · Video is offered until a photo is waiting: then Another adds photos to the same message, and a
    /// take, which would leave the draft aimed nowhere, waits until it is sent or thrown away.
    var videoOffered: Bool { draft.isEmpty }

    /// The camera's shutter: a photo into the draft, or, on Video, the take as REC starts it.
    func shutter() {
        if samples { return }
        switch cameraMode {
        case .screen:
            // The red key in Screen is the system's picker itself (RecordingScreen); a press from code is a fallback.
            guard screenReady else { return }
            if link?.start() == false { photoProblem = "Press the red key itself: iOS did not take the press from Polydance." }
        case .video:
            guard let recorder, cameraReady, !isBusy, !isRecording, draft.isEmpty else { return }
            if tapeFull, target != .report { return }
            recorder.start(thread: runThread())
        case .photo:
            guard let recorder, cameraReady, !preparing, !isBusy, !isRecording, draft.photos.count < PhotoPrep.maxPhotos else { return }
            preparing = true
            photoProblem = nil
            Task {
                defer { preparing = false }
                do {
                    let data = try await recorder.takePhoto()
                    try await add([data])
                    composing = true
                } catch {
                    photoProblem = Self.words(error)
                }
            }
        }
    }

    /// Photos chosen in the library (PhotosPicker, which needs no access to the library), into the draft.
    func addFromLibrary(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty, !preparing else { return }
        preparing = true
        photoProblem = nil
        Task {
            defer { preparing = false }
            do {
                var datas: [Data] = []
                for item in items.prefix(PhotoPrep.maxPhotos - draft.photos.count) {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw ReceiverError(status: 0, reason: "a photo could not be read from the library") }
                    datas.append(data)
                }
                try await add(datas)
                composing = true
            } catch {
                if composing { draft.problem = Self.words(error) } else { photoProblem = Self.words(error) }
            }
        }
    }

    /// Made upright, at most 4096 px, JPEG without tags (PhotoPrep), off the main thread, then into the draft.
    private func add(_ datas: [Data]) async throws {
        let ready = try await Task.detached(priority: .userInitiated) {
            try datas.map { data -> (PreparedPhoto, UIImage?) in
                let photo = try PhotoPrep.prepare(data)
                return (photo, UIImage(data: photo.jpeg)?.preparingThumbnail(of: CGSize(width: 480, height: 480)))
            }
        }.value
        if draft.isEmpty { draft.startedAt = Date() }
        for (photo, thumbnail) in ready where draft.photos.count < PhotoPrep.maxPhotos {
            draft.photos.append(DraftPhoto(photo: photo, thumbnail: thumbnail))
        }
        draft.problem = nil
    }

    func removePhoto(_ id: UUID) {
        draft.photos.removeAll { $0.id == id }
        if draft.isEmpty { composing = false }
    }

    /// Another: back to the camera, the draft kept.
    func anotherPhoto() {
        cameraMode = .photo
        photoProblem = nil
        composing = false
    }

    /// Cancel on the camera: back to the photos waiting, else out to where it was opened from.
    func closeCamera() {
        if !draft.isEmpty { composing = true; return }
        recordingShown = false
        target = .newThread
        // Back to the deck with the camera running again, as it was before Screen.
        if cameraMode == .screen { cameraMode = .photo }
    }

    /// Throw away on the photo message screen: nothing was sent, and nothing is kept.
    func discardDraft() {
        draft = PhotoDraft()
        composing = false
        recordingShown = false
        target = .newThread
    }

    /// Where Send goes, said over the photo message.
    var draftLine: String {
        switch target {
        case .thread(let key, let title): return "Reply · \(key) · \(title)"
        case .newThread: return "New thread · " + (currentProject.map(projectName) ?? (samples ? "All projects" : "no project"))
        case .report: return "Report"
        }
    }

    /// Why Send cannot go, or nil when it can.
    var sendNote: String? {
        if samples { return nil }
        if pairing == nil { return "This phone is not paired, so photos cannot be sent. Pair it behind the gear." }
        if target == .report { return "A report is a recording." }
        if target == .newThread, currentProject == nil { return "The receiver lists no project for this phone, so there is nowhere to open a thread." }
        return nil
    }

    /// Send: each photo to the receiver, then one message naming them; on a refusal the draft stays to try again.
    func sendPhotos() {
        guard let client, !draft.isEmpty, !draft.sending, sendNote == nil else { return }
        let target = target
        let project = currentProject
        let text = PhotoMessage.text(draft.words)
        let title = PhotoMessage.title(words: draft.words, at: draft.startedAt)
        let photos = draft.photos.map(\.photo)
        // The same photos and words, to the same place, keep the delivery id, so the receiver keeps one message.
        let signature = "\(target)|\(project ?? "")|\(text ?? "")|" + photos.map(\.sha256).joined(separator: ",")
        let deliveryId = draft.attempt?.signature == signature ? draft.attempt!.deliveryId : PhotoRequests.deliveryId()
        draft.attempt = (signature, deliveryId)
        draft.sending = true
        draft.problem = nil
        Task {
            do {
                let detail: ThreadDetail
                var ids: [String] = []
                switch target {
                case .thread(let key, _):
                    for photo in photos { ids.append(try await client.sendPhoto(photo, thread: key).sha256) }
                    detail = try await client.postPhotos(thread: key, text: text, photos: ids, deliveryId: deliveryId)
                case .newThread:
                    guard let project else { throw ReceiverError(status: 0, reason: "the receiver lists no project for this phone") }
                    for photo in photos { ids.append(try await client.sendPhoto(photo, project: project).sha256) }
                    detail = try await client.openThread(project: project, title: title, text: text, photos: ids, deliveryId: deliveryId)
                case .report:
                    throw ReceiverError(status: 0, reason: "a report is a recording")
                }
                probe.parts?.log.write("photo.sent", ["photos": photos.count, "words": text != nil, "opened": target == .newThread])
                details[detail.key] = detail
                draft = PhotoDraft()
                composing = false
                recordingShown = false
                self.target = .newThread
                path = [.thread(detail.key)]
                flash = Flash(text: photos.count == 1 ? "Sent a photo to \(detail.key)." : "Sent \(photos.count) photos to \(detail.key).", undo: nil)
                await refresh()
            } catch {
                draft.sending = false
                draft.problem = Self.words(error)
            }
        }
    }

    /// A message's photo for the thread page: fetched once through its thread and checked against its sha256.
    func loadPhoto(_ key: String, sha256: String) async {
        guard photos[sha256] == nil, let client else { return }
        if let data = try? await client.photo(thread: key, sha256: sha256), let image = UIImage(data: data) {
            photos[sha256] = image
        }
    }

    /// What the take's thread.json says, or nil to keep it on the phone (unpaired, or no project to open a thread in).
    private func runThread() -> RunThread? {
        guard pairing != nil else { return target == .report ? .report : nil }
        switch target {
        case .report: return .report
        case .thread(let key, _): return try? RunThread.replying(to: key)
        case .newThread: return currentProject.flatMap { try? RunThread.opening(in: $0) }
        }
    }

    func stop() {
        if screenTaking { link?.stop(); return }
        recorder?.stop(reason: "STOP was pressed")
    }

    func flip() { recorder?.flip() }

    func cancelTake() {
        cancelAsked = false
        if screenTaking { link?.cancel(); return }
        probe.cancelTake()
    }

    // MARK: The screen (I4)

    private var link: BroadcastLink? { probe.parts?.link }

    /// A screen take is starting, recording or being finished (not merely asked for).
    var screenTaking: Bool {
        switch link?.state {
        case .starting?, .recording?, .finishing?: true
        default: false
        }
    }

    /// The app group is there, so the extension has somewhere to write: Screen can record.
    var screenAvailable: Bool { samples || link?.root != nil }

    /// Screen's red key may start a take now.
    var screenReady: Bool {
        if samples { return true }
        return screenAvailable && !isRecording && !isBusy && !(tapeFull && target != .report)
    }

    /// Why Screen cannot record, or what went wrong with the last screen take; nil when nothing needs saying.
    var screenHint: String? {
        if samples { return nil }
        if let error = probe.setupError { return "Polydance could not set up its files: \(error)" }
        if !screenAvailable {
            return "This build has no app group for the screen's recordings, so Screen cannot record (ios/README.md, the app group)."
        }
        if link?.micSilent == true {
            return "No sound from the microphone: it is off in iOS's sheet. The screen is still recording; next time, turn Microphone on before Start Broadcast."
        }
        if let problem = link?.problem { return problem }
        if tapeFull, target != .report { return "The receiver's allowance is used up: delete recordings there before recording more." }
        return nil
    }

    /// The camera is off while Screen is chosen, so its picture and its hold on the microphone are not in the take.
    private func cameraModeChanged(from old: CameraMode) {
        guard cameraMode != old, !samples else { return }
        if cameraMode == .screen {
            recorder?.stopPreview()
            writeNext()
        } else if old == .screen, cameraReady, !screenTaking {
            recorder?.startPreview()
        }
    }

    /// next.json: where the screen's next take goes, kept as the line under the key says, so a broadcast started
    /// from Control Center goes there too.
    private func writeNext() {
        guard !samples, let link else { return }
        link.writeNext(NextTake(thread: runThread(), mic: true, app: BroadcastShared.recordsAppSound,
                                appVersion: probe.shortVersion, appBuild: nil, appCommit: probe.appCommit))
    }

    private var screenWasTaking = false

    private func linkChanged(_ state: BroadcastLink.State) {
        switch state {
        case .starting, .recording, .finishing:
            // Started here, or from Control Center: the camera stops and the take's STOP shows.
            if !screenWasTaking {
                screenWasTaking = true
                if cameraMode != .screen { cameraMode = .screen }
                recorder?.stopPreview()
                composing = false
                recordingShown = true
            }
        case .idle:
            guard screenWasTaking else { return }
            screenWasTaking = false
            cancelAsked = false
            // A take that could not be kept leaves Screen open with its reason, as a camera take that failed does.
            if link?.problem != nil { return }
            recordingShown = false
            target = .newThread
            cameraMode = .photo
            Task { try? await Task.sleep(for: .seconds(3)); await self.refresh() }
        case .asking:
            break
        }
    }

    /// Reply on a thread: back to the deck, aimed at the thread, with the camera open on Photo (S4, 2026-11-13).
    func reply(to key: String) {
        let title = details[key]?.title ?? threads.first { $0.key == key }?.title ?? archivedThreads.first { $0.key == key }?.title ?? key
        let aimed = Target.thread(key: key, title: title)
        // A draft for somewhere else is not carried into this reply.
        if target != aimed { draft = PhotoDraft() }
        target = aimed
        path = []
        openCamera()
    }

    /// New thread: the camera, to open one with a photo or a take, in the project the inbox shows, or the one chosen.
    func newThread() {
        if samples {
            target = .newThread
            openCamera()
            return
        }
        guard pairing != nil else { newThreadNote = true; return }
        // The list asks which, and offers New project where the receiver makes one (2026-11-13).
        if projects.count != 1, projectNames.count > 1 || newProjects { projectAsked = true; return }
        guard let project = currentProject else { newThreadNote = true; return }
        startNewThread(in: project)
    }

    /// New project from New thread's list: made on the receiver, then chosen for the take. Nil when made, else why not.
    func makeProject(_ name: String) async -> String? {
        guard let client else { return "This phone is not paired, so there is no receiver to make a project on." }
        do {
            let made = try await client.newProject(name)
            guard client.pairing == pairing else { return nil }
            projectRefs = made.projects
            projectNames = made.projects.map { (key: $0.key, name: $0.name) }
            chosenProject = made.project.key
            return nil
        } catch {
            return Self.words(error)
        }
    }

    func startNewThread(in project: String) {
        projectAsked = false
        if target != .newThread || chosenProject != project { draft = PhotoDraft() }
        chosenProject = project
        target = .newThread
        openCamera()
    }

    /// The bug key's Start recording (B1): the take is aimed at a report.
    func startReport() {
        reportAsked = false
        target = .report
        if samples { recordingShown = true; return }
        pressRecord()
    }

    /// Where a new thread goes: the one project the inbox shows, else the one last chosen, else the first.
    var currentProject: String? {
        if projects.count == 1, let only = projects.first { return only }
        if let chosenProject, projectNames.contains(where: { $0.key == chosenProject }) { return chosenProject }
        return projectNames.first?.key
    }

    /// Whether the bug key can send a report: unpaired it is kept, and a receiver without a reports project says so.
    var reportNote: String? {
        guard !samples else { return nil }
        if pairing == nil { return "This phone is not paired yet, so the report stays on it and goes once it is paired." }
        if reportsOn == false { return "This receiver takes no reports (it has no reports project), so the bug key cannot send one." }
        return nil
    }

    var reportRefused: Bool { !samples && pairing != nil && reportsOn == false }

    /// The line under the red key: where the take goes, in the deck's capitals.
    var targetLine: String {
        switch target {
        case .report: return paired ? "→ Report · Polydance team" : "→ Report · kept on this phone until it is paired"
        case .thread(let key, let title): return "→ \(key) · \(title)"
        case .newThread:
            if samples { return "→ New thread · " + (projects.count == 1 ? projectName(projects.first!) : "All projects") }
            guard pairing != nil else { return "→ Kept on this phone · pair it behind the gear" }
            guard let project = currentProject else { return "→ Kept on this phone · the receiver lists no projects" }
            return "→ New thread · \(projectName(project))"
        }
    }

    func projectName(_ key: String) -> String { projectNames.first { $0.key == key }?.name ?? key }

    // MARK: Takes on their way

    /// A take being prepared or sent, as the inbox and its thread show it (UploadViews): under the thread's row
    /// and on its message, Robin's pick of four mockups (2026-11-14), as the Quest shows a reply on its way.
    struct UploadShown: Equatable {
        let runName: String
        /// "Uploading to CAP-12", "Uploading a new thread in Marimba", "Uploading a report".
        let title: String
        /// The thread a reply goes to, whose row and page show it.
        let threadKey: String?
        /// The receiver's upload, once it has made one: its thread's message carries the same id.
        let uploadId: String?
        let progress: UploadProgress
    }

    /// Every take being prepared or sent at `now`, oldest first, as the uploads go out.
    func uploads(at now: Date) -> [UploadShown] {
        if samples { return [look.stuck ? Samples.stuckUpload : Samples.upload] }
        guard let uploads = probe.parts?.uploads else { return [] }
        return probe.runs.reversed().compactMap { row in
            uploads.progress(row.run.name, at: now).map { progress in
                UploadShown(runName: row.run.name, title: title(row.thread), threadKey: row.thread?.key,
                            uploadId: uploads.states[row.run.name]?.uploadId, progress: progress)
            }
        }
    }

    private func title(_ thread: RunThread?) -> String {
        switch thread {
        case .reply(let key, _)?: "Uploading to \(key)"
        case .newThread(let project)?: "Uploading a new thread in \(projectName(project))"
        case .report?: "Uploading a report"
        case nil: "Uploading to the receiver"
        }
    }

    /// The control panel at a moment: the counter and the meter move, so the deck asks for it on a timer.
    func readout(at now: Date) -> PhonePanel.Readout {
        let uploads = probe.parts?.uploads
        let uploading = !(uploads?.preparing.isEmpty ?? true)
            || (uploads?.states.values.contains { $0.phase == .narration || $0.phase == .content } ?? false)
        if samples {
            let recording = recordingShown
            return PhonePanel.Readout(recording: recording, ready: !recording, uploading: true, processing: true,
                                      seconds: recording ? Samples.recordingSeconds : 0, mic: Samples.micLevel, micActive: true,
                                      micStrip: "iPhone", key: recording ? .recording : .ready, target: targetLine, hint: nil)
        }
        var seconds = 0
        var key: RecordKey.Mode = cameraReady ? .ready : .disabled
        var word: String?
        var mic = cameraReady ? recorder?.micLevel ?? 0 : 0
        var micActive = cameraReady
        switch link?.state {
        case .recording(_, let since)?:
            // A screen take: its counter, and the extension's mic level (BroadcastLink reads it four times a second).
            seconds = Int(now.timeIntervalSince(since))
            key = .recording
            mic = link?.micLevel ?? 0
            micActive = true
        case .starting?, .finishing?:
            key = .starting
        default:
            switch recorder?.state {
            case .recording(let since)?:
                seconds = Int(now.timeIntervalSince(since))
                key = .recording
            case .starting?, .stopping?:
                key = .starting
            default:
                if tapeFull, target != .report { key = .disabled; word = "Full" }
            }
        }
        let recording = key == .recording
        return PhonePanel.Readout(recording: recording, ready: cameraReady && key == .ready, uploading: uploading, processing: false,
                                  seconds: seconds, mic: mic, micActive: micActive,
                                  micStrip: micActive ? Self.micName() : "No mic", key: key, keyWord: word, target: targetLine,
                                  hint: screenTaking ? screenHint : hint)
    }

    /// Only when something needs doing (S1): the camera, the files, a refused argument, a failed take, the tape.
    var hint: String? {
        if let error = probe.setupError { return "Polydance could not set up its files: \(error)" }
        if let lookError { return "Look arguments refused: \(lookError)" }
        if let autoError = probe.autoError { return "Auto mode refused: \(autoError)" }
        if case .failed(let why)? = recorder?.state { return why }
        switch probe.camera {
        case .noCamera: return "No camera here (the Simulator has none), so REC is off."
        case .denied(let why): return why
        case .notAsked: return "Asking for the camera and the microphone…"
        case .ready: break
        }
        if tapeFull { return "The receiver's allowance is used up: delete recordings there before recording more." }
        return nil
    }

    /// The microphone iOS has chosen, by its kind, never its name (which can carry a person's).
    static func micName() -> String {
        guard let port = AVAudioSession.sharedInstance().currentRoute.inputs.first?.portType else { return "Mic" }
        switch port {
        case .builtInMic: return "iPhone"
        case .headsetMic: return "Headset"
        case .bluetoothHFP: return "Bluetooth"
        case .usbAudio: return "USB"
        case .carAudio: return "Car"
        default: return "Mic"
        }
    }

    // MARK: The tape

    var storage: (used: Double?, full: Bool, label: String) {
        if samples { return (Samples.used, false, Samples.storage) }
        // Paired: the receiver's allowance for this token (GET /v1/account). Else what is on the phone.
        if let account { return (account.used, account.full, account.label) }
        let takes = probe.runs.filter { !$0.isReport }
        let bytes = takes.reduce(Int64(0)) { $0 + $1.bytes }
        return (nil, false, takes.isEmpty ? "No takes" : String(format: "%.1f GB here", Double(bytes) / 1_000_000_000))
    }

    // MARK: The receiver

    private func cameToFront() {
        Task { await refresh() }
        poll?.cancel()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    /// Reads the inbox (and Archived when it shows), the allowance, and who this token is.
    func refresh() async {
        guard let client else { return }
        loading = true
        defer { loading = false }
        do {
            let listing = try await client.listing()
            guard client.pairing == pairing else { return }
            apply(listing)
            inboxProblem = nil
            probe.parts?.notifier.shown(listing)
            if box == .archived { await loadArchived() }
        } catch {
            inboxProblem = Self.words(error)
        }
        if let account = try? await client.account(), client.pairing == pairing { self.account = account }
        if who == nil, let me = try? await client.me(), client.pairing == pairing { who = me.who }
        // A report kept while unpaired goes once there is somewhere to send it (launch sweeps too).
        if sweptFor != client.pairing, client.pairing == pairing {
            sweptFor = client.pairing
            probe.sweepReports()
        }
    }

    private func apply(_ listing: ThreadListing) {
        threads = listing.threads
        projectNames = listing.projects.map { (key: $0.key, name: $0.name) }
        projectRefs = listing.projects
        newProjects = listing.newProjects
        reportsOn = listing.reports
        projects = projects.filter { key in listing.projects.contains { $0.key == key } }
    }

    private func loadArchived() async {
        guard let client else { return }
        do {
            archivedThreads = try await client.listing(archived: true).threads
            inboxProblem = nil
        } catch {
            inboxProblem = Self.words(error)
        }
    }

    /// Pairs with what the code held, once the receiver has said who the token is and what it may store.
    func pair(_ new: Pairing) async -> Result<String, ReceiverError> {
        guard let store = probe.parts?.pairing else { return .failure(ReceiverError(status: 0, reason: "Polydance could not set up its files")) }
        let client = ReceiverClient(pairing: new)
        do {
            let me = try await client.me()
            let account = try await client.account()
            try store.save(new, how: "qr")
            who = me.who
            self.account = account
            details = [:]
            threads = []
            archivedThreads = []
            Task { await refresh() }
            return .success(me.who)
        } catch let error as ReceiverError {
            probe.parts?.log.write("pair.check", ["ok": false, "status": error.status, "appState": ProbeAppState.current()])
            return .failure(error.status == 401 ? ReceiverError(status: 401, reason: "the receiver does not know this token (is it in POLYCAP_SERVER_TOKENS?)") : error)
        } catch {
            return .failure(ReceiverError(status: 0, reason: ProbeModel.describe(error)))
        }
    }

    func unpair() {
        probe.parts?.pairing.forget()
        threads = []
        archivedThreads = []
        details = [:]
        projectNames = []
        projectRefs = []
        newProjects = false
        reportsOn = nil
        account = nil
        who = nil
        inboxProblem = nil
        target = .newThread
    }

    /// The scanner needs the camera: the deck's preview stops while it is up, and starts again after.
    func openPairing() {
        guard !isRecording, !isBusy else { return }
        recorder?.stopPreview()
        pairingShown = true
    }

    /// The deck's camera starts again when the cover has gone (DeckScreen's onDismiss).
    func closePairing() { pairingShown = false }

    // MARK: The inbox

    var unread: Int {
        if samples { return threads.filter { !archived.contains($0.key) && isNew($0) }.count }
        return threads.filter(\.unread).count
    }

    func isNew(_ thread: ThreadSummary) -> Bool { thread.isNew && !read.contains(thread.key) }

    /// The rows for the box showing, narrowed to the chosen projects and to the search.
    var visibleThreads: [ThreadSummary] {
        let source = samples ? threads.filter { (box == .archived) == archived.contains($0.key) } : (box == .archived ? archivedThreads : threads)
        return source.filter { thread in
            (projects.isEmpty || projects.contains(thread.project))
                && (query.isEmpty || thread.title.localizedCaseInsensitiveContains(query) || thread.key.localizedCaseInsensitiveContains(query)
                    || (thread.snippet ?? "").localizedCaseInsensitiveContains(query))
        }
        .map { thread in
            var shown = thread
            if read.contains(thread.key) { shown.unread = false; shown.fresh = 0 }
            return shown
        }
    }

    /// What the list shows, as Gmail's "All inboxes" line does: Inbox or Archived, unread, which projects.
    var sectionLine: String {
        let where_ = samples ? "Samples" : projects.isEmpty ? "All projects" : projects.sorted().map(projectName).joined(separator: " · ")
        let unreadPart = box == .inbox && unread > 0 ? " · \(unread) unread" : ""
        return "\(box == .archived ? "Archived" : "Inbox")\(unreadPart) · \(where_)"
    }

    var emptyLine: String {
        if samples { return box == .archived ? "Nothing archived." : "No threads match." }
        guard pairing != nil else {
            return "No threads yet. Pair this phone with the Mac (the gear, then Pair with the Mac) and its threads show here."
        }
        if loading && threads.isEmpty { return "Asking the receiver…" }
        if !query.isEmpty || !projects.isEmpty { return "No threads match." }
        return box == .archived ? "Nothing archived." : "No threads yet. Record with REC or New thread to start one."
    }

    func open(_ key: String) {
        read.insert(key)
        path.append(.thread(key))
        if !samples { Task { await loadThread(key) } }
    }

    private func openFromNotice(_ key: String) {
        drawerOpen = false
        path = [.thread(key)]
        Task { await loadThread(key) }
    }

    /// The thread from the receiver, marked read when something in it is new to this token.
    func loadThread(_ key: String) async {
        guard let client else { return }
        do {
            var detail = try await client.thread(key)
            if detail.unread == true || detail.hasUnseen {
                detail = try await client.markRead(key, seq: detail.seq)
                markReadInList(key)
            }
            details[key] = detail
            threadProblems[key] = nil
            probe.parts?.notifier.seen(key)
        } catch {
            threadProblems[key] = Self.words(error)
        }
    }

    private func markReadInList(_ key: String) {
        if let i = threads.firstIndex(where: { $0.key == key }) { threads[i].unread = false; threads[i].fresh = 0 }
        if let i = archivedThreads.firstIndex(where: { $0.key == key }) { archivedThreads[i].unread = false; archivedThreads[i].fresh = 0 }
    }

    /// The title for a thread page: its own, else the list's, else its key.
    func title(of key: String) -> String {
        details[key]?.title ?? threads.first { $0.key == key }?.title ?? archivedThreads.first { $0.key == key }?.title ?? key
    }

    func isArchived(_ key: String) -> Bool {
        if samples { return archived.contains(key) }
        return details[key]?.state == "closed" || archivedThreads.contains { $0.key == key }
    }

    /// Archive: the thread is closed for everyone and leaves the inbox; on an archived thread, it opens it again.
    func archive(_ key: String) {
        path.removeAll { $0 == .thread(key) }
        if samples {
            archived.insert(key)
            flash = Flash(text: "Archived \(key): it comes back when someone adds to it.", undo: .archive(key))
            return
        }
        let reopen = isArchived(key)
        change(key) { client in
            let detail = try await client.archive(key, archived: !reopen)
            self.details[key] = detail
            self.flash = Flash(text: reopen ? "\(key) is back in the inbox." : "Archived \(key): it is closed for everyone in it.", undo: reopen ? nil : .archive(key))
        }
    }

    /// Delete from this inbox (S4), after its confirmation: hidden for this phone's token until someone adds to it.
    func delete(_ key: String) {
        path.removeAll { $0 == .thread(key) }
        if samples {
            guard let thread = threads.first(where: { $0.key == key }) else { return }
            threads.removeAll { $0.key == key }
            flash = Flash(text: "Deleted \(key) from this inbox.", undo: .sampleDelete(thread))
            return
        }
        change(key) { client in
            try await client.hide(key, hidden: true)
            self.flash = Flash(text: "Deleted \(key) from this inbox: it comes back when someone adds to it.", undo: .delete(key))
        }
    }

    func undo(_ undo: Flash.Undo) {
        flash = nil
        switch undo {
        case .archive(let key):
            if samples { archived.remove(key); return }
            change(key) { client in self.details[key] = try await client.archive(key, archived: false) }
        case .delete(let key):
            change(key) { client in try await client.hide(key, hidden: false) }
        case .sampleDelete(let thread):
            threads.append(thread)
            threads.sort { ($0.lastMessageAt ?? $0.updatedAt) > ($1.lastMessageAt ?? $1.updatedAt) }
        }
    }

    /// A star on one of a message's options: the same again takes it off, another moves it.
    func togglePick(_ key: String, message: Int, launch: Int) {
        if samples {
            var chosen = picks[key] ?? []
            if !chosen.insert(launch).inserted { chosen.remove(launch) }
            picks[key] = chosen
            return
        }
        change(key) { client in self.details[key] = try await client.pick(key, message: message, launch: launch) }
    }

    func isPicked(_ key: String, message: ThreadMessage, launch: Int) -> Bool {
        if samples { return picks[key]?.contains(launch) == true }
        return details[key]?.myPick(on: message) == launch
    }

    /// A reaction on a message: the same again takes it off, another replaces it.
    func react(_ key: String, message: Int, reaction: String) {
        guard !samples else { return }
        change(key) { client in self.details[key] = try await client.react(key, message: message, reaction: reaction) }
    }

    func myReaction(_ key: String, on message: ThreadMessage) -> String? { details[key]?.myReaction(on: message) }

    /// A change to a thread on the receiver, then the inbox read again; a refusal is said on the thread and over the list.
    private func change(_ key: String, _ work: @escaping (ReceiverClient) async throws -> Void) {
        guard let client else { return }
        Task {
            do {
                try await work(client)
                self.threadProblems[key] = nil
            } catch {
                let words = Self.words(error)
                self.threadProblems[key] = words
                self.flash = Flash(text: "\(key): \(words)", undo: nil)
            }
            await self.refresh()
        }
    }

    /// Just open on a launch (L1): an https link opens in the default browser; nothing else is done here.
    func openLink(_ url: URL) {
        guard LaunchLink.https(url.absoluteString) != nil else { return }
        UIApplication.shared.open(url)
    }

    static func words(_ error: Error) -> String {
        if let error = error as? ReceiverError { return error.description }
        if let error = error as? UploadProtocolError { return error.description }
        if let error = error as? CaptureFailure { return error.message }
        return ProbeModel.describe(error)
    }
}
