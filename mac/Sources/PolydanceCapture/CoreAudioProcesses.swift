// Core Audio's process list: which processes are doing audio, and whether each is running input
// (holding a microphone) or output. Readable with no permission and no prompt (docs/MAC.md D7, seen on
// this Mac on 2026-11-05), so the detector can read it every second all day. Also which input device a
// process is using (kAudioProcessPropertyDevices, input scope), so a call's microphone track records the
// device Meet in Arc is sending rather than whatever the system default happens to be, and the few
// device facts the tap checks (a device's id, whether it is alive, its input buffers).
import CoreAudio
import Foundation
import PolydanceCore

enum CoreAudioProcesses {
    struct ReadError: Error, CustomStringConvertible {
        let status: OSStatus
        let what: String
        var description: String { "Core Audio could not read \(what) (\(status))" }
    }

    static func read() throws -> [AudioProcessInfo] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size)
        guard status == noErr else { throw ReadError(status: status, what: "the process list") }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard !ids.isEmpty else { return [] }
        status = ids.withUnsafeMutableBufferPointer { buffer in
            AudioObjectGetPropertyData(system, &address, 0, nil, &size, buffer.baseAddress!)
        }
        guard status == noErr else { throw ReadError(status: status, what: "the process list") }
        // The list can shrink between the two calls.
        ids = Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
        return ids.map { id in
            AudioProcessInfo(objectID: id, pid: pid(of: id) ?? -1, bundleID: bundleID(of: id),
                             isRunningInput: flag(id, kAudioProcessPropertyIsRunningInput),
                             isRunningOutput: flag(id, kAudioProcessPropertyIsRunningOutput))
        }
    }

    /// This app's own process object, which a walkthrough's global tap leaves out. Nil when the app has
    /// not used audio yet (then there is nothing of its own to leave out).
    static func objectID(forPID pid: pid_t) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var qualifier = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                                UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }

    /// The input device Arc's call is using: the first input device of an Arc process that is running
    /// input, by its Core Audio UID (which is AVCaptureDevice's uniqueID). Nil when none can be read.
    static func arcInputDeviceUID() -> String? {
        guard let list = try? read() else { return nil }
        for process in list where ArcBrowser.isArc(process) && process.isRunningInput {
            for device in objects(process.objectID, kAudioProcessPropertyDevices, scope: kAudioObjectPropertyScopeInput) {
                if let uid = deviceUID(device) { return uid }
            }
        }
        return nil
    }

    static func deviceUID(_ device: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        let text = value.takeRetainedValue() as String
        return text.isEmpty ? nil : text
    }

    static func isAlive(_ device: AudioObjectID) -> Bool {
        flag(device, kAudioDevicePropertyDeviceIsAlive)
    }

    /// The channel count of each of a device's input buffers, in IO-proc order (empty for an output-only device).
    static func inputBufferChannels(of device: AudioObjectID) -> [Int]? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr else { return nil }
        guard size > 0 else { return [] }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return nil }
        return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).map { Int($0.mNumberChannels) }
    }

    private static func objects(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope) -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    private static func pid(of id: AudioObjectID) -> Int32? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyPID, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var value: pid_t = -1
        var size = UInt32(MemoryLayout<pid_t>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func bundleID(of id: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        let text = value.takeRetainedValue() as String
        return text.isEmpty ? nil : text
    }

    private static func flag(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr && value != 0
    }
}
