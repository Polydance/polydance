// A take on its way, as the Vision Pro shows it (Robin, 2026-11-14: "no idea how much is left or if it's stuck"),
// as the Quest does: the twenty-segment transfer strip (LedStrip in InboxViews.kt) lit in the LED's orange and dimmed
// once nothing has moved for a while, then the words UploadProgress gives (PolydancePhoneCore, the iPhone's): how
// much, how fast, how long, or that it has stopped and why. Recordings, a thread's message for this headset's take
// and the card for a reply the receiver has nothing of yet draw it from UploadProbe.progress(_:at:), once a second.
import PolydancePhoneCore
import PolydanceShared
import SwiftUI

struct UploadStrip: View {
    let fraction: Double
    var stuck = false
    static let segments = 20

    var body: some View {
        let lit = Int((min(1, max(0, fraction)) * Double(Self.segments)).rounded(.down))
        HStack(spacing: 3) {
            ForEach(0..<Self.segments, id: \.self) { i in
                RoundedRectangle(cornerRadius: 2)
                    // Stuck, the lit part dims, as a lamp that is off is its colour at a fraction of the light.
                    .fill(i < lit ? (stuck ? Palette.led.opacity(0.4) : Palette.led) : Palette.ledOff)
                    .frame(height: 6)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The strip and the words under it: the amount and the pace once the video goes, the whole line before it.
struct UploadLines: View {
    let progress: UploadProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            UploadStrip(fraction: progress.fraction, stuck: progress.isStuck)
            Text(Self.detail(progress)).font(Theme.sans(14)).foregroundStyle(progress.isStuck ? Palette.amber : Palette.cream)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(progress.line)
    }

    /// "460 of 1,087 MB · 2.1 MB/s · about 5 min left", or before the video "sending the words first · 3.1 of 14 MB".
    static func detail(_ p: UploadProgress) -> String {
        p.stage == .video ? [p.amount, p.pace].compactMap { $0 }.joined(separator: " · ") : p.line
    }

    /// The word beside it, the Quest's: "Uploading 42%", or "Uploading" before the video.
    static func word(_ p: UploadProgress) -> String { p.stage == .video ? "Uploading \(p.percent)" : "Uploading" }

    static func color(_ p: UploadProgress) -> Color { p.isStuck ? Palette.amber : Palette.led }
}
