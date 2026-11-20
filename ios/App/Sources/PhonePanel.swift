// The deck's black control panel on the iPhone (docs/IPHONE.md S1), the headset's arranged for a phone's
// width: UPLOAD and PROCESSING left of the rolling counter and REC and READY right of it, as on the headset
// (eighth pass, 2026-10-05); then the MIC needle meter beside the red key; the line saying where the take
// goes; and a hint only when something needs doing. Drawn from a Readout of plain values, so a picture can
// be made from samples without a camera.
import PolydanceShared
import SwiftUI

struct PhonePanel: View {
    struct Readout: Equatable {
        var recording: Bool
        var ready: Bool
        var uploading: Bool
        var processing: Bool
        var seconds: Int
        /// The MIC meter's needle, 0 to 1 across its scale; inactive shows the dark face.
        var mic: Double
        var micActive: Bool
        /// The input's kind on the meter's strip ("iPhone", "Bluetooth"), never its name.
        var micStrip: String
        var key: RecordKey.Mode
        /// FULL when the receiver's allowance is used up (R8; read from the receiver once paired).
        var keyWord: String? = nil
        var target: String
        var hint: String?
    }

    let readout: Readout
    let record: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 0) {
                Lamp(name: "Upload", color: Palette.led, lit: readout.uploading, pulses: true)
                Spacer(minLength: 2)
                Lamp(name: "Processing", color: Palette.processing, lit: readout.processing, pulses: true)
                Spacer(minLength: 6)
                RollingCounter(seconds: readout.seconds, cell: 17, height: 32)
                Spacer(minLength: 6)
                Lamp(name: "Rec", color: Palette.red, lit: readout.recording, pulses: true)
                Spacer(minLength: 2)
                Lamp(name: "Ready", color: Palette.green, lit: readout.ready)
            }
            HStack(spacing: 14) {
                NeedleMeter(label: "Mic", level: readout.mic, active: readout.micActive, strip: readout.micStrip)
                    .frame(width: 148, height: 74)
                RecordKey(mode: readout.key, width: 120, height: 44, word: readout.keyWord, action: record)
                    .frame(maxWidth: .infinity)
            }
            LabelText(readout.target, size: 9.5, color: Palette.tan, tracking: 0.12)
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity)
            if let hint = readout.hint {
                Text(hint).font(Theme.sans(12)).foregroundStyle(Palette.amber)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
            }
        }
        .plate(padding: 14)
    }
}
