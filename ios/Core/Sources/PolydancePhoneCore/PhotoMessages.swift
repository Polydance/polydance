// Photos from the phone (docs/IPHONE.md, Photos; docs/THREADS.md, Photos; Robin's pick of 2026-11-13, "the
// camera, then choose"): a photo from the camera or the library made ready to send, the requests that send it
// and name it in a message, and the words a new thread is titled by. Kept here, away from the camera and the
// screen, so `swift test` proves them on the Mac without a phone or a network.
//
// Ready to send means what THREADS.md asks of every sender: upright pixels (the orientation tag applied, not
// kept), at most 4096 px a side, JPEG, and no metadata at all, so no location, camera or time leaves the
// phone. ImageIO draws the picture through its orientation into a new image and writes it with nothing but
// its colour profile; the receiver strips it again on arrival. HEIC from the camera or the library becomes
// JPEG here, which the headset and agents can read.
import CryptoKit
import Foundation
import ImageIO
import PolydanceShared
import UniformTypeIdentifiers

/// A photo ready to send: JPEG bytes, upright, with nothing but its picture and colour profile.
public struct PreparedPhoto: Sendable, Equatable {
    public let jpeg: Data
    public let width: Int
    public let height: Int
    /// The sha256 of these bytes, which is the receiver's id for the photo when it needs no stripping.
    public var sha256: String { SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined() }
}

public enum PhotoPrep {
    /// The receiver's own limit (src/photo.ts) on each side.
    public static let maxSide = 4096
    /// At most this many photos in one message (src/photo.ts MAX_PHOTOS).
    public static let maxPhotos = 10

    /// A camera's or the library's photo (JPEG, HEIC, PNG or anything ImageIO reads) as a PreparedPhoto.
    public static func prepare(_ data: Data, maxSide: Int = maxSide, quality: Double = 0.85) throws -> PreparedPhoto {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) > 0 else {
            throw UploadProtocolError("photo", "is not an image this phone can read")
        }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
        let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
        guard width > 0, height > 0 else { throw UploadProtocolError("photo", "has no size") }
        // The picture drawn through its orientation, never larger than it is nor than maxSide.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(max(width, height), maxSide),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw UploadProtocolError("photo", "could not be drawn")
        }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw UploadProtocolError("photo", "could not be written as JPEG")
        }
        // Only the quality: no EXIF, GPS, TIFF or orientation property is written, so none can leave.
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw UploadProtocolError("photo", "could not be written as JPEG") }
        return PreparedPhoto(jpeg: out as Data, width: image.width, height: image.height)
    }

    /// Whether bytes fetched from the receiver are the photo it named.
    public static func matches(_ data: Data, sha256: String) -> Bool {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == sha256
    }
}

/// What the receiver answers a photo sent to it (THREADS.md, Photos): its id is the stripped file's sha256.
public struct PhotoReply: Decodable, Sendable, Equatable {
    public var project: String
    public var sha256: String
    public var type: String
    public var width: Int
    public var height: Int
    public var bytes: Int
}

public enum PhotoMessage {
    /// The longest title the receiver keeps (thread-routes.ts).
    public static let maxTitle = 120
    /// The longest words a message holds.
    public static let maxText = 4000

    /// A new thread's title: the words' first line, else "Photo 13 Nov 19:40" in the phone's own time, so
    /// nothing is made up for it (Robin, 2026-11-13).
    public static func title(words: String, at date: Date, timeZone: TimeZone = .current) -> String {
        if let line = words.split(whereSeparator: \.isNewline).lazy.map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) {
            return line.count <= maxTitle ? line : String(line.prefix(maxTitle - 1)) + "…"
        }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_GB")
        format.timeZone = timeZone
        format.dateFormat = "d MMM HH:mm"
        return "Photo \(format.string(from: date))"
    }

    /// The message's words, or nil when there are none.
    public static func text(_ words: String) -> String? {
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(maxText))
    }
}

