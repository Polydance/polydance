// Where the Mac app keeps what it records, and the only deletion it ever does. Recordings go to
// <library>/mac/recordings/polydance-mac-<yyyymmdd>-<hhmmss>.mp4 with <same name>.meta.json beside it;
// directories the app creates are 0700 and files 0600 (CLAUDE.md, C8). The library is the app's own
// setting, else $POLYCAP_ROOT, else POLYCAP_ROOT in polycap's env file, else ~/PolydanceCapture: the
// order polycap itself uses, so the app and polycap find the same library, and the app then gives every
// polycap it runs that library explicitly. Discarding a recording removes exactly that
// recording's two files and refuses anything else: the hard rule is that nothing else is ever deleted.
import Foundation

public struct LibraryLayout: Sendable, Equatable {
    public let root: URL

    public init(root: URL) {
        self.root = root.standardizedFileURL
    }

    /// The setting wins, then POLYCAP_ROOT in the environment, then POLYCAP_ROOT in polycap's env file
    /// (`envFile`, its values), then ~/PolydanceCapture; `~` is expanded.
    public static func resolve(setting: String?, environment: [String: String], home: URL, envFile: [String: String] = [:]) -> LibraryLayout {
        for candidate in [setting, environment["POLYCAP_ROOT"], envFile["POLYCAP_ROOT"]] {
            if let path = candidate?.trimmingWhitespace(), !path.isEmpty {
                return LibraryLayout(root: URL(fileURLWithPath: expandTilde(path, home: home)))
            }
        }
        return LibraryLayout(root: home.appendingPathComponent("PolydanceCapture"))
    }

    /// The same, reading polycap's env file. When that file cannot be used (polycap refuses it too), the
    /// library is resolved without it and the problem is returned to be shown.
    public static func resolveForApp(setting: String?, environment: [String: String], home: URL) -> (layout: LibraryLayout, problem: String?) {
        let file = PolycapEnvFile.path(environment: environment, home: home)
        do {
            let values = try PolycapEnvFile.read(file, keys: ["POLYCAP_ROOT"])
            return (resolve(setting: setting, environment: environment, home: home, envFile: values), nil)
        } catch {
            return (resolve(setting: setting, environment: environment, home: home), "\(error)")
        }
    }

    public var sessions: URL { root.appendingPathComponent("sessions") }
    /// The Mac app's own folder in the library.
    public var mac: URL { root.appendingPathComponent("mac") }
    public var recordings: URL { mac.appendingPathComponent("recordings") }
    public var logs: URL { mac.appendingPathComponent("logs") }
    /// Which recordings were handed to polycap, and how that went.
    public var handoffLedger: URL { mac.appendingPathComponent("handoff.json") }
}

/// polycap's per-user env file (src/config.ts userConfigFile and readEnvFile): $POLYCAP_CONFIG, else
/// ~/.config/polycap/env. It holds tokens, so only the keys asked for are kept, and one readable or
/// writable by others is refused, as polycap refuses it.
public enum PolycapEnvFile {
    public static func path(environment: [String: String], home: URL) -> URL {
        if let set = environment["POLYCAP_CONFIG"]?.trimmingWhitespace(), !set.isEmpty { return URL(fileURLWithPath: expandTilde(set, home: home)) }
        return home.appendingPathComponent(".config/polycap/env")
    }

