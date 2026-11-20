// The camera (docs/IPHONE.md S2; Robin's pick of 2026-11-13, "the camera, then choose"): the picture fills
// the screen. New thread and Reply open it without recording, on Photo: along the foot, on the black panel, a
// Photo · Video switch over the shutter, Library at the left and Flip at the right. The cream shutter takes a
// photo, which goes to the photo message screen (PhotoMessageScreen); switched to Video, the shutter is red
// and starts the take. A take shows what it always has: the counter, the MIC meter, FLIP, the red key (STOP)
// and a smaller Cancel, which asks once and throws the take away, uploading nothing; STOP returns to the deck.
// The deck's REC key and the bug key's report come straight to the take. The picture is the session's own
// preview layer (CameraPreview); without a camera (the Simulator) the screen says so on black.
//
// Screen, the third mode (docs/IPHONE.md I4): the camera stops and the picture says what happens; the red key is
// the system's broadcast picker drawn invisibly over a red key, so a press opens iOS's Start Broadcast sheet.
// While the screen records, the foot is the take's own, without FLIP; STOP and Cancel go to the extension.
import PhotosUI
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct RecordingScreen: View {
    @ObservedObject var deck: DeckModel
    @State private var library: [PhotosPickerItem] = []

    var body: some View {
        Group {
            if deck.composing {
                PhotoMessageScreen(deck: deck)
            } else {
                camera
            }
        }
        .statusBarHidden(!deck.composing)
        .persistentSystemOverlays(deck.composing ? .automatic : .hidden)
    }

    private var camera: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            picture.ignoresSafeArea()
                // A sideways swipe on the picture moves along Photo, Video and Screen, as the iPhone's Camera does.
                .gesture(DragGesture(minimumDistance: 30).onEnded { drag in
                    guard !taking, deck.videoOffered, deck.target != .report, abs(drag.translation.width) > abs(drag.translation.height),
                          let i = Self.modes.firstIndex(of: deck.cameraMode) else { return }
                    let next = drag.translation.width < 0 ? min(i + 1, Self.modes.count - 1) : max(i - 1, 0)
                    deck.cameraMode = Self.modes[next]
                })
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    if !taking {
                        Button(deck.draft.isEmpty ? "Cancel" : deck.draft.photos.count == 1 ? "Back to the photo" : "Back to \(deck.draft.photos.count) photos") {
                            deck.closeCamera()
                        }
                        .buttonStyle(KeyStyle(color: Palette.tan))
                    }
                    LabelText(deck.targetLine, size: 10, color: Palette.cream, tracking: 0.12)
                        .lineLimit(1).truncationMode(.tail)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Capsule().fill(Palette.panel.opacity(0.85)))
                        .overlay(Capsule().stroke(Palette.edge))
                    if !taking { Spacer(minLength: 0) }
                }
                .padding(.horizontal, 16).padding(.top, 8)
                Spacer()
                TimelineView(.periodic(from: .now, by: 0.1)) { context in
                    let readout = deck.readout(at: context.date)
                    if readout.key == .recording || readout.key == .starting {
                        takeFoot(readout)
                    } else {
                        aimFoot(readout)
                    }
                }
            }
            if deck.cancelAsked {
                PlateDialog(title: "Throw this take away?",
                            text: "It stops now and is deleted from this phone. Nothing of it is uploaded.",
                            keys: [.init(title: "Keep recording", action: { deck.cancelAsked = false }),
                                   .init(title: "Throw away", color: Palette.red, action: deck.cancelTake)],
                            dismiss: { deck.cancelAsked = false })
            }
        }
        .onChange(of: library) { _, items in
            deck.addFromLibrary(items)
            library = []
        }
    }

    /// A take is starting, running or stopping: Cancel is not offered and the mode cannot change.
    private var taking: Bool { deck.isRecording || deck.isBusy }

    static let modes: [DeckModel.CameraMode] = [.photo, .video, .screen]

    /// Screen is chosen, or a screen take runs (it may have been started from Control Center).
    private var screen: Bool { deck.cameraMode == .screen || deck.screenTaking }

    @ViewBuilder private var picture: some View {
        if screen {
            screenPicture
        } else if deck.cameraReady, let session = deck.probe.parts?.recorder.session {
            CameraPreview(session: session)
        } else {
            VStack(spacing: 8) {
                Glyph(.camera, color: Palette.hint, size: 40)
                Text(deck.samples ? "The camera's picture fills this screen. The Simulator has no camera." : deck.hint ?? "No camera.")
                    .font(Theme.sans(14)).foregroundStyle(Palette.tan).multilineTextAlignment(.center)
            }
            .padding(40)
        }
    }

    /// Screen: no camera, so the picture says what the take is and how it ends.
    private var screenPicture: some View {
        VStack(spacing: 12) {
            Glyph(.camera, color: Palette.hint, size: 34).overlay { Rectangle().fill(Palette.hint).frame(width: 46, height: 3).rotationEffect(.degrees(-35)) }
            LabelText(deck.screenTaking ? "Recording the screen" : "The screen and the microphone", size: 13, color: Palette.whitePrint, tracking: 0.14)
            Text(deck.screenTaking
                 ? "Go to whatever you want to show: Polydance records the whole screen and the microphone in the background. Stop it here, or with the red pill at the top of the screen."
                 : "No camera. Press the red key, turn Microphone on in iOS's sheet, then Start Broadcast. After the countdown, go to whatever you want to show; stop it here or with the red pill at the top of the screen.")
                .font(Theme.sans(14)).foregroundStyle(Palette.tan).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(36)
    }

    /// Before anything is taken: what went wrong last, Photo · Video · Screen, then Library, the shutter and Flip.
    private func aimFoot(_ readout: PhonePanel.Readout) -> some View {
        VStack(spacing: 14) {
            if let problem = deck.photoProblem ?? (screen ? deck.screenHint : deck.cameraReady ? readout.hint : nil) {
                Text(problem).font(Theme.sans(13)).foregroundStyle(Palette.amber)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            if deck.videoOffered && deck.target != .report { modes }
            HStack(spacing: 12) {
                PhotosPicker(selection: $library, maxSelectionCount: max(PhotoPrep.maxPhotos - deck.draft.photos.count, 1),
                             selectionBehavior: .ordered, matching: .images, photoLibrary: .shared()) {
                    Text("Library")
                }
                .buttonStyle(KeyStyle(color: Palette.cream, small: false))
                .disabled(deck.preparing || deck.target == .report || deck.draft.photos.count >= PhotoPrep.maxPhotos)
                .accessibilityLabel("Choose photos from the library")
                .frame(width: 96, alignment: .leading)
                .opacity(screen ? 0 : 1)
                .allowsHitTesting(!screen)
                Spacer(minLength: 4)
                if screen { screenShutter } else { shutter(readout) }
                Spacer(minLength: 4)
                Button("Flip") { deck.flip() }
                    .buttonStyle(KeyStyle(color: Palette.cream, small: false))
                    .disabled(!deck.cameraReady || deck.preparing)
                    .accessibilityLabel("Flip the camera")
                    .frame(width: 96, alignment: .trailing)
                    .opacity(screen ? 0 : 1)
                    .allowsHitTesting(!screen)
            }
        }
        .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 10)
        .background(Palette.panel.opacity(0.92).ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Palette.edge).frame(height: 1) }
    }

    /// Photo first; the chosen one lit, Video and Screen in red (both record).
    private var modes: some View {
        HStack(spacing: 22) {
            ForEach(Self.modes, id: \.self) { mode in
                let on = deck.cameraMode == mode
                let name = switch mode { case .photo: "Photo"; case .video: "Video"; case .screen: "Screen" }
                let lit = mode == .photo ? Palette.amber : Palette.red
                Button { deck.cameraMode = mode } label: {
                    LabelText(name, size: 12, color: on ? lit : Palette.tan, tracking: 0.16)
                        .padding(.vertical, 4).padding(.horizontal, 6)
                        .overlay(alignment: .bottom) { if on { Capsule().fill(lit).frame(height: 2) } }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(mode == .screen ? "Screen and microphone" : name)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    /// Screen's red key: drawn here, with the system's own broadcast button over it, invisible, so a press always
    /// reaches iOS's sheet. Without the button (no app group, a take under way) it is dimmed and does nothing.
    private var screenShutter: some View {
        let usable = deck.screenReady
        return ZStack {
            Circle().stroke(usable ? Palette.cream : Palette.hint, lineWidth: 4).frame(width: 74, height: 74)
            RoundedRectangle(cornerRadius: 5).fill(Palette.red).frame(width: 30, height: 30).opacity(usable ? 1 : 0.4)
            if usable, !deck.samples, let link = deck.probe.parts?.link {
                BroadcastPicker(link: link).frame(width: 80, height: 80)
            }
        }
        .frame(width: 80, height: 80)
        .contentShape(Circle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Record the screen and the microphone")
    }

    /// Cream to take a photo, red to start a take; dimmed while a photo is made ready or the tape is full.
    private func shutter(_ readout: PhonePanel.Readout) -> some View {
        let video = deck.cameraMode == .video
        let usable = deck.samples || (deck.cameraReady && !deck.preparing && (video ? readout.key == .ready : deck.draft.photos.count < PhotoPrep.maxPhotos))
        return Button { deck.shutter() } label: {
            ZStack {
                Circle().stroke(usable ? Palette.cream : Palette.hint, lineWidth: 4).frame(width: 74, height: 74)
                Circle().fill(video ? Palette.red : Palette.plateLight).frame(width: video ? 30 : 60, height: video ? 30 : 60)
                    .opacity(usable ? 1 : 0.4)
                if deck.preparing { ProgressView().tint(Palette.print) }
                if video, let word = readout.keyWord {
                    LabelText(word, size: 10, color: Palette.whitePrint).offset(y: 50)
                }
            }
            .frame(width: 80, height: 80)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!usable)
        .accessibilityLabel(video ? "Record" : "Take a photo")
    }

    /// While a take runs: the counter, the MIC meter, FLIP, STOP and Cancel, as the REC screen always had.
    private func takeFoot(_ readout: PhonePanel.Readout) -> some View {
        VStack(spacing: 12) {
            // A screen take's warning, chiefly a microphone left off in iOS's sheet.
            if deck.screenTaking, let hint = deck.screenHint {
                Text(hint).font(Theme.sans(13)).foregroundStyle(Palette.amber)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                RollingCounter(seconds: readout.seconds, cell: 18, height: 34)
                Spacer(minLength: 8)
                NeedleMeter(label: "Mic", level: readout.mic, active: readout.micActive, strip: readout.micStrip)
                    .frame(width: 132, height: 64)
            }
            HStack(spacing: 12) {
                // No camera in a screen take, so nothing to flip: the key keeps its place, unseen.
                Button("Flip") { deck.flip() }
                    .buttonStyle(KeyStyle(color: Palette.cream, small: false))
                    .disabled(readout.key != .recording || deck.screenTaking)
                    .accessibilityLabel("Flip the camera")
                    .opacity(deck.screenTaking ? 0 : 1)
                Spacer(minLength: 4)
                RecordKey(mode: readout.key, width: 120, height: 46) {
                    if readout.key == .recording { deck.stop() }
                }
                Spacer(minLength: 4)
                Button("Cancel") { deck.cancelAsked = true }
                    .buttonStyle(KeyStyle(color: Palette.tan))
                    .disabled(readout.key != .recording)
            }
        }
        .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 10)
        .background(Palette.panel.opacity(0.92).ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Palette.edge).frame(height: 1) }
    }
}

/// After a photo (Robin's pick of 2026-11-13): the photos waiting, each with a key to take it out, Another
/// (back to the camera) and Library, the words (the first line names a new thread), and Send. On the wood, as
/// a thread is. A refusal is said over Send and the photos stay, so Send again is the same message.
struct PhotoMessageScreen: View {
    @ObservedObject var deck: DeckModel
    @State private var library: [PhotosPickerItem] = []
    @State private var discardAsked = false
    @FocusState private var writing: Bool

    private let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                IconKey(.close, color: Palette.burnt, label: "Throw these photos away") { discardAsked = true }
                    .disabled(deck.draft.sending)
                Spacer(minLength: 4)
                LabelText(deck.draftLine, size: 10, color: Palette.cream, tracking: 0.12)
                    .lineLimit(1).truncationMode(.tail)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Capsule().fill(Palette.panel))
            }
            .padding(.horizontal, 10).padding(.top, 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(deck.draft.photos) { photo in tile(photo) }
                    }
                    HStack(spacing: 10) {
                        Button("Another") { deck.anotherPhoto() }
                            .buttonStyle(KeyStyle(color: Palette.cream, small: false))
                            .accessibilityLabel("Take another photo")
                        PhotosPicker(selection: $library, maxSelectionCount: max(PhotoPrep.maxPhotos - deck.draft.photos.count, 1),
                                     selectionBehavior: .ordered, matching: .images, photoLibrary: .shared()) {
                            Text("Library")
                        }
                        .buttonStyle(KeyStyle(color: Palette.cream, small: false))
                        .accessibilityLabel("Add photos from the library")
                        if deck.preparing { ProgressView().tint(Palette.burnt) }
                        Spacer(minLength: 0)
                        LabelText("\(deck.draft.photos.count) of \(PhotoPrep.maxPhotos)", size: 10, color: Palette.burnt)
                    }
                    .disabled(deck.draft.sending || deck.draft.photos.count >= PhotoPrep.maxPhotos)
                    TextField("", text: $deck.draft.words,
                              prompt: Text(deck.target == .newThread ? "Words, if you like. The first line names the thread." : "Words, if you like.")
                                .foregroundStyle(Palette.hint),
                              axis: .vertical)
                        .lineLimit(3...8)
                        .font(Theme.sans(15)).foregroundStyle(Palette.cream).tint(Palette.amber)
                        .focused($writing)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Palette.panel))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.edge))
                        .disabled(deck.draft.sending)
                        .onChange(of: deck.draft.words) { _, words in
                            if words.count > PhotoMessage.maxText { deck.draft.words = String(words.prefix(PhotoMessage.maxText)) }
                        }
                    if deck.target == .newThread {
                        Text("Titled “\(PhotoMessage.title(words: deck.draft.words, at: deck.draft.startedAt))”")
                            .font(Theme.sans(13)).foregroundStyle(Palette.burnt)
                    }
                    if let note = deck.sendNote ?? deck.draft.problem {
                        Text(note).font(Theme.sans(14)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 10)
            }
            .scrollDismissesKeyboard(.interactively)
            Button { writing = false; deck.sendPhotos() } label: {
                Text(deck.draft.sending ? "Sending…" : deck.draft.photos.count == 1 ? "Send the photo" : "Send \(deck.draft.photos.count) photos")
                    .font(Theme.label(15)).tracking(1.5).textCase(.uppercase)
                    .foregroundStyle(sendable ? Palette.print : Palette.hint)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(Pill().fill(sendable ? Palette.cream : Palette.plateDark))
                    .overlay(Pill().stroke(Palette.plateEdge, lineWidth: 1.5))
                    .contentShape(Pill())
            }
            .buttonStyle(.plain)
            .disabled(!sendable)
            .padding(.horizontal, 10).padding(.vertical, 8)
        }
        .background(Wood().ignoresSafeArea())
        .overlay {
            if discardAsked {
                PlateDialog(title: deck.draft.photos.count == 1 ? "Throw this photo away?" : "Throw these photos away?",
                            text: "Nothing has been sent. They and the words are not kept anywhere.",
                            keys: [.init(title: "Keep", action: { discardAsked = false }),
                                   .init(title: "Throw away", color: Palette.red, action: { discardAsked = false; deck.discardDraft() })],
                            dismiss: { discardAsked = false })
            }
        }
        .onChange(of: library) { _, items in
            deck.addFromLibrary(items)
            library = []
        }
    }

    private var sendable: Bool { !deck.draft.sending && !deck.draft.isEmpty && deck.sendNote == nil && !deck.preparing }

    private func tile(_ photo: DeckModel.DraftPhoto) -> some View {
        Color.clear
            .aspectRatio(3 / 4, contentMode: .fit)
            .overlay {
                if let thumbnail = photo.thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    Palette.surface
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.edge))
            .overlay(alignment: .topTrailing) {
                Button { deck.removePhoto(photo.id) } label: {
                    Glyph(.close, color: Palette.cream, size: 14)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(Palette.panel.opacity(0.9)))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(deck.draft.sending)
                .padding(5)
                .accessibilityLabel("Take this photo out")
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Photo, \(photo.photo.width) by \(photo.photo.height)")
    }
}
