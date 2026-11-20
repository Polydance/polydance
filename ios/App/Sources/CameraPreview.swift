// The camera's picture on the probe's screen. A UIView whose layer is the session's preview layer,
// kept horizon-level by its own rotation coordinator: the preview turns with the phone, while the take's
// pixels are turned once at REC by CaptureRecorder on the data output's connection (docs/IPHONE.md R4,
// R6). The preview layer mirrors the front camera as people expect; the recording does not.
//
// A flip gives the preview layer a new connection and a new device, so the coordinator is made again
// whenever CaptureRecorder posts `polydanceCameraChanged` (AVCaptureSession.inputs is not documented as
// key-value observable), and again when the view joins a window, since a coordinator made for a layer
// outside a view hierarchy answers 0 degrees.
import AVFoundation
import SwiftUI
import UIKit

extension Notification.Name {
    /// Posted on the main queue by CaptureRecorder after the session's camera is set or changed. The
    /// object is the session; userInfo["uniqueID"] is the new camera's AVCaptureDevice.uniqueID.
    static let polydanceCameraChanged = Notification.Name("net.polydance.capture.iphone.cameraChanged")
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.backgroundColor = .black
        view.attach(session)
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {
        view.attach(session)
    }

    static func dismantleUIView(_ view: PreviewView, coordinator: ()) {
        view.detach()
    }
}

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        // layerClass makes this cast hold for every instance.
        layer as! AVCaptureVideoPreviewLayer
    }

    private var camera: AVCaptureDevice?
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var angleObservation: NSKeyValueObservation?
    private var cameraObserver: NSObjectProtocol?

    /// Shows `session`; does nothing when it is already shown.
    func attach(_ session: AVCaptureSession) {
        guard previewLayer.session !== session else { return }
        detach()
        previewLayer.videoGravity = .resizeAspect
        previewLayer.session = session
        cameraObserver = NotificationCenter.default.addObserver(forName: .polydanceCameraChanged, object: session, queue: .main) { [weak self] note in
            let id = note.userInfo?["uniqueID"] as? String
            MainActor.assumeIsolated {
                self?.follow(id.flatMap { AVCaptureDevice(uniqueID: $0) })
            }
        }
        follow(Self.camera(of: session))
    }

    func detach() {
        if let cameraObserver { NotificationCenter.default.removeObserver(cameraObserver) }
        cameraObserver = nil
        angleObservation = nil
        rotation = nil
        camera = nil
        previewLayer.session = nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { follow(camera) }
    }

    /// A coordinator for `device` and this layer, whose preview angle is applied now and on every change.
    private func follow(_ device: AVCaptureDevice?) {
        angleObservation = nil
        rotation = nil
        camera = device
        guard let device else { return }
        let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
        rotation = coordinator
        // The coordinator delivers its key-value updates on the main queue.
        angleObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) { [weak self] coordinator, _ in
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            MainActor.assumeIsolated { self?.apply(angle) }
        }
    }

    private func apply(_ angle: CGFloat) {
        guard let connection = previewLayer.connection, connection.isVideoRotationAngleSupported(angle) else { return }
        if connection.videoRotationAngle != angle { connection.videoRotationAngle = angle }
    }

    private static func camera(of session: AVCaptureSession) -> AVCaptureDevice? {
        session.inputs.compactMap { $0 as? AVCaptureDeviceInput }.first { $0.device.hasMediaType(.video) }?.device
    }
}
