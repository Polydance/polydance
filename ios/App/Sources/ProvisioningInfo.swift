// The app's own provisioning profile (embedded.mobileprovision; docs/IPHONE.md I0 and S6): when it was
// made and when the app stops launching, the earlier of the profile's ExpirationDate and its developer
// certificate's end (PolydancePhoneCore's SigningExpiry). The plan assumed the free team's 7 days, but the
// profiles Xcode made for this team on this Mac last a year while their certificate ends on 9 March 2027,
// so I0 reads both on the phone. The file is a CMS (PKCS #7) envelope around an XML plist: the plist's
// bytes are found and parsed, strictly, with no signature check (iOS checked it to launch the app). The
// devices it lists are never read out, only whether the list exists, so no UDID reaches the log or the
// screen; nor is the team's name, which for a personal team is the person's.
import Foundation
import PolydancePhoneCore

struct ProvisioningInfo: Equatable, Sendable {
    var name: String
    var teamIdentifier: String
    var creationDate: Date
    /// The profile's ExpirationDate and its certificates' end.
    var expiry: SigningExpiry
    /// Whether the profile lists devices (a development profile does; an App Store one does not).
    var hasProvisionedDevices: Bool

    enum Reading: Equatable, Sendable {
        case present(ProvisioningInfo)
        /// No profile in the app: "simulator" there, otherwise the reason.
        case absent(String)
        case unreadable(String)
    }

    enum ParseError: Error, CustomStringConvertible {
        case noPlist
        case notADictionary
        case missing(String)
        case certificate(String)

        var description: String {
            switch self {
            case .noPlist: "no plist inside embedded.mobileprovision"
            case .notADictionary: "the profile's plist is not a dictionary"
            case .missing(let key): "the profile has no \(key) of the expected type"
            case .certificate(let why): why
            }
        }
    }

    static func read(bundle: Bundle = .main) -> Reading {
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision") else {
            #if targetEnvironment(simulator)
            return .absent("simulator")
            #else
            return .absent("the app has no embedded.mobileprovision")
            #endif
        }
        do {
            return .present(try parse(Data(contentsOf: url)))
        } catch let error as ParseError {
            return .unreadable(error.description)
        } catch {
            return .unreadable((error as NSError).localizedDescription)
        }
    }

    static func parse(_ data: Data) throws -> ProvisioningInfo {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.upperBound..<data.endIndex) else {
            throw ParseError.noPlist
        }
        let plist = try PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil)
        guard let dict = plist as? [String: Any] else { throw ParseError.notADictionary }

        func value<T>(_ key: String, as _: T.Type) throws -> T {
            guard let v = dict[key] as? T else { throw ParseError.missing(key) }
            return v
        }
        guard let team = try value("TeamIdentifier", as: [String].self).first, !team.isEmpty else {
            throw ParseError.missing("TeamIdentifier")
        }
        let expiry: SigningExpiry
        do {
            expiry = try SigningExpiry(profile: try value("ExpirationDate", as: Date.self),
                                       certificateDERs: try value("DeveloperCertificates", as: [Data].self))
        } catch let error as SigningExpiryError {
            throw ParseError.certificate(error.message)
        }
        return ProvisioningInfo(
            name: try value("Name", as: String.self),
            teamIdentifier: team,
            creationDate: try value("CreationDate", as: Date.self),
            expiry: expiry,
            hasProvisionedDevices: dict["ProvisionedDevices"] != nil
        )
    }

    /// The profile event's fields: dates in ISO 8601, no device list and no team name.
    func logFields(now: Date = Date()) -> [String: any Sendable] {
        [
            "name": name,
            "teamId": teamIdentifier,
            "created": EventLog.timestamp(creationDate),
            "expires": EventLog.timestamp(expiry.profile),
            "certificateExpires": EventLog.timestamp(expiry.certificate),
            // The day the app is expected to stop launching, and which of the two it is.
            "stopsLaunching": EventLog.timestamp(expiry.first),
            "stopsBecause": expiry.cause.rawValue,
            "daysLeft": expiry.daysLeft(now: now),
            "provisionedDevices": hasProvisionedDevices,
        ]
    }
}
