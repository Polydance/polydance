// New thread's projects as one list (Robin picked the fourth of four mockups on 2026-11-13; docs/THREADS.md
// "Projects of your own"): the team's projects and your own, each marked, the chosen one ticked, and at the
// foot New project, which becomes a name field with Make. The iPhone shows it in New thread's plate, the
// Vision Pro drops it from the draft's IN selector; the headset's InboxPane.kt draws the same list. New
// project is there only when the receiver makes projects (`newProjects` on GET /v1/threads).
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct ProjectList: View {
    let projects: [ProjectRef]
    let chosen: String?
    /// Whether to offer New project at the foot.
    let canMake: Bool
    let choose: (String) -> Void
    /// Makes the project; nil when made (the caller then chooses it), else the refusal in a few words.
    let make: (String) async -> String?

    @State private var naming = false
    @State private var name = ""
    @State private var problem: String?
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ForEach(projects, id: \.key) { project in
                Button { choose(project.key) } label: {
                    HStack(spacing: 10) {
                        Text(project.key == chosen ? "✓  \(project.name)" : project.name)
                            .font(Theme.sans(16)).foregroundStyle(project.key == chosen ? Palette.amber : Palette.cream)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        LabelText(project.mine ? "Yours" : "Team", size: 10, color: Palette.hint, tracking: 0.12)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(project.name), \(project.mine ? "your own project" : "the team's project")\(project.key == chosen ? ", chosen" : "")")
                Rectangle().fill(Palette.edge).frame(height: 1)
            }
            if canMake { footer }
        }
        .background(Palette.casing)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.edge, lineWidth: 1))
    }

    @ViewBuilder private var footer: some View {
        if naming {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    TextField("", text: $name, prompt: Text("Project name").foregroundStyle(Palette.hint))
                        .font(Theme.sans(16)).foregroundStyle(Palette.print)
                        .padding(.horizontal, 9).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Palette.plateLight))
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(go)
                        .disabled(busy)
                    Button(busy ? "Making…" : "Make", action: go)
                        .buttonStyle(KeyStyle(color: Palette.amber, small: false, fill: true))
                        .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                    IconKey(.close, color: Palette.tan, label: "Do not make a project") { naming = false; name = ""; problem = nil }
                        .disabled(busy)
                }
                Text(problem ?? "Only you see it, and whoever you add to one of its threads.")
                    .font(Theme.sans(13)).foregroundStyle(problem == nil ? Palette.hint : Palette.amber)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .background(Palette.surface)
            .onAppear { focused = true }
        } else {
            Button { naming = true } label: {
                HStack {
                    Text("+  New project").font(Theme.sans(16)).foregroundStyle(Palette.cream)
                    Spacer()
                }
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Palette.surface)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New project: make a project of your own")
        }
    }

    private func go() {
        let typed = name
        guard !busy, !typed.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        busy = true
        problem = nil
        Task {
            let refused = await make(typed)
            busy = false
            if let refused { problem = refused } else { naming = false; name = "" }
        }
    }
}
