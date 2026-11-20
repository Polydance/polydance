// Connect your agent on the Vision Pro (2026-11-20, docs/THREADS.md "Connecting your own agent"), the Quest's in
// SwiftUI (InboxPane.kt, "Your agents"). Robin's picks of four mockups: D, a card at the top of the inbox until an
// agent is connected and the same card in the Welcome's answer, "and then C too", a page of their own from the
// menu with the three steps, the code and who is connected. The code is printed on a cream label with the reels'
// orange along its top, in the counter's type, with the line to type on the computer and a clock that runs down
// its ten minutes. Nothing shows a code while this headset records, since the recording would hold it.
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

/// A cream label with the reels' orange along its top, as a cassette's.
struct LabelPlate<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Palette.orange).frame(height: 8)
            VStack(alignment: .leading, spacing: 8) { content }
                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(LinearGradient(colors: [Palette.plateLight, Palette.plateDark], startPoint: .top, endPoint: .bottom))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.plateEdge, lineWidth: 2))
    }
}

/// A key on the cream label: light, lettered in the label's print, edged orange when it is the one to press.
struct CreamKeyStyle: ButtonStyle {
    var main = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.label(13)).tracking(13 * 0.12).textCase(.uppercase)
            .foregroundStyle(Palette.print)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .frame(minHeight: 44)
            .background(RoundedRectangle(cornerRadius: 8).fill(Palette.cream))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(main ? Palette.orange : Palette.plateEdge, lineWidth: main ? 2 : 1.5))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
            .contentShape(Rectangle())
            .hoverEffect(.highlight)
    }
}

private func printed(_ text: String, size: CGFloat = 15) -> some View {
    Text(text).font(Theme.sans(size)).foregroundStyle(Palette.print).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
}

private func stamped(_ text: String) -> some View { LabelText(text, size: 12, color: Palette.burnt, tracking: 0.16) }

/// The card at the top of the inbox until an agent is connected, or until it is put away.
struct AgentOffer: View {
    @ObservedObject var model: HeadsetModel

    var body: some View {
        LabelPlate {
            stamped("Your agent can read these")
            printed("Connect your own coding agent and it answers here with builds to try.")
            HStack {
                Button("Connect your agent ›") { model.openAgents(withCode: true) }.buttonStyle(CreamKeyStyle(main: true))
                Spacer(minLength: 8)
                Button { model.hideAgentOffer() } label: { stamped("Not now").frame(minWidth: 60, minHeight: 44).contentShape(Rectangle()) }
                    .buttonStyle(.plain).hoverEffect(.highlight)
                    .accessibilityLabel("Not now: put this card away. Agents stays in the menu.")
            }
        }
    }
}

/// A code on show: the code, its clock and the line to type. Hidden while this headset records.
struct AgentCodeBlock: View {
    @ObservedObject var model: HeadsetModel
    let code: AgentCode
    var strip = false

    var body: some View {
        if model.isRecording {
            printed("The code is hidden while this headset records, so it is not in the recording.")
        } else {
            VStack(spacing: 8) {
                Text(code.code).font(Theme.counter(34)).tracking(34 * 0.12).foregroundStyle(Palette.print)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Your code: \(code.code.map(String.init).joined(separator: " "))")
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(spacing: 6) {
                        if strip { UploadStrip(fraction: AgentWords.fraction(code, now: context.date)).frame(maxWidth: 240) }
                        stamped("Works once  ·  \(AgentWords.left(code, now: context.date) ?? "run out")")
                    }
                    .frame(maxWidth: .infinity)
                }
                VStack(alignment: .leading, spacing: 6) {
                    printed("On your computer, type:", size: 14)
                    (Text("polycap connect ").foregroundStyle(Palette.cream) + Text(code.code).foregroundStyle(Palette.amber))
                        .font(Theme.counter(16)).lineLimit(1).minimumScaleFactor(0.7)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.panel))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.edge, lineWidth: 1.5))
                        .accessibilityLabel(AgentWords.command(code))
                }
            }
        }
    }
}

/// Why a code could not be had, or that one is being asked for, in the label's print.
private struct AgentCodeStatus: View {
    @ObservedObject var model: HeadsetModel

