// How a flip is measured (docs/IPHONE.md R5, I0 question 1): the gap between the last frame written from
// one camera and the first frame written from the next, and where in the file the new camera begins. It
// lives here rather than in the app's capture sink so `swift test` proves it with no camera. Only frames
// the writer took count: one dropped for its size or a busy encoder never stands for the new camera, and
// frames the old camera still delivers after the swap move the gap's start without ending it. One flip is
// awaited at a time; the recorder refuses another until this one's first frame is reported or it gave up
// waiting. Used on the capture queue only.
import Foundation

public struct FlipClock: Sendable, Equatable {
    public struct Report: Sendable, Equatable {
        /// "back" or "front", as CameraSpan names it.
        public let facing: String
        /// Milliseconds since the last frame written before this one; nil when none was, so this camera
        /// is where the file begins (a flip pressed before the take's first frame).
        public let gapMs: Int?
        /// Milliseconds from the start of the file to this camera's first frame.
        public let atMs: Int

        public init(facing: String, gapMs: Int?, atMs: Int) {
            self.facing = facing
            self.gapMs = gapMs
            self.atMs = atMs
        }

        /// Puts the flip into run.json's `cameras` and `flipGapsMs`. A camera with no frame before it
        /// replaces the camera named at REC, which never wrote one, and has no gap to record.
        public func apply(cameras: inout [CameraSpan], flipGapsMs: inout [Int]) {
            let span = CameraSpan(atMs: atMs, facing: facing)
            guard let gapMs else {
                cameras = [span]
                return
            }
            cameras.append(span)
            flipGapsMs.append(gapMs)
        }
    }

    /// The camera a flip is waiting for, nil when none is.
    public private(set) var awaited: String?
    /// The presentation time of the last frame written, from any camera.
    public private(set) var lastWrittenSeconds: Double?

    public init() {}

    /// Waits for `facing`'s first written frame (nil stops waiting). Returns the camera an earlier flip
    /// was still waiting for, which will now never be reported.
    @discardableResult
    public mutating func expect(_ facing: String?) -> String? {
        let abandoned = awaited
        awaited = facing
        return abandoned == facing ? nil : abandoned
    }

    /// One video frame given to the writer: `written` is whether the writer took it, `facing` the camera it
    /// came from (nil when the connection did not say), `sessionStart` the writer's start
    /// (MovieWriterStats.startSeconds). Returns the flip's report on the awaited camera's first written frame.
    public mutating func frame(pts: Double, written: Bool, facing: String?, sessionStart: Double?) -> Report? {
        guard written, pts.isFinite else { return nil }
        defer { lastWrittenSeconds = pts }
        guard let wanted = awaited, facing == wanted else { return nil }
        awaited = nil
        let gap = lastWrittenSeconds.map { Self.ms(pts - $0) }
        let at = sessionStart.map { max(0, Self.ms(pts - $0)) } ?? 0
        return Report(facing: wanted, gapMs: gap, atMs: at)
    }

    static func ms(_ seconds: Double) -> Int { Int((seconds * 1000).rounded()) }
}
