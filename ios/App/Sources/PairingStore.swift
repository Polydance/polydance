// The phone's pairing with a receiver (docs/IPHONE.md P2, P3), kept in the Keychain only: one item,
// readable after first unlock and on this device only (PairingKeychain), so an upload or a refresh with the
// phone locked can use it and a backup never carries it. It arrives by the QR code (PairScreen), or as a
// file copied into Application Support over USB: `npm run ios -- configure` writes pairing.json, and the I0
// probe's probe-config.json has the same shape. Such a file is taken in once at launch, checked strictly,
// put in the Keychain and deleted; a file that is refused stays, and the log and the settings say why.
// Nothing here logs the token, and the server is logged by whether it is local, never by name.
import Foundation
import PolydancePhoneCore
import Security

@MainActor
final class PairingStore: ObservableObject {
    /// What the phone is paired with, nil when it is not (or the Keychain could not be read yet).
    @Published private(set) var pairing: Pairing?
    /// Why the last pairing file or Keychain read was refused, for the settings.
    @Published private(set) var problem: String?

    private let log: EventLog
    private let files: [URL]
    /// The Keychain was locked (a launch before the first unlock): read it again when next asked.
    private var locked = false

    /// `root` is Application Support, where `configure` copies pairing.json (and I0 copied probe-config.json).
    init(log: EventLog, root: URL) {
        self.log = log
        files = ["pairing.json", "probe-config.json"].map { root.appendingPathComponent($0) }
        load()
    }

    /// Reads the Keychain, then takes in a pairing file if one was copied over USB (it replaces what was there).
    func load() {
        problem = nil
        locked = false
        switch Self.read() {
        case .success(let found): pairing = found
        case .failure(let why):
            pairing = nil
            problem = why.text
            locked = why.locked
            log.write("pair.read", ["ok": false, "reason": why.text, "appState": ProbeAppState.current()])
        }
        for file in files where FileManager.default.fileExists(atPath: file.path) { adopt(file) }
    }

    /// The pairing now, reading the Keychain again if it was locked when last read.
    func current() -> Pairing? {
        if pairing == nil, locked { load() }
        return pairing
    }

    /// Keeps a pairing the phone has checked with the receiver.
    func save(_ new: Pairing, how: String) throws {
        try Self.write(new)
        pairing = new
        problem = nil
        log.write("pair.saved", ["how": how, "local": new.isLocal, "scheme": new.server.scheme ?? "", "appState": ProbeAppState.current()])
    }

    /// Unpair: the Keychain item goes; takes stay on the phone.
    func forget() {
        SecItemDelete(PairingKeychain.match as CFDictionary)
        pairing = nil
        log.write("pair.forget", ["appState": ProbeAppState.current()])
    }

    private func adopt(_ file: URL) {
        do {
            let found = try Pairing.load(file)
            try save(found, how: file.lastPathComponent)
            try FileManager.default.removeItem(at: file)
        } catch {
            let why = (error as? UploadProtocolError)?.description ?? ErrorWords.describe(error)
            problem = "\(file.lastPathComponent) was not taken: \(why)"
            log.write("pair.adopt", ["ok": false, "file": file.lastPathComponent, "reason": why, "appState": ProbeAppState.current()])
        }
    }

    // MARK: The Keychain

    private struct ReadFailure: Error {
        let text: String
        var locked = false
    }

    private static func read() -> Result<Pairing?, ReadFailure> {
        var out: CFTypeRef?
        let status = SecItemCopyMatching(PairingKeychain.read as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data else { return .failure(ReadFailure(text: "the Keychain item holds no data")) }
            do { return .success(try Pairing.decode(data, source: "the Keychain item")) }
            catch { return .failure(ReadFailure(text: (error as? UploadProtocolError)?.description ?? "the Keychain item does not decode")) }
        case errSecItemNotFound: return .success(nil)
        // Before the first unlock after a restart: not unpaired, only unreadable for now.
        case errSecInteractionNotAllowed: return .failure(ReadFailure(text: "the Keychain is locked until the phone is first unlocked", locked: true))
        // An unsigned build (the Simulator's, ios/build.sh sim) has no keychain access group at all.
        case errSecMissingEntitlement: return .failure(ReadFailure(text: "this build is unsigned (as in the Simulator), so it has no Keychain"))
        default: return .failure(ReadFailure(text: "the Keychain answered \(status)"))
        }
    }

    private static func write(_ pairing: Pairing) throws {
        let attributes = PairingKeychain.attributes(pairing)
        var status = SecItemUpdate(PairingKeychain.match as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(PairingKeychain.match.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "the Keychain refused the pairing (\(status))"])
        }
    }
}
