// Pairing the phone with a receiver (docs/IPHONE.md P2, P3): the receiver's address and the phone's
// `upload` token, as strict JSON, `{"v":1,"server":"https://capture.polydance.net","token":"…"}`. The same
// payload comes three ways: the QR code `npm run ios -- pair` draws on the Mac, the file `npm run ios --
// configure` copies into the app's container over USB, and the I0 probe's probe-config.json, which the app
// takes in once. Wherever it comes from it is checked here, refused with the field named, and then kept in
// the Keychain only (PairingKeychain: after first unlock, this device only), so a backup never carries it.
// Plain http reaches only this Mac's .local name, localhost or 127.0.0.1 (the local receiver of
// ios/tools/serve-local.sh); anything else must be https. The token is never part of a description, a
// mirror or an error.
import Foundation
import Security

public struct Pairing: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public static let version = 1
    public static let keys: Set<String> = ["v", "server", "token"]
    /// More than any pairing holds: a QR code or file that is larger is refused unread.
    public static let maxBytes = 2048

    /// scheme://host[:port], lowercased, with no path, query or fragment.
    public let server: URL
    public let token: String

    public init(server: String, token: String) throws {
        self.server = try Self.checkServer(server)
        self.token = try Self.checkToken(token)
    }

    /// Strict: an unknown key, a missing one, `v` other than 1 or a value of the wrong type is refused, and
    /// the error names the field. `source` names what was read when it is not JSON at all ("the code",
    /// "pairing.json").
    public static func decode(_ data: Data, source: String = "the pairing") throws -> Pairing {
        guard data.count <= maxBytes else { throw UploadProtocolError(source, "is larger than a pairing (\(maxBytes) bytes at most)") }
        do {
            return try JSONDecoder().decode(Wire.self, from: data).pairing
        } catch let error as UploadProtocolError {
            throw error
        } catch DecodingError.dataCorrupted {
            throw UploadProtocolError(source, "is not JSON")
        } catch {
            throw UploadProtocolError(source, "is not a JSON object")
        }
    }

    /// Reads and decodes a file; a missing file says so.
    public static func load(_ url: URL) throws -> Pairing {
        let name = url.lastPathComponent
        guard FileManager.default.fileExists(atPath: url.path) else { throw UploadProtocolError(name, "is missing") }
        return try decode(Data(contentsOf: url), source: name)
    }

    /// The JSON the Keychain keeps, keys sorted, which `decode` reads back.
    public func json() -> Data {
        let object: [String: Any] = ["v": Self.version, "server": server.absoluteString, "token": token]
        // A dictionary of a number and two strings always serialises.
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    /// The URL of a receiver route such as "/v1/uploads".
    public func endpoint(_ path: String) -> URL { URL(string: server.absoluteString + path)! }

    /// "capture.polydance.net", or "mac.local:8790", for the screen.
    public var place: String { (server.host ?? "") + (server.port.map { ":\($0)" } ?? "") }

    /// Whether the receiver is on this network (plain http to this Mac): what the local-network prompt is about.
    public var isLocal: Bool { server.scheme == "http" }

    /// The receiver's address with no token, for logs and the screen.
    public var description: String { "Pairing(server: \(server.absoluteString), token: <redacted>)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: ["server": server, "token": "<redacted>"]) }

    static func checkServer(_ text: String) throws -> URL {
        guard let c = URLComponents(string: text), let scheme = c.scheme?.lowercased(), let rawHost = c.host, !rawHost.isEmpty else {
            throw UploadProtocolError("server", "is not a URL such as https://capture.example.net")
        }
        let host = rawHost.lowercased()
        guard c.user == nil, c.password == nil else { throw UploadProtocolError("server", "must not carry a user or password") }
        guard c.query == nil else { throw UploadProtocolError("server", "must not have a query") }
        guard c.fragment == nil else { throw UploadProtocolError("server", "must not have a fragment") }
        guard c.path.isEmpty || c.path == "/" else { throw UploadProtocolError("server", "must have no path beyond /") }
        let isIPv4Loopback = host == "127.0.0.1"
        guard isIPv4Loopback || host.wholeMatch(of: /[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*/) != nil else {
            throw UploadProtocolError("server", "host must be a name such as mac.local, or 127.0.0.1")
        }
        if let port = c.port, !(1...65535).contains(port) { throw UploadProtocolError("server", "port must be 1 to 65535") }
        switch scheme {
        case "https": break
        case "http":
            guard isIPv4Loopback || host == "localhost" || host.hasSuffix(".local") else {
                throw UploadProtocolError("server", "may be http only for a .local host, localhost or 127.0.0.1; use https")
            }
        default:
            throw UploadProtocolError("server", "must be http or https")
        }
        var out = URLComponents()
        out.scheme = scheme
        out.host = host
        out.port = c.port
        guard let url = out.url else { throw UploadProtocolError("server", "is not a URL") }
        return url
    }

    static func checkToken(_ token: String) throws -> String {
        guard !token.isEmpty else { throw UploadProtocolError("token", "is empty") }
        guard token.count <= 512 else { throw UploadProtocolError("token", "is longer than 512 characters") }
        // It goes into an HTTP header: visible ASCII only, so no space, newline or control character.
        guard token.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7F }) else {
            throw UploadProtocolError("token", "must be printable ASCII with no whitespace")
        }
        return token
    }

    private struct Wire: Decodable {
        let pairing: Pairing

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self)
            if let extra = c.allKeys.map(\.stringValue).filter({ !Pairing.keys.contains($0) }).sorted().first {
                throw UploadProtocolError(extra, "is not a key of a pairing (v, server, token)")
            }
            let v = try field(c, "v", Int.self, "the number 1")
            guard v == Pairing.version else { throw UploadProtocolError("v", "is \(v), not \(Pairing.version)") }
            pairing = try Pairing(server: field(c, "server", String.self, "a string"), token: field(c, "token", String.self, "a string"))
        }
    }
}

/// Decodes one key, turning a decoding error into one that names the field and never echoes its value.
/// JSONDecoder reads `true` as no Int and "1" as no Int, so `v` must be the number itself.
func field<T: Decodable>(_ c: KeyedDecodingContainer<AnyKey>, _ key: String, _ type: T.Type, _ expected: String) throws -> T {
    let k = AnyKey(key)
    guard c.contains(k) else { throw UploadProtocolError(key, "is missing") }
    do { return try c.decode(T.self, forKey: k) } catch { throw UploadProtocolError(key, "must be \(expected)") }
}

/// Where the phone keeps its pairing (P3): one generic password item, readable once the phone has been
/// unlocked after it started (so a refresh or an upload with the phone locked can use it), on this device
/// only and never synchronised, so neither a backup nor iCloud Keychain carries the token. The app does the
/// reading and writing; these are the attributes, so a test can check them.
public enum PairingKeychain {
    public static let service = "net.polydance.capture.iphone.receiver"
    public static let account = "pairing"

    /// What finds the item.
    public static var match: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    /// The item's protection and value, for an add or an update.
    public static func attributes(_ pairing: Pairing) -> [String: Any] {
        [
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
            kSecAttrLabel as String: "Polydance receiver",
            kSecValueData as String: pairing.json(),
        ]
    }

    /// The query that reads the value back.
    public static var read: [String: Any] {
        match.merging([kSecReturnData as String: kCFBooleanTrue as Any, kSecMatchLimit as String: kSecMatchLimitOne]) { $1 }
    }
}
