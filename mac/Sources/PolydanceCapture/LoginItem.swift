// Open at login (A1), through SMAppService.mainApp. Off until the user turns it on in the settings;
// macOS may then ask for approval in System Settings, Login Items, which `status` reports.
import Foundation
import ServiceManagement

enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static var statusText: String {
        switch SMAppService.mainApp.status {
        case .enabled: "on"
        case .notRegistered: "off"
        case .requiresApproval: "waiting for approval in System Settings, General, Login Items"
        case .notFound: "not available for this copy of the app"
        @unknown default: "unknown"
        }
    }

    static func setEnabled(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}
