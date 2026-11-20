// The inbox under the deck (docs/IPHONE.md S3), the headset's Gmail layout at a phone's width: the search
// bar with the drawer behind three lines, the line saying what shows (Inbox or Archived, unread, which
// projects), the thread rows as PolydanceShared's ThreadRowView draws them on a black panel, and New thread
// with its red camera at the panel's foot. The drawer lists Inbox with its unread count, Archived, the
// projects to show and this phone's Recordings. The threads are the receiver's (DeckModel); pulling the
// list down reads it again, and a failed read is said over the list.
import PolydanceShared
import SwiftUI

struct InboxView: View {
    @ObservedObject var deck: DeckModel
    @FocusState private var searching: Bool

    var body: some View {
        VStack(spacing: 0) {
            searchBar
            HStack(spacing: 8) {
                LabelText(deck.sectionLine, size: 10.5, color: Palette.burnt, tracking: 0.16).lineLimit(1)
                Spacer(minLength: 4)
                if deck.box == .archived {
                    Button("Inbox") { deck.box = .inbox }.buttonStyle(KeyStyle())
                } else if !deck.projects.isEmpty {
                    Button("Show all") { deck.projects = [] }.buttonStyle(KeyStyle())
                }
            }
            .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 6)
            if let problem = deck.inboxProblem {
                Text("The receiver could not be read: \(problem)").font(Theme.sans(13)).foregroundStyle(Palette.red)
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8).padding(.bottom, 6)
            }
            if let flash = deck.flash {
                HStack(spacing: 8) {
                    Text(flash.text).font(Theme.sans(13)).foregroundStyle(Palette.burnt).lineLimit(2)
                    Spacer(minLength: 4)
                    if let undo = flash.undo { Button("Undo") { deck.undo(undo) }.buttonStyle(KeyStyle()) }
                }
                .padding(.horizontal, 8).padding(.bottom, 6)
            }
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        UploadAtTop(deck: deck)
                        let rows = deck.visibleThreads
                        if rows.isEmpty {
                            Text(deck.emptyLine).font(Theme.sans(14)).foregroundStyle(Palette.tan)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(16)
                        }
                        ForEach(rows) { thread in
                            Button { deck.open(thread.key) } label: {
                                VStack(spacing: 0) {
                                    ThreadRowView(thread: thread)
                                    UploadUnderRow(deck: deck, key: thread.key)
                                }
                            }
                            .buttonStyle(RowStyle())
                            if thread.key != rows.last?.key { Rectangle().fill(Theme.rule).frame(height: 1).padding(.leading, 52) }
                        }
                    }
                    .padding(.vertical, 6)
                    // Room under the last row, so New thread never covers it.
                    .padding(.bottom, 64)
                }
                .scrollDismissesKeyboard(.immediately)
                .refreshable { await deck.refresh() }
                NewThreadKey(action: deck.newThread).padding(12)
            }
            .background(RoundedRectangle(cornerRadius: 3).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Palette.edge, lineWidth: 2))
            .clipShape(RoundedRectangle(cornerRadius: 3))
        }
    }

    /// Gmail's search bar: the drawer behind three lines, the field, and a clear key while it holds text.
    private var searchBar: some View {
        HStack(spacing: 0) {
            IconKey(.menu, label: "Menu: inbox, archived, projects and recordings") { searching = false; deck.drawerOpen = true }
            TextField("", text: $deck.query, prompt: Text("Search threads").foregroundStyle(Palette.tan))
                .font(Theme.sans(16)).foregroundStyle(Palette.cream).tint(Palette.amber)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search).focused($searching)
            if !deck.query.isEmpty {
                IconKey(.close, color: Palette.tan, label: "Clear the search") { deck.query = ""; searching = false }
            } else {
                Glyph(.search, color: Palette.tan, size: 20).frame(width: 44, height: 44)
            }
        }
        .padding(.horizontal, 4)
        .background(Capsule().fill(Palette.panel))
        .overlay(Capsule().stroke(Palette.edge, lineWidth: 1.5))
    }
}

/// Takes on their way with no row in the list to go under (a new thread, a report, a thread filtered out or
/// archived), each as a row of its own at the top (UploadViews).
private struct UploadAtTop: View {
    @ObservedObject var deck: DeckModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let shown = deck.visibleThreads.map(\.key)
            ForEach(deck.uploads(at: context.date).filter { !shown.contains($0.threadKey ?? "") }, id: \.runName) { upload in
                UploadCard(shown: upload) { deck.path.append(.recordings) }
                    .padding(.horizontal, 6).padding(.bottom, 6)
            }
        }
    }
}

