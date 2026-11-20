// The name on a Meet tile. Meet writes each person's name at the bottom left of their tile, white on the
// video; beside a shared screen a long name is cut short with an ellipsis, and the presenter's own label
// can say "(You, presenting)". macOS Vision reads it on the Mac (VNRecognizeTextRequest, accurate), with
// language correction off, since a name is not a dictionary word and correction "fixes" it. Nothing is
// sent anywhere. On the first call's frames Vision read every tile's name exactly (2026-11-11).
import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import Vision

/// A tile's label as a name: cut short or not, and whether Meet said it is the recorder's own tile.
public struct TileName: Equatable, Sendable, Codable {
    public var name: String
    public var truncated: Bool
    public var you: Bool

    public init(name: String, truncated: Bool = false, you: Bool = false) {
        self.name = name
        self.truncated = truncated
        self.you = you
    }
}

public enum TileNames {
    /// Where Meet writes the name: the bottom of the tile (at least 44 px, or 28% of its height), its left 85%.
    public static func labelRegion(of box: TileBox) -> TileBox {
        let height = min(box.height, max(44, Int(Double(box.height) * 0.28)))
        let width = max(1, Int(Double(box.width) * 0.85))
        return TileBox(x: box.x, y: box.maxY - height + 1, width: width, height: height)
    }

    /// Meet's label as a name, or nil when it is not one: "(You…)" and a trailing ellipsis taken off and
    /// said, stray marks at the start taken off (Vision put a quote mark before a name on the first call), spaces
    /// collapsed; no letter, or longer than 80 characters, is not a name.
    public static func clean(_ raw: String) -> TileName? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while let first = text.unicodeScalars.first, !CharacterSet.letters.contains(first) { text.unicodeScalars.removeFirst() }
        var you = false
        if let paren = text.range(of: "(You", options: [.caseInsensitive]) {
            you = true
            text = String(text[..<paren.lowerBound])
        }
        var truncated = false
        for tail in ["…", "...", ".."] where text.hasSuffix(tail) {
            truncated = true
            text = String(text.dropLast(tail.count))
            break
        }
        var words = text.split(whereSeparator: \.isWhitespace)
        // An icon read as a lone small letter before the name ("e Grace Hopper" for a name in a speaking pill).
        if words.count > 1, let first = words.first, first.count == 1, first.first?.isLowercase == true { words.removeFirst() }
        text = words.joined(separator: " ")
        guard !text.isEmpty, text.count <= 80, text.unicodeScalars.contains(where: CharacterSet.letters.contains) else { return nil }
        return TileName(name: text, truncated: truncated, you: you)
    }

    /// One context for every crop: making a CIContext costs more than reading a name.
    static let context = CIContext(options: [.useSoftwareRenderer: false])

    /// A label region with a few pixels around it, cut out and enlarged so the text is about 50 px tall:
    /// beside a shared screen Meet's names are about 12 px, and Vision dropped the first letters of one
    /// (seven letters of a nine-letter cut-short name) read in place on the first call (2026-11-11).
    static func labelImage(_ frame: CIImage, label: TileBox, width: Int, height: Int) -> CGImage? {
        let x0 = max(0, label.x - 8), x1 = min(width, label.maxX + 5)
        let y0 = max(0, label.y - 4), y1 = min(height, label.maxY + 6)
        guard x1 > x0, y1 > y0 else { return nil }
        // Core Image's origin is the bottom left.
        let crop = CGRect(x: x0, y: height - y1, width: x1 - x0, height: y1 - y0)
        let scale = max(1, min(4, 150 / Double(y1 - y0)))
        let image = frame.cropped(to: crop)
            .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return context.createCGImage(image, from: CGRect(x: 0, y: 0, width: crop.width * scale, height: crop.height * scale))
    }

    /// The name written in `label` (a tile's bottom left, or a speaking pill), or nil when none is there.
    /// Of the text Vision finds, the lowest line starting in the region's left third.
    static func read(_ frame: CIImage, label: TileBox, width: Int, height: Int) throws -> TileName? {
        guard let image = labelImage(frame, label: label, width: width, height: height) else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let lines = (request.results ?? [])
            .filter { $0.boundingBox.minX < 0.34 }
            .sorted { $0.boundingBox.minY < $1.boundingBox.minY }
        for line in lines {
            guard let best = line.topCandidates(1).first, best.confidence >= 0.3, let name = clean(best.string) else { continue }
            return name
        }
        return nil
    }

    public static func read(_ pixelBuffer: CVPixelBuffer, label: TileBox) throws -> TileName? {
        try read(CIImage(cvPixelBuffer: pixelBuffer), label: label, width: CVPixelBufferGetWidth(pixelBuffer), height: CVPixelBufferGetHeight(pixelBuffer))
    }

    public static func read(_ image: CGImage, label: TileBox) throws -> TileName? {
        try read(CIImage(cgImage: image), label: label, width: image.width, height: image.height)
    }

    /// The name at the bottom left of a tile.
    public static func read(_ pixelBuffer: CVPixelBuffer, box: TileBox) throws -> TileName? { try read(pixelBuffer, label: labelRegion(of: box)) }
    public static func read(_ image: CGImage, box: TileBox) throws -> TileName? { try read(image, label: labelRegion(of: box)) }
}
