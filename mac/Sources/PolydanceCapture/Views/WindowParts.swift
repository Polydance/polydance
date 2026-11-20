// The Mac's own window pieces: frame thumbnails read off the main thread with ImageIO, and app names from
// the installed apps. The rest of the window's pieces (labels, chips, keys, cards, a thread's row, how times
// are written) are PolydanceShared's Pieces.swift.
import AppKit
import ImageIO
import PolydanceCore
import PolydanceShared
import SwiftUI

/// Frame thumbnails, made with ImageIO off the main thread at the size the grid needs and kept until
/// the file changes (a frame rebuilt with --force keeps its name).
enum Thumbnails {
    private static let cache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 400
        return cache
    }()

    static func image(_ url: URL, maxPixels: Int = 640) async -> NSImage? {
        let stamp = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = "\(url.path)#\(stamp)#\(maxPixels)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let made = await Task.detached(priority: .utility) { () -> CGImage? in
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPixels,
                                            kCGImageSourceCreateThumbnailWithTransform: true]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        }.value
        guard let made else { return nil }
        let image = NSImage(cgImage: made, size: NSSize(width: made.width, height: made.height))
        cache.setObject(image, forKey: key)
        return image
    }
}

struct ThumbnailView: View {
    let url: URL
    var placeholder = ""
    @State private var image: NSImage?
    @State private var missing = false

    var body: some View {
        ZStack {
            Theme.thumb
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                Text(missing ? "no picture" : placeholder).font(Theme.sans(11)).foregroundStyle(Theme.muted)
            }
        }
        .task(id: url) {
            image = await Thumbnails.image(url)
            missing = image == nil
        }
    }
}

/// App names for bundle ids, from the installed app when there is one.
enum AppNames {
    static let known = ["com.apple.MobileSMS": "Messages", "com.apple.mail": "Mail", "com.apple.Passwords": "Passwords"]

    static func name(_ bundleID: String) -> String {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            let name = FileManager.default.displayName(atPath: url.path)
            return name.hasSuffix(".app") ? String(name.dropLast(4)) : name
        }
        return known[bundleID] ?? bundleID
    }
}