/// Under a thread's row, each of this phone's takes on its way to it.
private struct UploadUnderRow: View {
    @ObservedObject var deck: DeckModel
    let key: String

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            ForEach(deck.uploads(at: context.date).filter { $0.threadKey == key }, id: \.runName) { upload in
                UploadRowLine(progress: upload.progress)
            }
        }
    }
}

/// A row lit while pressed, as the headset's ripple lights it.
private struct RowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.surface : Color.clear)
            .contentShape(Rectangle())
    }
}

/// New thread, where Gmail has Compose: the one cream key on the cabinet, with the red camera because a
/// thread starts with the camera: a photo or a recording (Robin, 2026-11-13).
struct NewThreadKey: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Glyph(.camera, color: Palette.red, size: 24)
                LabelText("New thread", size: 13, color: Palette.print, tracking: 0.06)
            }
        }
        .buttonStyle(CreamKeyStyle())
        .accessibilityLabel("New thread: a photo or a recording starts one")
    }

    private struct CreamKeyStyle: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .padding(.leading, 16).padding(.trailing, 20).padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 16).fill(configuration.isPressed ? Palette.plateDark : Palette.plateLight))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.plateEdge, lineWidth: 1.5))
                .shadow(color: Parts.keyShadow.opacity(0.6), radius: 6, y: 3)
                .contentShape(RoundedRectangle(cornerRadius: 16))
        }
    }
}

/// The drawer behind the three lines (InboxPane.showMenu): a black plate from the left.
struct InboxDrawer: View {
    @ObservedObject var deck: DeckModel

    var body: some View {
        ZStack(alignment: .leading) {
            Color.black.opacity(0.5).ignoresSafeArea().onTapGesture { deck.drawerOpen = false }
                .accessibilityAddTraits(.isButton).accessibilityLabel("Close the menu")
            VStack(alignment: .leading, spacing: 2) {
                LabelText("Polydance", size: 17, color: Palette.whitePrint, tracking: 0.3).padding(.leading, 14).padding(.bottom, 14)
                entry("Inbox", on: deck.box == .inbox, count: deck.unread) { deck.box = .inbox; deck.drawerOpen = false }
                entry("Archived", on: deck.box == .archived) { deck.box = .archived; deck.drawerOpen = false }
                if deck.projectNames.count > 1 {
                    heading("Projects")
                    entry("All projects", on: deck.projects.isEmpty, tick: true) { deck.projects = [] }
                    ForEach(deck.projectNames, id: \.key) { project in
                        entry(project.name, on: deck.projects.contains(project.key), tick: true) {
                            if deck.projects.contains(project.key) { deck.projects.remove(project.key) } else { deck.projects.insert(project.key) }
                        }
                    }
                }
                heading("This phone")
                entry("Recordings", on: false) { deck.drawerOpen = false; deck.path.append(.recordings) }
                Spacer()
            }
            .padding(.vertical, 20).padding(.horizontal, 10)
            .frame(width: 290)
            .frame(maxHeight: .infinity)
            .background(Palette.panel.ignoresSafeArea())
            .overlay(alignment: .trailing) { Rectangle().fill(Palette.edge).frame(width: 2).ignoresSafeArea() }
            .transition(.move(edge: .leading))
        }
    }

    private func heading(_ text: String) -> some View {
        LabelText(text, size: 10, color: Palette.tan, tracking: 0.16).padding(.leading, 14).padding(.top, 18).padding(.bottom, 6)
    }

    private func entry(_ name: String, on: Bool, count: Int = 0, tick: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if tick { Text(on ? "✓" : " ").font(Theme.label(14)).foregroundStyle(Palette.amber).frame(width: 14) }
                Text(name).font(on && !tick ? Theme.label(16) : Theme.sans(16)).foregroundStyle(on && !tick ? Palette.whitePrint : Palette.cream)
                Spacer()
                if count > 0 { LabelText(count > 99 ? "99+" : "\(count)", size: 13, color: Palette.red, tracking: 0.1) }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 22).fill(on && !tick ? Palette.surface : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
