// Photos from the phone (PhotoMessages.swift; Robin's pick of 2026-11-13): a camera's photo, tagged as turned
// and carrying a location, leaves upright, within 4096 px, as JPEG with nothing but its picture; the requests
// are the receiver's routes with the phone's token; a new thread is titled by the words or the time. The
// photos are drawn here with CoreGraphics, so nothing is from a real camera. No network.
import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import PolydancePhoneCore

private let token = "polycap_" + String(repeating: "cd", count: 32)
private let pairing = try! Pairing(server: "https://capture.polydance.net", token: token)

/// A width x height picture, left half red and right half blue, written as `type` with `properties`.
private func picture(_ width: Int, _ height: Int, type: UTType = .jpeg, properties: [CFString: Any] = [:]) throws -> Data {
    let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                         space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
    context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
    context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
    let image = try #require(context.makeImage())
    let out = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    #expect(CGImageDestinationFinalize(destination))
    return out as Data
}

private func properties(_ data: Data) throws -> [CFString: Any] {
    let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
    return try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
}

private func json(_ data: Data?) throws -> NSDictionary {
    let bytes = try #require(data)
    return try #require(JSONSerialization.jsonObject(with: bytes) as? NSDictionary)
}

@Suite struct PhotoPrepTests {
    /// What a phone's camera writes: turned a quarter (orientation 6), with where and with what it was taken.
    private let tagged: [CFString: Any] = [
        kCGImagePropertyOrientation: 6,
        kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 51.5, kCGImagePropertyGPSLatitudeRef: "N",
                                        kCGImagePropertyGPSLongitude: 0.12, kCGImagePropertyGPSLongitudeRef: "W"],
        kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "MadeUpCam", kCGImagePropertyTIFFModel: "Model Z"],
        kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2026:11:13 19:40:00", kCGImagePropertyExifUserComment: "made-up comment"],
    ]

    @Test func aTurnedPhotoLeavesUprightWithNothingButItsPicture() throws {
        let camera = try picture(64, 32, properties: tagged)
        #expect(try properties(camera)[kCGImagePropertyGPSDictionary] != nil)
        let ready = try PhotoPrep.prepare(camera)
        // Turned a quarter: 64 x 32 becomes 32 x 64 in its pixels, and no orientation is left to apply.
        #expect((ready.width, ready.height) == (32, 64))
        let after = try properties(ready.jpeg)
        #expect((after[kCGImagePropertyPixelWidth] as? Int, after[kCGImagePropertyPixelHeight] as? Int) == (32, 64))
        #expect((after[kCGImagePropertyOrientation] as? Int ?? 1) == 1)
        #expect(after[kCGImagePropertyGPSDictionary] == nil)
        #expect((after[kCGImagePropertyTIFFDictionary] as? [CFString: Any])?[kCGImagePropertyTIFFMake] == nil)
        #expect((after[kCGImagePropertyExifDictionary] as? [CFString: Any])?[kCGImagePropertyExifDateTimeOriginal] == nil)
        for secret in ["MadeUpCam", "Model Z", "made-up comment", "2026:11:13"] {
            #expect(ready.jpeg.range(of: Data(secret.utf8)) == nil, "\(secret) left the phone")
        }
        #expect(ready.jpeg.prefix(2) == Data([0xFF, 0xD8]))
        #expect(ready.sha256.count == 64 && PhotoPrep.matches(ready.jpeg, sha256: ready.sha256))
        #expect(!PhotoPrep.matches(camera, sha256: ready.sha256))
    }

    @Test func aLargePhotoIsScaledToTheReceiversLimitAndASmallOneIsNotEnlarged() throws {
        let wide = try PhotoPrep.prepare(try picture(5000, 100))
        #expect((wide.width, wide.height) == (4096, 82))
        let small = try PhotoPrep.prepare(try picture(30, 20, type: .png))
        #expect((small.width, small.height) == (30, 20))
        #expect(try properties(small.jpeg)[kCGImagePropertyColorModel] != nil)
        #expect(throws: UploadProtocolError.self) { try PhotoPrep.prepare(Data("not a photo".utf8)) }
    }
}

@Suite struct PhotoMessageTests {
    private let evening = ISO8601DateFormatter().date(from: "2026-11-13T19:40:00Z")!

