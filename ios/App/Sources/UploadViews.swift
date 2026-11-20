// A take on its way, as the iPhone shows it (docs/IPHONE.md S3, S4, S5; Robin, 2026-11-14: "no idea how much
// is left or if it's stuck"): the transfer strip, the headset's twenty segments (LedStrip in InboxViews.kt) lit
// in the LED's orange, dimmed once nothing has moved for a while, and the words UploadProgress gives: how much,
// how fast, how long, or that it has stopped and why. Where it shows is Robin's pick of four mockups
// (2026-11-14), as the Quest shows a reply on its way: under its thread's row in the inbox and on the thread's
// message for it, which the receiver makes when the upload starts. A take with no row to go under (a new
// thread, a report, a thread the inbox is not showing) has a row of its own at the top of the inbox, and one
// whose message the thread page has not read yet has a card at the thread's foot. Recordings shows each take's.
// Each reads DeckModel.uploads(at:) on a timeline of its own, so it moves without the probe publishing.
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct TransferStrip: View {
    let fraction: Double
    var stuck = false
    var height: CGFloat = 8
    static let segments = 20

    var body: some View {
        let lit = Int((min(1, max(0, fraction)) * Double(Self.segments)).rounded(.down))
        HStack(spacing: 2) {
            ForEach(0..<Self.segments, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1.5)
                    // Stuck, the lit part dims, as a lamp that is off is its colour at a fraction of the light.
                    .fill(i < lit ? (stuck ? Palette.led.opacity(0.4) : Palette.led) : Palette.ledOff)
                    .frame(height: height)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The words beside the strip: "460 of 1,087 MB · 2.1 MB/s · about 5 min left" once the video is going (the
/// share is printed on its own), the whole line before it.
private func words(_ p: UploadProgress) -> String {
    p.stage == .video ? [p.amount, p.pace].compactMap { $0 }.joined(separator: " · ") : p.line
}

/// Under the row of the thread a reply is on its way to, lined up with the row's words.
struct UploadRowLine: View {
    let progress: UploadProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TransferStrip(fraction: progress.fraction, stuck: progress.isStuck, height: 6)
            Text("Your recording · \(progress.line)").font(Theme.sans(12))
                .foregroundStyle(progress.isStuck ? Palette.amber : Palette.led).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 52).padding(.trailing, 12).padding(.bottom, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your recording: \(progress.line)")
    }
}

/// A take with no row of its own in the inbox yet: a row at the top, opening Recordings.
struct UploadCard: View {
    let shown: DeckModel.UploadShown
    let open: () -> Void

    var body: some View {
        let p = shown.progress
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle().fill(Palette.led.opacity(0.22)).frame(width: 28, height: 28)
                    Circle().fill(p.isStuck ? Palette.led.opacity(0.4) : Palette.led).frame(width: 11, height: 11)
                }
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(shown.title).font(Theme.label(14)).foregroundStyle(Palette.whitePrint).lineLimit(1)
                        Spacer(minLength: 4)
                        if p.stage == .video { LabelText(p.percent, size: 12, color: p.isStuck ? Palette.amber : Palette.led, tracking: 0.1) }
                    }
                    TransferStrip(fraction: p.fraction, stuck: p.isStuck)
                    Text(words(p)).font(Theme.sans(12)).foregroundStyle(p.isStuck ? Palette.amber : Palette.cream).lineLimit(2)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 3).fill(Palette.surface))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(shown.title): \(p.line)")
        .accessibilityHint("Opens Recordings")
    }
}

/// On the thread's message for this take, under its recording line: the receiver has the message, not yet
/// all of the video.
struct UploadOnMessage: View {
    let progress: UploadProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabelText(progress.stage == .video ? "From this phone · \(progress.percent)" : "From this phone",
                      size: 10, color: progress.isStuck ? Palette.amber : Palette.led, tracking: 0.12)
            TransferStrip(fraction: progress.fraction, stuck: progress.isStuck)
            Text(words(progress)).font(Theme.sans(13)).foregroundStyle(progress.isStuck ? Palette.amber : Palette.tan)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("From this phone: \(progress.line)")
    }
}

/// At the foot of the thread, a reply whose message the page does not show yet (being prepared, or not read
/// since), as the headset's pendingCard.
struct UploadPendingCard: View {
    let shown: DeckModel.UploadShown

    var body: some View {
        let p = shown.progress
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Avatar(name: "You", size: 20)
                Text("You · sending a recording").font(Theme.sans(13, .semibold)).foregroundStyle(Palette.cream)
            }
            UploadOnMessage(progress: p)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 3).fill(Palette.panel))
        .overlay(RoundedRectangle(cornerRadius: 3).stroke(Palette.edge))
    }
}
