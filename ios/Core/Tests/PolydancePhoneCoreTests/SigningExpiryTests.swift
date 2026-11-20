// When a development build stops launching (SigningExpiry): the earlier of the profile's date and its
// developer certificate's. The certificate below is a throwaway self-signed one made for this test on
// 2026-11-06 (CN "Polydance test certificate", valid 9 March 2026 to 9 March 2027 11:07:41 UTC, the same
// end as the developer certificate in this Mac's profiles); its private key was never kept.
import Foundation
import Testing
@testable import PolydancePhoneCore

@Suite struct SigningExpiryTests {
    static let certificate = Data(base64Encoded: """
    MIIBoDCCAUWgAwIBAgIUJQZ2qB1Vq142Ul2n7hSN9Sruoi8wCgYIKoZIzj0EAwIwJTEjMCEGA1UEAwwaUG9seWRhbmNlIHRlc3QgY2VydGlmaWNhdGUw\
    HhcNMjYwMzA5MTEwNzQxWhcNMjcwMzA5MTEwNzQxWjAlMSMwIQYDVQQDDBpQb2x5ZGFuY2UgdGVzdCBjZXJ0aWZpY2F0ZTBZMBMGByqGSM49AgEGCCqG\
    SM49AwEHA0IABFR2M8P979sQLRMrZM9ui9Kuey9D7MrlbODtvhYbJoSY19ZFH5uo6qnp/yS0shRKB8CzcaUrOwk78niOUg7u7XqjUzBRMB0GA1UdDgQW\
    BBT2vLeUyKrcu0TtfCnKAJPRWtg48DAfBgNVHSMEGDAWgBT2vLeUyKrcu0TtfCnKAJPRWtg48DAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kA\
    MEYCIQCj4cNnl6le29SyTskT9BB8OULMhI5y9u6FYsyK5fxAKAIhANx1i5PIUcQyYtPbcN7wDJ4HhBpetejOZqcYDnzCL2Bb
    """)!
    /// 2027-03-09T11:07:41Z
    static let certificateEnd = Date(timeIntervalSince1970: 1_804_590_461)
    static let day = 86_400.0

    @Test func readsTheCertificatesEnd() throws {
        #expect(try SigningExpiry.notValidAfter(Self.certificate) == Self.certificateEnd)
    }

    @Test func aProfileThatOutlivesItsCertificateStopsWithTheCertificate() throws {
        // As Xcode made them on this Mac: created 22 May 2026, expiring a year later.
        let profile = Self.certificateEnd.addingTimeInterval(74 * Self.day)
        let expiry = try SigningExpiry(profile: profile, certificateDERs: [Self.certificate])
        #expect(expiry.first == Self.certificateEnd)
        #expect(expiry.cause == .certificate)
        #expect(expiry.daysLeft(now: Self.certificateEnd.addingTimeInterval(-10.5 * Self.day)) == 10)
        #expect(expiry.daysLeft(now: Self.certificateEnd.addingTimeInterval(Self.day)) < 0)
    }

    @Test func aProfileThatEndsFirstStopsWithTheProfile() throws {
        let profile = Self.certificateEnd.addingTimeInterval(-120 * Self.day)
        let expiry = try SigningExpiry(profile: profile, certificateDERs: [Self.certificate, Self.certificate])
        #expect(expiry.first == profile)
        #expect(expiry.cause == .profile)
        #expect(expiry.certificate == Self.certificateEnd)
    }

    @Test func noCertificateOrABadOneIsRefused() {
        #expect(throws: SigningExpiryError("the profile lists no DeveloperCertificates")) {
            try SigningExpiry(profile: Self.certificateEnd, certificateDERs: [])
        }
        #expect(throws: SigningExpiryError("a DeveloperCertificates entry is not a certificate")) {
            try SigningExpiry(profile: Self.certificateEnd, certificateDERs: [Self.certificate, Data("not a certificate".utf8)])
        }
    }
}
