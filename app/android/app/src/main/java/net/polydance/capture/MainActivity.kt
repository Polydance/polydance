package net.polydance.capture

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.CheckBox
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import net.polydance.capture.platform.headsetPlatform
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Polydance's screen. The main view is a 1960s portable deck on a light wooden cabinet (design
 * passes three to five, sessions 2026-10-01T23-29-57 to 2026-10-02T00-33-28): a cream plate with two
 * reels that show storage as tape; a black control panel with the MIC and APP meters, each carrying its
 * track's OFF/ON switch, the UPLOAD and PROCESSING lamps left of a rolling counter (amber and cyan,
 * flashing while a recording goes up or is built) and REC and READY right of it, and a red RECORDING
 * key; the transfer bar under the panel came off in the eighth pass (2026-10-05). The
 * rack of recordings came off in the sixth pass (2026-10-04, thread CAP-1): recordings live in the inbox,
 * a panel beside the deck, which pressing record opens on the recording's thread. Every plate is screwed on. Settings and everything diagnostic (device,
 * clock, live stats, the away line, events) sit behind the gear. The bug key beside it records a report for the Polydance team (Reports,
 * 2026-10-12): a recording like any other, after a pop-up that says what it is for, that goes to no thread of the sender's. Every lifecycle callback is still written to the timeline, because "hidden" and
 * "back" are defined by this activity's onStop and onStart. adb can drive the same flow with the START
 * and STOP actions (see README).
 *
 * What a take records is four switches (Takes, docs/LOGS.md, 2026-11-16), kept with a reply's Settings in the
 * "settings" preferences: Screen, Mic, App sound and Logs. With Screen off there is no screen-capture prompt: Mic on
 * starts the recorder service for the mic alone, Mic off starts a take of logs alone (LogsTake), which no service
 * holds. A take with Logs on reads the headset's logs when it stops, from here, where Polydance is on top.
 */
class MainActivity : Activity() {

    companion object {
        const val ACTION_START = "net.polydance.capture.START"
        const val ACTION_STOP = "net.polydance.capture.STOP"
        /** adb only: `--es server https://host --es token polycap_...`; see `npm run app -- configure`. */
        const val ACTION_CONFIGURE = "net.polydance.capture.CONFIGURE"
        /** adb only: `--es run 20261001-161948` queues that recording, the same as its Upload button. */
        const val ACTION_UPLOAD = "net.polydance.capture.UPLOAD"
        /** From the inbox: record a thread reply, optionally running a message's launch. */
        const val ACTION_START_THREAD = "net.polydance.capture.START_THREAD"
        /** From the inbox's +: record a new thread in the chosen project. */
        const val ACTION_START_NEW_THREAD = "net.polydance.capture.START_NEW_THREAD"
        /** From a reply's notification: the deck with the inbox beside it, on the thread. */
        const val ACTION_OPEN_THREAD = "net.polydance.capture.OPEN_THREAD"
        /** The deck's column, in dp: the reels and the control panel, beside the inbox. */
        private const val DECK_WIDTH = 420f
        /**
         * This activity is exported (it is the launcher's), so any app on the headset could send it these
         * actions. The adb ones do nothing in a store build, and the inbox's starts carry [INTERNAL], a token
         * made fresh in each process, which another app cannot know.
         */
        private val ADB_ONLY = setOf(ACTION_START, ACTION_STOP, ACTION_CONFIGURE, ACTION_UPLOAD)
        const val EXTRA_INTERNAL = "internal"
        /** With [ACTION_START_NEW_THREAD]: addresses copied in from the inbox's New thread (Invites). */
        const val EXTRA_INVITE = "invite"
        val INTERNAL: String = UUID.randomUUID().toString()
        private const val REQUEST_PERMISSIONS = 1
        private const val REQUEST_CONSENT = 2
        private const val REQUEST_NOTIFICATIONS = 3
    }

    private val ui = Handler(Looper.getMainLooper())
    private val clockFormat = SimpleDateFormat("HH:mm:ss.S", Locale.US)
    // Main view: the deck and the rack.
    private lateinit var mainView: View
    private lateinit var deck: DeckView
    private lateinit var micMeter: VuMeter
    private lateinit var appMeter: VuMeter
    private lateinit var recLamp: Lamp
    private lateinit var readyLamp: Lamp
    private lateinit var uploadLamp: Lamp
    private lateinit var processingLamp: Lamp
    private lateinit var counter: RollingCounter
    private lateinit var recordKey: RecordKey
    private lateinit var cancelKey: TextView
    private lateinit var subText: TextView
    private lateinit var notice: TextView
    /** The inbox's two columns, to the right of the deck in this one panel (2026-10-20). */
    private lateinit var inbox: InboxPane
    /** Where the next recording goes, or where this one is going: a thread, or a new thread in a project. */
    private lateinit var destinationLine: TextView
    // Behind the gear.
    private lateinit var settingsView: View
    private lateinit var clock: TextView
    private lateinit var status: TextView
    private lateinit var awayLine: TextView
    private lateinit var events: TextView
    private lateinit var serverLine: TextView
    private lateinit var appsLine: TextView
    private lateinit var appsButton: TextView
    private lateinit var repliesLine: TextView
    private lateinit var repliesButton: TextView
    private lateinit var qualities: RadioGroup
    /** The radio buttons' ids, in [RecordingQuality.entries] order. */
    private val qualityIds = mutableListOf<Int>()
    private lateinit var qualityDetail: TextView
    private lateinit var screen: CheckBox
    private lateinit var mic: CheckBox
    private lateinit var appAudio: CheckBox
    private lateinit var logs: CheckBox
    /** Under App sound behind the gear: why it is off while Screen is. */
    private lateinit var appAudioWhy: TextView
    /** Set while the switches are drawn from the preferences, so drawing never writes them back. */
    private var syncing = false
    private var platformPermission: CheckBox? = null
    private var maxMinutes = 30
    private var consentAskedAt = 0L
    private var ticks = 0
    private val requestState = RecordingRequestState()
    private val starting: Boolean get() = requestState.starting
    private val background = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The search field must not raise the keyboard by itself when the panel opens.
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        inbox = InboxPane(this)
        setContentView(buildUi())
        inbox.show(null, null)
        lifecycle("create")
        Replies.schedule(this)
        // A recreated activity or a launch from recents would replay an old START; only fresh intents act.
        val fromHistory = (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
        if (savedInstanceState == null && !fromHistory) handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        Timeline.log("activity", "new_intent", "action" to intent.action)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        lifecycle("start")
        CaptureState.endAway()?.let { awayLine.text = it }
    }

