// The probe's one screen (docs/IPHONE.md I0): the camera at the top, the take's state, REC/STOP and FLIP,
// then plain lines for what I0 is finding out (the profile's expiry, the upload config, background
// refresh), the runs on the phone with their upload status, and the event log's last lines. System
// colours only: the deck's look comes in phase I2. Without a camera (the simulator) or without
// permission it says so plainly and REC stays off.
import AVFoundation
import PolydancePhoneCore
import SwiftUI

struct ProbeView: View {
    @ObservedObject var model: ProbeModel

    var body: some View {
        if let parts = model.parts {
            ProbeScreen(model: model, recorder: parts.recorder, uploads: parts.uploads, refresh: parts.refresh)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text("Polydance could not set up its files").font(.headline)
                Text(model.setupError ?? "No reason was given.").font(.callout)
                Text("Nothing records or uploads until this is fixed.").foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}

private struct ProbeScreen: View {
    @ObservedObject var model: ProbeModel
    @ObservedObject var recorder: CaptureRecorder
    @ObservedObject var uploads: UploadProbe
    @ObservedObject var refresh: RefreshProbe

    var body: some View {
        VStack(spacing: 0) {
            preview
                .frame(maxWidth: .infinity)
                .frame(height: 240)
                .background(Color.black)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    stateLines
                    keys
                    facts
                    runList
                    logLines
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task { await model.screenAppeared() }
    }

    // MARK: The camera

    @ViewBuilder private var preview: some View {
        switch model.camera {
        case .ready:
            CameraPreview(session: recorder.session)
        case .notAsked:
            note("Asking for the camera and the microphone…")
        case .noCamera:
            note("No camera here (the simulator has none). Recording is off.")
        case .denied(let why):
            note(why)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.white)
            .multilineTextAlignment(.center)
            .padding()
    }

    // MARK: The take

    private var stateLines: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            VStack(alignment: .leading, spacing: 4) {
                Text(stateText(at: context.date))
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(isRecording ? Color.red : Color.primary)
                Text("\(recorder.orientation) · \(recorder.facing == .front ? "front" : "back") camera · "
                     + "\(recorder.stats.videoFrames) frames · \(recorder.stats.droppedVideoFrames) dropped · "
                     + "\(recorder.stats.audioBuffers) audio buffers")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func stateText(at now: Date) -> String {
        switch recorder.state {
        case .idle: "Idle"
        case .starting: "Starting…"
        case .recording(let since): "REC \(Self.counter(now.timeIntervalSince(since)))"
        case .stopping: "Stopping…"
        case .failed(let why): "Failed: \(why)"
        }
    }

    /// mm:ss, as the counter reads.
    static func counter(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return String(format: "%02d:%02d", s / 60, s % 60)
    }

    private var isRecording: Bool {
        if case .recording = recorder.state { return true }
        return false
    }

    private var isBusy: Bool {
        switch recorder.state {
        case .starting, .stopping: true
        default: false
        }
    }

    private var keys: some View {
        HStack(spacing: 12) {
            Button {
                if isRecording { recorder.stop(reason: "STOP was pressed") } else { recorder.start() }
            } label: {
                Text(isRecording ? "STOP" : "REC").font(.headline).frame(minWidth: 88)
            }
            .buttonStyle(.borderedProminent)
            .tint(isRecording ? .gray : .red)
            .disabled(model.camera != .ready || isBusy)

            Button {
                recorder.flip()
            } label: {
                Text("FLIP").font(.headline).frame(minWidth: 64)
            }
            .buttonStyle(.bordered)
            .disabled(model.camera != .ready || isBusy)
        }
    }

    // MARK: What I0 is finding out

    private var facts: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.profileLine)
            if let detail = model.profileDetail {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Text("Upload: \(uploads.configured ? "configured" : model.uploadNote)")
            Text(refreshLine)
            Text("Polydance \(model.appVersion) · \(model.appCommit) · \(model.modelIdentifier) · \(model.systemVersion)")
                .font(.caption).foregroundStyle(.secondary)
            if let autoError = model.autoError {
                Text("Auto mode refused: \(autoError)").font(.caption).foregroundStyle(.red)
            } else if model.auto != .off {
                Text("Auto mode: \(model.auto.summary)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }

    private var refreshLine: String {
        let runs = "\(refresh.runsToday) \(refresh.runsToday == 1 ? "run" : "runs") today"
        let last = refresh.lastRun.map { "last at \(RefreshProbe.clock($0)) on \(ProbeModel.day($0))" } ?? "none yet"
        return "Refresh: \(runs), \(last); \(refresh.lastSubmit)"
    }

    // MARK: Runs

    private var runList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Runs").font(.headline)
            if model.runs.isEmpty {
                Text("No takes on this phone yet.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(model.runs) { row in
                let live = isLive(row)
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.run.name).font(.callout.monospaced())
                        Text("\(Self.megabytes(row.bytes)) · \(live ? "recording" : row.state) · "
                             + (uploads.statuses[row.run.name] ?? "not uploaded"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Button("Upload") { uploads.upload(row.run) }
                        .buttonStyle(.bordered)
                        .disabled(!uploads.configured || live)
                }
            }
        }
    }

    /// The take being recorded now: the newest run, still cut, while the recorder is busy.
    private func isLive(_ row: ProbeModel.RunRow) -> Bool {
        guard row.cut, row.id == model.runs.first?.id else { return false }
        switch recorder.state {
        case .starting, .recording, .stopping: return true
        default: return false
        }
    }

    static func megabytes(_ bytes: Int64) -> String {
        String(format: "%.1f MB", Double(bytes) / 1_000_000)
    }

    // MARK: The event log

    private var logLines: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Events").font(.headline)
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(model.logTail(30).enumerated()), id: \.offset) { _, line in
                        Text(line)
                    }
                }
                .font(.system(size: 9, design: .monospaced))
                .textSelection(.enabled)
            }
        }
    }
}
