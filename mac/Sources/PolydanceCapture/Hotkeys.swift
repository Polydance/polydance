// Global shortcuts through Carbon's RegisterEventHotKey, which needs no Accessibility permission:
// control-option-R records now or stops (C6), control-option-M marks this moment (C7). macOS 15 refuses
// shortcuts whose only modifiers are option (and shift); control-option is allowed.
import Carbon.HIToolbox
import Foundation

final class Hotkeys {
    enum Shortcut: UInt32, CaseIterable {
        case recordOrStop = 1
        case mark = 2

        var keyCode: UInt32 {
            switch self {
            case .recordOrStop: UInt32(kVK_ANSI_R)
            case .mark: UInt32(kVK_ANSI_M)
            }
        }

        /// How the menu writes it.
        var label: String {
            switch self {
            case .recordOrStop: "⌃⌥R"
            case .mark: "⌃⌥M"
            }
        }
    }

    private static let signature: OSType = 0x5044_4350 // "PDCP"
    private var refs: [EventHotKeyRef] = []
    private var handler: EventHandlerRef?
    private var actions: [UInt32: () -> Void] = [:]
    private(set) var problems: [String] = []

    /// Registers every shortcut; one that another app holds is reported, not fatal.
    func register(_ actions: [Shortcut: () -> Void]) {
        self.actions = Dictionary(uniqueKeysWithValues: actions.map { ($0.key.rawValue, $0.value) })
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                           MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard status == noErr else { return status }
            let hotkeys = Unmanaged<Hotkeys>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { hotkeys.actions[id.id]?() }
            return noErr
        }, 1, &spec, me, &handler)

        for shortcut in actions.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(shortcut.keyCode, UInt32(controlKey | optionKey), EventHotKeyID(signature: Self.signature, id: shortcut.rawValue),
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { refs.append(ref) } else { problems.append("\(shortcut.label) is taken by another app (\(status))") }
        }
    }

    deinit {
        refs.forEach { UnregisterEventHotKey($0) }
        if let handler { RemoveEventHandler(handler) }
    }
}
