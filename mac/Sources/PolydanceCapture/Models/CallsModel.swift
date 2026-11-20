// The main window's Calls: the list (every session with source.call, newest first), the open call's
// page, and the routine's actions on it. While the window is open the list and the page are read again
// whenever the sessions folder changes and every 3 s (a session's own files change inside its folder,
// which the folder's watcher does not see); the catalog and the page's stamps keep that to a few stats
// when nothing changed. Everything is read off the main thread. The configured hooks come from
// `polycap hooks list --json`, for the routine card's folder and the settings.
import AppKit
import Foundation
import Observation
import PolydanceCore

@MainActor
@Observable
final class CallsModel {
    @ObservationIgnored weak var app: AppModel?

    private(set) var calls: [RecentRecording] = []
    private(set) var listedOnce = false
    /// The open call's page, and why it could not be read when it could not.
    private(set) var page: CallPageData?
    private(set) var pageID: String?
    private(set) var pageProblem: String?

    private(set) var hooks: HookListing?
    private(set) var hooksProblem: String?
    private(set) var hooksLoading = false

    /// `hooks run` in flight, by session id and hook name ("*" for all of them).
    private(set) var rerunning: Set<String> = []
    /// What the last Run again said, by session id, until the page is left.
    private(set) var rerunNote: [String: String] = [:]

    @ObservationIgnored private let catalog = CallCatalog()
    @ObservationIgnored private var watcher: FolderWatcher?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var windows = 0
    @ObservationIgnored private var scanning = false

    // MARK: The window

    func windowAppeared() {
        windows += 1
        guard windows == 1 else { return }
        refresh()
        loadHooks()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer?.tolerance = 0.5
        watch()
    }

    func windowDisappeared() {
        windows = max(0, windows - 1)
        guard windows == 0 else { return }
        timer?.invalidate()
        timer = nil
        watcher = nil
    }

    /// The sessions folder may not exist until the first import; the watcher is made when it does.
    private func watch() {
        guard watcher == nil, let sessions = app?.layout.sessions else { return }
        watcher = FolderWatcher(url: sessions) { [weak self] in self?.refresh() }
    }

    // MARK: Reading

    func refresh() {
        guard let app, !scanning else { return }
        if windows > 0 { watch() }
        scanning = true
        let sessions = app.layout.sessions
        let catalog = self.catalog
        Task.detached(priority: .utility) {
            let found = catalog.scan(sessions: sessions)
            await MainActor.run {
                self.scanning = false
                if found != self.calls { self.calls = found }
                self.listedOnce = true
                self.reloadPageIfChanged()
            }
        }
    }

    /// Opens a call's page (the sidebar's selection).
    func open(id: String) {
        guard PolycapOutput.isSessionID(id), let app else { return }
        if pageID != id {
            pageID = id
            page = nil
            pageProblem = nil
        }
        load(app.layout.sessions.appendingPathComponent(id), id: id)
    }

    private func reloadPageIfChanged() {
        guard let id = pageID, let app else { return }
        let dir = app.layout.sessions.appendingPathComponent(id)
        let known = page?.stamp
        Task.detached(priority: .utility) {
            let stamp = CallPageData.stamp(of: dir)
            await MainActor.run {
                guard self.pageID == id, stamp != known || self.page == nil else { return }
                self.load(dir, id: id)
            }
        }
    }

    private func load(_ dir: URL, id: String) {
        Task.detached(priority: .userInitiated) {
            let result = Result { try CallPageData.load(from: dir) }
            await MainActor.run {
                guard self.pageID == id else { return }
                switch result {
                case .success(let page):
                    if page != self.page { self.page = page }
                    self.pageProblem = nil
                case .failure(let error):
                    self.page = nil
                    self.pageProblem = FileManager.default.fileExists(atPath: dir.path) ? "\(error)" : "This call's folder is no longer in the library."
                }
            }
        }
    }

    func loadHooks() {
        guard let app, !hooksLoading else { return }
        hooksLoading = true
        let runner = app.runner
        Task {
            do {
                hooks = try await runner.hooksList()
                hooksProblem = nil
            } catch {
                hooksProblem = "\(error)"
            }
            hooksLoading = false
        }
    }

    // MARK: The routine

    func isRerunning(_ id: String, hook: String?) -> Bool { rerunning.contains("\(id)/\(hook ?? "*")") }

    /// "Run again": `polycap hooks run <id> [--hook NAME] --force`. The page shows the run as hook-runs.json
    /// changes; the note says what polycap reported when it finished.
    func runAgain(id: String, hook: String?) {
        guard let app else { return }
        let key = "\(id)/\(hook ?? "*")"
        guard !rerunning.contains(key) else { return }
        rerunning.insert(key)
        rerunNote[id] = nil
        let runner = app.runner
        Task {
            do {
                let result = try await runner.hooksRun(id: id, hook: hook)
                rerunNote[id] = result.summary
            } catch {
                rerunNote[id] = "\(error)"
            }
            rerunning.remove(key)
            refresh()
        }
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    // MARK: Files

    func openFolder(_ dir: URL) { NSWorkspace.shared.activateFileViewerSelecting([dir]) }

    func openFile(_ url: URL) {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        NSWorkspace.shared.open(url)
    }

    /// The newest call's far end, for the settings' system-audio line (it cannot be checked otherwise).
    var lastFarEnd: (heard: Bool, at: Date?)? {
        guard let latest = calls.first(where: { !$0.short && $0.farEnd != nil }), let farEnd = latest.farEnd else { return nil }
        return (farEnd == "heard", latest.recordedAt)
    }
}

/// Calls back on the main queue when entries are added to, removed from or renamed in a folder.
final class FolderWatcher {
    private let source: DispatchSourceFileSystemObject

    init?(url: URL, onChange: @escaping @MainActor () -> Void) {
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { onChange() } }
        source.setCancelHandler { close(fd) }
        source.resume()
    }

    deinit { source.cancel() }
}
