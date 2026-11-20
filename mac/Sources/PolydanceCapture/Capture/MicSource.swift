// The microphone (Robin's voice, track "mic"): AVCaptureSession with one audio input and an
// AVCaptureAudioDataOutput asked for 32-bit float mono at 48 kHz. Raw: no voice processing, which on
// macOS 14+ would lower other apps' sound (C10). Buffers are re-stamped in host time and copied, so the
// recorder can hold them while it decides whether the screen is recorded.
//
// For a call the input is the device Meet in Arc is using (Core Audio's devices for Arc's process that
// runs input), so "me" is what the others hear, not whatever the system default is (on this Mac on
// 2026-11-05 the default input was a virtual device); the system default only when that cannot be read,
// and the metadata says so. When the session stops on its own (a runtime error, the device unplugged),
// that is reported with why, and the microphone starts again on Arc's current input or the default; the
// writer fills the gap with silence so the rest of the track keeps its time.
import AVFoundation
import CoreMedia
import Foundation

final class MicSource: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    enum Choice {
        /// The input Arc's call is using, else the system default.
        case arcInput
        case systemDefault
    }

    static let sampleRate: Double = 48_000
    /// A device that keeps failing is not restarted for ever.
    static let maxRestarts = 5
    let meter = LevelMeter()
    var onSample: ((CMSampleBuffer) -> Void)?
    /// Called on the microphone's queue when the microphone stopped or started again by itself, with a
    /// line for the metadata note.
    var onEvent: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "net.polydance.capture.mic", qos: .userInitiated)
    private var choice = Choice.systemDefault
    private var device: AVCaptureDevice?
    private var input: AVCaptureDeviceInput?
    private var observers: [NSObjectProtocol] = []
    private var stopped = false
    private var restarts = 0
    private let lock = NSLock()
    private var name: String?
    private var note: String?

    /// The device recorded, and for the metadata, when it is not the one Arc uses, which it is and why.
    /// Read from any queue.
    var deviceName: String? { lock.lock(); defer { lock.unlock() }; return name }
    var deviceNote: String? { lock.lock(); defer { lock.unlock() }; return note }

    static var authorization: AVAuthorizationStatus { AVCaptureDevice.authorizationStatus(for: .audio) }

    /// Starts the microphone, asking for access first if it was never asked. Calls back once, on an
    /// arbitrary queue, with nil on success or why there is no microphone track.
    func start(_ choice: Choice, _ done: @escaping (String?) -> Void) {
        queue.async { self.choice = choice }
        switch Self.authorization {
        case .authorized:
            queue.async { done(self.startSession()) }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                if granted { self.queue.async { done(self.startSession()) } }
                else { done("microphone access was refused") }
            }
        case .denied:
            done("microphone access is off in System Settings, Privacy & Security, Microphone")
        case .restricted:
            done("microphone access is restricted on this Mac")
        @unknown default:
            done("microphone access is unknown")
        }
    }

    /// The device to open: Arc's input for a call when it can be read, else the system default.
    private func chooseDevice() -> (AVCaptureDevice?, note: String?) {
        if choice == .arcInput, let uid = CoreAudioProcesses.arcInputDeviceUID(), let device = AVCaptureDevice(uniqueID: uid) { return (device, nil) }
        let fallback = AVCaptureDevice.default(for: .audio)
        let note = choice == .arcInput ? fallback.map { "mic: \($0.localizedName), the system default (Arc's input could not be read)" } : nil
        return (fallback, note)
    }

    /// On the microphone's queue.
    private func startSession() -> String? {
        guard !stopped else { return "the recording stopped before the microphone started" }
        let (chosen, note) = chooseDevice()
        guard let chosen else { return "no microphone is connected" }
        do {
            let input = try AVCaptureDeviceInput(device: chosen)
            session.beginConfiguration()
            if let old = self.input { session.removeInput(old) }
            guard session.canAddInput(input) else { session.commitConfiguration(); return "the microphone could not be used" }
            session.addInput(input)
            if !session.outputs.contains(output) {
                output.audioSettings = [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVLinearPCMIsFloatKey: true,
                    AVLinearPCMBitDepthKey: 32,
                    AVLinearPCMIsNonInterleaved: false,
                    AVLinearPCMIsBigEndianKey: false,
                    AVSampleRateKey: Self.sampleRate,
                    AVNumberOfChannelsKey: 1,
                ]
                output.setSampleBufferDelegate(self, queue: queue)
                guard session.canAddOutput(output) else { session.commitConfiguration(); return "the microphone's output could not be added" }
                session.addOutput(output)
            }
            session.commitConfiguration()
            self.input = input
            device = chosen
            lock.lock()
            name = chosen.localizedName
            self.note = note
            lock.unlock()
            watch(chosen)
            if !session.isRunning { session.startRunning() }
            return session.isRunning ? nil : "the microphone did not start"
        } catch {
            return "the microphone could not be opened: \(error.localizedDescription)"
        }
    }

    /// The session's runtime errors and the device going away, which otherwise end the track silently.
    private func watch(_ device: AVCaptureDevice) {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = [
            NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
                let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
                self?.queue.async { self?.lost(error?.localizedDescription ?? "the capture session failed") }
            },
            NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil) { [weak self] _ in
                self?.queue.async { self?.lost("\(device.localizedName) was disconnected") }
            },
        ]
    }

    /// On the microphone's queue: say so, then start again on whatever input is right now.
    private func lost(_ why: String) {
        guard !stopped else { return }
        onEvent?("the microphone stopped: \(why)")
        guard restarts < Self.maxRestarts else { onEvent?("the microphone was not started again after \(Self.maxRestarts) tries"); return }
        restarts += 1
        if let problem = startSession() { onEvent?("the microphone could not start again: \(problem)") }
        else { onEvent?("the microphone started again on \(deviceName ?? "the default input")") }
    }

    func stop() {
        queue.sync {
            stopped = true
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            output.setSampleBufferDelegate(nil, queue: nil)
            if session.isRunning { session.stopRunning() }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        var pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if let clock = session.synchronizationClock {
            pts = CMSyncConvertTime(pts, from: clock, to: CMClockGetHostTimeClock())
        }
        guard let copy = AudioBuffers.copy(sampleBuffer, pts: pts) else { return }
        meter.update(peak: copy.peak, rms: copy.rms)
        onSample?(copy.buffer)
    }
}
