// Behind the gear, in the deck's place (MainActivity's settings page): RECORDING (MIC, APP, picture quality and what
// visionOS records), RECEIVER (paired as "Robin · Vision Pro", how to pair, Unpair), NOTIFICATIONS (reply notices),
// DIAGNOSTICS (the device, visionOS, the build and commit, the signing's end, a live clock) and EVENTS (the log's
// last lines, the app's and the broadcast extension's). The Vision Pro pairs as the iPhone does over its cable: the
// Mac copies a pairing file into the app (`npm run visionos -- configure`), which takes it into the Keychain. There is
// no QR code here, since a visionOS app may not use the cameras.
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct SettingsPage: View {
    @ObservedObject var model: HeadsetModel
    @State private var notifyProblem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                LabelText("Settings", size: 17, color: Palette.whitePrint, tracking: 0.2)
                Spacer()
                Button("Done") { model.settingsShown = false }.buttonStyle(KeyStyle(color: Palette.amber, small: false))
            }
            .padding(.bottom, 12)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    section("Recording") {
                        Toggle("Record the microphone", isOn: $model.mic).disabled(model.isRecording || model.isBusy)
                        Toggle("Record the app's sound (its own track)", isOn: $model.appSound).disabled(model.isRecording || model.isBusy)
                        HStack(spacing: 10) {
                            Text("Picture quality").frame(width: 150, alignment: .leading)
                            // The chosen key is lit amber, the others tan, as the deck shows a changed choice.
                            ForEach(RecordingQuality.allCases) { quality in
                                Button(quality.label) { model.quality = quality }
                                    .buttonStyle(KeyStyle(color: model.quality == quality ? Palette.amber : Palette.tan))
                            }
                        }
                        .disabled(model.isRecording || model.isBusy)
                        note(model.quality.detail)
                        note("visionOS records the whole view at its own size, with the room black: Apple keeps the cameras' view out of "
                             + "recordings unless an app has its enterprise licence. Its Start Broadcast sheet asks before every recording; "
                             + "turn its microphone on there too.")
                    }
                    section("Receiver") {
                        if let pairing = model.parts?.pairing.pairing {
                            line("Paired", model.who ?? "asking who this is…")
                            line("Receiver", pairing.place)
                            Button("Unpair") { model.unpair() }.buttonStyle(KeyStyle(color: Palette.red))
                            note("Unpairing forgets the token. Recordings stay on this headset.")
                        } else {
                            note("Not paired. On the Mac, with this headset on the same network and paired in Xcode: "
                                 + "npm run visionos -- configure --token-file ~/.config/polycap/tokens/visionpro, then open Polydance again.")
                        }
                        if let problem = model.parts?.pairing.problem { Text(problem).font(Theme.sans(14)).foregroundStyle(Palette.red) }
                    }
                    section("Notifications") {
                        if let notifier = model.parts?.notifier {
                            Toggle("Replies", isOn: Binding(get: { notifier.enabled }, set: { on in
                                if on { Task { notifyProblem = await notifier.turnOn() } } else { notifier.turnOff() }
                            }))
                            line("Last check", notifier.lastCheck)
                            if let notifyProblem { Text(notifyProblem).font(Theme.sans(14)).foregroundStyle(Palette.red) }
                        }
                    }
                    section("Diagnostics") {
                        line("Device", "\(model.modelIdentifier) · \(model.systemVersion)")
                        line("App", model.versionLine)
                        line("Signing", signing)
                        if let size = model.parts?.link.size { line("Last picture", "\(size.width) × \(size.height)") }
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(context.date.formatted(date: .omitted, time: .standard)).font(.system(size: 30, design: .monospaced)).foregroundStyle(Palette.cream)
                        }
                    }
                    section("Events") {
                        ForEach(Array(model.recentEvents(14).enumerated()), id: \.offset) { _, line in
                            Text(line).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.tan).lineLimit(2)
                        }
                    }
                }
                .toggleStyle(.switch)
                .font(Theme.sans(16))
                .foregroundStyle(Palette.cream)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .plate(padding: 18)
    }

    private var signing: String {
        switch model.provisioning {
        case .present(let info): "stops launching \(info.expiry.first.formatted(date: .abbreviated, time: .omitted)) (the \(info.expiry.cause == .certificate ? "certificate" : "profile") ends)"
        case .absent(let why): why
        case .unreadable(let why): why
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            LabelText(title, size: 12, color: Palette.tan, tracking: 0.16)
            content()
        }
    }

    private func line(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(name).foregroundStyle(Palette.tan).frame(width: 110, alignment: .leading)
            Text(value).foregroundStyle(Palette.cream).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(Theme.sans(14)).foregroundStyle(Palette.hint).fixedSize(horizontal: false, vertical: true)
    }
}
