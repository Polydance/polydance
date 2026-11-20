// Sample threads for pictures of the look (-lookSamples): the receiver's JSON as `polycap thread list
// --json` and `thread show --json` print it, decoded by PolydanceShared's models like real answers, so the
// rows and the thread page are drawn from the same types they will be in I3. Names and words are made up;
// the inbox's line says SAMPLES while they show.
import Foundation
import PolydancePhoneCore
import PolydanceShared
import UIKit

enum Samples {
    /// Two made-up photos for the photo message screen: plain panels of the look's colours, made ready as a
    /// camera's would be (PhotoPrep), so the screen draws what it will send.
    static let photos: [PreparedPhoto] = [(UIColor(Palette.woodGrain), CGSize(width: 900, height: 1200)),
                                          (UIColor(Palette.surface), CGSize(width: 1200, height: 900))].compactMap { colour, size in
        let jpeg = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).jpegData(withCompressionQuality: 0.8) { context in
            colour.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor(Palette.cream).withAlphaComponent(0.3).setFill()
            context.fill(CGRect(x: size.width * 0.15, y: size.height * 0.55, width: size.width * 0.7, height: size.height * 0.08))
        }
        return try? PhotoPrep.prepare(jpeg)
    }

    static let threads: [ThreadSummary] = decode("""
    [
      {"key":"MUS-26","project":"MUS","title":"Marimba 2.0 test builds: welcome menu, drums, piano","state":"open",
       "updatedAt":"2026-11-07T15:42:00Z","lastMessageAt":"2026-11-07T15:42:00Z","messages":7,"unread":true,"waiting":true,"fresh":1,
       "last":{"kind":"text","by":{"id":"agent","name":"Opus","display":"Opus 5.5 on Robin's Mac"},"at":"2026-11-07T15:42:00Z","text":"Build 31 is up: try the piano."},
       "snippet":"Opus 5.5: Build 31 is up: the piano's keys now light as you play.",
       "people":[{"name":"Opus","initial":"O"},{"name":"Robin","initial":"R"},{"name":"Sam","initial":"S","colour":"#825AA0"}],"peopleCount":5},
      {"key":"CAP-12","project":"CAP","title":"The iPhone's deck: reels on the top plate","state":"open",
       "updatedAt":"2026-11-07T14:06:00Z","lastMessageAt":"2026-11-07T14:06:00Z","messages":3,"unread":true,"waiting":false,"fresh":0,
       "last":{"kind":"recording","by":{"id":"robin","name":"Robin","display":"Robin · iPhone"},"at":"2026-11-07T14:06:00Z","text":"sent a recording"},
       "snippet":"Robin: The reels turn while it records.",
       "people":[{"name":"Robin","initial":"R"},{"name":"Opus","initial":"O"}],"peopleCount":2},
      {"key":"CAP-10","project":"CAP","title":"One panel: deck, threads and the open thread","state":"open",
       "updatedAt":"2026-11-06T10:15:00Z","lastMessageAt":"2026-11-06T10:15:00Z","messages":12,"unread":false,"waiting":true,"fresh":0,
       "last":{"kind":"text","by":{"id":"agent","name":"Opus","display":"Opus 5.5 on Robin's Mac"},"at":"2026-11-06T10:15:00Z","text":"Two options to try."},
       "snippet":"Opus 5.5: Two options to try, one with the list on the left.",
       "people":[{"name":"Robin","initial":"R"}],"peopleCount":1},
      {"key":"MUS-19","project":"MUS","title":"Taiko drums feel late on the second beat","state":"open",
       "updatedAt":"2026-11-04T09:30:00Z","lastMessageAt":"2026-11-04T09:30:00Z","messages":5,"unread":false,"waiting":false,"fresh":0,
       "last":{"kind":"text","by":{"id":"ana","name":"ana@example.com"},"at":"2026-11-04T09:30:00Z","text":"Better now."},
       "snippet":"ana@example.com: Better now, thank you.",
       "people":[{"name":"ana@example.com","initial":"A","invited":true,"email":"ana@example.com"},{"name":"Robin","initial":"R"}],"peopleCount":2}
    ]
    """)

    static let projects: [(key: String, name: String)] = [("CAP", "Polydance Capture"), ("MUS", "Marimba")]

    static let details: [String: ThreadDetail] = {
        let mus: ThreadDetail = decode("""
        {"me":"robin","key":"MUS-26","project":{"key":"MUS","name":"Marimba"},"title":"Marimba 2.0 test builds: welcome menu, drums, piano",
         "state":"open","seq":7,"messages":[
          {"id":1,"at":"2026-11-05T10:00:00Z","by":{"id":"robin","name":"Robin","display":"Robin · Quest 3"},
           "recording":{"uploadId":"u1","status":"ready","title":"The welcome menu hides Settings","durationMs":95000},"reactions":[],"picks":[]},
          {"id":2,"at":"2026-11-05T10:20:00Z","by":{"id":"agent","name":"Opus","display":"Opus 5.5 on Robin's Mac"},
           "text":"Moved Settings to the first row and made the menu larger.","reactions":[{"reaction":"thumbs-up","by":{"id":"robin","name":"Robin"}}],"picks":[]},
          {"id":6,"at":"2026-11-07T11:02:00Z","by":{"id":"robin","name":"Robin","display":"Robin · iPhone"},
           "recording":{"uploadId":"u6","status":"ready","title":"Piano keys do not light","summary":"Robin plays three notes; the keys stay dark.","durationMs":42000},
           "reactions":[],"picks":[]},
          {"id":7,"at":"2026-11-07T15:42:00Z","by":{"id":"agent","name":"Opus","display":"Opus 5.5 on Robin's Mac"},
           "text":"Build 31 is up: the piano's keys now light as you play, and the taiko is 40 ms earlier. Two ways to try it:",
           "launches":[
             {"label":"Piano","steps":[{"do":"require","package":"com.example.marimba.aura","versionName":"2.0.31"},{"do":"app","package":"com.example.marimba.aura","activity":".Piano"}]},
             {"label":"Release notes","steps":[{"do":"open","url":"https://example.com/aura/2.0.31"}]}
           ],
           "reactions":[{"reaction":"heart","by":{"id":"sam","name":"Sam"}}],
           "picks":[{"launch":1,"by":{"id":"sam","name":"Sam"}}]}
         ]}
        """)
        let cap: ThreadDetail = decode("""
        {"me":"robin","key":"CAP-12","project":{"key":"CAP","name":"Polydance Capture"},"title":"The iPhone's deck: reels on the top plate",
         "state":"open","seq":4,"messages":[
          {"id":1,"at":"2026-11-07T13:30:00Z","by":{"id":"agent","name":"Opus","display":"Opus 5.5 on Robin's Mac"},
           "text":"The deck now has the headset's reels. Record something and see them turn.","reactions":[],"picks":[]},
          {"id":3,"at":"2026-11-07T14:06:00Z","by":{"id":"robin","name":"Robin","display":"Robin · iPhone"},
           "recording":{"uploadId":"u3","status":"ready","title":"The reels turn while it records","durationMs":31000},"reactions":[],"picks":[]},
          {"id":4,"at":"2026-11-07T15:12:00Z","by":{"id":"robin","name":"Robin","display":"Robin · iPhone"},
           "recording":{"uploadId":"u4","status":"uploading"},"reactions":[],"picks":[]}
         ]}
        """)
        return [mus.key: mus, cap.key: cap]
    }()

    /// A long reply on its way to CAP-12 (made-up numbers), its message u4 there, and the same one when nothing
    /// has moved for a while (-lookStuck).
    static let upload = DeckModel.UploadShown(runName: "20261107-151200", title: "Uploading to CAP-12", threadKey: "CAP-12", uploadId: "u4",
                                              progress: UploadProgress(stage: .video, sent: 460_400_000, total: 1_087_200_000, rate: 2_100_000))
    static let stuckUpload = DeckModel.UploadShown(runName: "20261107-151200", title: "Uploading to CAP-12", threadKey: "CAP-12", uploadId: "u4",
                                                   progress: UploadProgress(stage: .video, sent: 460_400_000, total: 1_087_200_000, rate: 0,
                                                                            stalledSeconds: 40, waiting: "waiting for Wi-Fi"))

    /// A deck that is recording, for the REC screen's picture: the counter, the meter and the target.
    static let recordingSeconds = 42
    static let micLevel = 0.62
    /// The tape's readout: 2.4 of 8 GB used.
    static let used = 0.3
    static let storage = "2.4 OF 8 GB"

    private static func decode<T: Decodable>(_ json: String) -> T {
        do { return try JSONDecoder().decode(T.self, from: Data(json.utf8)) } catch { preconditionFailure("Samples: \(error)") }
    }
}