    /// KEY=VALUE lines, # comments, one pair of surrounding quotes stripped. A missing file has no values.
    public static func read(_ url: URL, keys: Set<String>, fileManager: FileManager = .default) throws -> [String: String] {
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path) else { return [:] }
        let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
        if mode & 0o077 != 0 { throw FileRuleError("\(url.path) is readable by other users; run chmod 600 \(url.path)") }
        let text = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]
        for (index, raw) in text.components(separatedBy: "\n").enumerated() {
            let line = raw.trimmingWhitespace()
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let equals = line.firstIndex(of: "="), isKey(line[..<equals]) else {
                throw FileRuleError("\(url.path) line \(index + 1) is not KEY=VALUE")
            }
            let key = String(line[..<equals])
            guard keys.contains(key) else { continue }
            var value = String(line[line.index(after: equals)...])
            if value.count >= 2, let first = value.first, first == "\"" || first == "'", value.last == first {
                value = String(value.dropFirst().dropLast())
            }
            values[key] = value
        }
        return values
    }

    /// `^[A-Z][A-Z0-9_]*$`
    static func isKey(_ text: Substring) -> Bool {
        guard let first = text.utf8.first, (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(first) else { return false }
        return text.utf8.allSatisfy { (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains($0) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || $0 == UInt8(ascii: "_") }
    }
}

public func expandTilde(_ path: String, home: URL) -> String {
    if path == "~" { return home.path }
    if path.hasPrefix("~/") { return home.appendingPathComponent(String(path.dropFirst(2))).path }
    return path
}

public struct RecordingFiles: Sendable, Equatable, Hashable, Codable {
    public static let namePrefix = "polydance-mac-"
    public let directory: URL
    /// polydance-mac-20261105-110002
    public let baseName: String

    public init(directory: URL, baseName: String) {
        self.directory = directory.standardizedFileURL
        self.baseName = baseName
    }

    public var video: URL { directory.appendingPathComponent(baseName + ".mp4") }
    public var meta: URL { directory.appendingPathComponent(baseName + ".meta.json") }
    public var videoName: String { baseName + ".mp4" }

    /// `polydance-mac-<yyyymmdd>-<hhmmss>` in local time, the way the headset names its files.
    public static func baseName(for date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        func two(_ n: Int?) -> String { let v = n ?? 0; return v < 10 ? "0\(v)" : "\(v)" }
        return "\(namePrefix)\(c.year ?? 0)\(two(c.month))\(two(c.day))-\(two(c.hour))\(two(c.minute))\(two(c.second))"
    }

    /// The first free name at or after `date`: a second recording within the same second takes the next
    /// second's name, so every name still parses as a time.
    public static func next(in directory: URL, at date: Date, timeZone: TimeZone = .current,
                            exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> RecordingFiles {
        var moment = date
        while true {
            let files = RecordingFiles(directory: directory, baseName: baseName(for: moment, timeZone: timeZone))
            if !exists(files.video) && !exists(files.meta) { return files }
            moment = moment.addingTimeInterval(1)
        }
    }

    /// True for a name this app makes: polydance-mac-yyyymmdd-hhmmss.
    public static func isRecordingBaseName(_ name: String) -> Bool {
        guard name.hasPrefix(namePrefix) else { return false }
        let stamp = Array(name.utf8.dropFirst(namePrefix.utf8.count))
        guard stamp.count == 15, stamp[8] == UInt8(ascii: "-") else { return false }
        return stamp.enumerated().allSatisfy { $0.offset == 8 || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0.element) }
    }

    /// The recording a video file in `directory` belongs to, or nil for any other file.
    public static func forVideo(_ url: URL, in directory: URL) -> RecordingFiles? {
        let standard = url.standardizedFileURL
        guard standard.deletingLastPathComponent().path == directory.standardizedFileURL.path, standard.pathExtension == "mp4" else { return nil }
        let base = standard.deletingPathExtension().lastPathComponent
        return isRecordingBaseName(base) ? RecordingFiles(directory: directory, baseName: base) : nil
    }

    /// Stop and discard: removes this recording's video and metadata and nothing else. Refuses when the
    /// name is not one this app makes or the directory is not the library's recordings folder, so a bad
    /// value can never turn this into a deletion somewhere else. Returns what was removed.
    @discardableResult
    public func discard(recordingsDirectory: URL, fileManager: FileManager = .default) throws -> [URL] {
        try remove([video, meta], recordingsDirectory: recordingsDirectory, fileManager: fileManager)
    }

    /// The first half of a discard, done the moment the user discards: the metadata only, under the same
    /// rules. A video with no metadata is never handed over, so a discarded call cannot come back even
    /// if the app goes away before the rest of the discard runs.
    @discardableResult
    public func discardMetadata(recordingsDirectory: URL, fileManager: FileManager = .default) throws -> [URL] {
        try remove([meta], recordingsDirectory: recordingsDirectory, fileManager: fileManager)
    }

    private func remove(_ urls: [URL], recordingsDirectory: URL, fileManager: FileManager) throws -> [URL] {
        guard directory.path == recordingsDirectory.standardizedFileURL.path else {
            throw FileRuleError("refusing to discard outside \(recordingsDirectory.path)")
        }
        guard Self.isRecordingBaseName(baseName) else { throw FileRuleError("refusing to discard \(baseName): not a recording name") }
        var removed: [URL] = []
        for url in urls where url.deletingLastPathComponent().path == directory.path {
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else { continue }
            guard !isDirectory.boolValue else { throw FileRuleError("refusing to discard \(url.lastPathComponent): it is a folder") }
            try fileManager.removeItem(at: url)
            removed.append(url)
        }
        return removed
    }
}

public struct FileRuleError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Private by default: folders 0700, files 0600, written atomically.
public enum PrivateFiles {
    /// Creates `url` and any missing parents up to `within` as 0700, and tightens `url` itself to 0700.
    /// Folders above `within` (the home folder, the library root polycap made) are never touched.
    public static func makeDirectory(_ url: URL, within: URL, fileManager: FileManager = .default) throws {
        let target = url.standardizedFileURL
        let stop = within.standardizedFileURL.path
        let inside: (URL) -> Bool = { $0.path == stop || $0.path.hasPrefix(stop + "/") }
        guard inside(target) else { throw FileRuleError("\(target.path) is not inside \(stop)") }
        var chain: [URL] = []
        var cursor = target
        while inside(cursor), cursor.path != "/" {
            chain.append(cursor)
            if cursor.path == stop { break }
            cursor = cursor.deletingLastPathComponent()
        }
        for dir in chain.reversed() {
            var isDirectory: ObjCBool = false
            if fileManager.fileExists(atPath: dir.path, isDirectory: &isDirectory) {
                guard isDirectory.boolValue else { throw FileRuleError("\(dir.path) exists and is not a folder") }
                continue
            }
            try fileManager.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
    }

    /// Writes `data` to a temporary 0600 file beside `url`, then renames it over `url`.
    public static func write(_ data: Data, to url: URL) throws {
        let temp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw FileRuleError("cannot create \(temp.lastPathComponent): \(String(cString: strerror(errno)))") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            try handle.write(contentsOf: data)
            try handle.synchronize()
            try handle.close()
        } catch {
            unlink(temp.path)
            throw error
        }
        guard rename(temp.path, url.path) == 0 else {
            let reason = String(cString: strerror(errno))
            unlink(temp.path)
            throw FileRuleError("cannot write \(url.lastPathComponent): \(reason)")
        }
    }

    public static func restrict(_ url: URL, fileManager: FileManager = .default) throws {
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public static func permissions(of url: URL, fileManager: FileManager = .default) -> Int? {
        (try? fileManager.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue
    }
}
