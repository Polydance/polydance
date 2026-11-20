// The call's sound (track "app"): a Core Audio process tap (macOS 14.2+) on every Arc process, mixed to
// stereo, private, and not muted, so Robin still hears the call (C10). For a walkthrough it is a global
// tap that leaves out only this app. The tap sits in a private aggregate device whose clock is the
// default system output device; an IO proc reads it and turns each buffer into a CMSampleBuffer stamped
// with the buffer's host time, the clock the other two sources share.
//
// The aggregate's input list holds the clock device's own input streams (a headset's or an interface's
// microphone) and the tap's. That the tap's come last is how it behaves in the examples this follows,
// not something Apple documents, and it is not verified on hardware with an output device that has
// inputs (docs/PLATFORM-NOTES.md). So each list is checked against what it must be, the device's input
// buffers (followed as they change, as when a Bluetooth headset switches to its call profile) plus the
// tap's, each with the tap's channel count; a list that is not is skipped, with a note the first time,
// rather than record an unknown stream as "Others", and the writer fills what was skipped with silence.
// When the clock device goes away (unplugged), that is noted with the time and the aggregate is made
// again on the current output, if the tap's format is the same there.
//
// macOS asks for "system audio recording only" the first time a tap is read; when that grant is refused
// the tap delivers silence with no error (C12), which the recorder watches for.
import AudioToolbox
import CoreAudio
import CoreMedia
import Foundation

final class ProcessTapSource {
    enum Target {
        /// Every Arc process (their Core Audio object ids).
        case processes([AudioObjectID])
        /// Everything except these processes (this app's own object, when it has one).
        case allExcept([AudioObjectID])
    }

    let meter = LevelMeter()
    var onSample: ((CMSampleBuffer) -> Void)?
    /// Called on the tap's control queue when the call sound stopped or started again by itself.
    var onEvent: ((String) -> Void)?
    private(set) var format: AudioStreamBasicDescription?

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var tapUUID: UUID?
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var clockDevice = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var formatDescription: CMAudioFormatDescription?
    /// Set when the tap gives non-interleaved float: buffers are interleaved here, so the writer's AAC
    /// input always gets one interleaved buffer and never has to accept a planar layout.
    private var interleave = false
    private var scratch: [Float] = []
    /// What the IO proc's input list must be: the clock device's input buffers, then the tap's. The
    /// device's count changes on the control queue and is read on the IO queue, so it is behind a lock.
    private var deviceBufferCount = 0
    private let countLock = NSLock()
    private var deviceBuffers: Int {
        get { countLock.lock(); defer { countLock.unlock() }; return deviceBufferCount }
        set { countLock.lock(); deviceBufferCount = newValue; countLock.unlock() }
    }
    private var tapBuffers = 1
    private var tapChannelsPerBuffer = 2
    private var reportedWrongStreams = false
    private var stopped = false
    private var listeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    private let queue = DispatchQueue(label: "net.polydance.capture.tap", qos: .userInitiated)
    /// Device changes are handled here, never on the IO queue, so stopping the IO proc cannot wait on itself.
    private let control = DispatchQueue(label: "net.polydance.capture.tap.control", qos: .userInitiated)

    /// Creates the tap and the aggregate device and starts reading. Throws with what failed; on a
    /// throw everything made so far has been taken down again.
    func start(_ target: Target) throws {
        do { try control.sync { try build(target) } } catch {
            stop()
            throw error
        }
    }

