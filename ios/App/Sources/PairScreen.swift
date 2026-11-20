// Pairing with the Mac (docs/IPHONE.md P2): the phone scans the QR code `npm run ios -- pair` draws, with
// its own scanner rather than the Camera app, so no other app ever sees the token. The code's words are
// checked by Pairing's strict decoder, then the receiver is asked who the token is (GET /v1/me) and what it
// may store (GET /v1/account, which an upload token answers); only when both answer is the pairing kept, in
// the Keychain. A refusal says why and keeps nothing. The deck's camera is stopped while this screen has
// it and started again after (DeckModel.closePairing).
import AVFoundation
import PolydancePhoneCore
import PolydanceShared
import SwiftUI
import UIKit

struct PairScreen: View {
    @ObservedObject var deck: DeckModel

    enum Step: Equatable {
        case scanning
        case checking(String)
        case paired(who: String, place: String)
        case refused(String)
    }

    @State private var step: Step = .scanning

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                LabelText("Pair with the Mac", size: 14, color: Palette.burnt, tracking: 0.2)
                Spacer()
                Button(done ? "Done" : "Cancel") { deck.closePairing() }.buttonStyle(KeyStyle(color: Palette.burnt, small: false))
            }
            .padding(.horizontal, 12).padding(.top, 8)
            ZStack {
                if step == .scanning {
                    QRScanner { text in found(text) }
                    RoundedRectangle(cornerRadius: 12).stroke(Palette.amber, lineWidth: 3).frame(width: 240, height: 240)
                } else {
                    Color.black
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.edge, lineWidth: 2))
            .padding(.horizontal, 12)
            VStack(alignment: .leading, spacing: 10) {
                switch step {
                case .scanning:
                    Text("On the Mac, run npm run ios -- pair, then point the phone at the code it shows.")
                        .font(Theme.sans(15)).foregroundStyle(Palette.cream)
                    Text("The code holds the receiver's address and this phone's token. Polydance keeps the token in the Keychain, on this phone only.")
                        .font(Theme.sans(13)).foregroundStyle(Palette.tan)
                case .checking(let place):
                    Text("Asking \(place) who this token is…").font(Theme.sans(15)).foregroundStyle(Palette.cream)
                case .paired(let who, let place):
                    LabelText("Paired", size: 12, color: Palette.green, tracking: 0.16)
                    Text("Messages from this phone read “\(who)” on \(place). Threads come from there now.")
                        .font(Theme.sans(15)).foregroundStyle(Palette.cream)
                case .refused(let why):
                    LabelText("Not paired", size: 12, color: Palette.red, tracking: 0.16)
                    Text(why).font(Theme.sans(15)).foregroundStyle(Palette.cream)
                    Button("Scan again") { step = .scanning }.buttonStyle(KeyStyle(color: Palette.amber, small: false))
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .plate(padding: 16)
            .padding(.horizontal, 12).padding(.bottom, 12)
        }
        .background(Wood().ignoresSafeArea())
        .environment(\.colorScheme, .dark)
    }

    private var done: Bool { if case .paired = step { return true } else { return false } }

    private func found(_ text: String) {
        guard step == .scanning else { return }
        let pairing: Pairing
        do {
            pairing = try Pairing.decode(Data(text.utf8), source: "the code")
        } catch {
            deck.probe.parts?.log.write("pair.scan", ["ok": false, "reason": (error as? UploadProtocolError)?.description ?? "unreadable", "appState": ProbeAppState.current()])
            step = .refused("That code is not a Polydance pairing: \((error as? UploadProtocolError)?.description ?? "it could not be read").")
            return
        }
        step = .checking(pairing.place)
        Task { @MainActor in
            switch await deck.pair(pairing) {
            case .success(let who): step = .paired(who: who, place: pairing.place)
            case .failure(let why): step = .refused(why.description)
            }
        }
    }
}

/// The camera, reading QR codes only, on a session of its own while the pairing screen is up.
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) { controller.onCode = onCode }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "net.polydance.capture.iphone.scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private var told = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
        let session = session
        queue.async { [weak self] in
            session.beginConfiguration()
            if let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
               let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) {
                session.addInput(input)
            }
            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
            }
            session.commitConfiguration()
            session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = session
        queue.async { session.stopRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !told, let code = objects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first(where: { $0.type == .qr }),
              let text = code.stringValue else { return }
        told = true
        let session = session
        queue.async { session.stopRunning() }
        onCode?(text)
    }
}