    override fun onResume() {
        super.onResume()
        lifecycle("resume")
        ui.removeCallbacks(refresh)
        ui.post(refresh)
        ui.removeCallbacks(threadPoll)
        ui.post(threadPoll)
        ui.removeCallbacks(serverPoll)
        ui.post(serverPoll)
        inbox.resume()
        signIn.ensure(this)
        // A flavor whose sign-in needs the screen (Android XR's Google) tries a returning account quietly.
        if (signIn.interactive && UploadSettings.load(this) == null) signIn.begin(this, quiet = true)
        // Back from the app under test while a thread is recording: one press finishes and sends it.
        if (CaptureState.recording) destinationText(CaptureState.destination).takeIf { it.isNotEmpty() }?.let { notify("Recording $it. Press the key to finish and send.") }
    }

    override fun onPause() {
        lifecycle("pause")
        ui.removeCallbacks(refresh)
        ui.removeCallbacks(threadPoll)
        ui.removeCallbacks(serverPoll)
        inbox.pause()
        super.onPause()
    }

    override fun onStop() {
        lifecycle("stop")
        CaptureState.beginAway()
        super.onStop()
    }

    override fun onDestroy() {
        lifecycle("destroy")
        inbox.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        Timeline.log("activity", "focus", "has" to hasFocus)
    }

    override fun onTopResumedActivityChanged(isTopResumedActivity: Boolean) {
        super.onTopResumedActivityChanged(isTopResumedActivity)
        Timeline.log("activity", "top_resumed", "is" to isTopResumedActivity)
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        Timeline.log("activity", "trim_memory", "level" to level)
    }

    private fun lifecycle(state: String) {
        CaptureState.activityState = state
        Timeline.log("activity", state)
    }

    /** adb: `am start -n <pkg>/.MainActivity -a <ACTION_START> --es quality low --ez mic false`. */
    private fun handle(intent: Intent?) {
        val action = intent?.action ?: return
        if (!BuildConfig.DEBUG && action in ADB_ONLY) {
            Timeline.log("probe", "action_ignored", "action" to action, "why" to "adb only; this is a store build")
            return
        }
        if ((action == ACTION_START_THREAD || action == ACTION_START_NEW_THREAD) && intent.getStringExtra(EXTRA_INTERNAL) != INTERNAL) {
            Timeline.log("probe", "action_ignored", "action" to action, "why" to "not from this app's inbox")
            return
        }
        // Do not apply adb settings or replace a thread/launch while an earlier start is unresolved.
        if (action in setOf(ACTION_START, ACTION_START_THREAD, ACTION_START_NEW_THREAD) && !requestState.canStart(CaptureState.occupied)) {
            startIgnored()
            return
        }
        when (action) {
            ACTION_START -> requestStart {
                if (intent.hasExtra("quality")) {
                    val quality = RecordingQuality.parse(intent.getStringExtra("quality"))
                    if (quality != null) checkQuality(quality)
                    else Timeline.log("probe", "quality_ignored", "quality" to intent.getStringExtra("quality"), "why" to "not low, medium or high")
                }
                if (intent.hasExtra("screen")) screen.isChecked = intent.getBooleanExtra("screen", true)
                if (intent.hasExtra("mic")) mic.isChecked = intent.getBooleanExtra("mic", true)
                if (intent.hasExtra("appAudio")) appAudio.isChecked = intent.getBooleanExtra("appAudio", true)
                if (intent.hasExtra("logs")) logs.isChecked = intent.getBooleanExtra("logs", true)
                if (intent.hasExtra("spatial")) platformPermission?.isChecked = intent.getBooleanExtra("spatial", false)
                maxMinutes = intent.getIntExtra("maxMinutes", maxMinutes).coerceIn(1, 180)
                snapshotRequest()
            }
            ACTION_STOP -> requestStop()
            ACTION_OPEN_THREAD -> {
                Timeline.log("replies", "opened", "thread" to intent.getStringExtra("thread"))
                openInbox(intent.getStringExtra("thread"))
            }
            ACTION_START_THREAD -> requestStart {
                val key = intent.getStringExtra("thread")
                // The box beside START unticked: record the reply and open nothing (eighth pass, 2026-10-05).
                val open = intent.getBooleanExtra("open", true)
                val launch = runCatching { Threads.parseLaunch(JSONObject(intent.getStringExtra("launchJson") ?: "")) }.getOrNull()
                if (key.isNullOrBlank() || (open && launch?.steps == null)) { notify("That launch cannot run on this build of Polydance."); return@requestStart null }
                val index = intent.getIntExtra("launch", -1).takeIf { it >= 0 && open }
                val message = intent.getIntExtra("message", 0).takeIf { it > 0 }
                Timeline.log("thread", "start_requested", "key" to key, "open" to open, "launch" to (launch?.raw?.toString()?.take(300) ?: ""))
                snapshotRequest(
                    destination = Threads.destination(this, key, message, index),
                    launch = if (open) launch else null,
                    from = message to index?.takeIf { intent.getIntExtra("options", 1) > 1 },
                )
            }
            ACTION_START_NEW_THREAD -> requestStart {
                Threads.openKey = null
                val destination = Threads.destination(this, key = null)
                // Only a new thread takes addresses this way; an existing one has Forward in the inbox.
                val invite = intent.getStringArrayListExtra(EXTRA_INVITE)?.takeIf { it.isNotEmpty() && destination?.has("project") == true }
                snapshotRequest(destination = destination, invite = invite?.toList())
            }
            ACTION_UPLOAD -> {
                val run = intent.getStringExtra("run") ?: ""
                val known = Recording.all(this).any { it.name == run }
                Timeline.log("probe", "upload_requested", "run" to run, "known" to known)
                if (known) Uploads.enqueue(this, run, restart = true)
            }
            ACTION_CONFIGURE -> {
                val previous = UploadSettings.load(this)?.server
                val error = UploadSettings.save(this, intent.getStringExtra("server") ?: "", intent.getStringExtra("token") ?: "")
                if (error == null && previous != null && previous != UploadSettings.load(this)?.server) {
                    Uploads.forgetServer(this)
                    StorageStatus.forget(this)
                }
                // The token itself is never logged.
                Timeline.log("probe", "configure", "server" to intent.getStringExtra("server"), "ok" to (error == null), "error" to error)
                notify(error?.let { "Server not saved: $it" } ?: "Server saved. Waiting recordings will upload.")
                if (error == null) Uploads.resumeWaiting(this)
                intent.removeExtra("token")
            }
        }
    }

