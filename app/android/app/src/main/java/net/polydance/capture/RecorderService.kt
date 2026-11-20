package net.polydance.capture

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import net.polydance.capture.platform.headsetPlatform
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

/**
 * Owns the recording: the projection token, the virtual display that feeds a [Capture] engine, and a
 * one-second heartbeat that records whether this process is still running and the file is still
 * growing while another app is in front. Service work runs on the main looper (the muxer engine has
 * its own encoder threads), so a heartbeat that arrives late is itself the measurement.
 *
 * Android 14 order, which Quest also follows: consent in the activity, then startForeground with the
 * mediaProjection type, then getMediaProjection, then registerCallback, then one createVirtualDisplay.
 *
 * With Screen off and Mic on (docs/LOGS.md, 2026-11-16) there is no projection: the service is a microphone
 * foreground service, started from the activity while it is in front, and [SoundCapture] writes audio.m4a. A take of
 * logs alone never comes here (LogsTake). When Logs is on, the take's logs are read once it stops (RunFolder.handOff),
 * the service still in the foreground meanwhile, and its upload is queued only after them.
 */
class RecorderService : Service() {

    companion object {
        const val ACTION_START = "net.polydance.capture.service.START"
        const val ACTION_STOP = "net.polydance.capture.service.STOP"
        private const val EXTRA_RESULT_CODE = "resultCode"
        private const val EXTRA_RESULT_DATA = "resultData"
        private const val EXTRA_WIDTH = "width"
        private const val EXTRA_HEIGHT = "height"
        private const val EXTRA_BITRATE = "bitrate"
        private const val EXTRA_MIC = "mic"
        private const val EXTRA_APP_AUDIO = "appAudio"
        private const val EXTRA_SCREEN = "screen"
        private const val EXTRA_LOGS = "logs"
        private const val EXTRA_MAX_MINUTES = "maxMinutes"
        private const val EXTRA_THREAD = "thread"
        private const val EXTRA_INVITE = "invite"
        private const val CHANNEL = "recording"
        private const val NOTIFICATION_ID = 1
        private const val HEARTBEAT_MS = 1000L

        fun startIntent(
            /** The screen-capture consent; null for a take without the picture (sound alone). */
            context: Context, resultCode: Int, data: Intent?,
            width: Int, height: Int, bitrate: Int, mic: Boolean, appAudio: Boolean, maxMinutes: Int,
            /** The thread this recording goes in, as the upload will name it (docs/THREADS.md); null with threads off. */
            thread: String? = null,
            /** Addresses to add to the new thread this recording opens, once the receiver has made it (Invites). */
            invite: ArrayList<String>? = null,
            /** Screen off records the mic alone; Logs on reads the headset's logs when it stops (docs/LOGS.md). */
            screen: Boolean = true, logs: Boolean = false,
        ): Intent = Intent(context, RecorderService::class.java).setAction(ACTION_START)
            .putExtra(EXTRA_RESULT_CODE, resultCode).putExtra(EXTRA_RESULT_DATA, data)
            .putExtra(EXTRA_WIDTH, width).putExtra(EXTRA_HEIGHT, height).putExtra(EXTRA_BITRATE, bitrate)
            .putExtra(EXTRA_MIC, mic).putExtra(EXTRA_APP_AUDIO, appAudio).putExtra(EXTRA_MAX_MINUTES, maxMinutes)
            .putExtra(EXTRA_THREAD, thread)
            .putStringArrayListExtra(EXTRA_INVITE, invite)
            .putExtra(EXTRA_SCREEN, screen).putExtra(EXTRA_LOGS, logs)

        fun stopIntent(context: Context): Intent =
            Intent(context, RecorderService::class.java).setAction(ACTION_STOP)

        /** Run folders live here; `adb pull` reads them without any storage permission. */
        fun runsDir(context: Context): File = File(context.getExternalFilesDir(null), "runs")
    }

