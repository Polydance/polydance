// A 3D model in its message (the Quest's ModelView, app/PLATFORMS.md "The 3D viewer"), drawn the way the headset draws
// it: Google's <model-viewer> in a web view, from the very page the Quest serves (app/android/.../assets/viewer, copied
// into the app by project.yml, not kept twice). The model comes from the receiver through its thread and is checked
// against the message's sha256 (HeadsetModel.model) before the page may load it. The page is served under a scheme
// of the app's own, and the handler answers only files in that folder and the one verified model, so nothing in the
// viewer reaches the network. The page says how loading goes in its title ("progress 0.42", "loaded 1 animation",
// "error …"); the keys call window.polydance, as on the headset. 440 points tall, with Controls folded by default.
import PolydanceShared
import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct ModelViewer: View {
    @ObservedObject var model: HeadsetModel
    let key: String
    let name: String
    let bytes: Int
    let sha256: String
    @State private var file: URL?
    @State private var status = "Fetching the model…"
    @State private var loaded = false
    @State private var controls = false
    @State private var spinning = false
    @State private var page = ViewerPage()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                LabelText("3D · \(name) · \(LaunchLink.megabytes(bytes))", size: 12, color: Palette.tan, tracking: 0.12).lineLimit(1)
                Spacer()
                Button(controls ? "▴ Controls" : "▾ Controls") { controls.toggle() }.buttonStyle(KeyStyle(color: Palette.tan))
            }
            ZStack {
                if let file {
                    ViewerWeb(page: page, model: file, sha256: sha256) { title in
                        if title.hasPrefix("loaded") { loaded = true; status = "" }
                        else if title.hasPrefix("error") { status = "The model could not be shown: \(title.dropFirst(6))" }
                        else if title.hasPrefix("progress"), !loaded, let p = Double(title.dropFirst(9)) { status = "Loading \(Int(p * 100))%" }
                    }
                }
                if !status.isEmpty {
                    Text(status).font(Theme.sans(16)).foregroundStyle(Palette.cream)
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Palette.panel))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.edge))
                }
            }
            .frame(height: 440)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 10).fill(Palette.casing))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.edge))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            if controls {
                HStack(spacing: 8) {
                    Button("◀ Turn") { page.run("window.polydance.turn(-30)") }.buttonStyle(KeyStyle())
                    Button("Turn ▶") { page.run("window.polydance.turn(30)") }.buttonStyle(KeyStyle())
                    Button("－ Zoom") { page.run("window.polydance.zoom(-1)") }.buttonStyle(KeyStyle())
                    Button("Zoom ＋") { page.run("window.polydance.zoom(1)") }.buttonStyle(KeyStyle())
                    Button(spinning ? "■ Stop" : "↻ Spin") { spinning.toggle(); page.run("window.polydance.spin(\(spinning))") }.buttonStyle(KeyStyle())
                    Button("⟲ Reset") { spinning = false; page.run("window.polydance.reset()") }.buttonStyle(KeyStyle())
                }
                .disabled(!loaded)
            }
        }
        .task(id: sha256) {
            do {
                file = try await model.model(key: key, sha256: sha256, bytes: bytes)
                status = "Loading…"
            } catch {
                status = "The model could not be fetched: \(HeadsetModel.words(error))"
            }
        }
    }
}

/// The web view's handle, for the keys.
@MainActor
final class ViewerPage {
    weak var web: WKWebView?
    func run(_ script: String) { web?.evaluateJavaScript(script, completionHandler: nil) }
}

private struct ViewerWeb: UIViewRepresentable {
    static let scheme = "polydance-viewer"
    let page: ViewerPage
    let model: URL
    let sha256: String
    let onTitle: (String) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator.handler, forURLScheme: Self.scheme)
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.navigationDelegate = context.coordinator
        #if DEBUG
        web.isInspectable = true
        #endif
        context.coordinator.observe(web)
        page.web = web
        web.load(URLRequest(url: URL(string: "\(Self.scheme)://app/viewer/index.html?src=model/\(sha256).glb")!))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(model: model, sha256: sha256, onTitle: onTitle) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let handler: ViewerFiles
        let onTitle: (String) -> Void
        private var titleWatch: NSKeyValueObservation?

        init(model: URL, sha256: String, onTitle: @escaping (String) -> Void) {
            handler = ViewerFiles(model: model, sha256: sha256)
            self.onTitle = onTitle
        }

        func observe(_ web: WKWebView) {
            titleWatch = web.observe(\.title, options: [.new]) { [weak self] web, _ in
                guard let title = web.title else { return }
                DispatchQueue.main.async { self?.onTitle(title) }
            }
        }

        /// The page may not leave itself: every navigation but the viewer's own is refused.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.request.url?.scheme == ViewerWebScheme.name ? .allow : .cancel
        }
    }
}

private enum ViewerWebScheme { static let name = ViewerWeb.scheme }

/// Answers the page's requests from the app's viewer folder and the one verified model; everything else is a 404.
final class ViewerFiles: NSObject, WKURLSchemeHandler {
    let model: URL
    let sha256: String
    private let folder: URL?

    init(model: URL, sha256: String) {
        self.model = model
        self.sha256 = sha256
        folder = Bundle.main.url(forResource: "viewer", withExtension: nil)
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app" else { return fail(task, 404) }
        let path = url.path
        var file: URL?
        if path == "/viewer/model/\(sha256).glb" {
            file = model
        } else if path.hasPrefix("/viewer/"), let folder {
            let relative = String(path.dropFirst("/viewer/".count))
            let candidate = folder.appendingPathComponent(relative).standardizedFileURL
            // Only inside the folder: no "..", no model of any other name.
            if !relative.contains(".."), candidate.path.hasPrefix(folder.standardizedFileURL.path + "/"), !relative.hasPrefix("model/") { file = candidate }
        }
        guard let file, let data = try? Data(contentsOf: file) else { return fail(task, 404) }
        let type = Self.type(of: file)
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type, "Content-Length": "\(data.count)", "Access-Control-Allow-Origin": "*",
                                                      "Cache-Control": "no-store"])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, _ status: Int) {
        let response = HTTPURLResponse(url: task.request.url ?? URL(string: "\(ViewerWeb.scheme)://app/")!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
        task.didReceive(response)
        task.didReceive(Data())
        task.didFinish()
    }

    static func type(of file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js": "text/javascript; charset=utf-8"
        case "wasm": "application/wasm"
        case "glb": "model/gltf-binary"
        case "txt": "text/plain; charset=utf-8"
        default: UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
