// Pictures of the look, for a person to compare with the headset app (docs/DESIGN-SYSTEM.md): the deck's
// parts on the cabinet, the menu in each state, and the main window. They are written only when
// POLYDANCE_SNAPSHOTS names a folder (`./build.sh snapshots <folder>`); otherwise each test is skipped.
// Every picture also proves the view lays out and draws without hardware.
import AppKit
import PolydanceCore
import PolydanceShared
import SwiftUI
import XCTest
@testable import PolydanceCapture

@MainActor
final class LookSnapshots: XCTestCase {
    private func folder() throws -> URL {
        guard let path = ProcessInfo.processInfo.environment["POLYDANCE_SNAPSHOTS"], !path.isEmpty else {
            throw XCTSkip("POLYDANCE_SNAPSHOTS is not set")
        }
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The moment every picture is drawn at, so a pulsing lamp or the recording key's glow is the same in every
    /// run and two sets of pictures can be compared pixel for pixel: lamps at their brightest, the key's glow
    /// halfway.
    static let time = Date(timeIntervalSinceReferenceDate: 0.3)

    /// Renders a SwiftUI view at 2x through a window, so AppKit-backed parts (lists, scroll views) draw too.
    /// `titled` hosts it as the main window is shown, its title bar hidden and the traffic lights over the
    /// content, and draws the window's frame with them.
    private func snapshot<V: View>(_ view: V, size: CGSize, name: String, titled: Bool = false) throws {
        let out = try folder()
        _ = NSApplication.shared
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height).environment(\.colorScheme, .dark)
            .environment(\.lookTime, Self.time))
        let style: NSWindow.StyleMask = titled ? [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView] : [.borderless]
        let window = NSWindow(contentRect: CGRect(origin: CGPoint(x: 40, y: 40), size: size), styleMask: style, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil) }
        RunLoop.main.run(until: Date().addingTimeInterval(1.2))
        host.layoutSubtreeIfNeeded()
        let drawn: NSView = titled ? (host.superview ?? host) : host
        let rep = try XCTUnwrap(drawn.bitmapImageRepForCachingDisplay(in: drawn.bounds))
        drawn.cacheDisplay(in: drawn.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: out.appendingPathComponent("\(name).png"))
    }

    private func model() throws -> AppModel {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("polydance-look-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let suite = "polydance-look-\(UUID().uuidString)"
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: suite) }
        return AppModel(settings: SettingsStore(defaults: UserDefaults(suiteName: suite)!), environment: ["POLYCAP_ROOT": root.path])
    }

    func testTheDecksParts() throws {
        let sheet = VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 18) {
                Lamp(name: "Ready", color: Palette.green, lit: true)
                Lamp(name: "Rec", color: Palette.red, lit: true)
                Lamp(name: "Rec", color: Palette.red, lit: false)
                Lamp(name: "Processing", color: Palette.processing, lit: true)
                RollingCounter(seconds: 754)
                RollingCounter(seconds: 4000)
            }
            .plate()
            HStack(spacing: 10) {
                RecordKey(mode: .ready) {}
                RecordKey(mode: .recording) {}
                RecordKey(mode: .starting) {}
                RecordKey(mode: .disabled) {}
            }
            .plate()
            HStack(spacing: 12) {
                NeedleMeter(label: "Mic", level: 0.62, active: true, strip: "Me").frame(width: 150, height: 92)
                NeedleMeter(label: "Arc", level: 0.2, active: true, strip: "Others").frame(width: 150, height: 92)
                NeedleMeter(label: "App", level: 0, active: false, strip: "Off").frame(width: 150, height: 92)
            }
            .plate()
            HStack(spacing: 10) {
                Tag(text: "To try", color: Palette.amber)
                Tag(text: "Routine done", color: Palette.green)
                Tag(text: "Failed", color: Palette.red)
                Button("Retry") {}.buttonStyle(KeyStyle())
                Button("Delete") {}.buttonStyle(KeyStyle(color: Palette.red))
                Button("Reply") {}.buttonStyle(PillStyle())
                Button("New thread") {}.buttonStyle(PillStyle(cream: true))
                Avatar(name: "Robin")
                Avatar(name: "Opus 5.5 on Robin's Mac")
            }
            .plate()
            HStack {
                LabelText("Inbox · 3 unread · all projects", size: 11, color: Palette.burnt, tracking: 0.18)
                Spacer()
                Image(nsImage: Logo.mark ?? NSImage()).resizable().frame(width: 28, height: 28)
            }
            .padding(12).background(CreamPlateBackground())
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onWood()
        try snapshot(sheet, size: CGSize(width: 820, height: 520), name: "parts")
    }

    private var fixtures: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("PolydanceCoreTests/Fixtures") }

    /// A library with the fixture call in it (what polycap really wrote on 2026-11-05).
    private func modelWithACall() throws -> AppModel {
        let model = try model()
        let session = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("call-session.json"))) as? [String: Any]
        let id = try XCTUnwrap(session?["id"] as? String)
        let dir = model.layout.sessions.appendingPathComponent(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: fixtures.appendingPathComponent("call-session.json"), to: dir.appendingPathComponent("session.json"))
        model.calls.refresh()
        model.refreshRecent()
        RunLoop.main.run(until: Date().addingTimeInterval(1))
        return model
    }

    func testTheControlPanelInEachState() throws {
        let watching = ControlPanel.Readout(line: "Watching Arc for Google Meet calls", detail: "Every call records by itself. Bundles stay on this Mac.",
                                            hint: "⌃⌥R records the call, or a walkthrough")
        let recording = ControlPanel.Readout(recording: true, ready: false, seconds: 1_234,
                                             meters: .init(me: 0.62, others: 0.35, othersName: "Arc"),
                                             line: "Recording your Meet call · abc-defg-hij", detail: "Arc · started 10:01 when you joined · stops when you leave",
                                             key: .recording, hint: "⌃⌥R stops · ⌃⌥M marks")
        let building = ControlPanel.Readout(building: true, line: "Watching Arc for Google Meet calls", detail: "Building the last recording; a new call still records.",
                                            hint: "⌃⌥R records the call, or a walkthrough")
        let sheet = HStack(alignment: .top, spacing: 10) {
            ControlPanel(readout: watching)
            ControlPanel(readout: recording, mark: {}, discard: {})
            ControlPanel(readout: building)
        }
        .frame(width: 364 * 3 + 20)
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onWood()
        try snapshot(sheet, size: CGSize(width: 364 * 3 + 40, height: 460), name: "control-panel")
    }

    func testThreadRowsAsTheHeadsetListsThem() throws {
        var threads = try JSONDecoder().decode([ThreadSummary].self, from: Data(contentsOf: fixtures.appendingPathComponent("thread-list.json")))
        var read = threads[0]
        read.key = "CAP-10"; read.title = "One panel: deck, threads and the open thread"; read.unread = false; read.fresh = 0; read.waiting = true
        read.people = [ThreadPerson(name: "Robin", initial: "R", colour: nil, invited: nil, email: nil)]; read.peopleCount = 1
        var crowd = threads[0]
        crowd.key = "MUS-26"; crowd.title = "Marimba 2.0 test builds: welcome menu, drums, piano"; crowd.waiting = true
        crowd.people += [ThreadPerson(name: "ana@example.com", initial: "A", colour: nil, invited: true, email: "ana@example.com"),
                         ThreadPerson(name: "Sam", initial: "S", colour: "#825AA0", invited: nil, email: nil)]
        crowd.peopleCount = 5
        threads += [read, crowd]
        // The window's column at its narrowest and at its usual width (less its padding and the list's inset),
        // then the menu's.
        let column = { (width: CGFloat) in width - 40 }
        let sheet = HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) { ForEach(threads) { ThreadRowView(thread: $0, open: $0.key == "CAP-10") } }
                .padding(.vertical, 6).frame(width: column(Sidebar.width.min)).background(Palette.panel)
            VStack(spacing: 0) { ForEach(threads) { ThreadRowView(thread: $0, open: $0.key == "CAP-10") } }
                .padding(.vertical, 6).frame(width: column(Sidebar.width.ideal)).background(Palette.panel)
            VStack(spacing: 0) { ForEach(threads) { ThreadRowView(thread: $0, compact: true) } }
                .padding(.vertical, 6).frame(width: 344).background(Palette.panel)
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onWood()
        try snapshot(sheet, size: CGSize(width: column(Sidebar.width.min) + column(Sidebar.width.ideal) + 344 + 40, height: 300), name: "thread-rows")
    }

    /// A message's photos as the thread page draws them (from the copies polycap saved), a message whose photos
    /// this token may not see, and the photos waiting to go with a reply (2026-11-07).
    func testPhotosInAThread() throws {
        let model = try model()
        let thread = try JSONDecoder().decode(ThreadDetail.self, from: Data(contentsOf: fixtures.appendingPathComponent("thread-show-photos.json")))
        var sent = thread.ordered[1]
        // The fixture's paths are under /Users/test; these are drawn here, into this model's library.
        let folder = model.layout.photos.appendingPathComponent("MUS-1")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        sent.photos = try sent.photos.enumerated().map { index, photo in
            var photo = photo
            let file = folder.appendingPathComponent("\(photo.sha256).\(photo.type == "image/png" ? "png" : "jpg")")
            try drawPhoto(width: photo.width / 8, height: photo.height / 8, hue: index == 0 ? 0.08 : 0.55, to: file)
            photo.path = file.path
            return photo
        }
        var hidden = sent
        hidden.canView = false
        let waiting = try ["a", "b"].enumerated().map { index, name in
            let file = model.layout.root.appendingPathComponent("\(name).png")
            try drawPhoto(width: 160, height: 120, hue: index == 0 ? 0.3 : 0.9, to: file)
            return file
        }
        let sheet = VStack(alignment: .leading, spacing: 14) {
            PhotoStrip(model: model, key: "MUS-1", message: sent)
            PhotoStrip(model: model, key: "MUS-1", message: hidden)
            Attachments(model: model, key: "MUS-1", photos: waiting)
        }
        .padding(16)
        .frame(width: 640, alignment: .leading)
        .background(Theme.sidebar)
        try snapshot(sheet, size: CGSize(width: 640, height: 300), name: "thread-photos")
    }

    /// A message's launches as the headset draws them (2026-11-11): the keys with Settings beside them and the
    /// line saying what is recorded; folded with every sound on, then with the mic off and Settings unfolded,
    /// at the width of the thread page's two columns.
    func testALaunchWithItsSoundSwitches() throws {
        // Two models, since the switches are the model's and both rows are drawn at once.
        let allOn = try model(), micOff = try model()
        micOff.walkthroughMic = false
        let thread = try JSONDecoder().decode(ThreadDetail.self, from: Data(contentsOf: fixtures.appendingPathComponent("thread-show.json")))
        let message = try XCTUnwrap(thread.ordered.first { $0.launches?.isEmpty == false })
        let launches = try XCTUnwrap(message.launches)
        func card(_ model: AppModel, _ index: Int, unfolded: Bool) -> LaunchCard {
            LaunchCard(model: model, key: thread.key, message: message, index: index, launch: launches[index], count: launches.count, settingsShown: unfolded)
        }
        let on = HStack(alignment: .top, spacing: 10) { card(allOn, 0, unfolded: false); card(allOn, 1, unfolded: true) }.frame(width: 700)
        let off = HStack(alignment: .top, spacing: 10) { card(micOff, 0, unfolded: false); card(micOff, 1, unfolded: true) }.frame(width: 700)
        let sheet = VStack(alignment: .leading, spacing: 14) { on; off }
            .padding(16)
            .frame(width: 732, alignment: .leading)
            .background(Theme.sidebar)
        try snapshot(sheet, size: CGSize(width: 732, height: 470), name: "thread-launch")
    }

    /// A gradient picture of this size, as a PNG.
    private func drawPhoto(width: Int, height: Int, hue: CGFloat, to file: URL) throws {
        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { rect in
            NSGradient(starting: NSColor(hue: hue, saturation: 0.6, brightness: 0.9, alpha: 1), ending: NSColor(hue: hue, saturation: 0.8, brightness: 0.35, alpha: 1))?.draw(in: rect, angle: 60)
            return true
        }
        guard let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { throw XCTSkip("could not draw") }
        try png.write(to: file)
    }

    func testTheMenuWhileWatching() throws {
        let model = try modelWithACall()
        try snapshot(MenuContent(model: model).fixedSize(), size: CGSize(width: 384, height: 640), name: "menu-watching")
    }

    func testTheMainWindow() throws {
        let model = try modelWithACall()
        model.selection = model.calls.calls.first.map { .call($0.id) }
        try snapshot(MainWindow(model: model), size: CGSize(width: 1240, height: 800), name: "window", titled: true)
    }

    /// The window as Robin picked it (D of four mockups, 2026-11-16): the Threads tab with a report that did
    /// not get sent at its top, New thread's plate (recording, naming a project, and writing it), and the
    /// report's. polycap is a fake that prints made-up threads and projects.
    func testTheThreadsTabAndThePlates() throws {
        let model = try modelWithACall()
        try fakePolycap(for: model)
        // A report that could not be sent: its recording, and its line in the upload ledger.
        let files = RecordingFiles(directory: model.layout.recordings, baseName: "polydance-mac-20261116-101500")
        try FileManager.default.createDirectory(at: files.directory, withIntermediateDirectories: true)
        try Data(count: 2048).write(to: files.video)
        var ledger = UploadLedger()
        ledger.recordings[files.videoName] = .init(status: .failed, target: .report, at: "2026-11-16T10:16:00.000Z",
                                                  error: "POST /v1/uploads: could not reach https://capture.example.net (fetch failed); run the same command again to resume")
        try PrivateFiles.makeDirectory(model.layout.mac, within: model.layout.root)
        try ledger.save(to: model.layout.uploadLedger)
        model.threads.start()
        model.windowTab = .threads
        model.selection = nil
        let size = CGSize(width: 1240, height: 800)
        try snapshot(MainWindow(model: model), size: size, name: "window-threads", titled: true)

        model.threads.projects = [ThreadProject(key: "MUS", name: "Marimba", mine: false), ThreadProject(key: "PD", name: "Polydance", mine: false),
                                  ThreadProject(key: "CAP", name: "Polydance Capture", mine: false), ThreadProject(key: "START", name: "Welcome", mine: false),
                                  ThreadProject(key: "KITC", name: "Kitchen Timer", mine: true)]
        model.threads.takesReports = true
        model.threads.makesProjects = true
        model.threads.chosenProject = "KITC"
        InputDevice.standIn = .some(MicDescription(name: "MacBook Pro Microphone", virtual: false))
        defer { InputDevice.standIn = nil }
        model.plate = .newThread
        try snapshot(MainWindow(model: model), size: size, name: "window-new-thread", titled: true)
        model.threads.namingProject = true
        model.threads.projectName = "Garden Shed"
        try snapshot(NewThreadPlate(model: model).padding(30).frame(maxWidth: .infinity, maxHeight: .infinity).onWood(), size: CGSize(width: 660, height: 460), name: "plate-new-project")
        model.threads.namingProject = false
        model.threads.newTitle = "The alarm makes everyone jump"
        model.threads.newText = "On the kitchen tablet the alarm starts at full volume. Could it start quietly and get louder?"
        try snapshot(NewThreadPlate(model: model, writing: true).padding(30).frame(maxWidth: .infinity, maxHeight: .infinity).onWood(), size: CGSize(width: 660, height: 520), name: "plate-write")
        model.plate = .report
        try snapshot(MainWindow(model: model), size: size, name: "window-report", titled: true)
        model.threads.takesReports = false
        InputDevice.standIn = .some(MicDescription(name: "Sessions Input 2ch", virtual: true))
        try snapshot(ReportPlate(model: model).padding(30).frame(maxWidth: .infinity, maxHeight: .infinity).onWood(), size: CGSize(width: 600, height: 500), name: "plate-report-refused")
    }

    /// The card of the layer that asks what a walkthrough records (2026-11-16), in Display mode, in Window
    /// mode with a window pointed at, and counting down.
    func testThePickersCard() throws {
        let picker = ScreenPicker()
        let state = picker.state
        state.purpose = "a new thread in Kitchen Timer"
        state.hovered = .display(id: 2, name: "U28E590")
        let card = { PickerCard(state: state, picker: picker).padding(30).frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.casing) }
        try snapshot(card(), size: CGSize(width: 380, height: 360), name: "picker-display")
        state.windowMode = true
        state.hovered = .window(id: 10, title: "Kitchen Timer", app: "Arc")
        try snapshot(card(), size: CGSize(width: 380, height: 380), name: "picker-window")
        state.countdown = 2
        try snapshot(card(), size: CGSize(width: 380, height: 380), name: "picker-counting")
    }

    /// A polycap that answers `thread list` with made-up threads and `project list` with made-up projects, and
    /// fails anything else.
    private func fakePolycap(for model: AppModel) throws {
        let bin = model.layout.root.appendingPathComponent("fake-bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        var base = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("thread-list.json"))) as? [[String: Any]]).first!
        base["fresh"] = 0
        func thread(_ key: String, _ title: String, _ at: String, unread: Bool = false, waiting: Bool = false, snippet: String, people: [String]) -> [String: Any] {
            var t = base
            t["key"] = key; t["project"] = String(key.split(separator: "-")[0]); t["title"] = title; t["unread"] = unread; t["waiting"] = waiting
            t["snippet"] = snippet; t["lastMessageAt"] = at; t["updatedAt"] = at
            t["people"] = people.map { ["name": $0, "initial": String($0.prefix(1))] }; t["peopleCount"] = people.count
            return t
        }
        let threads = [
            thread("KITC-2", "Timer face: bigger digits, a softer alarm", "2026-11-16T10:40:00.000Z", unread: true,
                   snippet: "Here's the build with the bigger digits. Set a one-minute timer and let it ring.", people: ["Opus 5.5", "Robin"]),
            thread("MUS-26", "Marimba 2.0 test builds: welcome menu, drums, piano", "2026-11-16T09:12:00.000Z", unread: true, waiting: true,
                   snippet: "The taiko drums are in. Hit each one twice.", people: ["Opus 5.5", "Robin", "Sam"]),
            thread("CAP-10", "One panel: deck, threads and the open thread", "2026-11-15T17:30:00.000Z", waiting: true,
                   snippet: "Show the deck with a thread open beside it.", people: ["Robin"]),
            base,
        ]
        let list = model.layout.root.appendingPathComponent("threads.json")
        try JSONSerialization.data(withJSONObject: threads).write(to: list)
        let node = bin.appendingPathComponent("node")
        try Data("""
        #!/bin/sh
        case "$2 $3" in
          "thread list") cat "\(list.path)" ;;
          "project list") printf '{"projects":[{"key":"KITC","name":"Kitchen Timer","mine":true}],"capabilities":["reports-v1","projects-new-v1"]}\\n' ;;
          *) echo "not in the pictures" >&2; exit 1 ;;
        esac
        """.utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        let script = bin.appendingPathComponent("polycap.js")
        try Data("// fake".utf8).write(to: script)
        model.settings.nodePath = node.path
        model.settings.polycapPath = script.path
    }

}