    private fun startIgnored() {
        Timeline.log("probe", "start_ignored", "why" to "already recording or awaiting start")
        notify(when {
            CaptureState.recording -> "Already recording. Stop on the deck before starting another reply."
            CaptureState.readingLogs -> "Still reading the last take's logs. Try again in a moment."
            else -> "A recording start is already pending. Finish the permissions and capture dialog first."
        })
    }

    /**
     * SharedPreferences.apply updates memory synchronously, including the checkbox/adb listeners. App sound shows off
     * with Screen off, without forgetting its own setting for when Screen comes back.
     */
    private fun rememberedQuality(prefs: SharedPreferences) = RecordingQuality.remembered(
        prefs.getString("quality", null), if (prefs.contains("preset")) prefs.getInt("preset", 0) else null,
    )

    private fun checkedQuality(): RecordingQuality =
        RecordingQuality.entries.getOrNull(qualityIds.indexOf(qualities.checkedRadioButtonId)) ?: RecordingQuality.DEFAULT

    private fun checkQuality(quality: RecordingQuality) {
        qualities.check(qualityIds[quality.ordinal])
        qualityDetail.text = quality.detail
    }

    private fun refreshRecordingSettings() {
        val prefs = getSharedPreferences("settings", MODE_PRIVATE)
        syncing = true
        try {
            screen.isChecked = prefs.getBoolean("screen", true)
            mic.isChecked = prefs.getBoolean("mic", true)
            appAudio.isChecked = prefs.getBoolean("appAudio", true) && screen.isChecked
            logs.isChecked = prefs.getBoolean("logs", true)
        } finally { syncing = false }
        checkQuality(rememberedQuality(prefs))
        headsetPlatform.capturePermission?.let { permission ->
            platformPermission?.isChecked = prefs.getBoolean("spatial", permission.defaultEnabled)
        }
    }

    /** [report]: the bug key's recording stays as it was before the switches: the picture, and no logs. */
    private fun snapshotRequest(
        destination: JSONObject? = Threads.destination(this),
        launch: Threads.Launch? = null,
        from: Pair<Int?, Int?> = null to null,
        openInbox: Boolean = false,
        invite: List<String>? = null,
        report: Boolean = false,
    ): RecordingRequest {
        val quality = checkedQuality()
        val app = if (report) getSharedPreferences("settings", MODE_PRIVATE).getBoolean("appAudio", true) else appAudio.isChecked
        return RecordingRequest(
            quality.width, quality.height, quality.bitrate, mic.isChecked, app && (report || screen.isChecked), maxMinutes,
            destination?.toString(), launch?.raw?.toString(), from.first, from.second, openInbox,
            platformPermission?.isChecked == true, invite,
            screen = report || screen.isChecked, logs = !report && logs.isChecked,
        )
    }

    /** Refuse now rather than queueing a surprise recording when the flavor's gate (Quest: entitlement) opens later. */
    private fun recordingAllowed(): Boolean {
        if (signIn.mayRecord()) return true
        signIn.ensure(this)
        requestState.reset()
        notify(signIn.refusedText())
        return false
    }

    /** [report]: the bug key's recording, which is not on the tape, so a full tape does not stop it ("storage is full" may be the bug). */
    private fun requestStart(report: Boolean = false, prepare: () -> RecordingRequest? = { snapshotRequest() }) {
        if (!requestState.canStart(CaptureState.occupied)) { startIgnored(); return }
        if (!recordingAllowed()) return
        // The notice before the first recording (private/docs/STORE.md); Agree comes back here with the same request.
        if (!Consent.accepted(this)) {
            Consent.ask(this, then = { requestStart(report, prepare) })
            return
        }
        val request = requestState.accept(CaptureState.occupied) {
            if (!report && StorageStatus.current(this).full) {
                Timeline.log("probe", "start_refused", "why" to "storage full")
                notify("Storage is full. Delete recordings, from the list key by the storage readout, to record again.")
                null
            } else {
                // MainActivity may still be paused behind a same-task inbox: do not wait for render.
                refreshRecordingSettings()
                prepare()?.also { r ->
                    // Every switch off: the key records nothing and says why.
                    if (r.kind == TakeKind.NONE) {
                        Timeline.log("probe", "start_refused", "why" to "nothing to record")
                        notify(TakeSwitches.NOTHING)
                    }
                }?.takeIf { it.kind != TakeKind.NONE }
            }
        } ?: return
        Timeline.beginRequest()
        // Both the microphone and in-app audio (playback capture) need RECORD_AUDIO; logs alone need neither.
        val wanted = buildList {
            if (request.mic || request.appAudio) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
            if (request.screen) addAll(headsetPlatform.additionalCapturePermissions(request.platformPermission))
        }
        val missing = wanted.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        Timeline.log("probe", "permissions", "held" to (wanted - missing.toSet()).joinToString(), "asking" to missing.joinToString(), "kind" to request.kind.id, "logs" to request.logs)
        try {
            if (missing.isEmpty()) proceed() else requestPermissions(missing.toTypedArray(), REQUEST_PERMISSIONS)
        } catch (e: RuntimeException) {
            requestState.reset()
            Timeline.log("probe", "permissions_unavailable", "error" to e.toString())
            notify("Recording could not start: ${e.message}")
        }
    }

    /** Behind the gear: on asks the headset for the permission first; off stops the checks and clears what is shown. */
    private fun toggleReplies() {
        when {
            Replies.enabled(this) && !Replies.allowed(this) -> notificationSettings()
            Replies.enabled(this) -> { Replies.turnOff(this); Timeline.log("replies", "off") }
            Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED ->
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            else -> repliesOn()
        }
        render()
    }

    private fun repliesOn() {
        if (!Replies.allowed(this)) { notify("The headset is blocking notifications from Polydance; allow them in its settings."); return }
        Replies.turnOn(this)
        Timeline.log("replies", "on")
    }

