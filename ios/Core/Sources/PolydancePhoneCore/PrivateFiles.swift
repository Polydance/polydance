// Private by default (CLAUDE.md): directories this app makes are 0700 and files 0600. On the phone files
// are also protected until first unlock, the strongest class a background upload can still read while
// the phone is locked (docs/IPHONE.md V1).
import Foundation

public enum PrivateFiles {
    public static func directory(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: attributes(0o700))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    /// Writes `data` atomically and leaves the file 0600.
    public static func write(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: protectedWrite)
        try FileManager.default.setAttributes(attributes(0o600), ofItemAtPath: url.path)
    }

    /// Creates an empty file (0600) unless one exists, for files that are appended to.
    public static func touch(_ url: URL) throws {
        if !FileManager.default.fileExists(atPath: url.path) {
            guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: attributes(0o600)) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
            }
        }
    }

    /// Applies 0600 (and the phone's protection class) to a file another API wrote, such as AVAssetWriter's.
    public static func seal(_ url: URL) throws {
        try FileManager.default.setAttributes(attributes(0o600), ofItemAtPath: url.path)
    }

    static func attributes(_ mode: Int) -> [FileAttributeKey: Any] {
        var a: [FileAttributeKey: Any] = [.posixPermissions: mode]
        #if os(iOS)
        a[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        return a
    }

    static var protectedWrite: Data.WritingOptions {
        #if os(iOS)
        [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        [.atomic]
        #endif
    }
}
