// Pieces the Mac's menu, window and settings and the iPhone's screens share, in the headset's look
// (docs/DESIGN-SYSTEM.md): printed section labels, chips, keys for buttons, panels for cards, the "Later"
// tag for what is not built yet, a thread's row as the headset lists it, and how times are written.
import SwiftUI

public struct SectionLabel: View {
    let text: String
    public init(_ text: String) { self.text = text }

    public var body: some View {
        LabelText(text, size: 10.5, color: Palette.tan, tracking: 0.14)
            .accessibilityAddTraits(.isHeader)
    }
}

public struct ChipView: View {
    let text: String
    var tint: Color
    var edge: Color

    public init(text: String, tint: Color = Theme.soft, edge: Color = Theme.raised) {
        self.text = text
        self.tint = tint
        self.edge = edge
    }

    public var body: some View {
        Text(text).font(Theme.sans(11, .medium)).foregroundStyle(tint).lineLimit(1).fixedSize()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6).fill(Palette.panel))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(edge))
    }
}

/// What is shown but not built yet (the excerpt sheet, window-only capture).
public struct LaterTag: View {
    var text: String
    public init(text: String = "Later") { self.text = text }
    public var body: some View { ChipView(text: text, tint: Theme.soft, edge: Theme.greyEdge) }
}

public struct WindowButton: View {
    let title: String
    var size: CGFloat = 12
    let action: () -> Void
    public init(_ title: String, size: CGFloat = 12, action: @escaping () -> Void) {
        self.title = title
        self.size = size
        self.action = action
    }

    public var body: some View {
        Button(title, action: action).buttonStyle(KeyStyle(small: size <= 12))
    }
}

/// The page's main action: the cream key (as New thread on the headset), or the red one for what starts a
/// recording (as START).
public struct FilledButton: View {
    let title: String
    var fill: Color = Theme.blue
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled

    public init(_ title: String, fill: Color = Theme.blue, action: @escaping () -> Void) {
        self.title = title
        self.fill = fill
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            let red = fill == Theme.red
            LabelText(title, size: 12, color: !enabled ? Palette.hint : red ? Parts.recordKeyPrint : Palette.print, tracking: 0.12)
                .frame(maxWidth: .infinity).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 6).fill(!enabled ? AnyShapeStyle(Palette.edge)
                    : red ? AnyShapeStyle(LinearGradient(colors: Parts.recordKeyReady, startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(Palette.cream)))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(red ? Parts.recordKeyEdge : Palette.plateEdge))
                .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

/// A link-style button ("Open System Settings").
public struct LinkButton: View {
    let title: String
    let action: () -> Void
    public init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    public var body: some View {
        Button(action: action) { Text(title).font(Theme.sans(11)).foregroundStyle(Theme.blueText) }.buttonStyle(.plain)
    }
}

public struct Card<Content: View>: View {
    var dashed: Bool
    let content: Content

    public init(dashed: Bool = false, @ViewBuilder content: () -> Content) {
        self.dashed = dashed
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(dashed ? Color.clear : Palette.surface))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.edge, style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : [])))
    }
}

/// A line of small text that wraps, in a tone: what went wrong, or a note.
public struct NoteText: View {
    let text: String
    var tint: Color = Theme.muted
    public init(_ text: String, tint: Color = Theme.muted) {
        self.text = text
        self.tint = tint
    }

    public var body: some View {
        Text(text).font(Theme.sans(12)).foregroundStyle(tint).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    }
}

/// A status chip for a hook run or a grant.
public struct StatusChip: View {
    public enum Tone: Sendable { case good, busy, bad, quiet }
    let text: String
    let tone: Tone

    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        switch tone {
        case .good: ChipView(text: text, tint: Theme.greenText, edge: Theme.greenEdge)
        case .busy: ChipView(text: text, tint: Theme.amberText, edge: Theme.greyEdge)
        case .bad: ChipView(text: text, tint: Theme.redText, edge: Theme.redEdge)
        case .quiet: ChipView(text: text, tint: Theme.soft, edge: Theme.greyEdge)
        }
    }
}

