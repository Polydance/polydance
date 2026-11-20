// The deck, the panel's left column (the Quest's MainActivity, 420 points wide): the cream top plate with its reels
// (turning while recording), the tape (the receiver's allowance), the list key to Recordings, the bug key and the
// gear; under it the black control panel with the MIC and APP needle meters, each a switch (locked while a take
// runs; the headset's bat-handle OFF/ON switch on each meter's strip), the UPLOAD and PROCESSING lamps, the rolling counter, REC and READY, the red key (REC, "…", STOP, FULL)
// with Cancel under STOP, the line saying where the take goes, and a hint only when something needs doing; and the
// notice that fades after 8 s. The red key is visionOS's own broadcast button while a take may start
// (BroadcastPicker), so a press always reaches the system's sheet. Every part is PolydanceShared's.
import PolydanceShared
import SwiftUI

struct DeckColumn: View {
    @ObservedObject var model: HeadsetModel

    var body: some View {
        VStack(spacing: 10) {
            let tape = model.storage
            TopPlate(spinning: model.isRecording, used: tape.used, full: tape.full, storage: tape.label, logo: Logo.image,
                     onStorage: { model.detail = .recordings }, onBug: { if !model.isRecording && !model.isBusy { model.reportAsked = true } },
                     onGear: { model.settingsShown = true })
                .frame(minHeight: 150, maxHeight: .infinity)
            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                ControlPanel(model: model, readout: model.readout(at: context.date))
            }
            if let notice = model.notice {
                Text(notice).font(Theme.sans(15)).foregroundStyle(Palette.burnt)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.3), value: model.notice)
    }
}

/// The black panel, drawn from a readout of plain values.
private struct ControlPanel: View {
    @ObservedObject var model: HeadsetModel
    let readout: DeckReadout

    var body: some View {
        let locked = readout.recording || readout.key == .starting
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                NeedleMeter(label: "Mic", level: readout.mic, active: model.mic, toggle: $model.mic, toggleEnabled: !locked)
                NeedleMeter(label: "App", level: readout.app, active: model.appSound, toggle: $model.appSound, toggleEnabled: !locked)
            }
            .frame(height: 124)
            HStack(alignment: .top, spacing: 0) {
                Lamp(name: "Upload", color: Palette.led, lit: readout.uploading, pulses: true)
                Spacer(minLength: 2)
                Lamp(name: "Processing", color: Palette.processing, lit: readout.processing, pulses: true)
                Spacer(minLength: 6)
                RollingCounter(seconds: readout.seconds, cell: 26, height: 46)
                Spacer(minLength: 6)
                Lamp(name: "Rec", color: Palette.red, lit: readout.recording, pulses: true)
                Spacer(minLength: 2)
                Lamp(name: "Ready", color: Palette.green, lit: readout.ready)
            }
            VStack(spacing: 8) {
                ZStack {
                    RecordKey(mode: readout.key, width: 176, height: 80, word: readout.keyWord, action: model.pressRecord)
                    // While a take may start, the key is visionOS's own broadcast button under the deck's drawing.
                    if model.mayRecord, let link = model.parts?.link {
                        BroadcastPicker(link: link).frame(width: 176, height: 80)
                            .accessibilityLabel("REC: start recording")
                    }
                }
                if readout.recording {
                    Button("Cancel") { model.cancelAsked = true }.buttonStyle(KeyStyle(color: Palette.tan))
                        .accessibilityLabel("Cancel: stop and throw this recording away")
                }
            }
            LabelText(readout.target, size: 11, color: Palette.tan, tracking: 0.12)
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity)
            if let hint = readout.hint {
                Text(hint).font(Theme.sans(14)).foregroundStyle(Palette.amber)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
            }
        }
        .plate(padding: 18)
    }
}

