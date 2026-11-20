package net.polydance.capture

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.max

/**
 * Video, microphone and in-app audio as separate tracks of one MP4. MediaRecorder takes one audio
 * source and cannot hear other apps, so this drives the encoders and a MediaMuxer directly (several
 * audio tracks in MP4 need Android 8+).
 *
 * In-app audio is AudioPlaybackCapture on the projection token: it hears apps that play with a media,
 * game or unknown usage and allow capture (most music apps do), never system sounds or apps that
 * opt out. Track order is fixed, video then mic then app, and run.json lists it, because MP4 tracks
 * written by MediaMuxer carry no names.
 *
 * Every timestamp is on System.nanoTime, the clock surface frames use, so the tracks line up. Video is
 * not padded: if the compositor stops producing frames the file has a gap, which is the evidence.
 */
class MuxerCapture(
    private val projection: MediaProjection, private val output: File,
    private val width: Int, private val height: Int, private val bitrate: Int,
    private val wantMic: Boolean, private val wantApp: Boolean,
) : Capture {

    private enum class Kind(val label: String) { VIDEO("video"), MIC("mic"), APP("app") }

    override val engine = "muxer"
    override var audioTracks: List<String> = emptyList(); private set
    override val startBeforeDisplay = true
    override var onError: ((String) -> Unit)? = null

    private lateinit var sink: Sink
    private lateinit var video: MediaCodec
    private val audio = mutableListOf<AudioTrackSource>()
    private val threads = mutableListOf<Thread>()
    private val frames = AtomicInteger()
    @Volatile private var running = false
    private var baseUs = 0L

    private class AudioTrackSource(val kind: Kind, val record: AudioRecord, val encoder: MediaCodec, val channels: Int) {
        val peak = AtomicInteger()
    }

    override fun prepare(): Surface {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            // The compositor runs at the display rate; 30 fps is plenty for review and matches MediaRecorder.
            setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, 30f)
        }
        video = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        video.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = video.createInputSurface()

        // An audio source that cannot be opened is logged and left out; the video still records.
        if (wantMic) openAudio(Kind.MIC, channels = 1, bitrate = 128_000)?.let { audio += it }
        if (wantApp) openAudio(Kind.APP, channels = 2, bitrate = 192_000)?.let { audio += it }
        audioTracks = audio.map { it.kind.label }
        sink = Sink(output, listOf(Kind.VIDEO) + audio.map { it.kind })
        return surface
    }

    @SuppressLint("MissingPermission") // The activity only starts a run with audio after RECORD_AUDIO is granted.
    private fun openAudio(kind: Kind, channels: Int, bitrate: Int): AudioTrackSource? {
        val mask = if (channels == 1) AudioFormat.CHANNEL_IN_MONO else AudioFormat.CHANNEL_IN_STEREO
        val pcm = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(mask).build()
        val size = max(AudioRecord.getMinBufferSize(RATE, mask, AudioFormat.ENCODING_PCM_16BIT) * 4, 16_384)
        var record: AudioRecord? = null
        return try {
            val builder = AudioRecord.Builder().setAudioFormat(pcm).setBufferSizeInBytes(size)
            if (kind == Kind.MIC) {
                builder.setAudioSource(MediaRecorder.AudioSource.MIC)
            } else {
                builder.setAudioPlaybackCaptureConfig(
                    AudioPlaybackCaptureConfiguration.Builder(projection)
                        .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                        .addMatchingUsage(AudioAttributes.USAGE_GAME)
                        .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                        .build(),
                )
            }
            record = builder.build()
            check(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord did not initialise" }
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, channels).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
            }
            val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            Timeline.log("capture", "audio_open", "track" to kind.label, "channels" to channels, "bufferBytes" to size)
            AudioTrackSource(kind, record, encoder, channels)
        } catch (e: Exception) {
            Timeline.log("capture", "audio_unavailable", "track" to kind.label, "error" to e.toString())
            runCatching { record?.release() }
            null
        }
    }

    override fun start() {
        baseUs = nowUs()
        running = true
        video.start()
        threads += Thread({ guard(Kind.VIDEO) { videoLoop() } }, "probe-video")
        for (source in audio) {
            source.encoder.start()
            source.record.startRecording()
            threads += Thread({ guard(source.kind) { audioLoop(source) } }, "probe-${source.kind.label}")
        }
        threads.forEach { it.start() }
    }

    /** A failing audio track is dropped and the run goes on; a failing video track ends the run. */
    private fun guard(kind: Kind, body: () -> Unit) {
        try {
            body()
        } catch (e: Exception) {
            Timeline.log("capture", "track_failed", "track" to kind.label, "error" to e.toString())
            sink.abandon(kind)
            if (kind == Kind.VIDEO && running) onError?.invoke("video_track_failed")
        }
    }

    private fun videoLoop() {
        val info = MediaCodec.BufferInfo()
        var shiftUs: Long? = null
        var lastPts = -1L
        var deadline = Long.MAX_VALUE
        while (true) {
            if (!running && deadline == Long.MAX_VALUE) deadline = System.nanoTime() + 2_000_000_000L
            val index = video.dequeueOutputBuffer(info, 10_000)
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                sink.format(Kind.VIDEO, video.outputFormat)
            } else if (index >= 0) {
                val buffer = video.getOutputBuffer(index)!!
                if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
                    if (shiftUs == null) {
                        // Surface frames should already be on nanoTime; if the compositor stamps them on
                        // another clock, shift them onto ours and say so.
                        val delta = nowUs() - info.presentationTimeUs
                        shiftUs = if (abs(delta) > 1_000_000) delta else 0L
                        Timeline.log("capture", "video_clock", "deltaUs" to delta, "rebased" to (shiftUs != 0L))
                    }
                    val pts = info.presentationTimeUs + shiftUs - baseUs
                    if (pts >= 0) {
                        info.presentationTimeUs = max(pts, lastPts + 1)
                        lastPts = info.presentationTimeUs
                        sink.write(Kind.VIDEO, buffer, info)
                        frames.incrementAndGet()
                    }
                }
                video.releaseOutputBuffer(index, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
            }
            if (System.nanoTime() > deadline) {
                Timeline.log("capture", "video_eos_timeout")
                return
            }
        }
    }

    /**
     * The track is laid out on its own sample count from [baseUs], so it is continuous: when the source
     * delivers nothing (playback capture is idle while no app plays) or skips, silence fills the time.
     * Without that, a silent start would hold back the muxer, and with it the video, until audio played.
     */
    private fun audioLoop(source: AudioTrackSource) {
        val chunk = ByteArray(4096)
        val frameBytes = 2 * source.channels
        val silence = ByteArray(1024 * frameBytes)
        val info = MediaCodec.BufferInfo()
        var placed = 0L // frames on the track so far
        var padded = 0L
        var idle = false
        var lastPts = -1L
        fun trackEndUs() = baseUs + placed * 1_000_000L / RATE
        fun pad(untilUs: Long) {
            while (running && untilUs - trackEndUs() > 0) {
                val count = minOf(1024L, (untilUs - trackEndUs()) * RATE / 1_000_000L + 1).toInt()
                if (!feed(source.encoder, silence, count * frameBytes, trackEndUs() - baseUs, 0)) return
                placed += count; padded += count
                drain(source, info, lastPts, block = false)?.let { lastPts = it }
            }
        }
        while (running) {
            val n = source.record.read(chunk, 0, chunk.size, AudioRecord.READ_NON_BLOCKING)
            if (n < 0) throw IllegalStateException("AudioRecord.read returned $n")
            val now = nowUs()
            if (n == 0) {
                if (now - trackEndUs() > 100_000) {
                    if (!idle) { idle = true; Timeline.log("capture", "audio_idle", "track" to source.kind.label) }
                    pad(now)
                } else {
                    Thread.sleep(5)
                }
            } else {
                val count = n / frameBytes
                if (idle) { idle = false; Timeline.log("capture", "audio_resumed", "track" to source.kind.label) }
                // This chunk ends now; a hole of more than 200 ms before it is filled, a smaller skew is kept.
                val chunkStartUs = now - count * 1_000_000L / RATE
                if (chunkStartUs - trackEndUs() > 200_000) pad(chunkStartUs)
                val peak = peakOf(chunk, n)
                source.peak.accumulateAndGet(peak) { a, b -> max(a, b) }
                val now2 = android.os.SystemClock.elapsedRealtime()
                if (source.kind == Kind.MIC) { CaptureState.liveMicLevel = peak; CaptureState.liveMicAt = now2 }
                else { CaptureState.liveAppLevel = peak; CaptureState.liveAppAt = now2 }
                if (feed(source.encoder, chunk, n, trackEndUs() - baseUs, 0)) placed += count
            }
            drain(source, info, lastPts, block = false)?.let { lastPts = it }
        }
        Timeline.log(
            "capture", "audio_track_end", "track" to source.kind.label,
            "seconds" to placed / RATE, "silencePaddedSeconds" to padded / RATE,
        )
        val deadline = System.nanoTime() + 2_000_000_000L
        while (!feed(source.encoder, silence, 0, trackEndUs() - baseUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)) {
            if (System.nanoTime() > deadline) { Timeline.log("capture", "audio_eos_timeout", "track" to source.kind.label); return }
        }
        while (System.nanoTime() < deadline) {
            val last = drain(source, info, lastPts, block = true) ?: continue
            if (last == EOS) return
            lastPts = last
        }
        Timeline.log("capture", "audio_eos_timeout", "track" to source.kind.label)
    }

    /** Queues [size] bytes at [ptsUs]; false when the encoder had no free input buffer in time. */
    private fun feed(encoder: MediaCodec, data: ByteArray, size: Int, ptsUs: Long, flags: Int): Boolean {
        val index = encoder.dequeueInputBuffer(20_000)
        if (index < 0) return false
        val buffer = encoder.getInputBuffer(index)!!
        buffer.clear()
        val length = minOf(size, buffer.remaining())
        buffer.put(data, 0, length)
        encoder.queueInputBuffer(index, 0, length, max(ptsUs, 0), flags)
        return true
    }

    /** Writes whatever the encoder has ready. Returns the last pts written, [EOS] at end of stream, or null. */
    private fun drain(source: AudioTrackSource, info: MediaCodec.BufferInfo, lastPtsIn: Long, block: Boolean): Long? {
        var lastPts = lastPtsIn
        var wrote = false
        while (true) {
            val index = source.encoder.dequeueOutputBuffer(info, if (block) 10_000 else 0)
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return if (wrote) lastPts else null
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { sink.format(source.kind, source.encoder.outputFormat); continue }
            if (index < 0) continue
            val buffer = source.encoder.getOutputBuffer(index)!!
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
                info.presentationTimeUs = max(info.presentationTimeUs, lastPts + 1)
                lastPts = info.presentationTimeUs
                sink.write(source.kind, buffer, info)
                wrote = true
            }
            source.encoder.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return EOS
        }
    }

    override fun stop(): String? {
        if (!::sink.isInitialized) return "never prepared"
        running = false
        runCatching { video.signalEndOfInputStream() }
        threads.forEach { it.join(4_000) }
        val stuck = threads.filter { it.isAlive }.map { it.name }
        for (source in audio) {
            runCatching { source.record.stop() }; runCatching { source.record.release() }
            runCatching { source.encoder.stop() }; runCatching { source.encoder.release() }
        }
        runCatching { video.stop() }; runCatching { video.release() }
        val error = sink.stop()
        if (sink.dropped > 0) Timeline.log("capture", "samples_dropped_before_start", "count" to sink.dropped)
        return listOfNotNull(error, stuck.takeIf { it.isNotEmpty() }?.let { "threads did not stop: $it" }).joinToString("; ").ifEmpty { null }
    }

    override fun levels(): Levels = Levels(
        micPeak = audio.find { it.kind == Kind.MIC }?.peak?.getAndSet(0),
        appPeak = audio.find { it.kind == Kind.APP }?.peak?.getAndSet(0),
        videoFrames = frames.getAndSet(0),
    )

    /**
     * MediaMuxer needs every track added before it starts, and a track's format is only known once its
     * encoder has produced output. Samples that arrive first are held (up to a cap), then written.
     */
    private class Sink(file: File, kinds: List<Kind>) {
        private val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        private val expected = kinds.toMutableList()
        private val formats = HashMap<Kind, MediaFormat>()
        private val tracks = HashMap<Kind, Int>()
        private val held = ArrayList<Triple<Kind, ByteArray, MediaCodec.BufferInfo>>()
        private var heldBytes = 0L
        private var started = false
        private var stopped = false
        var dropped = 0; private set

        @Synchronized fun format(kind: Kind, format: MediaFormat) { formats[kind] = format; maybeStart() }

        @Synchronized fun abandon(kind: Kind) { if (!started) { expected.remove(kind); maybeStart() } }

        private fun maybeStart() {
            if (started || stopped || expected.isEmpty() || !expected.all { it in formats }) return
            for (kind in expected) tracks[kind] = muxer.addTrack(formats.getValue(kind))
            muxer.start()
            started = true
            Timeline.log("capture", "muxer_started", "tracks" to expected.joinToString { it.label }, "heldSamples" to held.size)
            for ((kind, bytes, info) in held) tracks[kind]?.let { muxer.writeSampleData(it, ByteBuffer.wrap(bytes), info) }
            held.clear(); heldBytes = 0
        }

        @Synchronized fun write(kind: Kind, data: ByteBuffer, info: MediaCodec.BufferInfo) {
            if (stopped) return
            data.position(info.offset); data.limit(info.offset + info.size)
            if (started) { tracks[kind]?.let { muxer.writeSampleData(it, data, info) }; return }
            if (heldBytes + info.size > HOLD_LIMIT) { dropped++; return }
            val bytes = ByteArray(info.size).also { data.get(it) }
            held += Triple(kind, bytes, MediaCodec.BufferInfo().apply { set(0, info.size, info.presentationTimeUs, info.flags) })
            heldBytes += info.size
        }

        @Synchronized fun stop(): String? {
            stopped = true
            return try {
                if (started) { muxer.stop(); null } else "the muxer never started: no format from ${expected.filter { it !in formats }.joinToString { it.label }}"
            } catch (e: Exception) {
                e.toString()
            } finally {
                runCatching { muxer.release() }
            }
        }
    }

    private companion object {
        const val RATE = 48_000
        const val EOS = Long.MIN_VALUE
        const val HOLD_LIMIT = 64L * 1024 * 1024
        fun nowUs() = System.nanoTime() / 1000

        /** Largest absolute 16-bit little-endian sample in the first [size] bytes. */
        fun peakOf(data: ByteArray, size: Int): Int {
            var peak = 0
            var i = 0
            while (i + 1 < size) {
                val sample = (data[i].toInt() and 0xff) or (data[i + 1].toInt() shl 8)
                peak = max(peak, abs(sample.toShort().toInt()))
                i += 2
            }
            return peak
        }
    }
}