    private func build(_ target: Target) throws {
        let description: CATapDescription
        switch target {
        case .processes(let ids):
            guard !ids.isEmpty else { throw CaptureError("Arc has no audio process to listen to") }
            description = CATapDescription(stereoMixdownOfProcesses: ids)
        case .allExcept(let ids):
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: ids)
        }
        description.uuid = UUID()
        description.name = "Polydance"
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(description, &tap), "create the sound tap")
        tapID = tap
        tapUUID = description.uuid

        let asbd = try Self.tapFormat(tapID)
        format = asbd
        let channels = Int(asbd.mChannelsPerFrame)
        let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
        let isFloat32 = asbd.mFormatID == kAudioFormatLinearPCM && asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0 && asbd.mBitsPerChannel == 32
        var written = asbd
        if !interleaved, channels > 1, isFloat32 {
            interleave = true
            written.mFormatFlags &= ~kAudioFormatFlagIsNonInterleaved
            written.mBytesPerFrame = UInt32(4 * channels)
            written.mBytesPerPacket = written.mBytesPerFrame
        }
        var formatDescription: CMAudioFormatDescription?
        try check(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &written, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                                 magicCookie: nil, extensions: nil, formatDescriptionOut: &formatDescription), "describe the tap's format")
        self.formatDescription = formatDescription
        tapBuffers = interleaved ? 1 : channels
        tapChannelsPerBuffer = interleaved ? channels : 1

        try makeAggregate()
        try startIO()
        listen()
    }

    private static func tapFormat(_ tap: AudioObjectID) throws -> AudioStreamBasicDescription {
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd), "read the tap's format")
        guard asbd.mSampleRate > 0, asbd.mChannelsPerFrame > 0 else { throw CaptureError("the sound tap reported no format") }
        return asbd
    }

    /// The private aggregate: the default system output as its clock, and the tap.
    private func makeAggregate() throws {
        guard let tapUUID else { throw CaptureError("no tap to listen to") }
        let (device, outputUID) = try Self.defaultOutput()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Polydance",
            kAudioAggregateDeviceUIDKey: "net.polydance.capture.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapUUID.uuidString]],
        ]
        var created = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &created), "create the tap's device")
        aggregateID = created
        clockDevice = device
        deviceBuffers = CoreAudioProcesses.inputBufferChannels(of: device)?.count ?? 0
    }

    private func startIO() throws {
        var proc: AudioDeviceIOProcID?
        try check(AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateID, queue) { [weak self] _, input, inputTime, _, _ in
            self?.receive(input, at: inputTime)
        }, "read the tap")
        procID = proc
        try check(AudioDeviceStart(aggregateID, procID), "start the tap")
    }

    /// The tap's buffers, after the clock device's own, checked against what the list must hold.
    private func receive(_ input: UnsafePointer<AudioBufferList>, at time: UnsafePointer<AudioTimeStamp>) {
        guard let formatDescription, let asbd = format else { return }
        let all = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        let tapBuffers = self.tapBuffers
        let tapStart = deviceBuffers
        guard all.count == tapStart + tapBuffers, (0..<tapBuffers).allSatisfy({ Int(all[tapStart + $0].mNumberChannels) == tapChannelsPerBuffer }) else {
            if !reportedWrongStreams {
                reportedWrongStreams = true
                let (found, expected) = (all.count, tapStart + tapBuffers)
                control.async { self.onEvent?("some call sound was not recorded: its device gave \(found) input buffers where \(expected) were expected") }
            }
            return
        }
        let list = AudioBufferList.allocate(maximumBuffers: tapBuffers)
        defer { free(list.unsafeMutablePointer) }
        for index in 0..<tapBuffers { list[index] = all[tapStart + index] }
        let bytesPerFrame = Int(asbd.mBytesPerFrame)
        guard bytesPerFrame > 0, let first = list.first else { return }
        let frames = Int(first.mDataByteSize) / bytesPerFrame
        guard frames > 0 else { return }
        let stamp = time.pointee
        let host = stamp.mFlags.contains(.hostTimeValid) ? stamp.mHostTime : mach_absolute_time()
        if let level = AudioBuffers.level(list: list.unsafePointer, format: asbd) { meter.update(peak: level.peak, rms: level.rms) }
        let pts = AudioBuffers.hostTime(host)
        let made: CMSampleBuffer?
        if interleave {
            let channels = tapBuffers
            if scratch.count < frames * channels { scratch = [Float](repeating: 0, count: frames * channels) }
            for channel in 0..<channels {
                guard let data = list[channel].mData else { return }
                let samples = data.assumingMemoryBound(to: Float.self)
                let count = min(frames, Int(list[channel].mDataByteSize) / 4)
                for frame in 0..<count { scratch[frame * channels + channel] = samples[frame] }
            }
            made = scratch.withUnsafeMutableBytes { bytes -> CMSampleBuffer? in
                var one = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(channels),
                                                                                    mDataByteSize: UInt32(frames * channels * 4), mData: bytes.baseAddress))
                return AudioBuffers.make(list: &one, frames: frames, format: formatDescription, pts: pts)
            }
        } else {
            made = AudioBuffers.make(list: list.unsafePointer, frames: frames, format: formatDescription, pts: pts)
        }
        guard let buffer = made else { return }
        onSample?(buffer)
    }

    // MARK: The clock device going away

    /// Whether the clock device is still there, which device is the system output, and the clock
    /// device's own input buffers (a headset's microphone appears when its call profile starts).
    private func listen() {
        let changed: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.clockMayHaveGone() }
        let inputs: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            self.deviceBuffers = CoreAudioProcesses.inputBufferChannels(of: self.clockDevice)?.count ?? self.deviceBuffers
        }
        let global = { (selector: AudioObjectPropertySelector) in
            AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        }
        let input = { (selector: AudioObjectPropertySelector) in
            AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        }
        let wanted: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = [
            (clockDevice, global(kAudioDevicePropertyDeviceIsAlive), changed),
            (AudioObjectID(kAudioObjectSystemObject), global(kAudioHardwarePropertyDefaultSystemOutputDevice), changed),
            (clockDevice, input(kAudioDevicePropertyStreamConfiguration), inputs),
            (clockDevice, input(kAudioDevicePropertyStreams), inputs),
        ]
        for (object, address, block) in wanted {
            var address = address
            if AudioObjectAddPropertyListenerBlock(object, &address, control, block) == noErr { listeners.append((object, address, block)) }
        }
    }

    private func unlisten() {
        for (object, address, block) in listeners {
            var address = address
            AudioObjectRemovePropertyListenerBlock(object, &address, control, block)
        }
        listeners = []
    }

    /// On the control queue. A new default output while the old one is alive changes nothing (the tap
    /// follows Arc, not the device); a clock device that is gone stops the IO proc, so the aggregate is
    /// made again on the current output.
    private func clockMayHaveGone() {
        guard !stopped, aggregateID != kAudioObjectUnknown, !CoreAudioProcesses.isAlive(clockDevice) else { return }
        let gone = CoreAudioProcesses.deviceUID(clockDevice) ?? "the output device"
        onEvent?("the call sound stopped: \(gone) went away")
        unlisten()
        tearDownAggregate()
        do {
            let before = format
            let now = try Self.tapFormat(tapID)
            guard let before, now.mSampleRate == before.mSampleRate, now.mChannelsPerFrame == before.mChannelsPerFrame, now.mFormatFlags == before.mFormatFlags else {
                onEvent?("the call sound was not started again: the new output runs the tap at \(Int(now.mSampleRate)) Hz")
                return
            }
            reportedWrongStreams = false
            try makeAggregate()
            try startIO()
            listen()
            onEvent?("the call sound started again on \(CoreAudioProcesses.deviceUID(clockDevice) ?? "the new output")")
        } catch {
            tearDownAggregate()
            onEvent?("the call sound could not start again: \(error)")
        }
    }

    private func tearDownAggregate() {
        if aggregateID != kAudioObjectUnknown, let procID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        procID = nil
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        // A buffer already queued finishes before anything it reads changes.
        queue.sync {}
    }

    func stop() {
        control.sync {
            stopped = true
            unlisten()
            tearDownAggregate()
            if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    private static func defaultOutput() throws -> (AudioObjectID, String) {
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device), "find the output device")
        guard let uid = CoreAudioProcesses.deviceUID(device) else { throw CaptureError("the output device has no id") }
        return (device, uid)
    }
}

private func check(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else { throw CaptureError("could not \(what) (Core Audio \(status))") }
}
