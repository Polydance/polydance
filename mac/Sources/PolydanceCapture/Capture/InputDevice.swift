// The input a walkthrough will record: the system default, which MicSource opens for anything but a call.
// Read for New thread's and the report's plates, so the person sees which microphone it is before recording
// (2026-11-16: a report was silent because the default input was a virtual device). Listing devices asks for
// no permission and opens nothing.
import AVFoundation
import CoreAudio
import PolydanceCore

enum InputDevice {
    /// Set by the window's pictures (LookSnapshots), so they do not depend on this Mac's devices.
    nonisolated(unsafe) static var standIn: MicDescription??

    static func current() -> MicDescription? {
        if let standIn { return standIn }
        guard let device = AVCaptureDevice.default(for: .audio) else { return nil }
        return MicDescription(name: device.localizedName, virtual: UInt32(bitPattern: device.transportType) == kAudioDeviceTransportTypeVirtual)
    }
}
