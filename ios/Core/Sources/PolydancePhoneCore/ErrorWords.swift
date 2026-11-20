// A few words for an error, for the screen and the event log: what a decoder or the file system said, in
// the plain words the rest of the app uses. Shared by the iPhone's and the Vision Pro's app code (it was
// ProbeModel.describe until the Vision Pro needed it too, docs/VISIONOS.md); never a token or a path's owner.
import Foundation

public enum ErrorWords {
    public static func describe(_ error: Error) -> String {
        switch error {
        case DecodingError.dataCorrupted(let context):
            return context.debugDescription
        case DecodingError.keyNotFound(let key, _):
            return "no \(key.stringValue)"
        case DecodingError.typeMismatch(_, let context), DecodingError.valueNotFound(_, let context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return "\(path.isEmpty ? "the file" : path) has the wrong type"
        case let error as CocoaError where error.code == .fileReadNoSuchFile:
            return "the file is missing"
        default:
            return (error as NSError).localizedDescription
        }
    }
}
