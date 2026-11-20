// Behind the gear (docs/IPHONE.md S6): the recording settings, the receiver (paired as "Robin · iPhone",
// Pair with the Mac, Unpair), notifications (U7: replies by background refresh, off until turned on), and
// the diagnostics, each on a black plate on the wood. What is not built yet is shown with a LATER tag, as
// the Mac shows it. The diagnostics are the I0 probe's: the phone and iOS, the app's version and commit, when
// the signing runs out (read from the embedded profile), background refresh, the clock and the event log's
// last lines, and the probe's own screen, kept as a debug view for the evidence it still gathers.
import PolydanceShared
import SwiftUI

struct SettingsScreen: View {
    @ObservedObject var deck: DeckModel
    @State private var unpairAsked = false
    @State private var noticeProblem: String?

    private var probe: ProbeModel { deck.probe }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                IconKey(.back, color: Palette.burnt, label: "Back") { deck.path.removeLast() }
                LabelText("Settings", size: 14, color: Palette.burnt, tracking: 0.2)
                Spacer()
            }
            .padding(.horizontal, 6)
            ScrollView {
                VStack(spacing: 10) {
                    section("Recording") {
                        row("Picture", "1080p, 30 fps, H.264", later: "720p")
                        row("Starts with", "the back camera", later: "Front")
                        row("Video on mobile data", "off: the video waits for Wi-Fi", later: "Switch")
                    }
                    section("Receiver") { receiver }
                    section("Notifications") { notifications }
                    section("Diagnostics") { diagnostics }
                }
                .padding(10)
            }
        }
        .background(Wood().ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .overlay {
            if unpairAsked {
                PlateDialog(title: "Unpair this phone?",
                            text: "The token leaves this phone's Keychain, and its threads leave the inbox. Takes stay on the phone, and the token still works on the receiver until it is taken out of POLYCAP_SERVER_TOKENS.",
                            keys: [.init(title: "Keep it", action: { unpairAsked = false }),
                                   .init(title: "Unpair", color: Palette.red, action: { unpairAsked = false; deck.unpair() })],
                            dismiss: { unpairAsked = false })
            }
        }
    }

    @ViewBuilder private var receiver: some View {
        if let pairing = probe.parts?.pairing.pairing {
            row("Paired", "as \(deck.who ?? "this phone's token") with \(pairing.place)" + (pairing.isLocal ? " (this Mac, on the cable)" : ""), later: nil)
            if let account = deck.account { row("Allowance", account.label.lowercased() + " used on the receiver", later: nil) }
            HStack(spacing: 10) {
                Button("Pair again") { deck.openPairing() }.buttonStyle(KeyStyle(color: Palette.cream, small: false))
                Button("Unpair") { unpairAsked = true }.buttonStyle(KeyStyle(color: Palette.red, small: false))
            }
            .disabled(deck.isRecording)
        } else {
            row("Not paired", "takes stay on this phone, and the inbox is empty", later: nil)
            if let problem = probe.parts?.pairing.problem {
                Text(problem).font(Theme.sans(13)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
            }
            Text("On the Mac: npm run ios -- pair. Then scan the code it shows.").font(Theme.sans(13)).foregroundStyle(Palette.tan)
                .fixedSize(horizontal: false, vertical: true)
            Button("Pair with the Mac") { deck.openPairing() }.buttonStyle(KeyStyle(color: Palette.amber, small: false))
                .disabled(deck.isRecording || probe.camera != .ready)
        }
    }

    @ViewBuilder private var notifications: some View {
        if let notifier = probe.parts?.notifier {
            Toggle(isOn: Binding(get: { notifier.enabled }, set: { on in
                noticeProblem = nil
                if on { Task { noticeProblem = await notifier.turnOn() } } else { notifier.turnOff() }
            })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Replies").font(Theme.sans(15, .semibold)).foregroundStyle(Palette.cream)
                    Text("A notification for each thread with a message you have not read. iOS runs the check when it chooses, often hours apart, and never after Polydance is swiped away; Polydance also checks whenever it comes to the front.")
                        .font(Theme.sans(13)).foregroundStyle(Palette.tan).fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(Palette.amber)
            .disabled(probe.parts?.pairing.pairing == nil && !notifier.enabled)
            if let noticeProblem { Text(noticeProblem).font(Theme.sans(13)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true) }
            if notifier.enabled { line("Last check", notifier.lastCheck) }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(title)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .plate(padding: 16)
    }

    private func row(_ name: String, _ value: String, later: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(Theme.sans(15, .semibold)).foregroundStyle(Palette.cream)
                Text(value).font(Theme.sans(13)).foregroundStyle(Palette.tan).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            if let later { LaterTag(text: "Later: \(later)") }
        }
    }

    @ViewBuilder private var diagnostics: some View {
        line("Phone", "\(probe.modelIdentifier) · \(probe.systemVersion)")
        line("Polydance", "\(probe.appVersion) · \(probe.appCommit)")
        line("Signing", probe.profileLine.replacingOccurrences(of: "Signing: ", with: ""))
        if let detail = probe.profileDetail { Text(detail).font(Theme.sans(12)).foregroundStyle(Palette.hint).fixedSize(horizontal: false, vertical: true) }
        if let refresh = probe.parts?.refresh {
            line("Refresh", "\(refresh.runsToday) \(refresh.runsToday == 1 ? "run" : "runs") today"
                 + (refresh.lastRun.map { ", last at \(RefreshProbe.clock($0))" } ?? ", none yet") + "; \(refresh.lastSubmit)")
        }
        TimelineView(.periodic(from: .now, by: 1)) { context in
            line("Clock", context.date.formatted(.dateTime.day().month(.abbreviated).hour().minute().second()))
        }
        VStack(alignment: .leading, spacing: 2) {
            LabelText("Events", size: 10, color: Palette.tan, tracking: 0.14)
            TimelineView(.periodic(from: .now, by: 2)) { _ in
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(probe.logTail(12).enumerated()), id: \.offset) { _, entry in
                        Text(entry).font(Theme.mono(8.5)).foregroundStyle(Palette.tan).lineLimit(2)
                    }
                }
                .textSelection(.enabled)
            }
        }
        .padding(.top, 4)
        Button("The I0 probe's screen") { deck.path.append(.probe) }
            .buttonStyle(KeyStyle(color: Palette.cream, small: false))
            .padding(.top, 4)
    }

    private func line(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            LabelText(name, size: 10, color: Palette.tan, tracking: 0.14).frame(width: 78, alignment: .leading)
            Text(value).font(Theme.sans(13)).foregroundStyle(Palette.cream).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}