/// Times as the boards write them: "Today", "Yesterday", "Wed 5 Nov"; "11:00".
public enum Clock {
    public static func day(_ date: Date?) -> String {
        guard let date else { return "Earlier" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    public static func time(_ date: Date?) -> String {
        guard let date else { return "" }
        return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    /// A thread row's time, as the headset writes it: "14:06", "5 Nov", "5 Nov 2025".
    public static func rowTime(_ iso: String) -> String {
        guard let date = MetaTime.parse(iso) else { return "" }
        return RetroLook.rowTime(date, now: Date())
    }

    /// "Mon", or "11:58" for today: when a message was posted.
    public static func when(_ iso: String) -> String {
        guard let date = MetaTime.parse(iso) else { return "" }
        return Calendar.current.isDateInToday(date) ? time(date) : date.formatted(.dateTime.weekday(.abbreviated).day())
    }

    public static func minutes(_ ms: Int?) -> String? {
        guard let ms else { return nil }
        let minutes = Int((Double(ms) / 60_000).rounded())
        return minutes < 1 ? "under 1 min" : "\(minutes) min"
    }

    public static func size(_ bytes: Int64?) -> String? {
        bytes.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) }
    }

    /// ~/PolydanceCapture rather than /Users/someone/PolydanceCapture.
    public static func path(_ path: String) -> String {
        let home = NSHomeDirectory()
        if path == home { return "~" }
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }
}

/// A thread as the headset lists it (InboxPane.threadRow): who is in it, the title bold and bright when
/// something is new and plain when read, when it last moved, then TO TRY when a launch waits, the key and
/// the last word, and a red dot for unread. `open` lights the row as the thread being read.
public struct ThreadRowView: View {
    let thread: ThreadSummary
    var compact: Bool
    var open: Bool

    public init(thread: ThreadSummary, compact: Bool = false, open: Bool = false) {
        self.thread = thread
        self.compact = compact
        self.open = open
    }

    public var body: some View {
        HStack(alignment: .top, spacing: compact ? 10 : 12) {
            if thread.people.isEmpty { Avatar(name: thread.last.by.name, size: compact ? 24 : 28) }
            else { AvatarStack(people: thread.people, total: thread.peopleCount, size: compact ? 24 : 28) }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    // The window's column gives a long title a second line; the menu, a fixed width, keeps one.
                    Text(thread.title).font(thread.isNew ? Theme.label(compact ? 13 : 14) : Theme.sans(compact ? 13 : 14))
                        .foregroundStyle(thread.isNew ? Palette.whitePrint : Palette.tan).lineLimit(compact ? 1 : 2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Text(Clock.rowTime(thread.lastMessageAt ?? thread.updatedAt)).font(thread.isNew ? Theme.label(11) : Theme.sans(11))
                        .foregroundStyle(thread.isNew ? Palette.whitePrint : Palette.tan)
                }
                HStack(alignment: .top, spacing: 7) {
                    // Something to try is said in words, never by a colour alone.
                    if thread.waiting { Tag(text: "To try", color: Palette.amber) }
                    Text("\(thread.key)  ·  \(thread.snippet ?? "\(thread.last.by.who): \(thread.last.text)")")
                        .font(Theme.sans(compact ? 11.5 : 12)).foregroundStyle(thread.isNew ? Palette.cream : Palette.tan)
                        .lineLimit(compact ? 1 : 2).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if thread.isNew { Circle().fill(Palette.red).frame(width: 8, height: 8).padding(.top, 4).accessibilityLabel("Unread") }
                }
            }
        }
        .padding(.horizontal, compact ? 10 : 12).padding(.vertical, compact ? 8 : 10)
        .background(RoundedRectangle(cornerRadius: 3).fill(open ? Palette.surface : .clear))
        .accessibilityElement(children: .combine)
    }
}