/// The photo routes, with the phone's `upload` token (THREADS.md, Receiver API).
public enum PhotoRequests {
    /// POST /v1/projects/:key/photos: a photo for a thread about to be opened in that project.
    public static func send(_ p: Pairing, project: String, _ photo: PreparedPhoto) throws -> URLRequest {
        guard project.wholeMatch(of: /[A-Z][A-Z0-9]{1,9}/) != nil else { throw UploadProtocolError("project", "is not a project key such as MUS") }
        return body(UploadRequests.base(p, "POST", "/v1/projects/\(project)/photos"), photo)
    }

    /// POST /v1/threads/:key/photos: a photo for a message in that thread.
    public static func send(_ p: Pairing, thread key: String, _ photo: PreparedPhoto) throws -> URLRequest {
        body(UploadRequests.base(p, "POST", "/v1/threads/\(try ThreadRequests.checked(key))/photos"), photo)
    }

    /// POST /v1/threads: a new thread whose first message is these photos and the words, if any.
    public static func open(_ p: Pairing, project: String, title: String, text: String?, photos: [String], deliveryId: String) throws -> URLRequest {
        guard project.wholeMatch(of: /[A-Z][A-Z0-9]{1,9}/) != nil else { throw UploadProtocolError("project", "is not a project key such as MUS") }
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...PhotoMessage.maxTitle).contains(title.count) else { throw UploadProtocolError("title", "must be 1 to \(PhotoMessage.maxTitle) characters") }
        var fields: [String: Any] = ["project": project, "title": title]
        try message(&fields, text: text, photos: photos, deliveryId: deliveryId)
        return json(UploadRequests.base(p, "POST", "/v1/threads"), fields)
    }

    /// POST /v1/threads/:key/messages: these photos and the words, if any, in that thread.
    public static func post(_ p: Pairing, thread key: String, text: String?, photos: [String], deliveryId: String) throws -> URLRequest {
        var fields: [String: Any] = [:]
        try message(&fields, text: text, photos: photos, deliveryId: deliveryId)
        return json(UploadRequests.base(p, "POST", "/v1/threads/\(try ThreadRequests.checked(key))/messages"), fields)
    }

    /// GET /v1/threads/:key/photos/:sha256: a photo one of the thread's messages holds.
    public static func fetch(_ p: Pairing, thread key: String, sha256: String) throws -> URLRequest {
        guard UploadProtocol.isSHA256(sha256) else { throw UploadProtocolError("sha256", "must be 64 lowercase hex digits") }
        var r = UploadRequests.base(p, "GET", "/v1/threads/\(try ThreadRequests.checked(key))/photos/\(sha256)")
        r.setValue("image/jpeg, image/png", forHTTPHeaderField: "Accept")
        return r
    }

    /// A new delivery id: a retry of the same send reuses it, so the receiver keeps one message or thread.
    public static func deliveryId() -> String { "iphone-photo-" + UUID().uuidString.lowercased() }

    private static func message(_ fields: inout [String: Any], text: String?, photos: [String], deliveryId: String) throws {
        guard (1...PhotoPrep.maxPhotos).contains(photos.count) else { throw UploadProtocolError("photos", "must be 1 to \(PhotoPrep.maxPhotos) photos") }
        guard photos.allSatisfy(UploadProtocol.isSHA256) else { throw UploadProtocolError("photos", "are named by their sha256, 64 lowercase hex digits") }
        guard Set(photos).count == photos.count else { throw UploadProtocolError("photos", "name each photo once") }
        guard deliveryId.wholeMatch(of: /[A-Za-z0-9_-]{1,128}/) != nil else { throw UploadProtocolError("deliveryId", "must be 1 to 128 letters, digits, underscores or hyphens") }
        fields["photos"] = photos
        fields["deliveryId"] = deliveryId
        if let text = text.flatMap(PhotoMessage.text) { fields["text"] = text }
    }

    private static func body(_ request: URLRequest, _ photo: PreparedPhoto) -> URLRequest {
        var r = request
        r.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        r.setValue(String(photo.jpeg.count), forHTTPHeaderField: "Content-Length")
        r.httpBody = photo.jpeg
        return r
    }

    private static func json(_ request: URLRequest, _ fields: [String: Any]) -> URLRequest {
        var r = request
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        return r
    }
}
