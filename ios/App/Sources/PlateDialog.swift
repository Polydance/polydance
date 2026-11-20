// The headset's pop-ups (MainActivity's AlertDialogs, InboxPane's plateDialog): a black plate over the
// dimmed screen with its title in printed capitals, its words, and its keys along the foot. Used for the
// bug key's report (B1), Cancel on the REC screen, Delete, and what is not built yet.
import PolydanceShared
import SwiftUI

struct PlateDialog: View {
    struct Key {
        let title: String
        var color: Color = Palette.cream
        let action: () -> Void
    }

    let title: String
    let text: String
    let keys: [Key]
    let dismiss: () -> Void
    /// Keys one above the other, for a list of choices.
    var vertical = false
    /// Drawn between the words and the keys: New thread's ProjectList.
    var content: AnyView? = nil

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea().onTapGesture(perform: dismiss)
                .accessibilityAddTraits(.isButton).accessibilityLabel("Close")
            VStack(alignment: .leading, spacing: 14) {
                LabelText(title, size: 13, color: Palette.whitePrint, tracking: 0.16)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(text).font(Theme.sans(15)).foregroundStyle(Palette.cream).lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                if let content { content }
                if vertical {
                    VStack(alignment: .trailing, spacing: 10) {
                        ForEach(Array(keys.enumerated()).reversed(), id: \.offset) { _, key in
                            Button(key.title, action: key.action).buttonStyle(KeyStyle(color: key.color, small: false))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                } else {
                    HStack(spacing: 10) {
                        Spacer(minLength: 0)
                        ForEach(Array(keys.enumerated()), id: \.offset) { _, key in
                            Button(key.title, action: key.action).buttonStyle(KeyStyle(color: key.color, small: false))
                        }
                    }
                }
            }
            .padding(.horizontal, 6)
            .plate(padding: 20)
            .padding(.horizontal, 22)
        }
    }
}

extension PlateDialog {
    /// B1: the headset's words, for a phone. `note` says when it cannot go yet; `refused` when it cannot go at all.
    static func report(note: String?, refused: Bool, start: @escaping () -> Void, cancel: @escaping () -> Void) -> PlateDialog {
        PlateDialog(
            title: "Report a bug or suggest a feature",
            text: "Use this for Polydance itself: something broken, confusing or slow, or a feature you would like. Feedback on an app "
                + "you are testing belongs in its thread.\n\n"
                + "Start recording, then show us what happened with the camera and say what you expected. Press STOP when "
                + "you are done; Cancel beside it throws the recording away.\n\n"
                + "A report goes only to the Polydance team, never to your inbox, and leaves this phone once it is sent."
                + (note.map { "\n\n\($0)" } ?? ""),
            keys: [Key(title: "Cancel", color: Palette.tan, action: cancel)] + (refused ? [] : [Key(title: "Start recording", color: Palette.red, action: start)]),
            dismiss: cancel)
    }
}