    @Test func aNewThreadIsTitledByTheWordsFirstLineElseByTheTime() {
        #expect(PhotoMessage.title(words: "\n  The shelf  \nleft side", at: evening) == "The shelf")
        #expect(PhotoMessage.title(words: "", at: evening, timeZone: TimeZone(identifier: "Europe/London")!) == "Photo 13 Nov 19:40")
        #expect(PhotoMessage.title(words: " \n ", at: evening, timeZone: TimeZone(identifier: "Asia/Tokyo")!) == "Photo 14 Nov 04:40")
        let long = PhotoMessage.title(words: String(repeating: "a", count: 200), at: evening)
        #expect(long.count == 120 && long.hasSuffix("…"))
        #expect(PhotoMessage.text("  \n ") == nil)
        #expect(PhotoMessage.text(" The shelf\nleft side \n") == "The shelf\nleft side")
    }
}

@Suite struct PhotoRequestTests {
    private let photo = PreparedPhoto(jpeg: Data([0xFF, 0xD8, 0xFF, 0xD9]), width: 1, height: 1)
    private let a = String(repeating: "a", count: 64), b = String(repeating: "b", count: 64)

    @Test func aPhotoIsSentWholeAsJPEGToItsProjectOrThread() throws {
        let toProject = try PhotoRequests.send(pairing, project: "SPOT", photo)
        #expect(toProject.httpMethod == "POST")
        #expect(toProject.url?.absoluteString == "https://capture.polydance.net/v1/projects/SPOT/photos")
        #expect(toProject.value(forHTTPHeaderField: "Content-Type") == "image/jpeg")
        #expect(toProject.value(forHTTPHeaderField: "Content-Length") == "4")
        #expect(toProject.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
        #expect(toProject.httpBody == photo.jpeg)
        #expect(try PhotoRequests.send(pairing, thread: "SPOT-2", photo).url?.path == "/v1/threads/SPOT-2/photos")
        #expect(throws: UploadProtocolError.self) { try PhotoRequests.send(pairing, project: "spot", photo) }
        #expect(throws: UploadProtocolError.self) { try PhotoRequests.send(pairing, thread: "../tokens", photo) }
        #expect(try PhotoRequests.fetch(pairing, thread: "SPOT-2", sha256: a).url?.path == "/v1/threads/SPOT-2/photos/\(a)")
        #expect(throws: UploadProtocolError.self) { try PhotoRequests.fetch(pairing, thread: "SPOT-2", sha256: "../x") }
    }

    @Test func aThreadOpensOrAMessageIsPostedWithThePhotosWordsAndADelivery() throws {
        let opened = try PhotoRequests.open(pairing, project: "SPOT", title: "The shelf", text: "The shelf\nleft side", photos: [a, b], deliveryId: "iphone-photo-1")
        #expect(opened.url?.path == "/v1/threads")
        #expect(try json(opened.httpBody) == ["project": "SPOT", "title": "The shelf", "text": "The shelf\nleft side", "photos": [a, b], "deliveryId": "iphone-photo-1"])
        let posted = try PhotoRequests.post(pairing, thread: "SPOT-2", text: "  ", photos: [a], deliveryId: "iphone-photo-2")
        #expect(posted.url?.path == "/v1/threads/SPOT-2/messages")
        #expect(try json(posted.httpBody) == ["photos": [a], "deliveryId": "iphone-photo-2"])
        #expect(throws: UploadProtocolError.self) { try PhotoRequests.post(pairing, thread: "SPOT-2", text: nil, photos: [], deliveryId: "d") }
        #expect(throws: UploadProtocolError.self) { try PhotoRequests.post(pairing, thread: "SPOT-2", text: nil, photos: [a, a], deliveryId: "d") }
        #expect(throws: UploadProtocolError.self) { try PhotoRequests.post(pairing, thread: "SPOT-2", text: nil, photos: Array(repeating: a, count: 11), deliveryId: "d") }
        #expect(throws: UploadProtocolError.self) { try PhotoRequests.post(pairing, thread: "SPOT-2", text: nil, photos: [a], deliveryId: "bad id!") }
        #expect(throws: UploadProtocolError.self) { try PhotoRequests.open(pairing, project: "SPOT", title: " ", text: nil, photos: [a], deliveryId: "d") }
        #expect(PhotoRequests.deliveryId().hasPrefix("iphone-photo-"))
        #expect(PhotoRequests.deliveryId() != PhotoRequests.deliveryId())
    }

    @Test func theReceiversAnswerDecodes() throws {
        let reply = try ReceiverReply.decode(PhotoReply.self, status: 201, body: Data(#"{"project":"SPOT","sha256":"\#(a)","type":"image/jpeg","width":3024,"height":4032,"bytes":2100000}"#.utf8), what: "a photo")
        #expect(reply.sha256 == a && reply.width == 3024)
        #expect(throws: ReceiverError(status: 403, reason: "posting words needs scope post")) {
            try ReceiverReply.decode(PhotoReply.self, status: 403, body: Data(#"{"error":"posting words needs scope post"}"#.utf8), what: "a photo")
        }
    }
}