    private fun notificationSettings() {
        runCatching { startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)) }
            .onFailure { notify("This headset has no notification settings page for apps: $it") }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS) {
            val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            Timeline.log("replies", "permission", "granted" to granted)
            if (granted) repliesOn() else notify("Notifications stay off: the headset did not allow them.")
            render()
            return
        }
        if (requestCode != REQUEST_PERMISSIONS || requestState.phase != RecordingRequestState.Phase.PERMISSIONS) return
        if (grantResults.isEmpty()) {
            requestState.reset()
            notify("Permission request was cancelled, so nothing is recording.")
            return
        }
        permissions.forEachIndexed { i, name ->
            val granted = grantResults.getOrNull(i) == PackageManager.PERMISSION_GRANTED
            Timeline.log("probe", "permission_result", "name" to name, "granted" to granted)
            if (name == Manifest.permission.RECORD_AUDIO && !granted) {
                requestState.audioPermissionDenied()
                mic.isChecked = false
                appAudio.isChecked = false
                Timeline.log("probe", "mic_disabled", "why" to "RECORD_AUDIO denied; recording without sound")
            }
        }
        proceed()
    }

    /** After the permissions: the screen-capture consent for the picture, or straight on for a take without it. */
    private fun proceed() {
        val accepted = requestState.accepted ?: return
        if (accepted.screen) { requestConsent(); return }
        if (accepted.kind == TakeKind.NONE) {
            requestState.reset()
            notify("Nothing is recording: the microphone was not allowed, and Screen and Logs are off.")
            return
        }
        if (!recordingAllowed()) return
        val request = requestState.startWithoutPicture(SystemClock.elapsedRealtime()) ?: return
        try {
            if (request.kind == TakeKind.LOGS) {
                // Nothing records while it runs, so there is no service: the take is its run folder (LogsTake).
                LogsTake.begin(this, request.maxMinutes, request.destination, request.invite)?.let { why ->
                    requestState.reset()
                    notify("Nothing is recording: $why")
                    return
                }
            } else {
                // Sound alone: a microphone service, started now while this activity is in front (Android 14).
                startForegroundService(
                    RecorderService.startIntent(
                        this, 0, null, request.width, request.height, request.bitrate, request.mic, false, request.maxMinutes,
                        request.destination, request.invite?.let { ArrayList(it) }, screen = false, logs = request.logs,
                    ),
                )
            }
        } catch (e: RuntimeException) {
            requestState.reset()
            Timeline.log("probe", "service_start_failed", "error" to e.toString(), "kind" to request.kind.id)
            notify("Recording could not start: ${e.message}")
            return
        }
        afterStart(request)
    }

    private fun requestConsent() {
        if (!recordingAllowed()) return
        if (!requestState.requestConsent()) return
        val manager = getSystemService(MediaProjectionManager::class.java)
        // Prefer whole-display capture on Android 14+, retry plain consent for older vendor screens.
        val wholeDisplay = Build.VERSION.SDK_INT >= 34
        consentAskedAt = SystemClock.elapsedRealtime()
        Timeline.log("probe", "consent_requested", "wholeDisplayConfig" to wholeDisplay)
        try {
            val consent = if (wholeDisplay) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                else manager.createScreenCaptureIntent()
            startActivityForResult(consent, REQUEST_CONSENT)
        } catch (e: RuntimeException) {
            Timeline.log("probe", "consent_unavailable", "error" to e.toString(), "wholeDisplayConfig" to wholeDisplay)
            val fallback = e is ActivityNotFoundException && wholeDisplay && runCatching {
                startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CONSENT)
            }.onFailure {
                Timeline.log("probe", "consent_unavailable", "error" to it.toString(), "wholeDisplayConfig" to false)
            }.isSuccess
            if (!fallback) {
                requestState.reset()
                notify("Screen capture consent is unavailable on this device. Nothing is recording.")
            }
        }
    }

    @Deprecated("Activity result API without androidx; fine for a dependency-free probe.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CONSENT || requestState.phase != RecordingRequestState.Phase.CONSENT) return
        Timeline.log(
            "probe", "consent_result", "ok" to (resultCode == RESULT_OK && data != null),
            "resultCode" to resultCode, "waitedMs" to SystemClock.elapsedRealtime() - consentAskedAt,
        )
        if (resultCode != RESULT_OK || data == null) {
            requestState.reset()
            notify("Screen capture was declined, so nothing is recording.")
            return
        }
        if (!recordingAllowed()) return
        val request = requestState.consentGranted(SystemClock.elapsedRealtime()) ?: return
        try {
            startForegroundService(
                RecorderService.startIntent(
                    this, resultCode, data, request.width, request.height, request.bitrate, request.mic, request.appAudio, request.maxMinutes,
                    request.destination, request.invite?.let { ArrayList(it) }, screen = true, logs = request.logs,
                ),
            )
        } catch (e: RuntimeException) {
            requestState.reset()
            Timeline.log("probe", "service_start_failed", "error" to e.toString())
            notify("Recording could not start: ${e.message}")
            return
        }
        afterStart(request)
    }

    /** Once a take is starting: its launch, or the inbox on its thread, after it has begun. */
    private fun afterStart(request: RecordingRequest) {
        val launch = request.launchJson?.let { Threads.parseLaunch(JSONObject(it)) }
        val key = request.destination?.let { JSONObject(it).optString("key").ifEmpty { null } }
        // The launch opens what it names only after recording has begun, so the start of the test is on the video.
        if (launch != null) onceRecording(SystemClock.elapsedRealtime() + 10_000, "launch") {
            val failed = Threads.run(this, launch, key)
            if (Threads.opens(launch)) Threads.logOpened(launch, request.fromMessage, request.fromOption)
            if (failed.isNotEmpty()) notify(failed.joinToString("; "))
        }
        // Pressing record with the inbox closed opens it on the recording's thread (sixth pass, 2026-10-04).
        if (request.openInbox && launch == null) onceRecording(SystemClock.elapsedRealtime() + 10_000, "inbox") { if (key != null && Threads.openKey != key) openInbox(key) }
    }

    /** Runs [then] 0.7 s after recording has begun, or drops it if recording has not begun by [deadline]. */
    private fun onceRecording(deadline: Long, what: String, then: () -> Unit) {
        when {
            CaptureState.recording -> ui.postDelayed(then, 700)
            SystemClock.elapsedRealtime() > deadline -> Timeline.log("thread", "${what}_dropped", "why" to "recording did not start")
            else -> ui.postDelayed({ onceRecording(deadline, what, then) }, 150)
        }
    }

    /** Shows a thread or a page in the inbox beside the deck; the list with neither. */
    private fun openInbox(key: String? = null, page: String? = null) = inbox.show(key, page)

    /** "→ MUS-12 · New menu", "→ NEW THREAD · Marimba" or "→ REPORT · Polydance team" from a recording's thread. */
    private fun destinationText(json: String?): String {
        val j = json?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return ""
        if (Reports.isReport(j)) return "→ REPORT  ·  Polydance team"
        j.optString("key").takeIf { it.isNotEmpty() }?.let { key -> return "→ $key${Threads.openTitle?.takeIf { key == Threads.openKey }?.let { "  ·  $it" } ?: ""}" }
        j.optString("project").takeIf { it.isNotEmpty() }?.let { p -> return "→ NEW THREAD  ·  ${Threads.listing?.projects?.firstOrNull { it.key == p }?.name ?: p}" }
        return ""
    }

    /** How this headset's recordings are doing on the receiver, every 10 s, or 3 s while one is being processed. */
    private val serverPoll = object : Runnable {
        override fun run() {
            background.execute { ServerSync.poll(this@MainActivity) }
            signIn.ensure(this@MainActivity)
            ui.postDelayed(this, if (ServerSync.busy(this@MainActivity)) 3_000 else 10_000)
        }
    }

    /** The badge's count and the projects, every 15 s while the deck is showing. */
    private val threadPoll = object : Runnable {
        override fun run() {
            val config = UploadSettings.load(this@MainActivity)
            if (config != null) background.execute {
                runCatching { Threads.list(ReceiverClient(config)) }
                    .onSuccess { ui.post { render() } }
                    .onFailure { android.util.Log.w("PolydanceCapture", "threads poll failed: $it") }
            }
            ui.postDelayed(this, 15_000)
        }
    }

    /** Ends the recording and deletes it, uploading nothing, after one confirmation (CAP-1 #24). */
    private fun confirmCancel() {
        if (!CaptureState.recording) return
        AlertDialog.Builder(this).setTitle("Discard this recording?")
            .setMessage("It stops now and is deleted from this headset. Nothing is uploaded.")
            .setPositiveButton("Discard") { _, _ ->
                CaptureState.discard = true
                Timeline.log("probe", "cancel_recording")
                requestStop()
            }
            .setNegativeButton("Keep recording", null)
            .show()
    }

    /**
     * The bug key (2026-10-12): says what a report is for, then records one like any recording. Its thread is
     * `{ "report": true }`, so the receiver gives it to the Polydance team and to no thread of the sender's;
     * nothing opens beside the deck, and the headset's copy goes once it is sent (Reports).
     */
    private fun confirmReport() {
        Timeline.log("report", "key")
        if (CaptureState.occupied || starting) { notify("Finish this recording first: press the key to stop it, then report."); return }
        // A receiver that says it takes no reports has nowhere to send one; an unknown answer (offline, older) does not stop it.
        if (Threads.listing?.reports == false) {
            AlertDialog.Builder(this).setTitle("Reports are not set up")
                .setMessage("This server does not take reports yet, so there is nowhere to send one. Tell the Polydance team another way.")
                .setPositiveButton("Close", null).show()
            return
        }
        AlertDialog.Builder(this).setTitle("Report a bug or suggest a feature")
            .setMessage(
                "Use this for Polydance itself: something broken, confusing or slow, or a feature you would like.\n\n" +
                    "Start recording, then show us what happened and say what you expected, or describe what you would like. " +
                    "Press the red key to stop when you are done; Cancel beside it throws the recording away.\n\n" +
                    "Your report goes only to the Polydance team. It does not appear in your inbox, and it is deleted from this headset once it has been sent.\n\n" +
                    "Feedback on an app you are testing belongs in its thread in the inbox.",
            )
            .setPositiveButton("Start recording") { _, _ -> startReport() }
            .setNegativeButton("Cancel") { _, _ -> Timeline.log("report", "cancelled") }
            .show()
    }

    private fun startReport() {
        Timeline.log("report", "start_requested")
        requestStart(report = true) { snapshotRequest(destination = Reports.destination(), report = true) }
    }

    /** A take of logs alone stops here, while Polydance is on top for Android's prompt; the others in their service. */
    private fun requestStop() {
        when {
            LogsTake.running() -> LogsTake.stop(this, "user")
            CaptureState.recording -> startService(RecorderService.stopIntent(this))
            else -> Timeline.log("probe", "stop_ignored", "why" to "not recording")
        }
        render()
    }

    private val refresh = object : Runnable {
        override fun run() {
            clock.text = clockFormat.format(Date())
            if (ticks++ % 5 == 0) render()
            ui.postDelayed(this, 100)
        }
    }

    private val clearNotice = Runnable { notice.text = ""; notice.visibility = View.GONE }

    /** A short message under the state line that fades after a few seconds. */
    private fun notify(text: String) {
        notice.text = text
        notice.visibility = View.VISIBLE
        ui.removeCallbacks(clearNotice)
        ui.postDelayed(clearNotice, 8000)
    }

    private fun render() {
        val all = Recording.all(this)
        val list = all.filterNot { it.report }
        val storage = StorageStatus.current(this, list)
        val recording = CaptureState.recording
        val readingLogs = CaptureState.readingLogs
        val kind = CaptureState.kind
        if (requestState.observe(recording, SystemClock.elapsedRealtime())) {
            notify("Recording did not start. You can try again.")
        }

        recordKey.mode = when {
            recording -> RecordKey.Mode.RECORDING
            starting || readingLogs -> RecordKey.Mode.STARTING
            storage.full || !signIn.mayRecord() -> RecordKey.Mode.DISABLED
            else -> RecordKey.Mode.READY
        }
        val seconds = if (recording) (SystemClock.elapsedRealtime() - CaptureState.startedElapsed) / 1000 else 0
        counter.seconds = seconds
        // The inbox's Settings share the switches (CAP-1 #24, and Screen and Logs since 2026-11-16): pick up a change made there.
        if (!recording && !starting) refreshRecordingSettings()
        val idle = !recording && !starting && !readingLogs
        cancelKey.visibility = if (recording) View.VISIBLE else View.GONE
        micMeter.active = recording && mic.isChecked && kind != TakeKind.LOGS
        appMeter.active = recording && appAudio.isChecked && kind == TakeKind.VIDEO
        micMeter.switchOn = mic.isChecked; micMeter.switchEnabled = idle
        // App sound rides on the screen capture: off and locked while Screen is off, and a press says why.
        appMeter.switchOn = appAudio.isChecked; appMeter.switchEnabled = idle && screen.isChecked
        appAudioWhy.visibility = if (screen.isChecked) View.GONE else View.VISIBLE
        recLamp.lit = recording
        readyLamp.lit = idle && !storage.full && signIn.mayRecord()
        // UPLOAD and PROCESSING flash in their colours while any recording is going up or being built; each
        // recording's progress is on its card in the inbox (eighth pass, 2026-10-05: the transfer bar came off).
        uploadLamp.lit = all.any { it.upload.state == "uploading" }
        processingLamp.lit = list.any { it.upload.state == "uploaded" && it.upload.server !in setOf("ready", "failed", "deleted") }

        // Storage is the tape on the reels; they turn only while recording to tape (sixth pass, 2026-10-04).
        deck.spin = if (recording) 1 else 0
        deck.full = storage.full
        deck.used = if (storage.allowanceBytes == null || UploadSettings.load(this) == null) null else storage.fraction.toFloat().coerceIn(0f, 1f)
        deck.storageLabel = storage.allowanceBytes?.let { String.format(Locale.US, "%.1f / %.0f GB", storage.totalBytes / 1e9, it / 1e9) } ?: ""

        // The lamps and the key carry the state; words appear only when something needs doing.
        subText.text = when {
            readingLogs -> "Reading the headset's logs. If the headset asks, allow it to include other apps' logs."
            requestState.phase == RecordingRequestState.Phase.WAITING_SERVICE -> "Starting recording…"
            !recording && !signIn.mayRecord() -> signInText()
            starting -> "Allow the permissions and the capture dialog."
            storage.full && !recording -> "Tape full: delete recordings, from the list key by the storage readout, to record again."
            UploadSettings.load(this) == null -> signInText()
            // Nothing else on the deck moves for logs alone: say what to do.
            recording && kind == TakeKind.LOGS -> "Keeping the headset's logs. Try what you are testing, then press the key here to send them."
            // A report is nowhere else on screen, so one the receiver refused is told here (Reports).
            !recording -> all.firstOrNull { it.report && it.upload.state == "failed" }?.let { "A report could not be sent: ${it.upload.error ?: "refused"}. Polydance tries again each time it starts, for a week." } ?: ""
            else -> ""
        }
        subText.visibility = if (subText.text.isEmpty()) View.GONE else View.VISIBLE

        for (v in listOfNotNull<View>(qualities, screen, mic, logs, platformPermission)) v.isEnabled = idle
        appAudio.isEnabled = idle && screen.isChecked
        for (i in 0 until qualities.childCount) qualities.getChildAt(i).isEnabled = idle
        status.text = if (recording && kind == TakeKind.LOGS) {
            String.format(Locale.US, "● KEEPING LOGS %d:%02d\nnothing records until Stop, when the logs are read\n%s", seconds / 60, seconds % 60, CaptureState.runDir?.absolutePath ?: "")
        } else if (recording) {
            String.format(
                Locale.US,
                "● RECORDING %d:%02d%s\nfile %.1f MB · %d KB/s · video %s fps\nheartbeats %d · longest gap %.2f s\nmic level %s · app audio level %s\n%s",
                seconds / 60, seconds % 60, if (kind == TakeKind.SOUND) " (sound only)" else "", CaptureState.bytes / 1_048_576.0, CaptureState.bytesPerSecond / 1024,
                CaptureState.framesPerBeat?.toString() ?: "?", CaptureState.heartbeats, CaptureState.maxIntervalMs / 1000.0,
                CaptureState.micAmplitude?.toString() ?: "off", CaptureState.appAmplitude?.toString() ?: "off",
                CaptureState.runDir?.absolutePath ?: "",
            )
        } else {
            val last = CaptureState.endReason?.let { "\nLast run ended: $it\n${CaptureState.runDir?.absolutePath ?: ""}" } ?: ""
            "○ Not recording$last"
        }
        awayLine.setTextColor(if (awayLine.text.contains("ALIVE")) Retro.GREEN else Retro.RED)
        serverLine.text = UploadSettings.load(this)?.let { c -> "Server: ${c.server}" + (c.accountName?.let { "\n" + signIn.signedInAs(it) } ?: "") }
            ?: "Server: not connected. ${signInText()}"
        val usage = AppSwitches.allowed(this)
        appsLine.text = if (usage) "On: each recording notes which app was in front and its version, so the review knows the build."
            else "Off: allow Usage access and each recording will note which app was in front and its version (the browser or the app itself)."
        appsButton.visibility = if (usage || !BuildConfig.DEBUG) View.GONE else View.VISIBLE
        val repliesOn = Replies.enabled(this); val repliesAllowed = Replies.allowed(this)
        repliesLine.text = when {
            repliesOn && repliesAllowed -> "On: a notification in the headset when someone replies in a thread you have not read. Checked every 15 minutes."
            repliesOn -> "On, but the headset is blocking notifications from Polydance. Allow them in its settings."
            else -> "Off. Turn on for a notification in the headset when someone replies in a thread you have not read; the headset asks first."
        }
        repliesButton.text = when { repliesOn && !repliesAllowed -> "Headset settings"; repliesOn -> "Turn off"; else -> "Turn on" }
        events.text = Timeline.recentLines(14).joinToString("\n")
        destinationLine.text = destinationText(if (recording) CaptureState.destination else if (starting) requestState.accepted?.destination else Threads.destination(this)?.toString())
        destinationLine.visibility = if (destinationLine.text.isEmpty()) View.GONE else View.VISIBLE
    }

    /** What the deck says while this headset has no token: how this flavor's sign-in is going. */
    private fun signInText(): String = signIn.deckText(this)

    private fun showSettings(show: Boolean) {
        settingsView.visibility = if (show) View.VISIBLE else View.GONE
        mainView.visibility = if (show) View.GONE else View.VISIBLE
        Timeline.log("probe", if (show) "settings_open" else "settings_close")
    }

    @Deprecated("Activity without androidx; onBackPressed still arrives on SDK 34 without the opt-in.")
    override fun onBackPressed() {
        if (settingsView.visibility == View.VISIBLE) showSettings(false)
        else if (!inbox.back()) @Suppress("DEPRECATION") super.onBackPressed()
    }

    private fun scroller(column: View) = ScrollView(this).apply {
        isFillViewport = true
        addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL))
    }

    private fun buildUi(): View {
        val pad = Retro.dp(this, 24f).toInt()
        val gap = { v: View, top: Float -> (v.layoutParams as? LinearLayout.LayoutParams ?: LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)).also { it.topMargin = Retro.dp(this, top).toInt(); v.layoutParams = it } }
        window.decorView.setBackgroundColor(Retro.WOOD_MID)

        // ---- Main: the cream deck plate and the black control panel; recordings are in the inbox.
        val column = ClampedColumn(this, Retro.dp(this, 640f).toInt()).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(pad / 2, pad / 2, pad / 2, pad)
        }
        deck = DeckView(this).apply { onStorage = { Timeline.log("inbox", "recordings_from_deck"); openInbox(page = InboxPane.PAGE_RECORDINGS) } }
        val plateFrame = FrameLayout(this)
        plateFrame.addView(deck, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        plateFrame.addView(GearIcon(this, Retro.PRINT, Retro.PLATE_LIGHT).apply { setOnClickListener { showSettings(true) } },
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
                topMargin = Retro.dp(this@MainActivity, 24f).toInt(); rightMargin = Retro.dp(this@MainActivity, 28f).toInt()
            })
        // The bug key, left of the gear (2026-10-12).
        plateFrame.addView(BugIcon(this, Retro.PRINT, Retro.PLATE_LIGHT).apply { setOnClickListener { confirmReport() } },
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
                topMargin = Retro.dp(this@MainActivity, 24f).toInt(); rightMargin = Retro.dp(this@MainActivity, 28f + 48f + 6f).toInt()
            })
        // The plate takes whatever height is left once the panel has its own: the reels grow into the space the
        // rack left (seventh pass, 2026-10-04) and the transfer bar's (eighth pass, 2026-10-05).
        column.addView(plateFrame, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        // The control panel: black, lettered in white, screwed to the cabinet at each corner.
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            val p = Retro.dp(context, 22f).toInt(); setPadding(p, p, p, Retro.dp(context, 16f).toInt())
            background = PlateDrawable(resources.displayMetrics.density)
        }
        val meters = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_HORIZONTAL; val p = Retro.dp(context, 20f).toInt(); setPadding(p, 0, p, 0) }
        // Each meter carries its track's OFF/ON switch (fourth pass, 00:21 to 00:45).
        micMeter = VuMeter(this, "MIC") { VuMeter.micLevel() }.apply { onSwitch = { mic.isChecked = !mic.isChecked; render() } }
        appMeter = VuMeter(this, "APP") { VuMeter.appLevel() }.apply {
            onSwitch = { appAudio.isChecked = !appAudio.isChecked; render() }
            onRefused = { if (!screen.isChecked && !CaptureState.occupied && !starting) notify(TakeSwitches.APP_NEEDS_SCREEN) }
        }
        meters.addView(micMeter, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = Retro.dp(this@MainActivity, 8f).toInt() })
        meters.addView(appMeter, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = Retro.dp(this@MainActivity, 8f).toInt() })
        panel.addView(meters, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        // Then only the counter and the big key (fourth pass, 01:05), with the REC and READY lamps either side.
        // The lamps and counter centred over the key; the row had been packed to the left (Robin, 2026-10-02).
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        recLamp = Lamp(this, "REC", Retro.RED, pulses = true)
        readyLamp = Lamp(this, "READY", Retro.GREEN, pulses = false)
        counter = RollingCounter(this)
        // UPLOAD and PROCESSING left of the counter, REC and READY right of it (eighth pass, 2026-10-05, 00:19 to 01:13).
        uploadLamp = Lamp(this, "UPLOAD", Retro.UPLOADING, pulses = true)
        processingLamp = Lamp(this, "PROCESSING", Retro.PROCESSING, pulses = true)
        controls.addView(uploadLamp)
        controls.addView(processingLamp)
        controls.addView(counter, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = Retro.dp(this@MainActivity, 12f).toInt(); rightMargin = Retro.dp(this@MainActivity, 12f).toInt()
        })
        controls.addView(recLamp)
        controls.addView(readyLamp)
        panel.addView(controls); gap(controls, 18f)
        recordKey = RecordKey(this).apply {
            setOnClickListener {
                if (!CaptureState.recording) { requestStart { snapshotRequest(openInbox = true) }; return@setOnClickListener }
                val report = Reports.isReport(CaptureState.destination)
                requestStop()
                if (report) notify("Thank you. Your report is on its way to the Polydance team.")
            }
        }
        // CANCEL, smaller, right under STOP while recording: ends it and deletes it (CAP-1 #24). It sat beside STOP
        // (CAP-5 at 0:39, 2026-10-13), with an invisible twin keeping STOP centred, until the one panel's 420 dp deck
        // squeezed it to an unreadable sliver (CAP-10, 2026-10-21); under STOP it has its full width.
        cancelKey = Retro.button(this, "Cancel", Retro.TAN, small = true) { confirmCancel() }.apply { visibility = View.GONE }
        val keyRow = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        keyRow.addView(recordKey, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        keyRow.addView(cancelKey, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = Retro.dp(this@MainActivity, 6f).toInt() })
        panel.addView(keyRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)); gap(keyRow, 10f)
        destinationLine = Retro.label(this, "", 13f, Retro.TAN, 0.14f).apply { gravity = Gravity.CENTER; visibility = View.GONE }
        panel.addView(destinationLine); gap(destinationLine, 4f)
        subText = Retro.body(this, 16f, Retro.TAN).apply {
            gravity = Gravity.CENTER; visibility = View.GONE
            // While there is no token, the sign-in line is the key that opens the account chooser.
            setOnClickListener {
                if (signIn.interactive && UploadSettings.load(this@MainActivity) == null) { signIn.begin(this@MainActivity, quiet = false); render() }
            }
        }
        panel.addView(subText); gap(subText, 2f)
        column.addView(panel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = Retro.dp(this@MainActivity, 10f).toInt() })

        notice = Retro.body(this, 17f, Retro.BURNT).apply { gravity = Gravity.CENTER; visibility = View.GONE }
        column.addView(notice); gap(notice, 8f)
        // The wood is on the scrolling content, full width, so it moves with the plates screwed to it
        // (Robin, 2026-10-02: it stayed put as the plates scrolled over it).
        val cabinet = FrameLayout(this).apply {
            background = WoodDrawable(resources.displayMetrics.density)
            addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER_HORIZONTAL))
        }
        mainView = scroller(cabinet)

        // ---- Behind the gear: settings and diagnostics.
        val settings = ClampedColumn(this, Retro.dp(this, 620f).toInt()).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad / 2, pad, pad) }
        val top = FrameLayout(this)
        top.addView(Retro.label(this, "SETTINGS", 22f, Retro.CREAM, 0.22f), FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.START or Gravity.CENTER_VERTICAL))
        top.addView(Retro.button(this, "Done", Retro.AMBER) { showSettings(false) }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.END or Gravity.CENTER_VERTICAL))
        settings.addView(top, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        fun section(title: String) = Retro.label(this, title, 14f, Retro.AMBER, 0.2f).also { settings.addView(it); gap(it, 26f) }
        fun line(size: Float, mono: Boolean = false, color: Int = Retro.CREAM) = Retro.body(this, size, color).apply {
            if (mono) typeface = Typeface.MONOSPACE
            setPadding(0, pad / 4, 0, pad / 4)
        }.also { settings.addView(it) }
        val tint = ColorStateList.valueOf(Retro.AMBER)

        section("RECORDING")
        line(17f).text = "Picture quality"
        qualities = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        for (quality in RecordingQuality.entries) {
            val button = RadioButton(this).apply { id = View.generateViewId(); text = quality.label; textSize = 17f; setTextColor(Retro.CREAM); buttonTintList = tint }
            qualityIds += button.id
            qualities.addView(button)
        }
        settings.addView(qualities)
        qualityDetail = line(14f, color = Retro.TAN)
        // Settings are remembered, so the defaults Robin chose stay chosen across launches.
        val prefs = getSharedPreferences("settings", MODE_PRIVATE)
        qualities.setOnCheckedChangeListener { _, _ ->
            val quality = checkedQuality()
            qualityDetail.text = quality.detail
            prefs.edit().putString("quality", quality.key).apply()
        }
        checkQuality(rememberedQuality(prefs))
        fun check(key: String, label: String, default: Boolean) = CheckBox(this).apply {
            text = label; textSize = 17f; setTextColor(Retro.CREAM); buttonTintList = tint
            isChecked = prefs.getBoolean(key, default)
            setOnCheckedChangeListener { _, on -> if (!syncing) prefs.edit().putBoolean(key, on).apply() }
        }.also { settings.addView(it) }
        // The reply's four switches (Takes): the same preferences as its Settings in the inbox.
        screen = check("screen", "Record the screen", true)
        mic = check("mic", "Record microphone", true)
        appAudio = check("appAudio", "Record in-app audio (separate track)", true)
        appAudioWhy = line(14f, color = Retro.TAN).apply { text = TakeSwitches.APP_NEEDS_SCREEN; visibility = View.GONE }
        logs = check("logs", "Keep the headset's logs", true)
        line(14f, color = Retro.TAN).text = "Logs: each take keeps Polydance's own log lines, and every app's once this headset has granted it " +
            "over adb (npm run app -- logs) and you allow the headset's prompt when a take stops on the deck."
        platformPermission = headsetPlatform.capturePermission?.let { check("spatial", it.label, it.defaultEnabled) }

        section("SERVER")
        serverLine = line(15f, color = Retro.TAN)
        line(15f, color = Retro.TAN).text = "Recordings upload by themselves when you press stop and keep going in the background. " +
            "Delete removes a recording from this headset and the server."

        // Debug builds only: the usage log needs a permission Meta's store refuses (src/debug/AndroidManifest.xml).
        val appsSection = section("APP SWITCHES")
        appsLine = line(15f, color = Retro.TAN)
        appsButton = Retro.button(this, "Allow usage access", Retro.AMBER) {
            Timeline.log("probe", "usage_access_settings")
            runCatching { startActivity(AppSwitches.settingsIntent(this)) }
                .onFailure { notify("This headset has no Usage access page: $it") }
        }
        settings.addView(appsButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        if (!BuildConfig.DEBUG) for (v in listOf(appsSection, appsLine, appsButton)) v.visibility = View.GONE

        section("NOTIFICATIONS")
        repliesLine = line(15f, color = Retro.TAN)
        repliesButton = Retro.button(this, "Turn on", Retro.AMBER) { toggleReplies() }
        settings.addView(repliesButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        section("DIAGNOSTICS")
        line(14f, color = Retro.TAN).text = headsetPlatform.label
        line(14f, color = Retro.TAN).text = "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) · ${Build.DISPLAY}"
        // From the installed package and its resources: compile-time constants are copied into each class and
        // can go stale in one that was not rebuilt (2026-10-05).
        val build = packageManager.getPackageInfo(packageName, 0)
        line(14f, color = Retro.TAN).text = "Polydance ${build.versionName} (${build.longVersionCode}) · commit ${getString(R.string.git_commit)}"
        clock = line(30f, mono = true)
        status = line(15f, mono = true)
        awayLine = line(17f)
        section("EVENTS")
        events = line(12f, mono = true, color = Retro.TAN)
        settingsView = scroller(settings).apply { visibility = View.GONE }

        // One panel (2026-10-20): the deck on the left, the inbox's columns beside it, like a desktop mail client.
        val deckColumn = FrameLayout(this).apply {
            setBackgroundColor(Retro.CASING)
            addView(mainView); addView(settingsView)
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Retro.WOOD_SEAM)
            addView(deckColumn, LinearLayout.LayoutParams(Retro.dp(this@MainActivity, DECK_WIDTH).toInt(), LinearLayout.LayoutParams.MATCH_PARENT))
            addView(inbox.view, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f).apply { leftMargin = Retro.dp(this@MainActivity, 2f).toInt() })
        }
    }
}
