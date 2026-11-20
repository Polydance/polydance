// Audio sample buffers on one clock. The microphone's buffers come from AVCapture and the call's sound
// from a Core Audio IO proc; both are copied into CMSampleBuffers the app owns, stamped in host time
// (the clock ScreenCaptureKit stamps frames in), so the three sources line up in one file and a
// buffer held while the recording starts never starves a capture pool. Also the meters' levels.
import AVFoundation
import CoreAudio
import CoreMedia
import Foundation
import PolydanceCore

enum AudioBuffers {
    /// A sample buffer holding a copy of `list`'s audio, presented at `pts`.
    static func make(list: UnsafePointer<AudioBufferList>, frames: Int, format: CMAudioFormatDescription, pts: CMTime) -> CMSampleBuffer? {
        guard frames > 0, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee, asbd.mSampleRate > 0 else { return nil }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(asbd.mSampleRate)),
                                        presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var buffer: CMSampleBuffer?
        var status = CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil,
                                          refcon: nil, formatDescription: format, sampleCount: frames, sampleTimingEntryCount: 1,
                                          sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &buffer)
        guard status == noErr, let buffer else { return nil }
        status = CMSampleBufferSetDataBufferFromAudioBufferList(buffer, blockBufferAllocator: kCFAllocatorDefault,
                                                                blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: list)
        return status == noErr ? buffer : nil
    }

    /// A deep copy of a capture buffer, presented at `pts`, with the copy's level.
    static func copy(_ source: CMSampleBuffer, pts: CMTime) -> (buffer: CMSampleBuffer, peak: Float, rms: Float)? {
        guard let format = CMSampleBufferGetFormatDescription(source) else { return nil }
        var needed = 0
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(source, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
                                                                      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0,
                                                                      blockBufferOut: nil) == noErr, needed > 0 else { return nil }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: 16)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(source, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: needed,
                                                                      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
                                                                      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                                                                      blockBufferOut: &block) == noErr else { return nil }
        let frames = CMSampleBufferGetNumSamples(source)
        guard let copy = make(list: list, frames: frames, format: format, pts: pts) else { return nil }
        let level = CMAudioFormatDescriptionGetStreamBasicDescription(format).flatMap { self.level(list: list, format: $0.pointee) }
        return (copy, level?.peak ?? 0, level?.rms ?? 0)
    }

    /// Peak and RMS over every sample, for 32-bit float formats (what the app asks both sources for).
    static func level(list: UnsafePointer<AudioBufferList>, format: AudioStreamBasicDescription) -> (peak: Float, rms: Float)? {
        guard format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32 else { return nil }
        var peak: Float = 0
        var sumSquares: Float = 0
        var count = 0
        for buffer in UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list)) {
            guard let data = buffer.mData else { continue }
            let samples = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
            let level = AudioLevel.measure(samples)
            peak = max(peak, level.peak)
            sumSquares += level.rms * level.rms * Float(samples.count)
            count += samples.count
        }
        return (peak, count == 0 ? 0 : (sumSquares / Float(count)).squareRoot())
    }

    /// Host time in mach ticks as a CMTime on the host clock.
    static func hostTime(_ ticks: UInt64) -> CMTime {
        CMClockMakeHostTimeFromSystemUnits(ticks)
    }

    static func nowHostTime() -> CMTime {
        CMClockGetTime(CMClockGetHostTimeClock())
    }
}

/// The latest level of one source for the meters, and the loudest sample since the far-end check last
/// looked (C12). Written on the capture queues, read on the main queue.
final class LevelMeter {
    private let lock = NSLock()
    private var rms: Float = 0
    private var updatedAt = Date.distantPast
    private var peakSinceTake: Float?

    func update(peak: Float, rms: Float) {
        lock.lock(); defer { lock.unlock() }
        self.rms = rms
        updatedAt = Date()
        peakSinceTake = max(peakSinceTake ?? 0, peak)
    }

    /// Zero when nothing arrived for half a second, so a stopped source does not freeze its meter.
    var current: Float {
        lock.lock(); defer { lock.unlock() }
        return Date().timeIntervalSince(updatedAt) > 0.5 ? 0 : rms
    }

    /// The loudest sample since the last call, or nil when no buffer arrived.
    func takePeak() -> Float? {
        lock.lock(); defer { lock.unlock() }
        defer { peakSinceTake = nil }
        return peakSinceTake
    }
}