    private val main = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var capture: Engine? = null
    private var output: File? = null
    private var config = JSONObject()
    private var runJson = JSONObject()
    private var mic = false
    private var appAudio = false
    private var screen = true
    private var logs = false
    private var active = false
    private var finishing = false
    /** The take has stopped and its logs are being read before its upload is queued. */
    private var handingOff = false
    private var lastBeatElapsed = 0L
    private var lastBytes = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Timeline.log("service", "create")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> if (active || handingOff) {
                Timeline.log("service", "start_ignored", "why" to if (active) "already recording" else "reading the last take's logs")
            } else {
                begin(intent)
            }
            // Stopped while its logs are read: the end of the take is already under way.
            ACTION_STOP -> if (active) finish("user") else if (!handingOff) stopSelf()
            else -> {
                // A null intent means the system restarted the service; there is no token to resume with.
                Timeline.log("service", "unexpected_start", "action" to intent?.action)
                if (!active && !handingOff) stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun begin(intent: Intent) {
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_RESULT_DATA)
        }
        val width = intent.getIntExtra(EXTRA_WIDTH, 1920)
        val height = intent.getIntExtra(EXTRA_HEIGHT, 1080)
        val bitrate = intent.getIntExtra(EXTRA_BITRATE, 8_000_000)
        val maxMinutes = intent.getIntExtra(EXTRA_MAX_MINUTES, 30)
        screen = intent.getBooleanExtra(EXTRA_SCREEN, true)
        mic = intent.getBooleanExtra(EXTRA_MIC, true)
        // Playback capture rides on the projection: no picture, no app sound (Takes).
        appAudio = screen && intent.getBooleanExtra(EXTRA_APP_AUDIO, false)
        logs = intent.getBooleanExtra(EXTRA_LOGS, false)
        val kind = TakeSwitches(screen, mic, appAudio, logs).kind
        finishing = false
        CaptureState.runDir = null
        CaptureState.kind = kind
        CaptureState.logs = logs

