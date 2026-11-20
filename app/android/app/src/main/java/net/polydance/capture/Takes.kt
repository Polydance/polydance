package net.polydance.capture

/**
 * What a take records, from a reply's four switches (docs/LOGS.md, Robin 2026-11-16): Screen, Mic, App sound and
 * Logs, the `settings` preferences `screen`, `mic`, `appAudio` and `logs`, all on by default and shared by the deck's
 * switches and a reply's Settings. App sound rides on the screen-capture token (Android's playback capture needs the
 * MediaProjection), so with Screen off it is off whatever its own switch says, and that switch keeps its value for
 * when Screen comes back. Pure, so the JVM tests it; the words are what the inbox shows under a launch's keys.
 */
enum class TakeKind(val id: String) {
    /** The picture, as before: video.mp4, with the mic and the app's sound as their switches say. */
    VIDEO("video"),
    /** Screen off, Mic on: the microphone alone, audio.m4a. No screen-capture prompt. */
    SOUND("sound"),
    /** Screen and Mic off, Logs on: nothing records while it runs; the headset's log is read at Stop. */
    LOGS("logs"),
    /** Everything off: there is nothing to record, and the Record key says so. */
    NONE("none");

    companion object {
        /** From run.json's `config.kind`; a run from before 2026-11-16 has none and was a video. */
        fun of(id: String?): TakeKind = entries.firstOrNull { it.id == id && it != NONE } ?: VIDEO
    }
}

data class TakeSwitches(val screen: Boolean, val mic: Boolean, val appAudio: Boolean, val logs: Boolean) {
    /** App sound as recorded: only with the picture. */
    val app: Boolean get() = appAudio && screen

    val kind: TakeKind get() = when {
        screen -> TakeKind.VIDEO
        mic -> TakeKind.SOUND
        logs -> TakeKind.LOGS
        else -> TakeKind.NONE
    }

    /** Some switch is off (App sound counts as off without Screen): the reply's Settings key shows its dot. */
    val changed: Boolean get() = !screen || !mic || !app || !logs

    /**
     * What Record does, in words, for the line under a launch's keys: "records", "records without the mic",
     * "records logs only". What is left out is said, so the folded Settings never hide it (CAP-1 #24); everything on
     * says only "records".
     */
    fun records(): String {
        if (screen) {
            val without = listOfNotNull("the mic".takeIf { !mic }, "the app's sound".takeIf { !app }, "the logs".takeIf { !logs })
            return when {
                !mic && !app -> if (logs) "records the picture and the logs, without sound" else "records the picture only"
                without.isEmpty() -> "records"
                else -> "records without ${without.joinToString(" or ")}"
            }
        }
        return when {
            mic && logs -> "records the mic and the logs, without the picture"
            mic -> "records the mic only, without the picture"
            logs -> "records logs only"
            else -> "records nothing"
        }
    }

    companion object {
        /** Why the Record key does nothing with every switch off. */
        const val NOTHING = "Nothing to record: Screen, Mic and Logs are all off. Turn one on in a reply's Settings or behind the gear."
        /** Why App sound cannot be turned on: said where its switch is. */
        const val APP_NEEDS_SCREEN = "App sound needs Screen: Android captures an app's sound only along with the screen."
    }
}
