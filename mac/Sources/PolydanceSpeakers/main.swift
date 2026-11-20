// polydance-speakers: who Meet showed speaking in a recorded call (docs/MAC.md P3a), for polycap's
// speakers step (src/pipeline/speakers.ts), which runs it like whisper-cli: no shell, arguments as an
// array. Everything happens on this Mac; nothing is sent anywhere. The report goes to --out, owner-only.
//
//   polydance-speakers <video> --out <file.json> [--every-ms 500] [--reread-ms 3000] [--from-ms N] [--to-ms N]
//   polydance-speakers --image <frame.png|jpg>     a saved frame's rings and names, printed
//   polydance-speakers --version
import Foundation
import ImageIO
import SpeakerTiles

let version = "1"

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("polydance-speakers: \(message)\n".utf8))
    exit(code)
}

func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return encoder
}

var args = Array(CommandLine.arguments.dropFirst())
if args == ["--version"] { print("polydance-speakers \(version)"); exit(0) }

var options: [String: String] = [:]
var positional: [String] = []
while !args.isEmpty {
    let arg = args.removeFirst()
    if arg.hasPrefix("--") {
        guard ["--out", "--every-ms", "--reread-ms", "--from-ms", "--to-ms", "--image"].contains(arg) else { fail("unknown option \(arg)", code: 2) }
        guard !args.isEmpty else { fail("\(arg) needs a value", code: 2) }
        options[arg] = args.removeFirst()
    } else {
        positional.append(arg)
    }
}

func number(_ key: String, _ fallback: Int?, _ range: ClosedRange<Int>) -> Int? {
    guard let text = options[key] else { return fallback }
    guard let n = Int(text), range.contains(n) else { fail("\(key) must be a whole number from \(range.lowerBound) to \(range.upperBound)", code: 2) }
    return n
}

if let path = options["--image"] {
    guard positional.isEmpty else { fail("--image takes no video", code: 2) }
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("\(path) is not an image") }
    do {
        let rings = try SpeakerReader.read(image: image)
        print(String(decoding: try encoder().encode(rings), as: UTF8.self))
    } catch { fail("\(error)") }
    exit(0)
}

guard positional.count == 1 else { fail("give one video, and --out for the report", code: 2) }
guard let out = options["--out"] else { fail("--out <file.json> is required", code: 2) }
let everyMs = number("--every-ms", 500, 100...10_000)!
let rereadMs = number("--reread-ms", 3000, 0...600_000)!
let fromMs = number("--from-ms", nil, 0...Int(Int32.max))
let toMs = number("--to-ms", nil, 0...Int(Int32.max))
let video = URL(fileURLWithPath: positional[0])
guard FileManager.default.fileExists(atPath: video.path) else { fail("no video at \(video.path)") }

do {
    let report = try await SpeakerReader.read(video: video, everyMs: everyMs, rereadMs: rereadMs, fromMs: fromMs, toMs: toMs)
    let data = try encoder().encode(report)
    // Owner-only, as every file polycap writes in the library (CLAUDE.md, private by default).
    let outURL = URL(fileURLWithPath: out)
    let partial = outURL.deletingLastPathComponent().appendingPathComponent(".\(outURL.lastPathComponent).partial")
    guard FileManager.default.createFile(atPath: partial.path, contents: data, attributes: [.posixPermissions: 0o600]) else { fail("could not write \(partial.path)") }
    guard rename(partial.path, outURL.path) == 0 else { fail("could not move the report to \(outURL.path): \(String(cString: strerror(errno)))") }
} catch {
    fail("\(error)")
}
