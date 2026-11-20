// Polydance for iPhone's screen (docs/IPHONE.md S1 to S6, Robin 2026-11-06: the deck on top, the inbox
// below): on the light wooden cabinet, the cream top plate with its reels, the bug key and the gear; the
// black control panel; and the inbox under it. A thread, Recordings, the settings and the I0 probe's own
// screen open over it, REC fills the screen with the camera, and pairing fills it with the QR scanner. Every part is PolydanceShared's, the
// look the Mac and the headset share, so nothing here picks a colour of its own.
import PolydanceShared
import SwiftUI
import UIKit

struct DeckScreen: View {
    @StateObject private var deck: DeckModel

    init(probe: ProbeModel) {
        _deck = StateObject(wrappedValue: DeckModel(probe: probe))
    }

    var body: some View {
        Group {
            if deck.probe.parts == nil {
                setupFailed
            } else {
                NavigationStack(path: $deck.path) {
                    DeckHome(deck: deck)
                        .toolbar(.hidden, for: .navigationBar)
                        .navigationDestination(for: DeckModel.Page.self) { page in
                            switch page {
                            case .thread(let key): ThreadScreen(deck: deck, key: key)
                            case .recordings: RecordingsScreen(deck: deck)
                            case .settings: SettingsScreen(deck: deck)
                            case .probe: ProbeView(model: deck.probe).navigationTitle("I0 probe").toolbar(.visible, for: .navigationBar)
                            }
                        }
                }
                .fullScreenCover(isPresented: $deck.recordingShown) { RecordingScreen(deck: deck) }
                .fullScreenCover(isPresented: $deck.pairingShown, onDismiss: { if deck.cameraReady { deck.probe.parts?.recorder.startPreview() } }) {
                    PairScreen(deck: deck)
                }
            }
        }
        .environment(\.colorScheme, .dark)
        .preferredColorScheme(.dark)
        .tint(Palette.amber)
        .task { await deck.probe.screenAppeared() }
    }

    private var setupFailed: some View {
        VStack(alignment: .leading, spacing: 12) {
            LabelText("Polydance could not set up its files", size: 13, color: Palette.whitePrint)
            Text(deck.probe.setupError ?? "No reason was given.").font(Theme.sans(15)).foregroundStyle(Palette.cream)
            Text("Nothing records or uploads until this is fixed.").font(Theme.sans(14)).foregroundStyle(Palette.tan)
        }
        .plate(padding: 20)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Wood().ignoresSafeArea())
    }
}

/// The deck and the inbox on the cabinet, with the drawer and the pop-ups over them.
private struct DeckHome: View {
    @ObservedObject var deck: DeckModel

    var body: some View {
        VStack(spacing: 8) {
            let tape = deck.storage
            TopPlate(spinning: deck.samples ? deck.recordingShown : deck.isRecording, used: tape.used, full: tape.full, storage: tape.label,
                     logo: Logo.image, onStorage: { deck.path.append(.recordings) },
                     onBug: { deck.reportAsked = true }, onGear: { deck.path.append(.settings) })
                .frame(height: 146)
            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                PhonePanel(readout: deck.readout(at: context.date), record: deck.pressRecord)
            }
            InboxView(deck: deck)
        }
        .padding(.horizontal, 10).padding(.top, 2)
        .background(Wood().ignoresSafeArea())
        .overlay {
            if deck.drawerOpen { InboxDrawer(deck: deck) }
        }
        .animation(.easeOut(duration: 0.2), value: deck.drawerOpen)
        .overlay {
            if deck.reportAsked {
                PlateDialog.report(note: deck.reportNote, refused: deck.reportRefused, start: deck.startReport, cancel: { deck.reportAsked = false })
            } else if deck.projectAsked {
                // One list, yours marked, ending in New project (Robin's pick of four mockups, 2026-11-13).
                PlateDialog(title: "New thread in…",
                            text: "The camera opens on Photo, with Video beside it. A photo's words name the thread; with a recording, the receiver names it from what you say.",
                            keys: [.init(title: "Cancel", color: Palette.tan, action: { deck.projectAsked = false })],
                            dismiss: { deck.projectAsked = false },
                            content: AnyView(ProjectList(projects: deck.projectRefs, chosen: deck.currentProject, canMake: deck.newProjects,
                                                         choose: { deck.startNewThread(in: $0) }, make: { await deck.makeProject($0) })))
            } else if deck.newThreadNote {
                PlateDialog(title: "New thread",
                            text: deck.paired ? "The receiver lists no project for this phone's token, so there is nowhere to open a thread."
                                : "A new thread starts with a recording sent to the receiver, so this phone needs pairing with the Mac first: the gear, then Pair with the Mac. "
                                + "Until then, REC on the deck records a take that stays on this phone.",
                            keys: [.init(title: "Close", action: { deck.newThreadNote = false })],
                            dismiss: { deck.newThreadNote = false })
            }
        }
    }
}

/// The ballerina, from the headset app's own file (copied into the app by ios/project.yml), as a template
/// image so the top plate prints it in the deck's ink.
enum Logo {
    static let image: Image? = UIImage(named: "polydance_mark").map { Image(uiImage: $0).renderingMode(.template) }
}
