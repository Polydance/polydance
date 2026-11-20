// When a development-signed build stops launching (docs/IPHONE.md I0 question 6, S6): the earlier of the
// provisioning profile's ExpirationDate and the end of its developer certificates, since a profile whose
// certificate has expired no longer signs anything. On this Mac on 2026-11-06 every profile Xcode made
// lasts a year while its certificate ends on 9 March 2027, so the profile's own date alone overstates the
// time left. Here, not in the app, so `swift test` proves it. Strict: a profile with no certificate, or
// one that does not decode, is an error rather than a guess.
import Foundation
import Security

public struct SigningExpiryError: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public struct SigningExpiry: Sendable, Equatable {
    public enum Cause: String, Sendable { case profile, certificate }

    /// The profile's ExpirationDate.
    public let profile: Date
    /// The earliest notAfter of the profile's DeveloperCertificates.
    public let certificate: Date

    public init(profile: Date, certificate: Date) {
        self.profile = profile
        self.certificate = certificate
    }

    /// From the profile's ExpirationDate and its DeveloperCertificates (DER).
    public init(profile: Date, certificateDERs: [Data]) throws {
        guard !certificateDERs.isEmpty else { throw SigningExpiryError("the profile lists no DeveloperCertificates") }
        var earliest: Date?
        for der in certificateDERs {
            let end = try Self.notValidAfter(der)
            earliest = min(earliest ?? end, end)
        }
        self.init(profile: profile, certificate: earliest!)
    }

    /// The day the app stops launching.
    public var first: Date { min(profile, certificate) }
    /// Which date that is; the profile's when both are the same.
    public var cause: Cause { certificate < profile ? .certificate : .profile }

    /// Whole days until `first`, rounded down; negative once it has passed.
    public func daysLeft(now: Date = Date()) -> Int {
        Int((first.timeIntervalSince(now) / 86_400).rounded(.down))
    }

    /// One DER certificate's notAfter.
    public static func notValidAfter(_ der: Data) throws -> Date {
        guard let certificate = SecCertificateCreateWithData(nil, der as CFData) else {
            throw SigningExpiryError("a DeveloperCertificates entry is not a certificate")
        }
        guard let date = SecCertificateCopyNotValidAfterDate(certificate) else {
            throw SigningExpiryError("a developer certificate has no end date")
        }
        return date as Date
    }
}