        // Foreground first: Android 14 refuses getMediaProjection from a service that is not yet typed,
        // and any start that never reaches startForeground is killed by the system. Sound alone is a
        // microphone service, which Android 14 starts only while the activity that asked is in front.
        try {
            val types = (if (screen) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0) or
                (if (mic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
            if (types == 0) { fail("nothing_to_record", null); return }
            createChannel()
            startForeground(NOTIFICATION_ID, notification("Starting"), types)
            Timeline.log("service", "foreground", "types" to types)
        } catch (e: Exception) {
            fail("foreground_failed", e); return
        }

        // Defense in depth: exported activities and delayed permission results cannot bypass the gate.
        // We enter foreground above to honour Android's startForegroundService contract, but capture
        // and run creation happen only after both checks. There is no automatic recording on sign-in.
        if (!signIn.mayRecord()) { fail("entitlement_not_established", null); return }
        val consent = Consent.snapshot(this)
        if (consent == null) { fail("consent_not_established", null); return }

        config = JSONObject()
            .put("kind", kind.id).put("screen", screen).put("logs", logs)
            .put("width", width).put("height", height).put("bitrate", bitrate).put("mic", mic).put("appAudio", appAudio)
            .put("maxMinutes", maxMinutes).put("densityDpi", resources.displayMetrics.densityDpi)
            .put("platform", headsetPlatform.id).put("resizePolicy", "fixed_output_canvas")
        // Where the recording goes, kept beside it so the upload names its thread even after a restart.
        val thread = intent.getStringExtra(EXTRA_THREAD)
        val opened = RunFolder.open(this, config, consent, thread, intent.getStringArrayListExtra(EXTRA_INVITE))
        if (opened == null) { fail("run_dir_failed", IllegalStateException("cannot create a run folder")); return }
        val dir = opened.first
        runJson = opened.second
        output = File(dir, if (screen) "video.mp4" else "audio.m4a")
        Timeline.open(File(dir, "timeline.jsonl"))
        CaptureState.runDir = dir
        CaptureState.endReason = null
        CaptureState.destination = thread
        Timeline.log("service", "run_open", "dir" to dir.absolutePath, "config" to config, "device" to runJson.optJSONObject("device"), "thread" to thread)

        if (!screen) {
            // Sound alone: no token, no display; the mic from now.
            try {
                val engine = SoundCapture(this, output!!, maxMinutes) { finish("max_duration") }
                engine.onError = { reason -> main.post { finish(reason) } }
                capture = engine
                engine.prepare()
                config.put("engine", engine.engine).put("audioTracks", JSONArray(engine.audioTracks))
                RunFolder.write(dir, runJson.put("config", config))
                Timeline.log("capture", "prepared", "engine" to engine.engine, "audioTracks" to engine.audioTracks.joinToString())
                startCapture(engine)
            } catch (e: Exception) {
                fail("recorder_setup_failed", e); return
            }
            running()
            return
        }

        try {
            val manager = getSystemService(MediaProjectionManager::class.java)
            val token = if (data != null) manager.getMediaProjection(resultCode, data) else null
            if (token == null) { fail("projection_null", null); return }
            token.registerCallback(projectionCallback, main)
            projection = token
            Timeline.log("projection", "created")
        } catch (e: Exception) {
            fail("projection_failed", e); return
        }

        try {
            // In-app audio needs the encoder engine; without it the proven MediaRecorder path is used.
            val engine: Capture = if (appAudio) {
                MuxerCapture(projection!!, output!!, width, height, bitrate, mic, appAudio)
            } else {
                RecorderCapture(this, output!!, width, height, bitrate, mic, maxMinutes) { finish("max_duration") }
            }
            engine.onError = { reason -> main.post { finish(reason) } }
            capture = engine
            val surface = engine.prepare()
            config.put("engine", engine.engine).put("audioTracks", JSONArray(engine.audioTracks))
            RunFolder.write(dir, runJson.put("config", config))
            Timeline.log("capture", "prepared", "engine" to engine.engine, "audioTracks" to engine.audioTracks.joinToString())
            if (engine.startBeforeDisplay) startCapture(engine)

            // Fixed encoder canvas for the whole run. Standard Android scales/letterboxes captured
            // content into it; no second virtual display or consent-token reuse on content resize.
            // Vendor compositor behaviour must be checked in the resulting frames, not inferred.
            display = projection!!.createVirtualDisplay(
                "PolydanceCapture", width, height, resources.displayMetrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, displayCallback, main,
            )
            Timeline.log("display", "created", "width" to width, "height" to height)
            if (!engine.startBeforeDisplay) startCapture(engine)
            if (engine is MuxerCapture) main.postDelayed(maxDuration, maxMinutes * 60_000L)
        } catch (e: Exception) {
            fail("recorder_setup_failed", e); return
        }
        running()
    }

    /** The engine has started: the deck and the heartbeat take over. */
    private fun running() {
        active = true
        CaptureState.recording = true
        CaptureState.startedElapsed = Timeline.anchorElapsed
        CaptureState.bytes = 0; CaptureState.heartbeats = 0; CaptureState.maxIntervalMs = 0
        lastBeatElapsed = SystemClock.elapsedRealtime(); lastBytes = 0
        registerScreenReceiver()
        main.postDelayed(heartbeat, HEARTBEAT_MS)
    }

    private fun startCapture(engine: Engine) {
        engine.start()
        Timeline.anchorElapsed = SystemClock.elapsedRealtime()
        // The take's 0:00 on the wall clock: its logs are read from here (DeviceLogs).
        CaptureState.runDir?.let { RunFolder.markZero(it, runJson) }
        Timeline.log("recorder", "started", "file" to output!!.absolutePath, "engine" to engine.engine)
    }

    private val maxDuration = Runnable { finish("max_duration") }

    private val heartbeat = object : Runnable {
        override fun run() {
            if (!active) return
            val now = SystemClock.elapsedRealtime()
            val interval = now - lastBeatElapsed
            lastBeatElapsed = now
            val bytes = output?.length() ?: 0L
            val delta = bytes - lastBytes
            lastBytes = bytes
            val levels = capture?.levels() ?: Levels(null, null, null)
            val amplitude = levels.micPeak
            val power = getSystemService(PowerManager::class.java)
            val process = ActivityManager.RunningAppProcessInfo().also { ActivityManager.getMyMemoryState(it) }

            CaptureState.heartbeats += 1
            CaptureState.bytes = bytes
            CaptureState.bytesPerSecond = if (interval > 0) delta * 1000 / interval else 0
            CaptureState.micAmplitude = amplitude
            CaptureState.appAmplitude = levels.appPeak
            CaptureState.framesPerBeat = levels.videoFrames
            if (interval > CaptureState.maxIntervalMs) CaptureState.maxIntervalMs = interval
            CaptureState.away?.let { away ->
                if (interval > away.maxIntervalMs) away.maxIntervalMs = interval
                if ((amplitude ?: 0) > away.micPeak) away.micPeak = amplitude ?: 0
                if ((levels.appPeak ?: 0) > away.appPeak) away.appPeak = levels.appPeak ?: 0
            }
            Timeline.log(
                "service", "heartbeat",
                "n" to CaptureState.heartbeats, "intervalMs" to interval, "bytes" to bytes, "bytesDelta" to delta,
                "mic" to amplitude, "app" to levels.appPeak, "frames" to levels.videoFrames, "interactive" to power.isInteractive, "importance" to process.importance,
                "activity" to CaptureState.activityState,
            )
            if (CaptureState.heartbeats % 5 == 0) {
                val seconds = (now - CaptureState.startedElapsed) / 1000
                val text = String.format(Locale.US, "Recording %d:%02d · %.1f MB", seconds / 60, seconds % 60, bytes / 1_048_576.0)
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
            }
            main.postDelayed(this, HEARTBEAT_MS)
        }
    }

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            // The system ends a projection when another app takes a token, when the user revokes it,
            // or for reasons of its own. This is the event the spike most needs to see if it happens.
            Timeline.log("projection", "stop", "duringFinish" to finishing)
            if (active && !finishing) finish("projection_stopped")
        }

