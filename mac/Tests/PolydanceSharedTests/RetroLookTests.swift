// The computed parts of the look must match the headset app's Java: java.util.Random's published values,
// String.hashCode's, and the wood laid out the same way every time.
import Foundation
import PolydanceShared
import XCTest

final class RetroLookTests: XCTestCase {
    func testJavaRandomMatchesJava() {
        // new Random(42).nextInt() and nextFloat(), as every JVM gives them.
        var a = JavaRandom(seed: 42)
        XCTAssertEqual(a.nextInt(), -1_170_105_035)
        var b = JavaRandom(seed: 42)
        XCTAssertEqual(b.nextFloat(), 0.7275637, accuracy: 0.0000001)
        // A bound that is a power of two takes the top bits; any other is rejection-sampled into range.
        var c = JavaRandom(seed: 1966)
        for _ in 0..<1000 {
            XCTAssertTrue((0..<9).contains(c.nextInt(9)))
            XCTAssertTrue((0..<64).contains(c.nextInt(64)))
            XCTAssertTrue((0..<1).contains(c.nextFloat()))
        }
    }

    func testJavaHashCodeAndTheAvatarColour() {
        XCTAssertEqual(RetroLook.javaHashCode("hello"), 99_162_322)
        XCTAssertEqual(RetroLook.javaHashCode(""), 0)
        XCTAssertEqual(RetroLook.javaHashCode("Opus 5.5 on Robin's Mac"), -1_002_214_711, "overflows as an Int32 does")
        XCTAssertEqual(RetroLook.avatarIndex(for: "Robin", count: 6), 2)
        XCTAssertEqual(RetroLook.avatarIndex(for: "Opus 5.5 on Robin's Mac", count: 6), 1, "a negative hash is masked, not negated")
        XCTAssertEqual(RetroLook.initial("robin"), "R")
        XCTAssertEqual(RetroLook.initial("  9am"), "9")
        XCTAssertEqual(RetroLook.initial("—"), "?")
    }

    func testRowTimesAreWrittenAsTheHeadsetWritesThem() {
        let london = TimeZone(identifier: "Europe/London")!
        let now = MetaTime.parse("2026-11-06T16:20:00Z")!
        XCTAssertEqual(RetroLook.rowTime(MetaTime.parse("2026-11-06T09:05:00Z")!, now: now, timeZone: london), "09:05")
        XCTAssertEqual(RetroLook.rowTime(MetaTime.parse("2026-11-05T14:06:10.285Z")!, now: now, timeZone: london), "5 Nov")
        XCTAssertEqual(RetroLook.rowTime(MetaTime.parse("2025-12-24T10:00:00Z")!, now: now, timeZone: london), "24 Dec 2025")
    }

    func testThePeopleInAThreadAreRead() throws {
        // What polycap really printed (PolydanceCoreTests' fixtures), read by path as those tests read it.
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("PolydanceCoreTests/Fixtures/thread-list.json")
        let threads = try JSONDecoder().decode([ThreadSummary].self, from: Data(contentsOf: url))
        XCTAssertEqual(threads.first?.people.map(\.initial), ["O", "R"])
        XCTAssertEqual(threads.first?.peopleCount, 2)
        XCTAssertNotNil(threads.first?.snippet)
        let own = try JSONDecoder().decode(ThreadPerson.self, from: Data(##"{"name":"Ana","initial":"A","colour":"#4084A0"}"##.utf8))
        XCTAssertEqual(own.ownColour, 0x4084A0)
        let invited = try JSONDecoder().decode(ThreadPerson.self, from: Data(#"{"name":"ana@example.com","initial":"A","invited":true,"email":"ana@example.com"}"#.utf8))
        XCTAssertNil(invited.ownColour)
        XCTAssertEqual(invited.colourKey, "ana@example.com")
    }

    func testTheWoodIsTheSameEveryTimeAndCoversTheCabinet() {
        let one = RetroLook.wood(width: 384, height: 520)
        let two = RetroLook.wood(width: 384, height: 520)
        XCTAssertEqual(one, two)
        XCTAssertEqual(one.map(\.top), [0, 150, 300, 450])
        XCTAssertEqual(one.last?.bottom, 520)
        XCTAssertEqual(one.map(\.wood), [0, 1, 0, 1], "light and mid boards alternate")
        for board in one {
            XCTAssertTrue((-4...4).contains(board.shift))
            XCTAssertTrue((10...15).contains(board.grain.count))
            for line in board.grain {
                XCTAssertTrue((26...89).contains(line.alpha))
                XCTAssertTrue(line.width >= 0.6 && line.width <= 2.1)
                XCTAssertGreaterThanOrEqual(line.points.last?.x ?? 0, 384, "each grain line crosses the board")
            }
        }
        // A taller cabinet keeps the same top boards: the seed is consumed board by board.
        XCTAssertEqual(Array(RetroLook.wood(width: 384, height: 900).prefix(3)).map(\.shift), one.prefix(3).map(\.shift))
    }
}
