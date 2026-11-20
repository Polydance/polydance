// The pairing window (docs/IPHONE.md P2). It reads the pairing, `{"v":1,"server":…,"token":…}`, from
// standard input (never the command line, which other processes can read), draws it as a QR code with Core
// Image's generator, and shows it on a black plate on the wooden cabinet until Done (or Esc) is pressed or
// two minutes have passed. The code is drawn only in memory: no image is written anywhere, and the window
// is kept out of screenshots and screen recordings (NSWindow.sharingType none), since Polydance for Mac
// records screens. ios/build.sh has already checked the pairing with the phone's own rules; this only
// refuses what is plainly not one. The receiver keeps no record of a token's first use, so the window
// cannot see the phone pair: the phone itself says "Paired".
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import PolydanceShared
import SwiftUI

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("polydance-pair: \(message)\n".utf8))
    exit(2)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty, input.count <= 2048 else { fail("give the pairing JSON on standard input (2048 bytes at most)") }
guard let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any], Set(object.keys) == ["v", "server", "token"],
      let server = object["server"] as? String, let host = URLComponents(string: server)?.host else {
    fail("standard input is not a pairing: a JSON object with exactly v, server and token")
}
let text = String(decoding: input, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)

let qr = CIFilter.qrCodeGenerator()
qr.message = Data(text.utf8)
qr.correctionLevel = "M"
guard let code = qr.outputImage, let drawn = CIContext().createCGImage(code, from: code.extent) else { fail("Core Image drew no QR code") }
let modules = code.extent.width

struct PairView: View {
    let image: CGImage
    let modules: CGFloat
    let place: String
    let closesAt: Date
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            LabelText("Pair Polydance for iPhone", size: 14, color: Palette.whitePrint, tracking: 0.18)
            Text("On the phone: the gear, then Pair with the Mac. Point the phone at this code.")
                .font(Theme.sans(15)).foregroundStyle(Palette.cream).fixedSize(horizontal: false, vertical: true)
            // Black on white with a quiet zone of four modules, as a scanner expects; pixels kept square.
            Image(decorative: image, scale: 1).interpolation(.none).resizable().frame(width: 300, height: 300)
                .padding(300 / modules * 4).background(Color.white)
                .frame(maxWidth: .infinity)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = max(0, Int(closesAt.timeIntervalSince(context.date).rounded(.up)))
                Text("It holds \(place)'s address and the phone's token, so it is not saved, and screenshots leave it out. Closes in \(left / 60):\(String(format: "%02d", left % 60)).")
                    .font(Theme.sans(13)).foregroundStyle(Palette.tan).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Done", action: done).buttonStyle(KeyStyle(color: Palette.cream, small: false)).keyboardShortcut(.cancelAction)
            }
        }
        .frame(width: 380)
        .plate(padding: 20)
        .padding(20)
        .background(Wood())
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    let image: CGImage, modules: CGFloat, place: String
    var window: NSWindow?

    init(image: CGImage, modules: CGFloat, place: String) {
        self.image = image
        self.modules = modules
        self.place = place
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let closesAt = Date().addingTimeInterval(120)
        let view = PairView(image: image, modules: modules, place: place, closesAt: closesAt) { NSApp.terminate(nil) }
        let window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Pair Polydance for iPhone"
        window.sharingType = .none
        window.contentView = NSHostingView(rootView: view)
        window.setContentSize(window.contentView?.fittingSize ?? NSSize(width: 460, height: 640))
        window.center()
        window.level = .floating
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in NSApp.terminate(nil) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate(image: drawn, modules: modules, place: host)
app.delegate = delegate
app.run()
