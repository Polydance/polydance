package net.polydance.capture

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import java.io.File
import java.nio.ByteBuffer

/**
 * The narration alone: the mic track copied out of a finished recording into narration.m4a, without
 * re-encoding, so the upload can send it before the video. It is about 1 MB a minute against hundreds
 * for the video, and lets the receiver transcribe and summarise while the video is still on its way
 * (Robin, 2026-10-04: "get words back faster"). Only for a recording whose run.json says which audio
 * track is the mic and whose file still has every track it names; anything unexpected means no
 * narration, and the video goes up as before with the same sound in it. The recording is only read.
 */
object Narration {
    const val FILE = "narration.m4a"
    /** The receiver's limit, about an hour of the 128 kbps mono mic. */
    const val MAX_BYTES = 64L * 1024 * 1024
    private const val TAG = "PolydanceCapture"

    /** narration.m4a in the run's folder, made once; null when there is no mic track to take or it fails. */
    fun prepare(dir: File, video: File, roles: List<String>): File? {
        val out = File(dir, FILE)
        if (out.length() > 0) return out.takeIf { it.length() <= MAX_BYTES }
        val mic = roles.indexOf("mic").takeIf { it >= 0 } ?: return null
        val part = File(dir, "$FILE.part")
        val extractor = MediaExtractor()
        var muxer: MediaMuxer? = null
        try {
            extractor.setDataSource(video.path)
            val audio = (0 until extractor.trackCount).filter { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
            // A track that did not make it into the file leaves no way to know which is the mic.
            if (audio.size != roles.size) return null
            val format = extractor.getTrackFormat(audio[mic])
            extractor.selectTrack(audio[mic])
            muxer = MediaMuxer(part.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val track = muxer.addTrack(format)
            muxer.start()
            val size = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0
            val buffer = ByteBuffer.allocate(maxOf(size, 64 * 1024))
            val info = MediaCodec.BufferInfo()
            var samples = 0
            while (true) {
                val n = extractor.readSampleData(buffer, 0)
                if (n < 0) break
                // The recording's own clock, so the transcript's times are the video's.
                info.set(0, n, extractor.sampleTime, if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                muxer.writeSampleData(track, buffer, info)
                samples++
                extractor.advance()
            }
            if (samples == 0) return null
            muxer.stop()
            if (part.length() > MAX_BYTES || !part.renameTo(out)) return null
            Log.i(TAG, "narration for ${dir.name}: ${out.length()} bytes from track ${mic + 1}")
            return out
        } catch (e: Exception) {
            Log.w(TAG, "narration for ${dir.name} not made: $e")
            return null
        } finally {
            runCatching { muxer?.release() }
            extractor.release()
            part.delete()
        }
    }
}
