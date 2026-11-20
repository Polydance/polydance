// Entry point: `--probe` prints the self-check and `--arc-tabs` asks Arc for its tabs once; each exits
// before anything of the app starts (no NSApplication, no notifications, no timers). Otherwise the
// menu-bar app runs.
import Foundation

let arguments = CommandLine.arguments.dropFirst()
if arguments.contains("--probe") {
    exit(Probe.run())
}
if arguments.contains("--arc-tabs") {
    exit(ArcTabsCheck.run())
}
PolydanceApp.main()
