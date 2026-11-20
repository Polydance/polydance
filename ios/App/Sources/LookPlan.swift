// Launch arguments that set the screens up for pictures of the look in the Simulator (docs/IPHONE.md,
// "Tests"): -lookSamples fills the inbox, a thread and the deck's readouts with sample values, marked
// SAMPLES on the screen, -lookScreen opens one screen at launch, and -lookStuck shows the sample take on
// its way as stuck. Strict, as AutoPlan is: an argument
// starting -look that is not one of these refuses the plan, and the launch shows why. Nothing here is
// stored, sent or logged beyond the launch event's argument names.
import Foundation

struct LookPlan: Equatable {
    enum Screen: String, CaseIterable { case deck, rec, camera, screen, photo, thread, recordings, settings, report, drawer, newThread }

    var samples = false
    var screen: Screen = .deck
    /// -lookStuck: the sample take on its way has sent nothing for 40 s.
    var stuck = false

    static let off = LookPlan()

    static func parse(_ arguments: [String]) -> Result<LookPlan, LookPlanError> {
        var plan = LookPlan()
        var seen: Set<String> = []
        var i = arguments.startIndex
        while i < arguments.endIndex {
            let name = arguments[i]
            guard name.hasPrefix("-look") else {
                i += 1
                continue
            }
            guard seen.insert(name).inserted else { return .failure(LookPlanError("\(name) is given twice")) }
            switch name {
            case "-lookSamples":
                plan.samples = true
                i += 1
            case "-lookStuck":
                plan.stuck = true
                i += 1
            case "-lookScreen":
                guard i + 1 < arguments.endIndex, let screen = Screen(rawValue: arguments[i + 1]) else {
                    return .failure(LookPlanError("-lookScreen needs one of \(Screen.allCases.map(\.rawValue).joined(separator: ", "))"))
                }
                plan.screen = screen
                i += 2
            default:
                return .failure(LookPlanError("\(name) is not a look argument (-lookSamples, -lookScreen NAME, -lookStuck)"))
            }
        }
        if plan.stuck, !plan.samples { return .failure(LookPlanError("-lookStuck needs -lookSamples")) }
        if plan.screen != .deck, plan.screen != .settings, plan.screen != .report, !plan.samples {
            return .failure(LookPlanError("-lookScreen \(plan.screen.rawValue) needs -lookSamples"))
        }
        return .success(plan)
    }

    static let current: (plan: LookPlan, error: String?) = {
        switch parse(Array(ProcessInfo.processInfo.arguments.dropFirst())) {
        case .success(let plan): return (plan, nil)
        case .failure(let error): return (.off, error.message)
        }
    }()
}

struct LookPlanError: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}
