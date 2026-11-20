// The menu's control panel, the headset's (MainActivity's black panel lettered in white, screwed to the
// cabinet): READY and PROCESSING lamps, the tape counter, the REC lamp, the MIC and ARC needle meters
// while recording, a line saying what the deck is doing, and the red key with Mark and Discard beside it.
// It is drawn from a Readout, plain values the model gives, so it can be pictured in every state without
// hardware (LookSnapshots).
import PolydanceCore
import PolydanceShared
import SwiftUI

struct ControlPanel: View {
    struct Readout: Equatable {
        var recording = false
        var building = false
        var ready = true
        var seconds = 0
        /// The two meters while recording: Me's level, the others' level (0 to 1) and their source's name.
        var meters: Meters?
        var line: String
        var detail: String?
        var key: RecordKey.Mode = .ready
        /// What the red key does, said under it.
        var hint: String

        struct Meters: Equatable {
            var me: Double
            var others: Double
            var othersName: String
            var meOff = false
            var othersOff = false
            /// Off because the launch's switch was off (a walkthrough), not because it failed.
            var meSwitchedOff = false
            var othersSwitchedOff = false
        }
    }

    let readout: Readout
    var record: () -> Void = {}
    var mark: (() -> Void)?
    var discard: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                Lamp(name: "Ready", color: Palette.green, lit: readout.ready)
                Lamp(name: "Processing", color: Palette.processing, lit: readout.building, pulses: true)
                Spacer(minLength: 4)
                RollingCounter(seconds: readout.seconds, cell: 18, height: 32)
                Spacer(minLength: 4)
                Lamp(name: "Rec", color: Palette.red, lit: readout.recording, pulses: true)
            }
            if let meters = readout.meters {
                HStack(spacing: 10) {
                    NeedleMeter(label: "Mic", level: meters.me, active: !meters.meOff,
                                strip: meters.meSwitchedOff ? "Mic off" : meters.meOff ? "No mic" : "Me")
                    NeedleMeter(label: meters.othersName, level: meters.others, active: !meters.othersOff,
                                strip: meters.othersSwitchedOff ? "Sound off" : meters.othersOff ? "No sound" : "Others")
                }
                .frame(height: 84)
            }
            VStack(spacing: 3) {
                Text(readout.line).font(Theme.sans(13, .semibold)).foregroundStyle(Palette.whitePrint)
                if let detail = readout.detail { Text(detail).font(Theme.sans(11)).foregroundStyle(Palette.tan) }
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                if let mark { Button("Mark", action: mark).buttonStyle(KeyStyle(color: Palette.amber)).help("Mark this moment (\(Hotkeys.Shortcut.mark.label))") }
                RecordKey(mode: readout.key, action: record)
                if let discard { Button("Discard", action: discard).buttonStyle(KeyStyle(color: Palette.red)).help("Stop and discard what this recording wrote") }
            }
            LabelText(readout.hint, size: 9, color: Palette.tan, tracking: 0.12)
        }
        .plate(padding: 16)
    }
}

extension AppModel {
    /// What the control panel shows now.
    var controlReadout: ControlPanel.Readout {
        if let live {
            let isCall = live.mode != .walkthrough
            let started = live.startedAt.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
            let line: String
            switch live.mode {
            case .call(let code): line = "Recording your Meet call · \(code)"
            case .walkthrough: line = live.thread.map { "Recording \($0.what)" } ?? "Recording a walkthrough"
            }
            let detail = isCall ? "Arc · started \(started)\(live.automatic ? " when you joined" : "") · stops when you leave"
                : "Started \(started) · " + (live.thread.map { "\($0.whenStopped) when you stop" } ?? "stop with \(Hotkeys.Shortcut.recordOrStop.label)")
            return ControlPanel.Readout(
                recording: true, building: handoff.current != nil, ready: false, seconds: Int(live.elapsed),
                meters: .init(me: Double(live.micBars) / 7, others: Double(live.appBars) / 7, othersName: isCall ? "Arc" : "Mac",
                              meOff: live.status.micNote != nil || live.status.micOff, othersOff: live.status.appNote != nil || live.status.appOff,
                              meSwitchedOff: live.status.micOff, othersSwitchedOff: live.status.appOff),
                line: live.stopping ? "Saving…" : line, detail: detail,
                key: live.stopping ? .starting : .recording,
                hint: live.stopping ? "Saving the recording" : "\(Hotkeys.Shortcut.recordOrStop.label) stops · \(Hotkeys.Shortcut.mark.label) marks")
        }
        let line = autoRecordMeet ? "Watching Arc for Google Meet calls" : "Automatic recording is off"
        let detail = phase == .building ? "Building the last recording; a new call still records."
            : autoRecordMeet ? "Every call records by itself. Bundles stay on this Mac." : nil
        return ControlPanel.Readout(
            recording: false, building: phase == .building, ready: autoRecordMeet, seconds: 0, meters: nil,
            line: line, detail: detail, key: .ready,
            hint: "\(Hotkeys.Shortcut.recordOrStop.label) records the call, or a walkthrough")
    }
}