        override fun onCapturedContentResize(width: Int, height: Int) {
            // Both engines have a fixed-size encoding surface. Keep the canvas stable when the
            // capture changes; record the actual source geometry instead of claiming a crop-free fit.
            Timeline.log("projection", "content_resize", "width" to width, "height" to height,
                "resizePolicy" to "fixed_output_canvas", "outputWidth" to config.optInt("width"), "outputHeight" to config.optInt("height"))
        }

        override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
            Timeline.log("projection", "content_visible", "visible" to isVisible)
        }
    }

    private val displayCallback = object : VirtualDisplay.Callback() {
        override fun onPaused() { Timeline.log("display", "paused") }
        override fun onResumed() { Timeline.log("display", "resumed") }
        override fun onStopped() { Timeline.log("display", "stopped") }
    }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            Timeline.log("system", "screen", "action" to intent.action)
        }
    }
    private var screenReceiverRegistered = false

    private fun registerScreenReceiver() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, filter, RECEIVER_NOT_EXPORTED)
        else registerReceiver(screenReceiver, filter)
        screenReceiverRegistered = true
    }

    /** Idempotent. Stops in the order that leaves a playable file, records how it went, then exits. */
    private fun finish(reason: String) {
        if (finishing) return
        finishing = true
        main.removeCallbacks(heartbeat)
        CaptureState.endReason = reason
        Timeline.log("service", "finishing", "reason" to reason)
        main.removeCallbacks(maxDuration)
        capture?.let { engine ->
            val error = runCatching { engine.stop() }.getOrElse { it.toString() }
            if (error == null) Timeline.log("recorder", "stopped", "bytes" to output?.length())
            else Timeline.log("recorder", "stop_failed", "error" to error, "bytes" to output?.length())
        }
        capture = null
        runCatching { display?.release() }
        display = null
        projection?.let { p -> runCatching { p.unregisterCallback(projectionCallback) }; runCatching { p.stop() } }
        projection = null
        if (screenReceiverRegistered) { runCatching { unregisterReceiver(screenReceiver) }; screenReceiverRegistered = false }

        val endedAt = System.currentTimeMillis()
        // Taken before the timeline closes, which forgets the anchor: the hold after Stop is longer for a short take.
        val ranMs = if (Timeline.anchorElapsed >= 0) SystemClock.elapsedRealtime() - Timeline.anchorElapsed else null
        val summary = JSONObject()
            .put("reason", reason).put("endedAt", endedAt)
            .put("durationMs", ranMs ?: JSONObject.NULL)
            .put("bytes", output?.length() ?: 0).put("heartbeats", CaptureState.heartbeats)
            .put("maxHeartbeatIntervalMs", CaptureState.maxIntervalMs).put("config", config)
        Timeline.log("service", "run_end", "summary" to summary)
        CaptureState.runDir?.let { dir -> runCatching { File(dir, "summary.json").writeText(summary.toString(2)) } }
        // Which apps were in front, from the system's usage log, before the upload is queued so it goes too.
        CaptureState.runDir?.let { dir -> AppSwitches.record(this, dir, endedAt) }
        Timeline.close()
        // Every run that produced a file goes to the receiver; the upload is a separate job that outlives this service.
        // One cancelled on the deck is deleted here and never queued (CAP-1 #24, 01:16 to 01:31). With Logs on, the
        // take's logs are read first, the service staying in the foreground meanwhile so the process is kept.
        val discard = CaptureState.discard
        CaptureState.discard = false
        val dir = CaptureState.runDir
        val produced = (output?.length() ?: 0L) > 0
        val done = {
            handingOff = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        when {
            dir == null -> done()
            discard -> {
                Log.i("PolydanceCapture", "recording ${dir.name} cancelled: deleted ${runCatching { dir.deleteRecursively() }.getOrDefault(false)}")
                done()
            }
            else -> {
                if (logs && produced) getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification("Reading the headset's logs"))
                handingOff = true
                RunFolder.handOff(this, dir, send = produced, logs = logs && produced, ranMs = ranMs, done = done)
            }
        }
        active = false
        CaptureState.recording = false
    }

    private fun fail(what: String, error: Exception?) {
        Timeline.log("service", what, "error" to error?.toString())
        finish(what)
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Closing the panel removes the task; the service is not stopWithTask, so recording continues.
        Timeline.log("service", "task_removed")
        super.onTaskRemoved(rootIntent)
    }

    override fun onTrimMemory(level: Int) {
        Timeline.log("service", "trim_memory", "level" to level)
        super.onTrimMemory(level)
    }

    override fun onDestroy() {
        Timeline.log("service", "destroy", "wasActive" to active)
        if (active) finish("service_destroyed")
        super.onDestroy()
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1, stopIntent(this), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("Polydance")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }
}
