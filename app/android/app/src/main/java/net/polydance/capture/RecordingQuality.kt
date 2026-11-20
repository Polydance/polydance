package net.polydance.capture

/**
 * The picture's quality, chosen behind the gear: Low, Medium (the default) or High. Each is an encoder size and bitrate;
 * the frame rate stays capped at 30 fps for all three. Medium is what every take had before the choice existed, measured
 * on Quest 3 takes of 0.21.0 at 9.3 to 9.9 Mbit/s (the encoder runs over the 8 asked for). High asks for twice that, which
 * at 30 fps gives each frame about the bits of Meta's own recorder at its recommended 20 Mbit/s and 36 fps; it stays
 * 1920 × 1080 because the frames an agent reads are at most 1920 wide. Low is 720p for slow Wi-Fi. The Vision Pro has the
 * same three (visionos/Shared/Broadcast.swift), where visionOS picks the size and only the bitrate changes.
 */
enum class RecordingQuality(val key: String, val label: String, val width: Int, val height: Int, val bitrate: Int) {
    LOW("low", "Low", 1280, 720, 4_000_000),
    MEDIUM("medium", "Medium", 1920, 1080, 8_000_000),
    HIGH("high", "High", 1920, 1080, 16_000_000);

    /** One line under the choice: what it records and what it costs. */
    val detail: String get() = "%d × %d at %d Mbit/s. %s".format(width, height, bitrate / 1_000_000, when (this) {
        LOW -> "Smaller uploads, for slow Wi-Fi; small text blurs."
        MEDIUM -> "The default."
        HIGH -> "Small text stays sharper while you move; uploads are about twice Medium's."
    })

    companion object {
        val DEFAULT = MEDIUM

        /** An adb `--es quality` value, or null for one this app does not know. */
        fun parse(key: String?): RecordingQuality? = entries.firstOrNull { it.key == key }

        /**
         * The remembered choice. Before 2026-11-18 the setting was a size, stored as an index into 1920 × 1080,
         * 1280 × 720 and 1024 × 1024: 720p becomes Low, the others Medium (the square size is no longer offered).
         */
        fun remembered(quality: String?, oldPreset: Int?): RecordingQuality =
            parse(quality) ?: if (oldPreset == 1) LOW else DEFAULT
    }
}