    var body: some View {
        if model.askingCode { printed("Asking for a code…", size: 14) }
        if let problem = model.agentProblem {
            Text(problem).font(Theme.sans(14)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The card in the Welcome's answer: an offer, then the code where it was asked for, then who is connected.
struct AgentInline: View {
    @ObservedObject var model: HeadsetModel

    var body: some View {
        // The clock is the code's own; this reads it each second so a code that has run out stops showing.
        TimelineView(.periodic(from: .now, by: 1)) { context in
            LabelPlate {
                stamped("Connect your agent")
                if let code = model.liveCode(at: context.date) {
                    AgentCodeBlock(model: model, code: code)
                    HStack(spacing: 12) {
                        Button("New code") { Task { await model.askCode() } }.buttonStyle(CreamKeyStyle())
                        Spacer(minLength: 4)
                        printed("Connected agents are in the menu, under Agents.", size: 13).multilineTextAlignment(.trailing)
                    }
                } else if let connected = model.agentList?.connected, !connected.isEmpty {
                    printed("\(connected.map(\.label).joined(separator: ", ")) \(connected.count == 1 ? "is" : "are") connected, and can read this thread and answer in it.")
                    Button("Agents ›") { model.openAgents(withCode: false) }.buttonStyle(CreamKeyStyle())
                } else {
                    printed("Your own coding agent can read threads like this one and answer with builds to try. It takes a code from here and one line typed on your computer.")
                    Button("Connect your agent ›") { Task { await model.askCode() } }.buttonStyle(CreamKeyStyle(main: true))
                }
                AgentCodeStatus(model: model)
            }
        }
    }
}

/// The Agents page: the three steps and the code on a label, then who is connected, each with Disconnect.
struct AgentsPage: View {
    @ObservedObject var model: HeadsetModel
    @State private var leaving: ConnectedAgent?

    private static let steps = ["Install polycap on your computer.", "Type polycap connect and the code below.", "Ask your agent to use Polydance."]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                IconKey(.close, color: Palette.tan, label: "Close Agents") { model.detail = nil }
                LabelText("Agents", size: 15, color: Palette.whitePrint, tracking: 0.16)
                Spacer()
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let code = model.liveCode(at: context.date)
                        LabelPlate {
                            stamped("Your coding agents, on your own computers")
                            ForEach(Array(Self.steps.enumerated()), id: \.offset) { index, step in printed("\(index + 1)   \(step)", size: 16) }
                            Rectangle().fill(Palette.plateEdge).frame(height: 1).padding(.vertical, 4)
                            stamped("Your code").frame(maxWidth: .infinity)
                            if let code { AgentCodeBlock(model: model, code: code, strip: true) }
                            else { printed("A code works once, for ten minutes. Ask for one when you are at your computer.", size: 14).frame(maxWidth: .infinity) }
                            Button(code == nil ? "Show a code" : "New code") { Task { await model.askCode() } }
                                .buttonStyle(CreamKeyStyle(main: code == nil)).frame(maxWidth: .infinity)
                            AgentCodeStatus(model: model)
                        }
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        LabelText("Connected", size: 12, color: Palette.tan, tracking: 0.2)
                        if let list = model.agentList {
                            if list.agents.isEmpty { Text("No agent is connected yet.").font(Theme.sans(15)).foregroundStyle(Palette.tan) }
                            ForEach(list.agents) { agent in row(agent) }
                        } else {
                            Text(model.paired ? "Loading…" : "Pair this headset first.").font(Theme.sans(15)).foregroundStyle(Palette.tan)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .plate(padding: 18)
                    Text("An agent reads your threads and recordings and posts in them, as you, and nobody else's. Up to \(model.agentList?.limit ?? 5); each connection lasts 90 days.")
                        .font(Theme.sans(14)).foregroundStyle(Palette.burnt).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 8)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task { await model.refreshAgents() }
        .confirmationDialog(leaving.map { "Disconnect \($0.label)?" } ?? "", isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }), titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { if let agent = leaving { model.disconnectAgent(agent) }; leaving = nil }
            Button("Keep", role: .cancel) { leaving = nil }
        } message: {
            Text("Its agent stops reading and posting at once. To use it again, connect it with a new code.")
        }
    }

    /// One connected agent: a square, as agents are drawn, its machine's name, when, and Disconnect.
    private func row(_ agent: ConnectedAgent) -> some View {
        HStack(spacing: 12) {
            Text(String(agent.label.first(where: { $0.isLetter || $0.isNumber }) ?? "?").uppercased())
                .font(Theme.label(17)).foregroundStyle(Palette.whitePrint)
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 9).fill(Palette.woodGrain))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.label).font(Theme.sans(16, .semibold)).foregroundStyle(agent.expired ? Palette.tan : Palette.cream).lineLimit(1)
                Text(AgentWords.detail(agent, now: Date())).font(Theme.sans(13)).foregroundStyle(Palette.tan).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button(agent.expired ? "Remove" : "Disconnect") { leaving = agent }.buttonStyle(KeyStyle(color: Palette.tan))
        }
    }
}
