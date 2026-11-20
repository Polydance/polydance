package net.polydance.capture

import android.app.AlertDialog
import android.app.Dialog
import android.content.ContextWrapper
import android.content.Intent
import android.content.SharedPreferences
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import net.polydance.capture.platform.headsetPlatform
import java.io.File
import java.text.SimpleDateFormat
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

/**
 * The inbox, in the same panel as the deck (Robin, 2026-10-20: several panels are hard to manage on Horizon
 * OS, so one widescreen panel laid out like a desktop mail client). Until then it was a panel of its own
 * beside the deck (2026-10-03), laid out like the Gmail mobile inbox (2026-10-12); it is now two columns
 * to the right of the deck:
 *  - the threads under a search bar, with the menu (Inbox or Archived, which projects, this headset's
 *    recordings) behind the three lines and this headset's person in the corner. Each row shows who is in
 *    the thread, its title, its latest words and the time of its last message, with a red lamp when
 *    something is unseen and amber while a launch waits. New thread, bottom right of the list, asks for a
 *    project and the people to copy in by email, then records. With nothing open the list takes the width;
 *  - a thread opens in a wider column on the right, under a bar with close, Archive, Delete and more: its
 *    title with its project as a label, who is in it, and its messages, the earlier ones folded to a line
 *    each and the latest open in full with its launches, recording, reactions and any 3D model, drawn in
 *    the message (ModelView). Reply (with a camera: it records), Share and a smiley stay at its foot;
 *  - Recordings, local copies to manage plus this account's server history, open in that column too.
 * A narrow panel shows the open thread in place of the list. Reply hands the launch to the deck, which asks
 * for capture, records and then opens what it names. Polls the receiver while showing (the list every
 * 10 s, a thread every 5 s) and this headset's own recordings every second while one is moving.
 * [host] owns the lifecycle and calls [resume], [pause], [destroy], [back] and [show].
 */
class InboxPane(private val host: MainActivity) : ContextWrapper(host) {
    companion object {
        const val PAGE_RECORDINGS = "recordings"
        /** Sheets with a text field (account, New thread, Forward), in dp; narrower screens get their width less a margin. */
        private const val SHEET_WIDTH = 520f
        /** The list's width beside an open thread, and the panel width below which the thread takes its place. */
        private const val LIST_WIDTH = 400f
        private const val SIDE_BY_SIDE = 820f
    }

    /** COMPOSE is a new thread's draft (2026-10-21): who it is for, then a separate key that records its first message. */
    /** AGENTS is the person's own coding agents (2026-11-20): the code to connect one, and those connected. */
    private enum class Page { LIST, THREAD, RECORDINGS, COMPOSE, AGENTS }
    /** Gmail's Inbox and Archive: the open threads, or the closed ones. */
    private enum class Box { INBOX, ARCHIVED }

    private val ui = Handler(Looper.getMainLooper())
    private val background = Executors.newSingleThreadExecutor()
    private lateinit var head: LinearLayout
    private lateinit var searchBar: LinearLayout
    private lateinit var search: EditText
    private lateinit var clearSearch: View
    private lateinit var profile: ProfileBadge
    private lateinit var sectionLine: LinearLayout
    private lateinit var listView: LinearLayout
    private lateinit var notice: LinearLayout
    private lateinit var flash: LinearLayout
    private lateinit var recordingsView: LinearLayout
    /** A new thread's draft, in the right column; its Record key and the words that say why it is off. */
    private lateinit var draftView: LinearLayout
    private var draftRecord: View? = null
    private var draftWhy: TextView? = null
    private lateinit var threadView: LinearLayout
    /** The Agents page, in the right column; what it looked like when last drawn, and why a code could not be had. */
    private lateinit var agentsView: LinearLayout
    private var drawnAgents = ""
    private var agentsProblem: String? = null
    private var askingCode = false
    /** The clocks beside a code on show, run down by the tick without redrawing what they sit in. */
    private val agentClocks = mutableListOf<(Long) -> Unit>()
    /** The thread's title kept in view once the big one scrolls off (CAP-8, 2026-10-15); a press opens it out. */
    private lateinit var pinned: LinearLayout
    private var titleBlockView: View? = null
    private var pinnedOpen = false
    /** The open thread's (or Recordings') column, and the list's. */
    private lateinit var scroll: ScrollView
    private lateinit var listScroll: ScrollView
    private lateinit var listColumn: View
    private lateinit var detailColumn: View
    private lateinit var empty: TextView
    private lateinit var problem: TextView
    private lateinit var detailProblem: TextView
    private lateinit var composeKey: View
    private lateinit var bottomBar: View
    private lateinit var deleteKey: TextView
    private var page = Page.LIST
    private var mailbox = Box.INBOX
    /** The closed threads while Archived shows; the open ones are Threads.listing, which the deck shares. */
    private var archived: Threads.Listing? = null
    /** What is typed in the search bar; the list shows only threads that match every word. */
    private var query = ""
    /** Recordings chosen on the Recordings page, by run name, to delete together (CAP-1 #21). */
    private val selected = mutableSetOf<String>()
    private var thread: Threads.Thread? = null
    /** Earlier messages of the open thread opened out from their one line; the latest is always open. */
    private val unfoldedMessages = mutableSetOf<Int>()
    /** The open thread's 3D viewers, by message and model, kept across redraws so a turned model stays turned. */
    private val modelViews = mutableMapOf<String, ModelView>()
    /** What the open thread, the recordings page and the notice looked like when last drawn. */
    private var drawn = ""
    private var drawnRecordings = ""
    private var drawnNotice = ""
    private var polling = false
    private var pollInFlight = false
    private val historyGuard = HistoryPolicy.Guard<UploadSettings.Config>()
    private var historyRecords: List<ReceiverClient.Upload>? = null
    private var historyProblem: String? = null
    private var historyLoading = false
    private var historyRevision = 0L
    private val settingsChanged = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == null || key in setOf("server", "token", "deviceId", "metaUser", "metaName")) {
            // Invalidate even for a rapid A -> B -> A change before the callback is delivered.
            historyGuard.invalidate()
            clearHistory()
            syncHistoryScope()
            updateProfile()
            if (page == Page.RECORDINGS) showRecordings()
        }
    }
    private var popup: Dialog? = null
    private val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    private val shown = SimpleDateFormat("d MMM HH:mm", Locale.UK)
    private val runStamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)

    /** The two columns, for the deck to put beside itself. */
    val view: View = buildUi()

    init {
        // A launch that opens a 3D model shows it in its message; the deck runs launches, so it asks here.
        // Properties further down are not made yet, so the deck calls show() once this is built.
        Threads.showModel = { key, sha256 -> showModel(key, sha256) }
        Timeline.log("inbox", "open")
    }

    /** Goes to a thread, or to a page, or to the list. */
    fun show(key: String?, pageName: String?) {
        when {
            key != null -> openThread(key, Threads.listing?.threads?.firstOrNull { it.key == key }?.title ?: key)
            pageName == PAGE_RECORDINGS -> openRecordings()
            else -> openList()
        }
    }

    fun resume() {
        Threads.inboxInFront = true
        polling = true
        getSharedPreferences("upload", MODE_PRIVATE).registerOnSharedPreferenceChangeListener(settingsChanged)
        syncHistoryScope()
        updateProfile()
        if (UploadSettings.load(this) == null) signIn.ensure(this)
        ui.removeCallbacks(poll); ui.removeCallbacks(tick)
        ui.post(poll); ui.post(tick)
    }

    fun pause() {
        Threads.inboxInFront = false
        polling = false
        getSharedPreferences("upload", MODE_PRIVATE).unregisterOnSharedPreferenceChangeListener(settingsChanged)
        syncHistoryScope()
        ui.removeCallbacks(poll); ui.removeCallbacks(tick)
    }

    fun destroy() {
        Threads.openKey = null; Threads.openTitle = null; Threads.showModel = null
        dropModels()
        popup?.dismiss()
        background.shutdown()
        ui.removeCallbacksAndMessages(null)
        Timeline.log("inbox", "close")
    }

    /** Back: closes what is open in the right column, the search, then Archived; false when there is nothing to go back from. */
    fun back(): Boolean {
        when {
            page != Page.LIST -> openList()
            query.isNotEmpty() -> search.setText("")
            mailbox == Box.ARCHIVED -> switchBox(Box.INBOX)
            else -> return false
        }
        return true
    }

    private fun dp(v: Float) = Retro.dp(this, v).toInt()

    // ---- Keeping up.

    private val poll = object : Runnable {
        override fun run() {
            if (!polling) return
            syncHistoryScope()
            val key = thread?.key
            val requestedPage = page
            val box = mailbox
            val ticket = historyGuard.ticket()
            if (ticket == null) {
                signIn.ensure(this@InboxPane)
                if (page == Page.RECORDINGS) showRecordings() else say(signInMessage())
            } else if (!pollInFlight) {
                // Slow/offline calls must not queue a new poll every 5/10 seconds (or every UI tick).
                pollInFlight = true
                if (requestedPage == Page.RECORDINGS) {
                    historyLoading = true; historyRevision++; showRecordings()
                }
                background.execute {
                    try {
                        if (!current(ticket)) return@execute
                        when (requestedPage) {
                            Page.RECORDINGS -> fetchHistory(ticket)
                            Page.THREAD -> if (key != null) fetchThread(key, ticket)
                            Page.LIST, Page.COMPOSE, Page.AGENTS -> {}
                        }
                        // The list stays in view beside an open thread, so it is kept up too.
                        fetchList(ticket, box)
                        // Who is connected is asked while it can change under the person's eyes: on its page, and while a code shows.
                        if (requestedPage == Page.AGENTS || Agents.code(ticket.scope) != null) fetchAgents(ticket)
                        if (Account.cached(ticket.scope) == null && !Account.unsupported) fetchAccount(ticket)
                        if (current(ticket)) ServerSync.poll(this@InboxPane)
                    } finally { ui.post { pollInFlight = false } }
                }
            }
            ui.postDelayed(this, if (key != null || Agents.code(UploadSettings.load(this@InboxPane)) != null) 5_000 else 10_000)
        }
    }

    private fun clearHistory() {
        historyRecords = null; historyProblem = null; historyLoading = false
        historyRevision++; drawnRecordings = ""
        // Hidden rows and their thread-button closures are cached data too.
        recordingsView.removeAllViews()
        if (page == Page.RECORDINGS) head.removeAllViews()
    }

    /** UI-thread cache, bound to all settings (including token/account) and this visible lifecycle. */
    private fun syncHistoryScope() {
        if (historyGuard.update(UploadSettings.load(this), polling)) clearHistory()
    }

    private fun current(ticket: HistoryPolicy.Guard.Ticket<UploadSettings.Config>) =
        historyGuard.accepts(ticket, UploadSettings.load(this))

    private fun signInMessage(): String = signIn.inboxText()

    private fun fetchHistory(ticket: HistoryPolicy.Guard.Ticket<UploadSettings.Config>) {
        runCatching { ReceiverClient(ticket.scope).history() }
            .onSuccess { records -> ui.post {
                if (!current(ticket)) { syncHistoryScope(); if (polling) showRecordings(); return@post }
                historyRecords = records; historyProblem = null; historyLoading = false
                historyRevision++; showRecordings()
            } }
            .onFailure { e ->
                if (e is ReceiverClient.Refused && e.code == 401) signIn.rejected(this, ticket.scope.token)
                ui.post {
                    if (!current(ticket)) { syncHistoryScope(); if (polling) showRecordings(); return@post }
                    val code = (e as? ReceiverClient.Refused)?.code
                    if (code == 401 || code == 403) historyRecords = null
                    historyProblem = when (code) {
                        401 -> signIn.expiredText
                        403 -> "This account cannot view server history. Ask the team to check access."
                        in 400..499 -> "Server history is unavailable on this server. Ask the team to check the connection."
                        else -> "Cannot reach the server. Check your connection; history will retry automatically."
                    }
                    historyLoading = false; historyRevision++; showRecordings()
                }
            }
    }

    /** This headset's own recordings change between polls (bytes sent, a recording starting): redraw when they do. */
    private val tick = object : Runnable {
        override fun run() {
            if (!polling) return
            syncHistoryScope()
            when (page) {
                Page.THREAD -> thread?.takeIf { it.seq > 0 }?.let { showThread(it) }
                Page.RECORDINGS -> showRecordings()
                Page.COMPOSE -> syncDraftRecord()
                Page.AGENTS -> showAgents()
                Page.LIST -> {}
            }
            showNotice()
            refreshLive()
            // A code's clock runs down each second; once it has run out, what showed it is drawn again without it.
            val now = System.currentTimeMillis()
            val showing = Agents.code(UploadSettings.load(this@InboxPane), now) != null
            if (showing) agentClocks.forEach { it(now) } else if (agentClocks.isNotEmpty()) { agentClocks.clear(); redrawAgents() }
            val online = online()
            val moving = showing || CaptureState.occupied || Recording.list(this@InboxPane).any { progressOf(it, online) != null || (it.upload.holdUntil ?: 0) > System.currentTimeMillis() }
            ui.postDelayed(this, if (moving) 1_000 else 4_000)
        }
    }

    private fun client(): ReceiverClient? = UploadSettings.load(this)?.let { ReceiverClient(it) }

    private fun fetchList(ticket: HistoryPolicy.Guard.Ticket<UploadSettings.Config>, box: Box) {
        // Publish only after the same config/lifecycle guard as history; never install a late account's list.
        val state = if (box == Box.ARCHIVED) "closed" else "open"
        runCatching { Threads.parseListing(ReceiverClient(ticket.scope).json("GET", "/v1/threads?state=$state")) }
            .onSuccess { listing -> ui.post {
                if (current(ticket)) {
                    if (box == Box.INBOX) Threads.listing = listing else archived = listing
                    if (mailbox == box) { if (page == Page.LIST) say(null); showList() }
                    // Whether this person has an agent decides the inbox's card, so it is asked once per token.
                    if (listing.agents && Agents.cached(ticket.scope) == null && !background.isShutdown) background.execute { fetchAgents(ticket) }
                }
            } }
            .onFailure { e -> pollFailure(e, ticket, Page.LIST) }
    }

    /** Who this headset is, for the corner circle; asked once per token, and again after the email changes. */
    private fun fetchAccount(ticket: HistoryPolicy.Guard.Ticket<UploadSettings.Config>) {
        runCatching { Account.fetch(ticket.scope) }
            .onSuccess { ui.post { if (current(ticket)) updateProfile() } }
            .onFailure { e -> Log.w("PolydanceCapture", "account poll failed: ${e.javaClass.simpleName}") }
    }

    /** This person's connected agents; a code that has just been used stops showing. */
    private fun fetchAgents(ticket: HistoryPolicy.Guard.Ticket<UploadSettings.Config>) {
        val before = Agents.cached(ticket.scope)
        runCatching { Agents.fetch(ticket.scope) }
            .onSuccess { now -> ui.post { if (current(ticket)) { Agents.settle(before, now); redrawAgents() } } }
            .onFailure { e -> Log.w("PolydanceCapture", "agents poll failed: ${e.javaClass.simpleName}") }
    }

    private fun fetchThread(key: String, ticket: HistoryPolicy.Guard.Ticket<UploadSettings.Config>) {
        val client = ReceiverClient(ticket.scope)
        runCatching {
            var t = Threads.get(client, key)
            // Seen once it is on screen: everything up to now is read for this headset.
            if (current(ticket) && t.seq > t.readSeq) t = Threads.markRead(client, key, t.seq)
            t
        }.onSuccess { t -> ui.post {
            if (current(ticket) && thread?.key == key) { Replies.seen(this, key); say(null); showThread(t) }
        } }.onFailure { e -> pollFailure(e, ticket, Page.THREAD) }
    }

    private fun pollFailure(e: Throwable, ticket: HistoryPolicy.Guard.Ticket<UploadSettings.Config>, target: Page) {
        val code = (e as? ReceiverClient.Refused)?.code
        if (code == 401) signIn.rejected(this, ticket.scope.token)
        ui.post {
            if (current(ticket) && page == target) say(when (code) {
                401 -> signIn.expiredText
                403 -> "This account cannot open these threads. Ask the team to check access."
                else -> "Cannot reach the server. Check your connection; retrying automatically."
            })
            else if (polling && page == target && UploadSettings.load(this) == null) say(signInMessage())
        }
    }

    /** A problem in words, over whichever column is in use: the open thread's, else the list's. */
    private fun say(text: String?) {
        val shown = if (page == Page.LIST) problem else detailProblem
        val other = if (page == Page.LIST) detailProblem else problem
        shown.text = text ?: ""
        shown.visibility = if (text == null) View.GONE else View.VISIBLE
        other.visibility = View.GONE
    }

    // ---- Pages.

    private fun goTo(next: Page) {
        val leaving = thread?.key
        page = next
        problem.visibility = View.GONE; detailProblem.visibility = View.GONE
        hideKeyboard()
        if (next != Page.THREAD) { pinnedOpen = false; titleBlockView = null }
        syncPinned()
        // The list and New thread stay; the right column opens for a thread or Recordings.
        bottomBar.visibility = if (next == Page.THREAD) View.VISIBLE else View.GONE
        if (next != Page.RECORDINGS) selected.clear()
        updateDeleteKey()
        recordingsView.visibility = if (next == Page.RECORDINGS) View.VISIBLE else View.GONE
        draftView.visibility = if (next == Page.COMPOSE) View.VISIBLE else View.GONE
        if (next != Page.COMPOSE) { draftView.removeAllViews(); draftRecord = null; draftWhy = null }
        threadView.visibility = if (next == Page.THREAD) View.VISIBLE else View.GONE
        agentsView.visibility = if (next == Page.AGENTS) View.VISIBLE else View.GONE
        if (next != Page.AGENTS) { agentsView.removeAllViews(); drawnAgents = "" }
        agentClocks.clear()
        if (next != Page.THREAD) { thread = null; Threads.openKey = null; Threads.openTitle = null }
        if (next != Page.THREAD || leaving != null) { dropModels(); unfoldedMessages.clear() }
        head.removeAllViews()
        layoutColumns()
        scroll.scrollTo(0, 0)
        showList()
    }

    /**
     * The list takes the width with nothing open; beside an open thread it narrows to LIST_WIDTH and the thread
     * takes the rest. Below SIDE_BY_SIDE the thread takes the list's place (Meta's panels go down to 384 dp).
     */
    private fun layoutColumns() {
        val open = page != Page.LIST
        val width = view.width.takeIf { it > 0 } ?: Int.MAX_VALUE
        val sideBySide = width >= dp(SIDE_BY_SIDE)
        listColumn.visibility = if (!open || sideBySide) View.VISIBLE else View.GONE
        detailColumn.visibility = if (open) View.VISIBLE else View.GONE
        listColumn.layoutParams = LinearLayout.LayoutParams(if (open) dp(LIST_WIDTH) else 0, LinearLayout.LayoutParams.MATCH_PARENT, if (open) 0f else 1f)
        detailColumn.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f).apply { leftMargin = if (sideBySide) dp(2f) else 0 }
    }

    private fun openList() {
        goTo(Page.LIST)
        showList()
        drawnNotice = ""; showNotice()
        ui.removeCallbacks(poll); ui.post(poll)
    }

    /** Inbox or Archived, from the menu. */
    private fun switchBox(next: Box) {
        mailbox = next
        Timeline.log("inbox", "box", "box" to next.name.lowercase(Locale.ROOT))
        showList()
        ui.removeCallbacks(poll); ui.post(poll)
    }

    /**
     * The bar over a thread or the Recordings page, Gmail's: back on the left, the page's own keys on the right.
     * A key is taken from wherever it was last shown, since pages redraw their bar.
     */
    private fun topBar(title: String?, vararg keys: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        addView(Glyph.key(this@InboxPane, Glyph.Kind.CLOSE, Retro.BURNT, "Close, back to the list") { openList() })
        if (title != null) addView(Retro.label(this@InboxPane, title, 18f, Retro.BURNT, 0.18f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(4f) })
        else addView(View(this@InboxPane), LinearLayout.LayoutParams(0, 1, 1f))
        for (key in keys) { (key.parent as? ViewGroup)?.removeView(key); addView(key) }
    }

    private fun headPlate(title: String, subtitle: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        val p = dp(18f); setPadding(p + dp(6f), p, p + dp(6f), p)
        background = PlateDrawable(resources.displayMetrics.density)
        addView(Retro.label(this@InboxPane, title, 20f, Retro.WHITE_PRINT, 0.04f).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
        addView(Retro.body(this@InboxPane, 14f, Retro.TAN).apply { text = subtitle })
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) }
    }

    // ---- This headset's recordings and their status.

    private fun clientId(r: Recording) = "${UploadSettings.deviceId(this)}-${r.name}"

    private fun localLook(list: List<Recording>, online: Boolean = online()) = list.joinToString("|") { r ->
        val u = r.upload
        // An upload's share, rate and time left move in place each second (refreshLive); its stage, or its
        // becoming stuck or moving again (the row's dot turns amber), redraws.
        val step = progressOf(r, online)?.let { "${it.stage}${it.isStuck}" } ?: (u.stepsDone ?: -1).toString()
        val held = u.holdUntil?.let { ((it - System.currentTimeMillis()) / 1000).coerceAtLeast(-1) } ?: -1
        "${r.name}:${u.state}:${u.server}:${u.thread}:$step:$held:${u.error}:${r.name in selected}"
    } + ":${CaptureState.recording}:${CaptureState.readingLogs}:${CaptureState.runDir?.name}"

    /** [progress] for one of this headset's recordings on its way (UploadLive); [recording] is that recording. */
    private data class Status(
        val word: String, val colour: Int, val fraction: Float? = null, val processing: Boolean = false, val reason: String? = null,
        val progress: UploadProgress? = null, val recording: Recording? = null,
    )

    /** Whether the headset has a network that reaches the internet: its Wi-Fi, since a headset has no other. */
    private fun online(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return true
        return cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }

    /** How this headset's recording is going on its way to the receiver; null when it is not under way. */
    private fun progressOf(r: Recording, online: Boolean = online()): UploadProgress? =
        UploadLive.progress(r.name, r.upload, online, UploadWorker.clock(), System.currentTimeMillis())

    /** The words for an upload under way: its share once the video goes, amber once nothing has moved for a while. */
    private fun uploading(r: Recording, p: UploadProgress) = Status(
        if (p.stage == UploadProgress.Stage.VIDEO) "UPLOADING ${p.percent}" else "UPLOADING",
        if (p.isStuck) Retro.AMBER else Retro.UPLOADING, p.fraction.toFloat(),
        // Waiting to go again, upload.json says why the last attempt ended.
        reason = r.upload.error?.takeIf { r.upload.state == "waiting" }, progress = p, recording = r,
    )

    /**
     * An upload's line, strip and pace as drawn, so they move each second without redrawing the page: the
     * thread's 3D models and the scroll stay put. The page's own redraw replaces them.
     */
    private inner class LiveStatus(val recording: Recording, val prefix: String, val suffix: String, val word: TextView, val strip: LedStrip, val pace: TextView) {
        fun show(p: UploadProgress) {
            val s = uploading(recording, p)
            word.text = "$prefix${s.word}$suffix"
            word.setTextColor(s.colour)
            strip.fraction = p.fraction.toFloat()
            strip.stuck = p.isStuck
            strip.contentDescription = p.line
            pace.text = p.detail
            pace.setTextColor(if (p.isStuck) Retro.AMBER else Retro.TAN)
        }
    }

    private val liveStatuses = mutableListOf<LiveStatus>()

    /** Each second: the share, megabytes, rate, time left or stall of every upload on the page, in place. */
    private fun refreshLive() {
        if (liveStatuses.isEmpty()) return
        val online = online()
        for (live in liveStatuses) {
            val r = live.recording.copy(upload = UploadState.read(live.recording.dir))
            progressOf(r, online)?.let { live.show(it) }
        }
    }

    /**
     * One word for where a recording is, in the transfer unit's colours: uploading amber, processing cyan
     * (sixth pass, 2026-10-04), on the server green, a problem red. This headset's own state comes first,
     * then the receiver's, live from the thread when there is one.
     */
    private fun statusOf(local: Recording?, server: Threads.Recording?): Status {
        if (local != null) {
            val u = local.upload
            when {
                CaptureState.recording && CaptureState.runDir == local.dir -> return Status(if (local.kind == TakeKind.LOGS) "KEEPING LOGS NOW" else "RECORDING NOW", Retro.RED)
                CaptureState.busy(local.dir) -> return Status("READING LOGS", Retro.UPLOADING, reason = "It goes up once the headset's logs are read.")
                local.interrupted -> return Status("CUT OFF", Retro.RED, reason = if (local.kind == TakeKind.LOGS) "Closed before it stopped, so its logs were never read." else "Closed mid-recording, so it can't be played.")
            }
            progressOf(local)?.let { return uploading(local, it) }
            when {
                u.state == "uploading" -> return Status("UPLOADING", Retro.UPLOADING, 0f)
                u.state == "waiting" && (u.holdUntil ?: 0) > System.currentTimeMillis() -> {
                    val left = (u.holdUntil!! - System.currentTimeMillis() + 999) / 1000
                    val short = (local.durationMs ?: Long.MAX_VALUE) < Uploads.SHORT_MS
                    return Status(if (short) "SHORT  ·  SENDS IN ${left}s" else "SENDS IN ${left}s", Retro.UPLOADING,
                        reason = if (short) "Under 20 s, so it waits in case it was a mistake: Delete it, or Send now." else null)
                }
                u.state == "waiting" -> return Status("WAITING", Retro.TAN, reason = u.error)
                u.state == "failed" -> return Status("FAILED", Retro.RED, reason = u.error)
                u.state == "not_configured" -> return Status("NO SERVER", Retro.TAN)
                u.state == "none" -> return Status("NOT SENT", Retro.TAN)
            }
        }
        val status = server?.status ?: local?.upload?.server ?: "unknown"
        val done = server?.stepsDone ?: local?.upload?.stepsDone
        val total = server?.stepsTotal ?: local?.upload?.stepsTotal
        return when (status) {
            "uploading" -> Status("UPLOADING", Retro.UPLOADING)
            "received", "processing" -> Status(
                "PROCESSING${if (done != null && total != null) " $done/$total" else ""}", Retro.PROCESSING,
                if (done != null && total != null && total > 0) done.toFloat() / total else 0f, processing = true,
            )
            "ready" -> Status("ON SERVER", Retro.GREEN)
            "failed" -> Status("FAILED", Retro.RED, reason = server?.error ?: local?.upload?.error)
            "deleted" -> Status("DELETED", Retro.TAN, reason = local?.upload?.error)
            else -> Status(status.uppercase(), Retro.TAN)
        }
    }

    /** Not gone up and not going: what the notice on the threads page points at. */
    private fun needsAttention(r: Recording) = !r.interrupted && !CaptureState.busy(r.dir) &&
        r.upload.state in setOf("failed", "waiting", "none", "not_configured")

    private fun whenRun(name: String) = runCatching { shown.format(runStamp.parse(name)!!) }.getOrDefault(name)

    private fun length(ms: Long?) = ms?.let { String.format(Locale.US, "%d:%02d", it / 60_000, (it / 1000) % 60) }

    /**
     * The status line, a progress strip while it moves, and the reason when something went wrong. An upload
     * under way adds how much, how fast and how long under its strip, or that nothing has moved and why
     * (UploadProgress, the iPhone's words), and moves each second (refreshLive).
     */
    private fun statusViews(into: LinearLayout, s: Status, prefix: String, suffix: String = "") {
        val word = Retro.label(this, "$prefix${s.word}$suffix", 13f, s.colour, 0.12f).apply { setPadding(0, dp(6f), 0, 0) }
        into.addView(word)
        s.fraction?.let { f ->
            val strip = LedStrip(this).apply { fraction = f; processing = s.processing }
            into.addView(strip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
            if (s.progress != null && s.recording != null) {
                val pace = Retro.body(this, 13f, Retro.TAN).apply { setPadding(0, dp(4f), 0, 0); maxLines = 2; ellipsize = TextUtils.TruncateAt.END }
                into.addView(pace)
                liveStatuses += LiveStatus(s.recording, prefix, suffix, word, strip, pace).also { it.show(s.progress) }
            }
        }
        s.reason?.let { into.addView(Retro.body(this, 13f, if (s.colour == Retro.RED) Retro.RED else Retro.TAN).apply { text = it; maxLines = 3; ellipsize = TextUtils.TruncateAt.END }) }
    }

    /**
     * Retry when it has not gone up (Send now while it waits after Stop), and Delete everywhere, for a
     * recording made on this headset; on the Recordings page a Select chip too, for deleting several at once.
     */
    private fun recordingButtons(r: Recording, selectable: Boolean = false) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(0, dp(10f), 0, 0)
        val now = CaptureState.busy(r.dir)
        if (selectable && !now) addView(chip("Select", r.name in selected) {
            if (!selected.remove(r.name)) selected.add(r.name)
            updateDeleteKey(); drawnRecordings = ""; showRecordings()
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) })
        val held = (r.upload.holdUntil ?: 0) > System.currentTimeMillis()
        if (!now && !r.interrupted && r.upload.state in setOf("failed", "waiting", "none", "not_configured")) {
            addView(Retro.button(this@InboxPane, when { held && r.upload.state == "waiting" -> "Send now"; r.upload.state == "none" -> "Upload"; else -> "Retry" }, Retro.CREAM, small = true) {
                Uploads.enqueue(this@InboxPane, r.name, restart = true); refresh()
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) })
        }
        if (!now) addView(Retro.button(this@InboxPane, "Delete", Retro.RED, small = true) { confirmDelete(r) })
    }

    /** Delete N in the header while recordings are selected on the Recordings page. */
    private fun updateDeleteKey() {
        deleteKey.text = "Delete ${selected.size}"
        deleteKey.visibility = if (page == Page.RECORDINGS && selected.isNotEmpty()) View.VISIBLE else View.GONE
    }

    /** Every selected recording, everywhere, after one confirmation that says how many copies go. */
    private fun deleteSelected() {
        val runs = Recording.list(this).filter { it.name in selected && !CaptureState.busy(it.dir) }
        if (runs.isEmpty()) { selected.clear(); updateDeleteKey(); return }
        val onServer = runs.count { it.upload.uploadId != null && it.upload.server != "deleted" }
        AlertDialog.Builder(this)
            .setTitle("Delete ${runs.size} recording${if (runs.size == 1) "" else "s"} everywhere?")
            .setMessage(when (onServer) {
                runs.size -> "They are removed from this headset now. Server deletion is queued and may wait for connectivity or sign-in. This cannot be undone."
                0 -> "No server copies have been confirmed. This removes the local copies and queues any in-flight server deletions. This cannot be undone."
                else -> "$onServer have confirmed server copies. This removes local copies and queues server deletion, including any in-flight uploads. It may wait for connectivity or sign-in. This cannot be undone."
            })
            .setPositiveButton("Delete") { _, _ ->
                val localFailures = runs.count { !Uploads.deleteEverywhere(this, it.name) }
                if (localFailures > 0) say("$localFailures local deletion(s) failed. Server deletions remain queued where needed.")
                Timeline.log("inbox", "delete_selected", "runs" to runs.size, "onServer" to onServer)
                selected.clear(); updateDeleteKey(); refresh()
            }
            .setNegativeButton("Keep", null)
            .show()
    }

    private fun confirmDelete(r: Recording) {
        val onServer = r.upload.uploadId != null && r.upload.server != "deleted"
        AlertDialog.Builder(this)
            .setTitle("Delete the recording from ${whenRun(r.name)} everywhere?")
            .setMessage(
                if (onServer) "It is removed from this headset now. Server deletion is queued and may wait for connectivity or sign-in. This cannot be undone."
                else "No server copy has been confirmed. This removes the local copy and queues deletion of any in-flight upload. This cannot be undone.",
            )
            .setPositiveButton("Delete") { _, _ ->
                val ok = Uploads.deleteEverywhere(this, r.name)
                if (!ok) say("Local deletion failed. Server deletion remains queued where needed.")
                Log.i("PolydanceCapture", "deletion requested for recording ${r.name} (server queued: $onServer, local ok: $ok)")
                Timeline.log("inbox", "delete", "run" to r.name, "onServer" to onServer)
                refresh()
            }
            .setNegativeButton("Keep", null)
            .show()
    }

    private fun refresh() {
        drawn = ""; drawnRecordings = ""; drawnNotice = ""
        when (page) {
            Page.THREAD -> thread?.takeIf { it.seq > 0 }?.let { showThread(it) }
            Page.RECORDINGS -> showRecordings()
            Page.COMPOSE -> syncDraftRecord()
            Page.AGENTS -> showAgents()
            Page.LIST -> {}
        }
        showNotice()
    }

    // ---- The threads.

    /** The list for the box showing, narrowed to the chosen projects and to what the search bar holds. */
    private fun showList() {
        updateSection()
        listView.removeAllViews()
        val listing = if (mailbox == Box.ARCHIVED) archived else Threads.listing
        if (listing == null) { empty.visibility = View.GONE; return }
        // Until an agent is connected, a card at the top of the inbox offers it (Robin's pick D, 2026-11-20).
        val config = UploadSettings.load(this)
        if (mailbox == Box.INBOX && query.isBlank() && page != Page.AGENTS && Agents.offer(listing.agents, Agents.cached(config), agentOfferHidden(config))) {
            listView.addView(agentOffer(config), wide())
        }
        val keys = Threads.filter(this)
        val inProjects = if (keys.isEmpty()) listing.threads else listing.threads.filter { it.project in keys }
        val names = listing.projects.associate { it.key to it.name }
        val visible = inProjects.filter { s ->
            InboxText.matches(query, listOf(s.title, s.key, names[s.project], s.snippet, s.lastBy, s.lastText) + s.people.flatMap { listOf(it.name, it.email) })
        }
        empty.visibility = if (visible.isEmpty()) View.VISIBLE else View.GONE
        empty.text = when {
            listing.projects.isEmpty() -> "Threads are off on this server."
            query.isNotBlank() && inProjects.isNotEmpty() -> "No threads match “${query.trim()}”."
            mailbox == Box.ARCHIVED && listing.threads.isEmpty() -> "Nothing archived. Archive a thread from its top bar; it comes back to the inbox when someone adds to it."
            listing.threads.isNotEmpty() -> "No threads in the projects you've chosen. Open the menu to show more."
            else -> "No threads yet. Press New thread to record one: say what you want, and point."
        }
        if (visible.isNotEmpty()) {
            // One dark plate for the whole list, rows ruled apart, as Gmail's rows sit on one sheet.
            val plate = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                background = PlateDrawable(resources.displayMetrics.density)
                setPadding(0, dp(10f), 0, dp(10f))
            }
            visible.forEachIndexed { i, s ->
                if (i > 0) plate.addView(View(this).apply { setBackgroundColor(Retro.EDGE) },
                    LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1f)).apply { leftMargin = dp(84f); rightMargin = dp(22f) })
                plate.addView(threadRow(s))
            }
            listView.addView(plate, wide())
        }
        // Room under the last row, so New thread never covers it.
        listView.addView(View(this), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(84f)))
    }

    /** What the list shows, under the search bar like Gmail's "All inboxes": Inbox or Archived, and which projects. */
    private fun updateSection() {
        val projects = Threads.listing?.projects.orEmpty()
        val keys = Threads.filter(this)
        val names = projects.filter { it.key in keys }.map { it.name }
        sectionLine.removeAllViews()
        val where = if (names.isEmpty()) "All projects" else names.joinToString("  ·  ")
        // How many are unread, as Gmail counts them beside Inbox.
        val unread = Threads.listing?.unread?.takeIf { it > 0 && mailbox == Box.INBOX }?.let { "  ·  $it UNREAD" } ?: ""
        sectionLine.addView(Retro.label(this, "${if (mailbox == Box.ARCHIVED) "ARCHIVED" else "INBOX"}$unread  ·  ${where.uppercase(Locale.UK)}", 13f, Retro.BURNT, 0.16f).apply {
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        // The way back is beside what is narrowed, so it is plain that the filter worked (eighth pass, 2026-10-05).
        if (mailbox == Box.ARCHIVED) sectionLine.addView(Retro.button(this, "Inbox", Retro.CREAM, small = true) { switchBox(Box.INBOX) })
        else if (names.isNotEmpty()) sectionLine.addView(Retro.button(this, "Show all", Retro.CREAM, small = true) {
            Threads.setFilter(this, emptySet())
            Timeline.log("inbox", "filter", "keys" to "")
            showList()
        })
    }

    /** A line above the threads when a recording on this headset has not gone up, leading to the recordings page. */
    private fun showNotice() {
        val waiting = Recording.list(this).filter { needsAttention(it) }
        val look = localLook(waiting)
        if (look == drawnNotice) return
        drawnNotice = look
        notice.removeAllViews()
        if (waiting.isNotEmpty()) {
            notice.addView(Retro.body(this, 15f, Retro.BURNT).apply {
                text = if (waiting.size == 1) "One recording on this headset hasn't gone up." else "${waiting.size} recordings on this headset haven't gone up."
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            notice.addView(Retro.button(this, "Recordings ›", Retro.CREAM, small = true) { openRecordings() })
        }
        notice.visibility = if (waiting.isNotEmpty()) View.VISIBLE else View.GONE
    }

    /**
     * A thread as a Gmail row (Robin, 2026-10-12): who is in it on the left, one circle or overlapping ones; the
     * title, bold while something in it is unseen, with the time of its last message; and its latest words
     * under it. No star: where Gmail has one, a lamp shows red for something unseen and amber while a launch
     * waits for this headset. The whole row opens the thread.
     */
    private fun threadRow(s: Threads.Summary): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP
            setPadding(dp(22f), dp(12f), dp(22f), dp(12f))
            // The thread open beside the list is lit, as a mail client marks the message being read.
            val open = page == Page.THREAD && thread?.key == s.key
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(40, 239, 230, 210)), if (open) ColorDrawable(Retro.SURFACE) else null, ColorDrawable(Color.WHITE))
            isClickable = true; isFocusable = true
            setOnClickListener { openThread(s.key, s.title) }
            contentDescription = "${s.title}, ${s.key}${if (s.unread) ", unread" else ""}${if (s.waiting) ", something to try" else ""}"
        }
        row.addView(AvatarStack(this, Retro.PANEL).apply { faces = faces(s.people); total = s.peopleCount },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(18f); topMargin = dp(2f) })
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        // Read and unread as Gmail shows them (CAP-10, 2026-10-21: the dots' colours said nothing): unread is bold and
        // bright with a dot; read is plain and quieter, with none.
        top.addView(TextView(this).apply {
            text = s.title; textSize = 17f; letterSpacing = 0.02f
            typeface = if (s.unread) Retro.LABEL else Retro.BODY
            setTextColor(if (s.unread) Retro.WHITE_PRINT else Retro.TAN)
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val at = InboxText.millis(s.lastMessageAt ?: s.updatedAt)
        top.addView(TextView(this).apply {
            text = at?.let { InboxText.rowTime(it, System.currentTimeMillis()) } ?: ""
            textSize = 13f; typeface = if (s.unread) Retro.LABEL else Retro.BODY
            setTextColor(if (s.unread) Retro.WHITE_PRINT else Retro.TAN)
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(10f) })
        texts.addView(top)
        val bottom = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(3f), 0, 0) }
        // Something to try is said in words, never by a colour alone.
        if (s.waiting) bottom.addView(tag("TO TRY", Retro.AMBER), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) })
        bottom.addView(Retro.body(this, 14f, if (s.unread) Retro.CREAM else Retro.TAN).apply {
            text = "${s.key}  ·  ${s.snippet ?: listOf(s.lastBy, s.lastText).filter { it.isNotBlank() }.joinToString(": ")}"
            maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setLineSpacing(0f, 1.1f)
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (s.unread) bottom.addView(View(this).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Retro.RED) }
            contentDescription = "Unread"
        }, LinearLayout.LayoutParams(dp(11f), dp(11f)).apply { leftMargin = dp(12f) })
        texts.addView(bottom)
        row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }

    /** People as circles: a person's colour follows their name, an invited address's follows the address. */
    private fun faces(people: List<Threads.Person>) = people.map { p ->
        AvatarStack.Face(p.initial, Avatar.fill(p.colour, if (p.invited) p.email ?: p.name else p.name), p.invited)
    }

    /** A line over the threads after Archive or Delete, with Undo, gone after a few seconds (Gmail's snackbar). */
    private fun flash(text: String, action: String? = null, onAction: (() -> Unit)? = null) {
        flash.removeAllViews()
        flash.addView(Retro.body(this, 15f, Retro.BURNT).apply { this.text = text }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (action != null && onAction != null) flash.addView(Retro.button(this, action, Retro.CREAM, small = true) { clearFlash.run(); onAction() })
        flash.visibility = View.VISIBLE
        ui.removeCallbacks(clearFlash); ui.postDelayed(clearFlash, 8_000)
    }

    private val clearFlash = Runnable { flash.removeAllViews(); flash.visibility = View.GONE }

    // ---- The menu, new threads and the account.

    /**
     * A pop-up on the dark plate, closed by its own key or a press outside it. [side] makes it Gmail's drawer
     * down the left edge; [gravity] pins it, as the more menu is pinned under its key. Long ones scroll.
     */
    /**
     * A plate as a dialog. [width] gives a sheet with a text field its room: rows that share their width by
     * weight (a field beside Save) collapse to nothing in a dialog that only wraps its content, which left the
     * account sheet a sliver of cut-off words (CAP-5 at 0:12, 2026-10-13).
     */
    private fun plateDialog(title: String?, gravity: Int? = null, side: Boolean = false, width: Float? = null, build: (LinearLayout, Dialog) -> Unit): Dialog {
        popup?.dismiss()
        hideKeyboard()
        val dialog = Dialog(this)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val p = dp(22f); setPadding(p + dp(8f), p, p + dp(8f), p)
            background = PlateDrawable(resources.displayMetrics.density)
        }
        if (title != null) box.addView(Retro.label(this, title, 15f, Retro.WHITE_PRINT, 0.22f))
        // Set before build, which may set its own: a dialog keeps one listener, and setting this one after
        // build threw the filter's away, so the filter never saved (eighth pass, 2026-10-05, 00:07 to 00:30).
        dialog.setOnDismissListener { if (popup === dialog) popup = null }
        build(box, dialog)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setContentView(ScrollView(this).apply {
            isFillViewport = side
            addView(box, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, if (side) FrameLayout.LayoutParams.MATCH_PARENT else FrameLayout.LayoutParams.WRAP_CONTENT))
        })
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        dialog.setCanceledOnTouchOutside(true)
        dialog.show()
        if (side) dialog.window?.setLayout(dp(320f), ViewGroup.LayoutParams.MATCH_PARENT)
        else if (width != null) dialog.window?.setLayout(minOf(dp(width), resources.displayMetrics.widthPixels - dp(32f)), ViewGroup.LayoutParams.WRAP_CONTENT)
        (gravity ?: if (side) Gravity.START or Gravity.TOP else null)?.let { dialog.window?.setGravity(it) }
        popup = dialog
        return dialog
    }

    private fun wide() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) }
    private fun spaced() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) }
    private fun fieldHeading(text: String) = Retro.label(this, text, 12f, Retro.TAN, 0.2f).apply { setPadding(0, dp(16f), 0, dp(6f)) }
    private fun note(text: String) = Retro.body(this, 13f, Retro.TAN).apply { this.text = text; setPadding(0, dp(8f), 0, 0) }

    /** A text field on the dark plates: cream type on the casing, single line. */
    private fun textField(hint: String, email: Boolean) = EditText(this).apply {
        this.hint = hint; setHintTextColor(Color.rgb(128, 118, 102)); setTextColor(Retro.CREAM)
        textSize = 17f; typeface = Retro.BODY; isSingleLine = true
        inputType = if (email) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS else InputType.TYPE_CLASS_TEXT
        imeOptions = EditorInfo.IME_ACTION_DONE
        background = Retro.panel(this@InboxPane, Retro.CASING, 10f, Retro.EDGE)
        setPadding(dp(12f), dp(10f), dp(12f), dp(10f))
    }

    /** A key with an icon before its word, in the inbox's outlined style. */
    private fun iconButton(kind: Glyph.Kind, label: String, colour: Int, onClick: () -> Unit) = Retro.button(this, label, colour, onClick = onClick).apply {
        setCompoundDrawablesRelativeWithIntrinsicBounds(Glyph(kind, colour, resources.displayMetrics.density, 20f), null, null, null)
        compoundDrawablePadding = dp(10f)
    }

    private fun hideKeyboard() {
        if (!::search.isInitialized) return
        getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(search.windowToken, 0)
        search.clearFocus()
    }

    private fun menuHeading(text: String) = Retro.label(this, text, 12f, Retro.TAN, 0.2f).apply { setPadding(dp(14f), dp(18f), 0, dp(6f)) }

    /** One line of a menu: lit amber when it is what shows, with a tick for a chosen project and an unread count. */
    private fun menuEntry(text: String, on: Boolean, tick: Boolean = false, count: Int = 0, onClick: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
        val lit = if (on && !tick) Retro.panel(this@InboxPane, Retro.SURFACE, 22f, Retro.AMBER) else null
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 239, 230, 210)), lit, ColorDrawable(Color.WHITE))
        isClickable = true; isFocusable = true
        contentDescription = "$text${if (on) ", chosen" else ""}${if (count > 0) ", $count unread" else ""}"
        setOnClickListener { onClick() }
        addView(Retro.label(this@InboxPane, "${if (tick) (if (on) "✓  " else "     ") else ""}$text", 16f, if (on) Retro.AMBER else Retro.CREAM, 0.06f),
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (count > 0) addView(Retro.label(this@InboxPane, if (count > 99) "99+" else count.toString(), 14f, Retro.RED, 0.1f))
    }

    /**
     * Gmail's menu behind the three lines: Inbox or Archived, which projects show (none chosen shows them all,
     * like an inbox's filter), and this headset's recordings.
     */
    private fun showMenu() {
        val projects = Threads.listing?.projects.orEmpty()
        val chosen = Threads.filter(this).filter { key -> projects.any { it.key == key } }.toMutableSet()
        val before = chosen.toSet()
        plateDialog(null, side = true) { box, dialog ->
            box.addView(Retro.label(this, "POLYDANCE", 20f, Retro.WHITE_PRINT, 0.3f).apply { setPadding(dp(14f), dp(4f), 0, dp(14f)) })
            box.addView(menuEntry("Inbox", mailbox == Box.INBOX, count = Threads.listing?.unread ?: 0) { dialog.dismiss(); switchBox(Box.INBOX) })
            box.addView(menuEntry("Archived", mailbox == Box.ARCHIVED) { dialog.dismiss(); switchBox(Box.ARCHIVED) })
            if (Threads.listing?.agents == true) box.addView(menuEntry("Agents", page == Page.AGENTS) { dialog.dismiss(); openAgents(withCode = false) })
            if (projects.size > 1) {
                box.addView(menuHeading("PROJECTS"))
                val options = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                fun draw() {
                    options.removeAllViews()
                    options.addView(menuEntry("All projects", chosen.isEmpty(), tick = true) { chosen.clear(); draw() })
                    for (p in projects) options.addView(menuEntry(p.name, p.key in chosen, tick = true) { if (!chosen.remove(p.key)) chosen.add(p.key); draw() })
                }
                draw()
                box.addView(options)
            }
            box.addView(menuHeading("THIS HEADSET"))
            box.addView(menuEntry("Recordings", page == Page.RECORDINGS) { dialog.dismiss(); openRecordings() })
            dialog.setOnDismissListener {
                if (popup === dialog) popup = null
                if (chosen != before) {
                    Threads.setFilter(this, chosen)
                    Timeline.log("inbox", "filter", "keys" to chosen.sorted().joinToString())
                    showList()
                }
            }
        }
        Timeline.log("inbox", "menu_open")
    }

    /**
     * Who to copy in, as in an email's To line (Robin, 2026-10-12): type or paste addresses and press Add, Done
     * or a comma; each shows with ✕ to take it out. [commit] takes in whatever is still typed.
     */
    private inner class Recipients(private val list: MutableList<String>, private val max: Int = 20) {
        val view = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.VERTICAL }
        private val chosen = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.VERTICAL }
        private val error = Retro.body(this@InboxPane, 13f, Retro.RED).apply { visibility = View.GONE; setPadding(0, dp(6f), 0, 0) }
        private val field = textField("name@example.com", email = true)
        private var committing = false

        init {
            field.setOnEditorActionListener { _, _, _ -> commit(); true }
            field.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    val text = s?.toString().orEmpty()
                    if (!committing && (text.endsWith(",") || text.endsWith(";") || (text.endsWith(" ") && "@" in text))) commit()
                }
            })
            val row = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            row.addView(field, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(Retro.button(this@InboxPane, "Add", Retro.CREAM, small = true) { commit() },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
            view.addView(chosen)
            view.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4f) })
            view.addView(error)
            draw()
        }

        /** Takes the typed addresses; false, saying why, when something typed is not one. */
        fun commit(): Boolean {
            committing = true
            val (good, bad) = InboxText.emails(field.text.toString())
            var full = false
            for (e in good) if (e !in list) { if (list.size < max) list.add(e) else full = true }
            field.setText(bad.joinToString(" "))
            field.setSelection(field.text.length)
            committing = false
            error.text = when {
                bad.isNotEmpty() -> "Not an email address: ${bad.joinToString(", ")}"
                full -> "At most $max at a time."
                else -> ""
            }
            error.visibility = if (error.text.isEmpty()) View.GONE else View.VISIBLE
            draw()
            return bad.isEmpty()
        }

        private fun draw() {
            chosen.removeAllViews()
            for (e in list) chosen.addView(LinearLayout(this@InboxPane).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                addView(AvatarStack(this@InboxPane, Retro.PANEL, 30f).apply { faces = listOf(AvatarStack.Face(InboxText.initial(e, null), Avatar.fill(null, e), invited = true)) })
                addView(Retro.body(this@InboxPane, 16f, Retro.CREAM).apply { text = e; maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE },
                    LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(10f) })
                addView(Glyph.key(this@InboxPane, Glyph.Kind.CLOSE, Retro.TAN, "Take out $e") { list.remove(e); draw() })
            })
        }
    }

    /**
     * New thread, where Gmail has Compose (Robin, 2026-10-12): which project, who to copy in by email, then
     * Record. The addresses go with the recording and join the thread once the receiver has made it (Invites).
     */
    /**
     * New thread opens a draft in the right column (CAP-10, 2026-10-21: it was one key that both made a thread and
     * recorded, and it went grey while recording, which read as broken). The draft says which project and whom to
     * invite; its own Record key records the first message, off while another recording runs and saying why. The
     * receiver makes the thread from that first recording (a headset's token may not open one by itself), so the
     * draft stays on the headset until then.
     */
    private fun newThread() {
        val projects = Threads.listing?.projects.orEmpty()
        val keys = Threads.filter(this)
        val choices = projects.filter { keys.isEmpty() || it.key in keys }.ifEmpty { projects }
        var project = Threads.currentProject(this)?.key?.takeIf { k -> choices.any { it.key == k } } ?: choices.firstOrNull()?.key
        val invite = mutableListOf<String>()
        goTo(Page.COMPOSE)
        head.addView(topBar("New thread"))
        val box = plate(mine = true)
        // IN is one selector that drops a list of every project, yours marked, ending in New project where the
        // receiver makes one (Robin's pick of four mockups, 2026-11-13; ProjectList.swift draws the same).
        val canMake = Threads.listing?.newProjects == true
        if (projects.size > 1 || canMake) {
            box.addView(fieldHeading("IN"))
            val selector = TextView(this).apply {
                textSize = 14f; typeface = Retro.LABEL; letterSpacing = 0.06f; setTextColor(Retro.CASING)
                background = Retro.panel(this@InboxPane, Retro.AMBER, 18f, Retro.AMBER)
                setPadding(dp(14f), dp(7f), dp(14f), dp(7f)); isClickable = true; isFocusable = true
            }
            val list = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL; visibility = View.GONE
                background = Retro.panel(this@InboxPane, Retro.CASING, 10f, Retro.EDGE)
            }
            fun draw() {
                val all = Threads.listing?.projects.orEmpty().ifEmpty { projects }
                val name = all.firstOrNull { it.key == project }?.name ?: "Choose"
                val open = list.visibility == View.VISIBLE
                selector.text = "$name  ${if (open) "▴" else "▾"}"
                selector.contentDescription = "Project: $name. ${if (open) "Close the list" else "Choose another"}"
                list.removeAllViews()
                for (p in all) list.addView(projectRow(p, p.key == project) { project = p.key; list.visibility = View.GONE; draw() }, wideRow())
                if (canMake) list.addView(newProjectRow { made -> project = made.key; list.visibility = View.GONE; draw() }, wideRow())
            }
            selector.setOnClickListener { list.visibility = if (list.visibility == View.VISIBLE) View.GONE else View.VISIBLE; draw() }
            draw()
            box.addView(LinearLayout(this).apply { addView(selector) })
            box.addView(list, wide())
        }
        box.addView(fieldHeading("TO"))
        val to = Recipients(invite)
        box.addView(to.view)
        box.addView(note("Optional. They join the thread once its first recording reaches the server. If you're on the team, Polydance then emails them how to join."))
        box.addView(Retro.body(this, 16f, Retro.CREAM).apply {
            text = "The thread starts with a recording: say what you want, and point. The server titles it from what you say."
            setPadding(0, dp(16f), 0, 0); setLineSpacing(0f, 1.1f)
        })
        val keysRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(16f), 0, 0) }
        draftRecord = iconButton(Glyph.Kind.CAMERA, "Record the first message", Retro.RED) {
            if (CaptureState.recording) { syncDraftRecord(); return@iconButton }
            if (to.commit()) startNew(project, invite.toList())
        }.also { keysRow.addView(it, spaced()) }
        keysRow.addView(Retro.button(this, "Discard", Retro.TAN, small = true) { openList() })
        box.addView(keysRow)
        draftWhy = Retro.body(this, 15f, Retro.AMBER).apply { setPadding(0, dp(10f), 0, 0) }
        box.addView(draftWhy)
        draftView.addView(box)
        syncDraftRecord()
        Timeline.log("inbox", "compose_open")
    }

    private fun wideRow() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

    /** One project in New thread's list: its name, ticked and amber when chosen, and whether it is yours or the team's. */
    private fun projectRow(p: Threads.Project, on: Boolean, onClick: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 239, 230, 210)), null, ColorDrawable(Color.WHITE))
        isClickable = true; isFocusable = true
        contentDescription = "${p.name}, ${if (p.mine) "your own project" else "the team's project"}${if (on) ", chosen" else ""}"
        setOnClickListener { onClick() }
        addView(Retro.body(this@InboxPane, 16f, if (on) Retro.AMBER else Retro.CREAM).apply { text = if (on) "✓  ${p.name}" else p.name; isSingleLine = true },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        addView(Retro.label(this@InboxPane, if (p.mine) "YOURS" else "TEAM", 11f, Retro.TAN, 0.12f))
    }

    /**
     * The list's last row: "+ New project", which becomes a name field with Make. The receiver makes the key from
     * the name; once made, the project is the draft's. A refusal is said under the field, in the receiver's words.
     */
    private fun newProjectRow(made: (Threads.Project) -> Unit): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = Retro.panel(this@InboxPane, Retro.SURFACE, 10f, Retro.SURFACE)
        // The two states open each other, so the field's is a variable set below.
        var naming: () -> Unit = {}
        fun closed() {
            removeAllViews()
            setPadding(0, 0, 0, 0)
            addView(Retro.body(this@InboxPane, 16f, Retro.CREAM).apply {
                text = "+  New project"; setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
                isClickable = true; isFocusable = true; contentDescription = "New project: make a project of your own"
                setOnClickListener { naming() }
            })
        }
        naming = {
            removeAllViews()
            setPadding(dp(10f), dp(10f), dp(10f), dp(10f))
            val field = textField("Project name", email = false)
            val why = note("Only you see it, and whoever you add to one of its threads.")
            lateinit var make: TextView
            fun go() {
                val name = InboxText.projectName(field.text.toString())
                if (name == null) { why.setTextColor(Retro.AMBER); why.text = "A project needs a name, of at most 60 characters on one line."; return }
                val client = client() ?: run { why.text = "Not signed in, so there is no server to make it on."; return }
                make.isEnabled = false; make.text = "Making…"; field.isEnabled = false
                this@InboxPane.background.execute {
                    runCatching { Threads.newProject(client, name) }
                        .onSuccess { p -> ui.post { Timeline.log("inbox", "project_new"); made(p) } }
                        .onFailure { e -> ui.post {
                            make.isEnabled = true; make.text = "Make"; field.isEnabled = true
                            why.setTextColor(Retro.AMBER)
                            why.text = if ((e as? ReceiverClient.Refused)?.code == 404) "This server doesn't make projects yet." else problemText(e).replaceFirstChar(Char::uppercase)
                        } }
                }
            }
            field.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_DONE) { go(); true } else false }
            make = Retro.button(this@InboxPane, "Make", Retro.AMBER, small = true) { go() }
            val row = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            row.addView(field, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = dp(8f) })
            row.addView(make, spaced())
            row.addView(Glyph.key(this@InboxPane, Glyph.Kind.CLOSE, Retro.TAN, "Do not make a project") { closed() })
            addView(row); addView(why)
            field.requestFocus()
            Unit
        }
        closed()
    }

    /** The draft's Record key is off while another recording runs, and the words under it say so. */
    private fun syncDraftRecord() {
        val key = draftRecord ?: return
        val recording = CaptureState.recording
        key.isEnabled = !recording; key.alpha = if (recording) 0.4f else 1f
        draftWhy?.apply {
            text = if (recording) "A recording is running. Stop it on the deck, then record this thread's first message." else ""
            visibility = if (recording) View.VISIBLE else View.GONE
        }
    }

    private fun startNew(project: String?, invite: List<String>) {
        if (project != null) Threads.chooseProject(this, project)
        if (page != Page.LIST) openList()
        Timeline.log("inbox", "new_thread", "project" to project, "invited" to invite.size)
        startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_START_NEW_THREAD)
            .putExtra(MainActivity.EXTRA_INTERNAL, MainActivity.INTERNAL)
            .putStringArrayListExtra(MainActivity.EXTRA_INVITE, ArrayList(invite)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** The corner circle: the first letter of this person's email, or of their name until they give one. */
    private fun updateProfile() {
        if (!::profile.isInitialized) return
        val config = UploadSettings.load(this)
        val me = Account.cached(config)
        val name = me?.name ?: config?.accountName ?: "You"
        profile.show(InboxText.initial(me?.email, name), Avatar.fill(me?.colour, name), me?.email != null || config == null || Account.unsupported)
    }

    /**
     * The account sheet behind the corner circle: who this headset is signed in as, and the email that ties
     * threads to them. Horizon OS never gives the app an email, so it is typed here, once (2026-10-12).
     */
    private fun showAccount() {
        val config = UploadSettings.load(this)
        val me = Account.cached(config)
        val name = me?.name ?: config?.accountName ?: "Not signed in"
        plateDialog("YOUR ACCOUNT", width = SHEET_WIDTH) { box, dialog ->
            val who = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(14f), 0, dp(4f)) }
            who.addView(AvatarStack(this, Retro.PANEL, 56f).apply { faces = listOf(AvatarStack.Face(InboxText.initial(me?.email, name), Avatar.fill(me?.colour, name))) })
            val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            words.addView(Retro.label(this, name, 19f, Retro.WHITE_PRINT, 0.04f))
            val shownEmail = Retro.body(this, 15f, Retro.TAN).apply { text = me?.email ?: "No email yet" }
            words.addView(shownEmail)
            who.addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(14f) })
            box.addView(who)
            box.addView(note(when {
                config == null -> signInMessage()
                config.account != null -> signIn.signedInText(Build.MODEL)
                else -> "Connected with a team token on this ${Build.MODEL}."
            }))
            if (config != null && Account.unsupported) box.addView(note("This server doesn't keep email addresses yet."))
            else if (config != null) {
                box.addView(fieldHeading("YOUR EMAIL"))
                val field = textField("you@example.com", email = true).apply { setText(me?.email.orEmpty()) }
                val status = Retro.body(this, 13f, Retro.TAN).apply { setPadding(0, dp(6f), 0, 0) }
                val about = note(accountEmailNote(me))
                fun save() {
                    val typed = field.text.toString().trim()
                    val email = if (typed.isEmpty()) null else InboxText.email(typed)
                    if (typed.isNotEmpty() && email == null) { status.setTextColor(Retro.RED); status.text = "That isn't an email address."; return }
                    status.setTextColor(Retro.TAN); status.text = "Saving…"
                    background.execute {
                        runCatching { Account.setEmail(config, email) }
                            .onSuccess { saved -> ui.post {
                                updateProfile()
                                shownEmail.text = saved.email ?: "No email yet"
                                status.text = when {
                                    saved.email == null -> "Email removed."
                                    saved.verified -> "Saved. Confirmed."
                                    else -> "Saved. Look for Polydance's email with the link to confirm it."
                                }
                                about.text = accountEmailNote(saved)
                            } }
                            .onFailure { e -> ui.post { status.setTextColor(Retro.RED); status.text = "Not saved: ${problemText(e)}" } }
                    }
                    Timeline.log("inbox", "email_save", "cleared" to (email == null))
                }
                field.setOnEditorActionListener { _, _, _ -> save(); true }
                val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                row.addView(field, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                row.addView(Retro.button(this, "Save", Retro.AMBER, small = true) { save() },
                    LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
                box.addView(row)
                box.addView(status)
                box.addView(about)
                box.addView(note("Server ${config.server.substringAfter("://")}  ·  install ${config.deviceId}"))
            }
            box.addView(Retro.button(this, "Close", Retro.CREAM, small = true) { dialog.dismiss() },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16f); gravity = Gravity.END })
        }
        Timeline.log("inbox", "account_open")
    }

    /** What the address is for, and whether it is confirmed (2026-11-10: the receiver emails a link to confirm it). */
    private fun accountEmailNote(me: Account.Me?) =
        if (me?.email != null && me.verified) "People add you to threads with this address. It is confirmed: threads that invited it are in your inbox."
        else "People add you to threads with this address. Polydance emails you a link to confirm it; once it's confirmed, threads that invited this address appear in your inbox."

    // ---- Your agents (2026-11-20, docs/THREADS.md "Connecting your own agent"; Robin's picks D, then C too).

    /** What the card, the Welcome's answer and the Agents page are drawn from: redrawn only when this changes. */
    private fun agentLook(): String {
        val config = UploadSettings.load(this)
        val state = Agents.cached(config)
        return "${state?.agents?.joinToString(",") { "${it.id}${it.label}${it.expired}${it.lastUsedOn}" }}:${state?.limit}:${Agents.code(config)?.code}:$agentsProblem:$askingCode:${CaptureState.occupied}:${agentOfferHidden(config)}"
    }

    /** Draws again whatever shows agents: the inbox's card, the Agents page, and the Welcome's answer in an open thread. */
    private fun redrawAgents() {
        showList()
        when (page) {
            Page.AGENTS -> showAgents()
            Page.THREAD -> thread?.takeIf { it.seq > 0 }?.let { showThread(it) }
            else -> {}
        }
    }

    /** The inbox's card is put away per account, on this headset: another person signing in is offered it afresh. */
    private fun agentOfferKey(config: UploadSettings.Config?) = "agentOfferHidden:${config?.account ?: "team"}"
    private fun agentOfferHidden(config: UploadSettings.Config?) = getSharedPreferences("settings", MODE_PRIVATE).getBoolean(agentOfferKey(config), false)

    /** A cream label with the reels' orange along its top, as a cassette's: what Connect your agent is printed on. */
    private fun labelPlate(build: (LinearLayout) -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = Retro.panel(this@InboxPane, Retro.PLATE_LIGHT, 8f, Retro.PLATE_EDGE)
        val r = dp(7f).toFloat()
        addView(View(this@InboxPane).apply {
            background = GradientDrawable().apply { setColor(Retro.ORANGE); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f) }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(8f)).apply { setMargins(dp(1f), dp(1f), dp(1f), 0) })
        addView(LinearLayout(this@InboxPane).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16f), dp(12f), dp(16f), dp(14f)); build(this) })
    }

    /** A key on the cream label: light, lettered in the label's print, edged orange when it is the one to press. */
    private fun creamKey(text: String, main: Boolean = false, onClick: () -> Unit) = TextView(this).apply {
        this.text = text.uppercase(Locale.UK); textSize = 13f; typeface = Retro.LABEL; letterSpacing = 0.12f
        setTextColor(Retro.PRINT); gravity = Gravity.CENTER
        setPadding(dp(14f), dp(9f), dp(14f), dp(9f))
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 58, 44, 32)), Retro.panel(this@InboxPane, Retro.CREAM, 8f, if (main) Retro.ORANGE else Retro.PLATE_EDGE), null)
        isClickable = true; isFocusable = true
        setOnClickListener { onClick() }
    }
    private fun printed(text: String, size: Float = 15f) = Retro.body(this, size, Retro.PRINT).apply { this.text = text; setLineSpacing(0f, 1.15f) }
    private fun stamped(text: String) = Retro.label(this, text, 12f, Retro.BURNT, 0.16f)

    /** The card at the top of the inbox until an agent is connected, or until it is put away. */
    private fun agentOffer(config: UploadSettings.Config?) = labelPlate { box ->
        box.addView(stamped("YOUR AGENT CAN READ THESE"))
        box.addView(printed("Connect your own coding agent and it answers here with builds to try.").apply { setPadding(0, dp(4f), 0, dp(10f)) })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        row.addView(creamKey("Connect your agent ›", main = true) { openAgents(withCode = true) })
        row.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        row.addView(stamped("NOT NOW").apply {
            setPadding(dp(10f), dp(9f), dp(4f), dp(9f)); isClickable = true; isFocusable = true
            contentDescription = "Not now: put this card away. Agents stays in the menu."
            setOnClickListener {
                getSharedPreferences("settings", MODE_PRIVATE).edit().putBoolean(agentOfferKey(config), true).apply()
                Timeline.log("inbox", "agent_offer_hidden")
                showList()
                flash("Put away. Agents is in the menu when you want it.")
            }
        })
        box.addView(row)
    }

    /**
     * A code on show: the code in the counter's type, the line to type, and its clock. Nothing is shown while this
     * headset records, since the recording would hold it.
     */
    private fun codeBlock(box: LinearLayout, code: Agents.Code, withStrip: Boolean) {
        if (CaptureState.occupied) { box.addView(printed("The code is hidden while this headset records, so it is not in the recording.")); return }
        box.addView(TextView(this).apply {
            text = code.code; textSize = 34f; typeface = Retro.COUNTER; letterSpacing = 0.12f
            setTextColor(Retro.PRINT); gravity = Gravity.CENTER; setPadding(0, dp(6f), 0, dp(6f))
            contentDescription = "Your code: ${code.code.toList().joinToString(" ")}"
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        val strip = if (withStrip) LedStrip(this).also { box.addView(it, LinearLayout.LayoutParams(dp(240f), LinearLayout.LayoutParams.WRAP_CONTENT).apply { gravity = Gravity.CENTER_HORIZONTAL }) } else null
        val clock = stamped("").apply { gravity = Gravity.CENTER; setPadding(0, dp(6f), 0, dp(10f)) }
        box.addView(clock, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        val run = { now: Long ->
            clock.text = "WORKS ONCE  ·  ${(Agents.left(code, now) ?: "run out").uppercase(Locale.UK)}"
            strip?.fraction = Agents.fraction(code, now)
        }
        run(System.currentTimeMillis()); agentClocks += run
        box.addView(printed("On your computer, type:", 14f))
        val line = Agents.command(code)
        box.addView(TextView(this).apply {
            text = SpannableString(line).apply { setSpan(ForegroundColorSpan(Retro.AMBER), line.length - code.code.length, line.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            textSize = 16f; typeface = Retro.COUNTER; setTextColor(Retro.CREAM); isSingleLine = true
            setPadding(dp(12f), dp(10f), dp(12f), dp(10f))
            background = Retro.panel(this@InboxPane, Retro.PANEL, 6f, Retro.EDGE)
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
    }

    /** Why a code could not be had, or that one is being asked for, in the label's print. */
    private fun codeStatus(box: LinearLayout) {
        if (askingCode) box.addView(printed("Asking for a code…", 14f).apply { setPadding(0, dp(8f), 0, 0) })
        agentsProblem?.let { box.addView(Retro.body(this, 14f, Retro.RED).apply { text = it; setPadding(0, dp(8f), 0, 0) }) }
    }

    /** The card in the Welcome's answer (pick D): an offer, then the code where it was asked for, then who is connected. */
    private fun agentInline() = labelPlate { box ->
        val config = UploadSettings.load(this)
        val state = Agents.cached(config)
        val code = Agents.code(config)
        box.addView(stamped("CONNECT YOUR AGENT"))
        when {
            code != null -> {
                codeBlock(box, code, withStrip = false)
                val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(10f), 0, 0) }
                row.addView(creamKey("New code") { askCode() })
                row.addView(printed("Connected agents are in the menu, under Agents.", 13f).apply { gravity = Gravity.END },
                    LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(12f) })
                box.addView(row)
            }
            state != null && state.connected.isNotEmpty() -> {
                val names = state.connected.joinToString(", ") { it.label }
                box.addView(printed("$names ${if (state.connected.size == 1) "is" else "are"} connected, and can read this thread and answer in it.").apply { setPadding(0, dp(4f), 0, dp(10f)) })
                box.addView(creamKey("Agents ›") { openAgents(withCode = false) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            }
            else -> {
                box.addView(printed("Your own coding agent can read threads like this one and answer with builds to try. It takes a code from here and one line typed on your computer.").apply { setPadding(0, dp(4f), 0, dp(10f)) })
                box.addView(creamKey("Connect your agent ›", main = true) { askCode() }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            }
        }
        codeStatus(box)
    }

    /** Agents, from the menu or the inbox's card; [withCode] asks for a code at once, as pressing the card's key means. */
    private fun openAgents(withCode: Boolean) {
        goTo(Page.AGENTS)
        agentsProblem = null
        showAgents()
        if (withCode && Agents.code(UploadSettings.load(this)) == null) askCode()
        ui.removeCallbacks(poll); ui.post(poll)
        Timeline.log("inbox", "agents_open", "code" to withCode)
    }

    /** Asks the receiver for a code. Never while recording: the code would be in the recording. It is never logged. */
    private fun askCode() {
        val config = UploadSettings.load(this)
        val state = Agents.cached(config)
        agentsProblem = when {
            config == null -> signInMessage()
            CaptureState.occupied -> "Stop the recording first: a code on screen would be in it."
            state?.full == true -> Agents.full(state)
            else -> null
        }
        if (config == null || agentsProblem != null || askingCode) { redrawAgents(); return }
        askingCode = true
        redrawAgents()
        background.execute {
            runCatching { Agents.ask(config) }
                .onSuccess { ui.post {
                    askingCode = false; redrawAgents()
                    // The clock starts now, and the list is asked sooner while the code shows.
                    ui.removeCallbacks(poll); ui.post(poll); ui.removeCallbacks(tick); ui.post(tick)
                } }
                .onFailure { e ->
                    if (e is ReceiverClient.Refused && e.code == 401) signIn.rejected(this, config.token)
                    ui.post { askingCode = false; agentsProblem = Agents.problem(e, Agents.cached(config)); redrawAgents() }
                }
        }
        Timeline.log("inbox", "agent_code_asked")
    }

    /** The Agents page (pick C): the three steps and the code on a label, then who is connected, each with Disconnect. */
    private fun showAgents() {
        if (page != Page.AGENTS) return
        val look = agentLook()
        if (look == drawnAgents) return
        drawnAgents = look
        agentClocks.clear()
        val config = UploadSettings.load(this)
        val state = Agents.cached(config)
        val code = Agents.code(config)
        head.removeAllViews()
        head.addView(topBar("Agents"))
        agentsView.removeAllViews()
        agentsView.addView(labelPlate { box ->
            box.addView(stamped("YOUR CODING AGENTS, ON YOUR OWN COMPUTERS"))
            listOf("Install polycap on your computer.", "Type polycap connect and the code below.", "Ask your agent to use Polydance.").forEachIndexed { i, step ->
                box.addView(printed("${i + 1}   $step", 16f).apply { setPadding(0, dp(if (i == 0) 8f else 4f), 0, 0) })
            }
            box.addView(View(this).apply { setBackgroundColor(Retro.PLATE_EDGE) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1f)).apply { topMargin = dp(12f); bottomMargin = dp(10f) })
            box.addView(stamped("YOUR CODE").apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            if (code != null) codeBlock(box, code, withStrip = true)
            else box.addView(printed("A code works once, for ten minutes. Ask for one when you are at your computer.", 14f).apply { gravity = Gravity.CENTER; setPadding(0, dp(6f), 0, 0) })
            box.addView(creamKey(if (code != null) "New code" else "Show a code", main = code == null) { askCode() },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12f); gravity = Gravity.CENTER_HORIZONTAL })
            codeStatus(box)
        }, wide())
        val connected = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val p = dp(18f); setPadding(p + dp(6f), p, p + dp(6f), p)
            background = PlateDrawable(resources.displayMetrics.density)
        }
        connected.addView(Retro.label(this, "CONNECTED", 12f, Retro.TAN, 0.2f))
        when {
            config == null -> connected.addView(note(signInMessage()))
            state == null -> connected.addView(note("Loading…"))
            state.agents.isEmpty() -> connected.addView(note("No agent is connected yet."))
            else -> state.agents.forEach { connected.addView(agentRow(config, it)) }
        }
        agentsView.addView(connected, wide())
        agentsView.addView(Retro.body(this, 14f, Retro.BURNT).apply {
            text = "An agent reads your threads and recordings and posts in them, as you, and nobody else's. Up to ${state?.limit ?: 5}; each connection lasts 90 days."
            setPadding(dp(8f), dp(12f), dp(8f), 0)
        })
    }

    /** One connected agent: a square, as agents are drawn everywhere, its machine's name, when, and Disconnect. */
    private fun agentRow(config: UploadSettings.Config, a: Agents.Agent) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(0, dp(12f), 0, 0)
        addView(Avatar.of(this@InboxPane, a.label, null, null, a.label, sizeDp = 36f))
        val words = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.VERTICAL }
        words.addView(Retro.label(this@InboxPane, a.label, 16f, if (a.expired) Retro.TAN else Retro.CREAM, 0.04f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
        words.addView(Retro.body(this@InboxPane, 13f, Retro.TAN).apply { text = Agents.detail(a, LocalDate.now()) })
        addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(12f); rightMargin = dp(8f) })
        addView(Retro.button(this@InboxPane, if (a.expired) "Remove" else "Disconnect", Retro.TAN, small = true) { confirmDisconnect(config, a) })
    }

    private fun confirmDisconnect(config: UploadSettings.Config, a: Agents.Agent) {
        AlertDialog.Builder(this)
            .setTitle("Disconnect ${a.label}?")
            .setMessage("Its agent stops reading and posting at once. To use it again, connect it with a new code.")
            .setPositiveButton("Disconnect") { _, _ ->
                background.execute {
                    runCatching { Agents.disconnect(config, a.id) }
                        .onSuccess { ui.post { agentsProblem = null; redrawAgents(); flash("${a.label} is disconnected.") } }
                        .onFailure { e -> ui.post { flash("Not disconnected: ${problemText(e)}") } }
                }
                Timeline.log("inbox", "agent_disconnect")
            }
            .setNegativeButton("Keep", null)
            .show()
    }

    // ---- Local recordings and read-only account history.

    private fun openRecordings() {
        goTo(Page.RECORDINGS)
        drawnRecordings = ""
        showRecordings()
        ui.removeCallbacks(poll); ui.post(poll)
        Timeline.log("inbox", "recordings_open")
    }

    /** Local storage first; remote rows never enter Recording.list, UploadState or the deletion flow. */
    private fun showRecordings() {
        if (page != Page.RECORDINGS) return
        syncHistoryScope()
        val config = UploadSettings.load(this)
        val all = Recording.list(this)
        val pendingDeletes = DeleteWorker.pending(this)
        val deleteErrors = DeleteWorker.errors(this)
        val look = localLook(all) + ":${all.map { it.upload.uploadId }}:${all.sumOf { it.bytes }}:$pendingDeletes:$deleteErrors:$historyRevision:${signIn.inboxText()}"
        if (look == drawnRecordings) return
        drawnRecordings = look
        liveStatuses.clear()
        // StorageStatus is the receiver's allowance, not bytes actually stored on this headset.
        val used = String.format(Locale.US, "%.1f GB stored locally", all.sumOf { it.bytes } / 1e9)
        head.removeAllViews()
        head.addView(topBar("Recordings", deleteKey))
        head.addView(headPlate("This account", config?.account?.takeIf { it.isNotBlank() }?.let {
            signIn.accountText(it)
        } ?: if (config != null) "Connected with a team token." else "Not signed in to the server."))
        recordingsView.removeAllViews()
        recordingsView.addView(headPlate("On this headset", "$used  ·  ${all.size} recording${if (all.size == 1) "" else "s"}  ·  delete to free space"))
        if (pendingDeletes > 0) recordingsView.addView(Retro.body(this, 17f, Retro.BURNT).apply {
            text = "$pendingDeletes server deletion(s) not yet confirmed. " + deleteErrors.ifEmpty { "Queued; waiting for the server." }
            setPadding(0, dp(14f), 0, 0)
        })
        if (all.isEmpty()) recordingsView.addView(Retro.body(this, 17f, Retro.BURNT).apply { text = "No recordings on this headset."; setPadding(0, dp(14f), 0, 0) })
        for (r in all) recordingsView.addView(recordingRow(r))
        recordingsView.addView(headPlate("On the server", "Read-only history · not stored on this headset. Nothing is downloaded or deleted here."))
        val records = historyRecords?.let { HistoryPolicy.serverOnly(it, all.map { r -> HistoryPolicy.Local(r.upload.uploadId, clientId(r)) }) }
        val message = when {
            config == null -> signInMessage()
            historyProblem != null -> historyProblem + if (records != null) " Showing last checked history; it may be out of date." else ""
            records == null -> "Loading server history…"
            historyLoading -> "Refreshing server history…"
            records.isEmpty() && historyRecords.orEmpty().none { it.status != "deleted" } -> "No recordings on the server for this account."
            records.isEmpty() -> "All server recordings are already listed on this headset."
            else -> "${records.size} server recording${if (records.size == 1) "" else "s"} not stored on this headset."
        }
        recordingsView.addView(Retro.body(this, 15f, Retro.BURNT).apply { text = message; setPadding(0, dp(12f), 0, dp(4f)) })
        val ticket = historyGuard.ticket()
        if (config != null && ticket != null) records.orEmpty().forEach { recordingsView.addView(serverRecordingRow(it, ticket)) }
    }

    private fun serverRecordingRow(r: ReceiverClient.Upload, ticket: HistoryPolicy.Guard.Ticket<UploadSettings.Config>): View {
        val colour = when (r.status) {
            "ready" -> Retro.GREEN
            "failed" -> Retro.RED
            "received", "processing" -> Retro.PROCESSING
            "uploading" -> Retro.UPLOADING
            else -> Retro.TAN
        }
        val format = DateTimeFormatter.ofPattern("d MMM yyyy HH:mm", Locale.UK)
        val date = r.recordedAt?.let { iso -> runCatching {
            OffsetDateTime.parse(iso).atZoneSameInstant(ZoneId.systemDefault()).format(format)
        }.getOrNull() }
            // Earlier receivers omit recordedAt; app client IDs preserve the headset's local run time.
            ?: Regex("(?:^|-)([0-9]{8}-[0-9]{6})$").find(r.clientId)?.groupValues?.get(1)?.let { run -> runCatching {
                LocalDateTime.parse(run, DateTimeFormatter.ofPattern("uuuuMMdd-HHmmss", Locale.US)
                    .withResolverStyle(ResolverStyle.STRICT)).format(format)
            }.getOrNull() }
            ?: "Date unavailable"
        return RackUnit(this).apply {
            layoutParams = wide()
            val texts = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(Retro.label(this@InboxPane, r.title ?: "Recording · $date", 16f, Retro.CREAM, 0.04f).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
            texts.addView(Retro.body(this@InboxPane, 13f, Retro.TAN).apply {
                text = listOfNotNull(date, r.bytes?.let { String.format(Locale.US, "%.0f MB", it / 1_048_576.0) }, r.thread).joinToString("  ·  ")
            })
            statusViews(texts, Status(if (r.status == "ready") "ON SERVER" else r.status.uppercase(Locale.US), colour), "SERVER · ")
            texts.addView(Retro.body(this@InboxPane, 14f, Retro.TAN).apply { text = r.summary ?: "No summary available." })
            r.thread?.let { key -> texts.addView(Retro.button(this@InboxPane, "Open thread ›", Retro.CREAM, small = true) {
                if (current(ticket)) openThread(key, r.title ?: key)
                else { syncHistoryScope(); showRecordings() }
            }, wide()) } ?: texts.addView(Retro.body(this@InboxPane, 13f, Retro.TAN).apply { text = "No linked thread." })
            addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
    }

    private fun recordingRow(r: Recording): View {
        val s = statusOf(r, null)
        val row = RackUnit(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) }
        }
        row.addView(View(this).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(s.colour) } },
            LinearLayout.LayoutParams(dp(12f), dp(12f)).apply { rightMargin = dp(14f) })
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(Retro.label(this, r.upload.title ?: whenRun(r.name), 16f, Retro.CREAM, 0.04f).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
        texts.addView(Retro.body(this, 13f, Retro.TAN).apply {
            text = listOfNotNull(
                if (r.upload.title != null) whenRun(r.name) else null, r.without, length(r.durationMs),
                String.format(Locale.US, "%.0f MB", r.bytes / 1_048_576.0), r.threadKey ?: "no thread",
            ).joinToString("  ·  ")
        })
        statusViews(texts, s, "")
        texts.addView(recordingButtons(r, selectable = true))
        row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }

    // ---- A thread.

    private fun openThread(key: String, title: String) {
        // Read once opened: the row goes quiet now rather than at the next poll (the receiver marks it on fetch).
        Threads.listing?.let { l ->
            if (l.threads.any { it.key == key && it.unread }) Threads.listing = l.copy(threads = l.threads.map { if (it.key == key) it.copy(unread = false) else it }, unread = (l.unread - 1).coerceAtLeast(0))
        }
        goTo(Page.THREAD)
        Threads.openKey = key; Threads.openTitle = title
        thread = Threads.Thread("", key, "", "", title, "open", 0, 0, emptyList())
        drawn = ""
        head.addView(threadTopBar(closed = false))
        threadView.removeAllViews()
        threadView.addView(titleBlock(title, null))
        threadView.addView(Retro.body(this, 15f, Retro.BURNT).apply { text = "Loading…"; setPadding(dp(6f), dp(8f), 0, 0) })
        showList()
        Timeline.log("inbox", "thread_open", "key" to key)
        ui.removeCallbacks(poll); ui.post(poll)
    }

    private fun showThread(t: Threads.Thread) {
        if (page != Page.THREAD) return
        val locals = Recording.list(this)
        val mine = locals.filter { it.threadKey == t.key }
        // A recording's status moves (uploading, processing) without the thread's seq moving, and this
        // headset's bytes move between polls, so all of it counts.
        // A recording's words can be ready (title, summary) while its video is still uploading.
        val marks = t.messages.joinToString(",") { m -> m.picks.joinToString("") { "${it.launch}${it.byId}" } + "/" + m.reactions.joinToString("") { "${it.reaction}${it.byId}" } }
        val people = t.people.joinToString(",") { "${it.name}${it.email}${it.invited}" } + ":${t.participantCount}:${t.canPlay}"
        // The Welcome's answer carries the card that connects an agent, so what that card shows counts too.
        val agents = if (t.messages.any(Agents::isWelcomeAnswer)) agentLook() else ""
        val look = "${t.key}:${t.seq}:${t.title}:${t.state}:${t.messages.joinToString(",") { m -> m.recording?.let { "${it.status}${it.stepsDone}${it.title}${it.sessionId}" } ?: "" }}:$marks:$people/${localLook(mine)}:${unfoldedMessages.sorted()}:$agents"
        val grew = thread?.key != t.key || (thread?.messages?.size ?: 0) < t.messages.size
        thread = t
        Threads.openTitle = t.title
        if (look == drawn) return
        drawn = look
        liveStatuses.clear()
        agentClocks.clear()
        // The bar lives above the scroll, so back, Archive, Delete and more stay put while the messages scroll.
        head.removeAllViews()
        head.addView(threadTopBar(t.state == "closed"))
        val y = scroll.scrollY
        threadView.removeAllViews()
        titleBlockView = titleBlock(t.title, t).also { threadView.addView(it) }
        drawPinned(t)
        val byClient = locals.associateBy { clientId(it) }
        // Earlier messages fold to a line each, the latest open in full, as a mail client shows a conversation.
        val latest = t.messages.lastOrNull()?.id
        pendingModel?.let { sha -> t.messages.lastOrNull { m -> m.launches.any { l -> l.steps.orEmpty().any { it is Threads.Step.Model && it.sha256 == sha } } }?.let { unfoldedMessages += it.id } }
        for (m in t.messages) threadView.addView(
            if (m.id == latest || m.id in unfoldedMessages) messageCard(t, m, m.recording?.let { byClient[it.clientId] }, foldable = m.id != latest)
            else foldedCard(t, m))
        // This headset's recordings for this thread that the receiver does not have yet, the one being recorded among them.
        val onServer = t.messages.mapNotNull { it.recording?.clientId }.toSet()
        for (r in mine.filter { clientId(it) !in onServer }.sortedBy { it.name }) threadView.addView(pendingCard(r))
        val reveal = pendingModel?.let { sha -> modelViews.entries.firstOrNull { it.key.startsWith("${t.key}#") && it.key.endsWith("#$sha") && it.value.parent != null }?.value }
        when {
            reveal != null -> { pendingModel = null; scroll.post { scroll.smoothScrollTo(0, top(reveal)); syncPinned() } }
            grew -> scroll.post { scroll.fullScroll(View.FOCUS_DOWN); syncPinned() }
            else -> scroll.post { scroll.scrollTo(0, y); syncPinned() }
        }
    }

    /** Where [v] sits in the thread's scrolling content. */
    private fun top(v: View): Int {
        var y = 0; var at: View? = v
        while (at != null && at !== scroll) { y += at.top; at = at.parent as? View }
        return (y - dp(60f)).coerceAtLeast(0)
    }

    /** A model a launch has just opened, from the deck: its message opens out and scrolls into view. */
    private var pendingModel: String? = null

    private fun showModel(key: String, sha256: String) {
        pendingModel = sha256
        if (page == Page.THREAD && thread?.key == key) { drawn = ""; thread?.takeIf { it.seq > 0 }?.let { showThread(it) } }
        else openThread(key, Threads.listing?.threads?.firstOrNull { it.key == key }?.title ?: key)
    }

    /** The viewer for a launch's model in this message, made once and kept across redraws. */
    private fun modelFor(t: Threads.Thread, m: Threads.Message, launch: Threads.Launch): ModelView? {
        val step = launch.steps.orEmpty().filterIsInstance<Threads.Step.Model>().firstOrNull() ?: return null
        val view = modelViews.getOrPut("${t.key}#${m.id}#${step.sha256}") { ModelView(this, t.key, step) }
        (view.parent as? ViewGroup)?.removeView(view)
        return view
    }

    private fun dropModels() {
        modelViews.values.forEach { it.destroy() }
        modelViews.clear()
    }

    /** An earlier message folded to one line: who, a few words, what it carries and when; a press opens it out. */
    private fun foldedCard(t: Threads.Thread, m: Threads.Message): View {
        val mine = m.byId == t.me
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18f), dp(12f), dp(18f), dp(12f))
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(50, 239, 230, 210)), PlateDrawable(resources.displayMetrics.density, if (mine) Retro.SURFACE else Retro.PANEL), null)
            isClickable = true; isFocusable = true
            contentDescription = "Message ${m.id} from ${m.byName}, folded. Press to open it"
            setOnClickListener { unfoldedMessages += m.id; drawn = ""; showThread(t); Timeline.log("inbox", "message_open", "key" to t.key, "message" to m.id) }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) }
        }
        val letter = t.people.firstOrNull { !it.invited && it.name == (m.byUser ?: m.byName) }?.initial
        row.addView(Avatar.of(this, m.byName, m.byUser, m.byColour, m.byAgent, letter, sizeDp = 28f))
        row.addView(Retro.label(this, if (mine) "You" else m.byName, 14f, Retro.CREAM, 0.04f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END },
            LinearLayout.LayoutParams(dp(150f), LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(10f) })
        val carries = listOfNotNull(
            "3D".takeIf { m.launches.any { l -> l.steps.orEmpty().any { it is Threads.Step.Model } } },
            // A take of logs alone (docs/LOGS.md) recorded nothing to play.
            "● REC".takeIf { m.recording != null && m.recording.content != "none" },
            "LOGS".takeIf { m.recording?.content == "none" },
            "${m.launches.size} OPTIONS".takeIf { m.launches.size > 1 },
            (if (m.photos.size == 1) "PHOTO" else "${m.photos.size} PHOTOS").takeIf { m.photos.isNotEmpty() },
        )
        val words = m.text ?: m.recording?.let { r -> listOfNotNull(r.title, r.summary).joinToString(": ").ifEmpty { "Recording" } }
            ?: m.photos.takeIf { it.isNotEmpty() }?.let { Photos.words(it.size) } ?: m.launches.firstOrNull()?.let { Threads.steps(it) } ?: ""
        row.addView(Retro.body(this, 14f, Retro.TAN).apply { text = words.replace(Regex("\\s+"), " "); maxLines = 1; ellipsize = TextUtils.TruncateAt.END },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(10f) })
        for (c in carries) row.addView(tag(c, if (c == "● REC") Retro.RED else Retro.AMBER), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
        row.addView(Retro.body(this, 13f, Retro.TAN).apply { text = whenText(m.at) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(10f) })
        return row
    }

    /** The slim strip: the title on one line with the thread's key and an opener; open, the whole title block. */
    private fun drawPinned(t: Threads.Thread) {
        pinned.removeAllViews()
        if (pinnedOpen) {
            pinned.addView(titleBlock(t.title, t).apply { setPadding(dp(14f), dp(4f), dp(14f), dp(6f)) })
            pinned.addView(Retro.button(this, "▴  Less", Retro.TAN, small = true) { pinnedOpen = false; drawPinned(t); syncPinned() },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(14f); bottomMargin = dp(8f) })
            return
        }
        pinned.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(14f), dp(2f), dp(10f), dp(8f))
            isClickable = true; isFocusable = true; contentDescription = "Thread: ${t.title}. Press to show it all"
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(50, 82, 44, 18)), null, ColorDrawable(Color.WHITE))
            setOnClickListener { pinnedOpen = true; drawPinned(t); Timeline.log("inbox", "pinned_title_open", "key" to t.key) }
            addView(TextView(this@InboxPane).apply {
                text = t.title; textSize = 17f; typeface = Retro.LABEL; setTextColor(Retro.BURNT); maxLines = 1; ellipsize = TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(tag(t.key, Retro.CREAM), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(10f) })
            addView(Retro.label(this@InboxPane, "▾", 16f, Retro.BURNT, 0f).apply { setPadding(dp(10f), 0, 0, 0) })
        })
    }

    /** Shown once the big title has scrolled out of sight (or while opened out); gone on other pages and at the top. */
    private fun syncPinned() {
        if (!::pinned.isInitialized) return
        val block = titleBlockView
        val column = threadView.parent as? View
        if (page != Page.THREAD || block == null || column == null || block.parent == null) { pinned.visibility = View.GONE; pinnedOpen = false; return }
        val titleGone = scroll.scrollY > column.top + threadView.top + block.bottom - dp(8f)
        if (!titleGone && pinnedOpen) { pinnedOpen = false; thread?.let { drawPinned(it) } }
        val show = titleGone || pinnedOpen
        if ((pinned.visibility == View.VISIBLE) != show) pinned.visibility = if (show) View.VISIBLE else View.GONE
    }

    /** Gmail's bar over a message: back, then Archive (or Move to inbox), Delete and more. */
    private fun threadTopBar(closed: Boolean): View {
        fun loaded(go: (Threads.Thread) -> Unit) { thread?.takeIf { it.seq > 0 }?.let(go) }
        return topBar(null,
            Glyph.key(this, if (closed) Glyph.Kind.UNARCHIVE else Glyph.Kind.ARCHIVE, Retro.BURNT, if (closed) "Move to inbox" else "Archive") { loaded { archive(it, close = it.state != "closed") } },
            Glyph.key(this, Glyph.Kind.TRASH, Retro.BURNT, "Delete from your inbox") { loaded { confirmHide(it) } },
            Glyph.key(this, Glyph.Kind.MORE, Retro.BURNT, "More") { loaded { showMore(it) } },
        )
    }

    /** A small label on a dark plate: a thread's project beside its title, as Gmail labels a message Inbox. */
    private fun tag(text: String, colour: Int) = Retro.label(this, text, 12f, colour, 0.14f).apply {
        setPadding(dp(10f), dp(4f), dp(10f), dp(4f))
        background = Retro.panel(this@InboxPane, Retro.PANEL, 8f, Retro.EDGE)
    }

    /**
     * The thread's subject, Gmail's: the title large, the project as its label with the key, and who is in it
     * (their circles and names; a press lists them, the person key adds more). No star: the label is enough.
     */
    private fun titleBlock(title: String, t: Threads.Thread?) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(6f), 0, dp(6f), dp(6f))
        addView(TextView(this@InboxPane).apply {
            text = title; textSize = 24f; typeface = Retro.LABEL; letterSpacing = 0.02f; setTextColor(Retro.BURNT); setLineSpacing(0f, 1.05f)
        })
        if (t == null) return@apply
        val labels = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(8f), 0, 0) }
        labels.addView(tag(t.projectName.uppercase(Locale.UK), Retro.AMBER), spaced())
        labels.addView(tag(t.key, Retro.CREAM), spaced())
        if (t.state == "closed") labels.addView(tag("ARCHIVED", Retro.TAN), spaced())
        if (t.hidden) labels.addView(tag("NOT IN YOUR INBOX", Retro.TAN), spaced())
        addView(labels)
        val who = LinearLayout(this@InboxPane).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(8f), 0, 0)
            isClickable = true; isFocusable = true
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(50, 82, 44, 18)), null, ColorDrawable(Color.WHITE))
            contentDescription = "People in this thread"
            setOnClickListener { showPeople(t) }
        }
        who.addView(AvatarStack(this@InboxPane, Retro.WOOD_MID, 36f).apply { faces = faces(t.people); total = t.people.size })
        val names = t.people.map { p -> if (p.invited) "${p.email ?: "someone"} (invited)" else p.name }
        who.addView(Retro.body(this@InboxPane, 15f, Retro.BURNT).apply {
            text = InboxText.names(names.take(3), names.size).ifEmpty { "Nobody yet" }; maxLines = 2; ellipsize = TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(10f) })
        who.addView(Glyph.key(this@InboxPane, Glyph.Kind.PERSON_ADD, Retro.BURNT, "Add people") { showForward(t) })
        addView(who)
    }

    private fun whenText(iso: String) = runCatching { shown.format(stamp.parse(iso.take(19))!!) }.getOrDefault("")

    /** A message's plate, full width as Gmail's are; this headset's own a shade lighter. */
    private fun plate(mine: Boolean) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        val p = dp(18f); setPadding(p + dp(6f), p, p + dp(6f), p)
        background = PlateDrawable(resources.displayMetrics.density, if (mine) Retro.SURFACE else Retro.PANEL)
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) }
    }

    /**
     * One message, Gmail's: the sender's circle and name, when, and a smiley to react to it; then its words,
     * launches and recording, and the reactions given.
     */
    private fun messageCard(t: Threads.Thread, m: Threads.Message, local: Recording?, foldable: Boolean = false): View {
        val mine = m.byId == t.me
        val card = plate(mine)
        // Who sent it, and how they read ("Opus 5.5 on Robin's Mac"); a person's circle has their email's letter.
        val letter = t.people.firstOrNull { !it.invited && it.name == (m.byUser ?: m.byName) }?.initial
        val sender = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        sender.addView(Avatar.of(this, m.byName, m.byUser, m.byColour, m.byAgent, letter, sizeDp = 36f))
        val who = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        who.addView(Retro.label(this, if (mine) "You" else m.byName, 15f, Retro.CREAM, 0.04f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
        who.addView(Retro.body(this, 13f, Retro.TAN).apply { text = "#${m.id}  ·  ${whenText(m.at)}" })
        sender.addView(who, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(12f) })
        sender.addView(Glyph.key(this, Glyph.Kind.SMILE, Retro.TAN, "React to #${m.id}") { showReactions(t, m) })
        // An earlier message opened out folds back from its sender line.
        if (foldable) sender.apply {
            isClickable = true; isFocusable = true; contentDescription = "Fold message ${m.id}"
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(50, 239, 230, 210)), null, ColorDrawable(Color.WHITE))
            setOnClickListener { unfoldedMessages -= m.id; drawn = ""; showThread(t) }
        }
        card.addView(sender)
        m.text?.let { card.addView(Retro.body(this, 17f, Retro.CREAM).apply { text = it; setPadding(0, dp(6f), 0, 0); setLineSpacing(0f, 1.15f) }) }
        if (m.photos.isNotEmpty()) card.addView(photosBlock(t, m))
        // The Welcome's answer says an agent can read all this; here is where one is connected (pick D).
        if (Agents.isWelcomeAnswer(m) && Threads.listing?.agents == true) card.addView(agentInline(), wide())
        if (m.launches.size > 1) card.addView(optionsBlock(t, m))
        else m.launches.forEachIndexed { i, launch -> card.addView(launchRow(t, m, i, launch)) }
        m.recording?.let { r ->
            card.addView(recordingBlock(t, m, r, local))
            if (local != null) card.addView(recordingButtons(local))
        }
        reactionRow(t, m)?.let { card.addView(it) }
        return card
    }

    /**
     * A message's photos (2026-11-07): a row of tiles, fetched through the thread, one opening large when
     * pressed; or, for a headset not in the thread, a line saying who can see them.
     */
    private fun photosBlock(t: Threads.Thread, m: Threads.Message): View {
        val params = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) }
        if (!m.canView) return Retro.body(this, 14f, Retro.TAN).apply {
            text = if (m.photos.size == 1) "A photo only people in this thread can see." else "${m.photos.size} photos only people in this thread can see."
            layoutParams = params
        }
        return PhotoStrip(this, t.key, m.photos) { photo, file -> showPhoto(photo, file) }.apply { layoutParams = params }
    }

    /** One photo large, over the panel, shrunk to the screen; a press anywhere or Close puts it away. */
    private fun showPhoto(photo: Threads.Photo, file: File) {
        val longest = maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        val bitmap = PhotoStrip.decode(file, photo, longest) ?: run { say("That photo could not be drawn."); return }
        plateDialog(null, width = 1100f) { box, dialog ->
            box.addView(ImageView(this).apply {
                setImageBitmap(bitmap); adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER
                maxHeight = (resources.displayMetrics.heightPixels * 0.75).toInt()
                contentDescription = "Photo, ${photo.width} by ${photo.height}. Press to close"
                setOnClickListener { dialog.dismiss() }
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            val foot = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(12f), 0, 0) }
            foot.addView(Retro.body(this, 13f, Retro.TAN).apply { text = Photos.describe(photo) }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            foot.addView(Retro.button(this, "Close", Retro.CREAM, small = true) { dialog.dismiss() })
            box.addView(foot)
        }
    }

    /**
     * This headset's own copy of a recording, when it is whole and not still being made: it plays without the network.
     * The video, or the sound of a take without the picture; a take of logs alone has nothing to play.
     */
    private fun localMedia(r: Recording?): File? = r?.takeIf { !it.interrupted && !CaptureState.busy(it.dir) }
        ?.media?.takeIf { it.exists() }

    /**
     * A recording in its message (2026-10-12): a tile that opens the player, with its length, beside its title,
     * summary and where it is, in the transfer unit's colours. It plays once the receiver has it and this
     * headset may (people in the thread and the team), or from this headset's own copy.
     */
    private fun recordingBlock(t: Threads.Thread, m: Threads.Message, r: Threads.Recording, local: Recording?): View {
        // What it holds: the receiver says (fail closed to a video), else this headset's own copy knows.
        val content = if (r.content != "video" || local == null) r.content else when (local.kind) {
            TakeKind.SOUND -> "sound"; TakeKind.LOGS -> "none"; else -> "video"
        }
        // Logs alone (docs/LOGS.md): nothing to play, so no play key; the tile says what it is instead.
        val logsOnly = content == "none"
        val own = if (logsOnly) null else localMedia(local)
        val playable = !logsOnly && (own != null || (t.canPlay != false && r.sessionId != null && r.status != "deleted"))
        val block = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP; setPadding(0, dp(12f), 0, 0) }
        val tile = FrameLayout(this).apply {
            background = Retro.panel(this@InboxPane, Retro.CASING, 8f, if (playable) Retro.EDGE else Retro.SURFACE)
            alpha = if (playable || logsOnly) 1f else 0.5f
            if (!logsOnly) {
                foreground = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 239, 230, 210)), null, ColorDrawable(Color.WHITE))
                isClickable = true; isFocusable = true
                contentDescription = if (playable) "Play ${r.title ?: "the recording"}${if (content == "sound") ", sound only" else ""}" else "Not ready to play"
                setOnClickListener { if (playable) openPlayer(t, m, r, own, content) else say(notPlayable(t, r)) }
            } else contentDescription = "Logs only: the headset's logs, nothing to play"
        }
        if (logsOnly) tile.addView(Retro.label(this, "LOGS ONLY", 13f, Retro.AMBER, 0.14f).apply { gravity = Gravity.CENTER },
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        else tile.addView(ImageView(this).apply { setImageDrawable(Glyph(Glyph.Kind.PLAY, Retro.CREAM, resources.displayMetrics.density, 34f)) },
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        // Where the picture would be: there is none.
        if (content == "sound") tile.addView(Retro.label(this, "SOUND ONLY", 11f, Retro.AMBER, 0.12f).apply {
            setPadding(dp(6f), dp(2f), dp(6f), dp(2f)); background = Retro.panel(this@InboxPane, Retro.PANEL, 4f, Retro.PANEL)
        }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply { setMargins(dp(6f), dp(6f), 0, 0) })
        length(r.durationMs ?: local?.durationMs)?.let {
            tile.addView(Retro.label(this, it, 12f, Retro.CREAM, 0.08f).apply {
                setPadding(dp(6f), dp(2f), dp(6f), dp(2f)); background = Retro.panel(this@InboxPane, Retro.PANEL, 4f, Retro.PANEL)
            }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, dp(6f), dp(6f)) })
        }
        block.addView(tile, LinearLayout.LayoutParams(dp(136f), dp(77f)))
        val words = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        words.addView(Retro.label(this, r.title ?: if (logsOnly) "Logs" else "Recording", 16f, Retro.CREAM, 0.04f).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END })
        r.summary?.let { words.addView(Retro.body(this, 14f, Retro.TAN).apply { text = it; maxLines = 4; ellipsize = TextUtils.TruncateAt.END }) }
        if (logsOnly || r.logs) words.addView(Retro.body(this, 13f, Retro.TAN).apply {
            text = if (logsOnly) "Logs only: the headset's logs from the take, in its bundle." else "With the headset's logs from the take."
        })
        statusViews(words, statusOf(local, r), "● ")
        optionsTried(t, r)?.let { words.addView(Retro.body(this, 14f, Retro.AMBER).apply { text = it; setPadding(0, dp(4f), 0, 0) }) }
        block.addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(14f) })
        return block
    }

    private fun notPlayable(t: Threads.Thread, r: Threads.Recording) = when {
        t.canPlay == false -> "Only people in this thread, and the team, can play its recordings."
        r.status == "deleted" -> "This recording was deleted."
        else -> "Not ready to play yet: it is still on its way to the server."
    }

    /** The player, over the inbox in its panel: the receiver streams it, or this headset's own copy plays. */
    private fun openPlayer(t: Threads.Thread, m: Threads.Message, r: Threads.Recording, own: File?, content: String) {
        Timeline.log("inbox", "play", "key" to t.key, "message" to m.id, "local" to (own != null), "content" to content)
        startActivity(Intent(this, PlayerActivity::class.java)
            .putExtra(PlayerActivity.EXTRA_THREAD, t.key).putExtra(PlayerActivity.EXTRA_MESSAGE, m.id)
            .putExtra(PlayerActivity.EXTRA_TITLE, r.title ?: "${t.key} #${m.id}")
            .putExtra(PlayerActivity.EXTRA_LOCAL, own?.absolutePath)
            .putExtra(PlayerActivity.EXTRA_SOUND_ONLY, content == "sound"))
    }

    /** A recording of this headset's on its way to this thread: the receiver has nothing for it yet. */
    private fun pendingCard(r: Recording): View {
        val card = plate(mine = true)
        card.addView(Retro.body(this, 13f, Retro.TAN).apply { text = listOfNotNull("You", whenRun(r.name), r.without, "not on the server yet").joinToString("  ·  ") })
        statusViews(card, statusOf(r, null), "● RECORDING  ·  ", length(r.durationMs)?.let { "  ·  $it" } ?: "")
        card.addView(recordingButtons(r))
        return card
    }

    /**
     * Reply records (the camera on the key says so, Robin 2026-10-12): the deck asks for capture and the
     * recording replies to this thread, as the deck's own key does while a thread is open.
     */
    private fun recordReply(key: String) {
        if (CaptureState.recording) {
            AlertDialog.Builder(this).setTitle("Already recording")
                .setMessage("Stop the current recording on the deck before recording a reply to $key.")
                .setPositiveButton("Back to deck") { _, _ ->
                    startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                .setNegativeButton("Keep recording", null).show()
            return
        }
        // The destination travels in the intent: a same-task inbox (Android XR) is gone once the deck returns.
        val reply = ThreadReplyRoute(key)
        Timeline.log("inbox", "record_reply", "key" to reply.threadKey)
        startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_START_THREAD)
            .putExtra("thread", reply.threadKey).putExtra("open", reply.open).putExtra(MainActivity.EXTRA_INTERNAL, MainActivity.INTERNAL)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Why a call to the receiver did not work, in words; an older receiver without the route says so. */
    private fun problemText(e: Throwable): String = when ((e as? ReceiverClient.Refused)?.code) {
        null -> "can't reach the server. Check the connection."
        401 -> "sign-in expired; signing in again."
        403 -> "only people in this thread, and the team, can do that."
        404 -> "this server doesn't do that yet."
        else -> e.message?.substringAfter("): ", "")?.ifBlank { null } ?: "the server refused."
    }

    /**
     * Archive, Gmail's key, closes the thread on the receiver: it leaves the inbox, and comes back when
     * someone adds to it. Closing is shared, so it leaves everyone's inbox; Delete is this headset's alone.
     */
    private fun archive(t: Threads.Thread, close: Boolean) {
        val config = UploadSettings.load(this) ?: return
        background.execute {
            runCatching { Threads.setState(ReceiverClient(config), t.key, if (close) "closed" else "open") }
                .onSuccess { updated -> ui.post {
                    val without = { l: Threads.Listing -> l.copy(threads = l.threads.filter { it.key != t.key }) }
                    if (close) Threads.listing = Threads.listing?.let(without) else archived = archived?.let(without)
                    if (page == Page.THREAD && thread?.key == t.key && !close) showThread(updated)
                    else if (page == Page.THREAD && thread?.key == t.key) openList()
                    else showList()
                    if (close) flash("Archived ${t.key}: it comes back when someone adds to it.", "Undo") { archive(updated, close = false) }
                    else flash("${t.key} is back in the inbox.")
                    ui.removeCallbacks(poll); ui.post(poll)
                } }
                .onFailure { e -> ui.post { say("Not ${if (close) "archived" else "moved"}: ${problemText(e)}") } }
        }
        Timeline.log("inbox", if (close) "archive" else "unarchive", "key" to t.key)
    }

    /** Delete is this inbox's alone: the thread stays for everyone else, and comes back here when someone adds to it. */
    private fun confirmHide(t: Threads.Thread) {
        AlertDialog.Builder(this)
            .setTitle("Delete ${t.key} from your inbox?")
            .setMessage("It leaves this inbox, and comes back if someone adds to it. Everyone else in it keeps it, and your recordings in it stay until you delete them.")
            .setPositiveButton("Delete") { _, _ -> hide(t, hidden = true) }
            .setNegativeButton("Keep", null)
            .show()
    }

    private fun hide(t: Threads.Thread, hidden: Boolean) {
        val config = UploadSettings.load(this) ?: return
        background.execute {
            runCatching { if (hidden) Threads.hide(ReceiverClient(config), t.key) else Threads.unhide(ReceiverClient(config), t.key) }
                .onSuccess { ui.post {
                    if (hidden) {
                        val without = { l: Threads.Listing -> l.copy(threads = l.threads.filter { it.key != t.key }) }
                        Threads.listing = Threads.listing?.let(without); archived = archived?.let(without)
                        if (page == Page.THREAD && thread?.key == t.key) openList() else showList()
                        flash("Deleted ${t.key} from your inbox.", "Undo") { hide(t, hidden = false) }
                    } else flash("${t.key} is back in your inbox.")
                    ui.removeCallbacks(poll); ui.post(poll)
                } }
                .onFailure { e -> ui.post { say("Not ${if (hidden) "deleted" else "put back"}: ${problemText(e)}") } }
        }
        Timeline.log("inbox", if (hidden) "hide" else "unhide", "key" to t.key)
    }

    /** Gmail's ⋮ over a thread: what is used less often. */
    private fun showMore(t: Threads.Thread) {
        plateDialog(null, gravity = Gravity.TOP or Gravity.END) { box, dialog ->
            fun item(text: String, go: () -> Unit) = box.addView(menuEntry(text, false) { dialog.dismiss(); go() })
            item("Add people") { showForward(t) }
            item("People in this thread (${t.people.size})") { showPeople(t) }
            item(if (t.state == "closed") "Move to inbox" else "Archive") { archive(t, close = t.state != "closed") }
            if (t.hidden) item("Put back in your inbox") { hide(t, hidden = false) } else item("Delete from inbox") { confirmHide(t) }
            item("Recordings on this headset") { openRecordings() }
        }
    }

    /**
     * Forward, and Add people (2026-10-12): addresses join the thread on the receiver, where everyone in it and
     * the team see them. Since 2026-11-10 the receiver emails each an invitation (who added them, the thread's
     * title, how to join) when the person adding them is on the team; a tester's additions are kept, not emailed.
     */
    private fun showForward(t: Threads.Thread) {
        // Only people in a thread may add to it: the receiver refuses anyone else (they could otherwise probe addresses).
        if (t.canPlay == false) { say("Only people in this thread can add people to it. Reply to it first."); return }
        val invite = mutableListOf<String>()
        plateDialog("SHARE ${t.key}", width = SHEET_WIDTH) { box, dialog ->
            box.addView(Retro.body(this, 15f, Retro.CREAM).apply {
                text = "Add people by email. They join this thread, and if you're on the team, Polydance emails them who added them, the thread's title and how to join."
                setPadding(0, dp(10f), 0, 0); setLineSpacing(0f, 1.1f)
            })
            box.addView(fieldHeading("TO"))
            val to = Recipients(invite)
            box.addView(to.view)
            box.addView(note("The email carries no recordings or messages. Testers' additions join the thread without an email."))
            val keysRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END or Gravity.CENTER_VERTICAL; setPadding(0, dp(16f), 0, 0) }
            keysRow.addView(Retro.button(this, "Cancel", Retro.TAN, small = true) { dialog.dismiss() }, spaced())
            keysRow.addView(iconButton(Glyph.Kind.SHARE, "Add people", Retro.AMBER) {
                if (to.commit() && invite.isNotEmpty()) { dialog.dismiss(); changePeople(t, add = invite.toList()) }
            })
            box.addView(keysRow)
        }
        Timeline.log("inbox", "forward_open", "key" to t.key)
    }

    /** Everyone in the thread: who has posted, and each invited address with ✕ to take it out again. */
    private fun showPeople(t: Threads.Thread) {
        plateDialog("IN ${t.key}") { box, dialog ->
            for (p in t.people) box.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(10f), 0, 0)
                addView(AvatarStack(this@InboxPane, Retro.PANEL, 34f).apply { faces = faces(listOf(p)) })
                val words = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.VERTICAL }
                words.addView(Retro.body(this@InboxPane, 16f, Retro.CREAM).apply { text = if (p.invited) p.email ?: p.name else p.name })
                words.addView(Retro.body(this@InboxPane, 13f, Retro.TAN).apply {
                    // The invitation's state is in participants, which only people in the thread and the team get.
                    val invitation = p.email?.let { e -> t.participants?.firstOrNull { it.email.equals(e, ignoreCase = true) } }
                    text = if (p.invited) InboxText.invitedLine(invitation?.emailed, InboxText.millis(invitation?.emailedAt), invitation?.emailNote, System.currentTimeMillis())
                        else p.email ?: "Posted here"
                })
                addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(12f) })
                val address = p.email
                if (p.invited && address != null) addView(Glyph.key(this@InboxPane, Glyph.Kind.CLOSE, Retro.TAN, "Take $address out of the thread") {
                    dialog.dismiss(); changePeople(t, remove = listOf(address))
                })
            })
            if (t.participants == null && t.participantCount > 0) box.addView(note("Only people in this thread see the invited addresses."))
            val keysRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END or Gravity.CENTER_VERTICAL; setPadding(0, dp(16f), 0, 0) }
            keysRow.addView(Retro.button(this, "Close", Retro.TAN, small = true) { dialog.dismiss() }, spaced())
            keysRow.addView(iconButton(Glyph.Kind.PERSON_ADD, "Add people", Retro.AMBER) { dialog.dismiss(); showForward(t) })
            box.addView(keysRow)
        }
    }

    private fun changePeople(t: Threads.Thread, add: List<String> = emptyList(), remove: List<String> = emptyList()) {
        val config = UploadSettings.load(this) ?: run { say(signInMessage()); return }
        background.execute {
            runCatching { Threads.people(ReceiverClient(config), t.key, add, remove) }
                .onSuccess { updated -> ui.post {
                    say(null)
                    if (page == Page.THREAD && thread?.key == t.key) showThread(updated)
                } }
                .onFailure { e -> ui.post { say("People not ${if (add.isNotEmpty()) "added" else "changed"}: ${problemText(e)}") } }
        }
        Timeline.log("inbox", "people", "key" to t.key, "added" to add.size, "removed" to remove.size)
    }

    /**
     * A message's launches as its options (CAP-1 #17, 2026-10-06): OPTION 1, 2, 3, each on its own plate with
     * its name, a star to pick it, START and what START does. Record each on its own, or start one and press
     * the next START while recording: the recording notes which option was on screen when.
     */
    private fun optionsBlock(t: Threads.Thread, m: Threads.Message) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(Retro.body(this@InboxPane, 13f, Retro.TAN).apply {
            text = "${m.launches.size} options. Record each on its own, or record one and press the next one's Just open while recording."
            setPadding(0, dp(10f), 0, 0)
        })
        val mine = m.picks.firstOrNull { it.byId == t.me }?.launch
        m.launches.forEachIndexed { i, launch ->
            val plate = LinearLayout(this@InboxPane).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12f), dp(10f), dp(12f), dp(10f))
                background = Retro.panel(this@InboxPane, Retro.CASING, 10f, if (mine == i) Retro.AMBER else Retro.EDGE)
            }
            val head = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            head.addView(Retro.label(this@InboxPane, "OPTION ${i + 1}${launch.label?.let { "  ·  ${it.uppercase()}" } ?: ""}", 14f, Retro.CREAM, 0.14f).apply { maxLines = 2 },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            val others = m.picks.filter { it.launch == i && it.byId != t.me }.map { it.byName }
            if (others.isNotEmpty()) head.addView(Retro.body(this@InboxPane, 12f, Retro.TAN).apply { text = "★ ${others.joinToString(", ")}" },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) })
            head.addView(Retro.button(this@InboxPane, if (mine == i) "★ Picked" else "☆ Pick", if (mine == i) Retro.AMBER else Retro.TAN, small = true) { pickOption(t, m, i) })
            plate.addView(head)
            plate.addView(launchRow(t, m, i, launch, withLabel = false))
            addView(plate, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
        }
    }

    /**
     * The star: one option per message, the same again takes it back; the team sees it (CAP-1 #18). Shown at
     * once and put back only if the receiver refuses (CAP-1 #20, 00:24 to 00:40: buttons answer at once).
     */
    private fun pickOption(t: Threads.Thread, m: Threads.Message, launch: Int) {
        val client = client() ?: return
        val before = thread
        val mine = m.picks.firstOrNull { it.byId == t.me }
        val picks = m.picks.filter { it.byId != t.me } + if (mine?.launch == launch) emptyList() else listOf(Threads.Pick(launch, t.me, "you"))
        before?.takeIf { it.key == t.key }?.let { cur -> showThread(cur.copy(messages = cur.messages.map { if (it.id == m.id) it.copy(picks = picks) else it })) }
        background.execute {
            runCatching { Threads.pick(client, t.key, m.id, launch) }
                .onSuccess { updated -> ui.post { if (thread?.key == t.key) showThread(updated) } }
                .onFailure { e -> ui.post { if (before != null && thread?.key == t.key) showThread(before); say("Pick not sent: ${e.message}") } }
        }
        Timeline.log("inbox", "pick", "key" to t.key, "message" to m.id, "launch" to launch)
    }

    /** Which of the answered message's options a recording tried: "answers option 2 (Red)", or several in one take. */
    private fun optionsTried(t: Threads.Thread, r: Threads.Recording): String? {
        val asked = r.replyTo?.let { id -> t.messages.firstOrNull { it.id == id } } ?: return null
        if (asked.launches.size < 2) return null
        val name = { i: Int -> "${i + 1}${asked.launches.getOrNull(i)?.label?.let { " ($it)" } ?: ""}" }
        return when {
            r.tried.size > 1 -> "tried options ${r.tried.joinToString(", ") { name(it) }}"
            r.tried.size == 1 -> "answers option ${name(r.tried[0])}"
            r.replyLaunch != null -> "answers option ${name(r.replyLaunch)}"
            else -> null
        }
    }

    /**
     * A filter chip, Material's pattern for switching one thing on or off: a tick and amber when on, a plain
     * outline when off (CAP-1 #20, 03:17 to 03:36: the ■ box did not read as a checkbox).
     */
    private fun chip(label: String, on: Boolean, onClick: () -> Unit) = TextView(this).apply {
        text = if (on) "✓  $label" else label
        textSize = 14f; typeface = Retro.LABEL; letterSpacing = 0.06f
        setTextColor(if (on) Retro.CASING else Retro.TAN)
        background = Retro.panel(this@InboxPane, if (on) Retro.AMBER else Retro.CASING, 18f, if (on) Retro.AMBER else Retro.EDGE)
        setPadding(dp(14f), dp(7f), dp(14f), dp(7f))
        isClickable = true; isFocusable = true
        contentDescription = "$label: ${if (on) "on" else "off"}"
        setOnClickListener { onClick() }
    }

    /** Launches whose settings are unfolded, by thread, message and launch. */
    private val unfolded = mutableSetOf<String>()

    /**
     * Two keys, a Settings key beside them, and below what the main key will do (Robin, 2026-11-07): Record
     * and open, red with the camera, records and then opens what the launch names, the press most of them
     * want; Just open opens it with no recording, to look again at something without leaving an empty
     * recording to delete. They replaced one Reply key and the Record and Open switches under Settings
     * (CAP-1 #20 and #24, CAP-7). A launch that opens nothing has Record alone: there is nothing else for it
     * to do. Settings is folded away by default and holds what the take records, Screen, Mic, App sound and Logs
     * (Takes, 2026-11-16), the deck's own switches (the "settings" preferences), so the two places agree; a dot on
     * Settings marks one switched off. App sound needs Screen: without it the chip shows off, will not turn on, and
     * a line under the chips says why.
     */
    private fun launchRow(t: Threads.Thread, m: Threads.Message, index: Int, launch: Threads.Launch, withLabel: Boolean = true) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, dp(10f), 0, 0)
        val runnable = launch.steps != null
        val choice = "${t.key}#${m.id}.$index"
        val opens = runnable && Threads.opens(launch)
        val prefs = getSharedPreferences("settings", MODE_PRIVATE)
        fun build() {
            removeAllViews()
            // A 3D model the launch opens is in the message itself, over its keys (Robin, 2026-10-20).
            modelFor(t, m, launch)?.let { addView(it, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)) }
            val switches = TakeSwitches(prefs.getBoolean("screen", true), prefs.getBoolean("mic", true), prefs.getBoolean("appAudio", true), prefs.getBoolean("logs", true))
            val changed = switches.changed
            val shown = choice in unfolded
            val row = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            val beside = { LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12f) } }
            // A launch this build cannot read keeps its key, drawn tan and switched off, so the message still shows what it offers.
            row.addView(iconButton(Glyph.Kind.CAMERA, if (opens || !runnable) "Record and open" else "Record", if (runnable) Retro.RED else Retro.TAN) {
                if (runnable) start(t, m, index, launch, record = true)
            }.apply { isEnabled = runnable; contentDescription = if (opens) "Record and open: records a reply, then opens it" else "Record: records a reply" })
            if (opens) row.addView(Retro.button(this@InboxPane, "Just open") { start(t, m, index, launch, record = false) }
                .apply { contentDescription = "Just open: opens it without recording" }, beside())
            if (runnable) row.addView(Retro.button(this@InboxPane, "${if (shown) "▴" else "▾"}  Settings${if (changed) "  •" else ""}", if (changed) Retro.AMBER else Retro.TAN, small = true) {
                if (!unfolded.remove(choice)) unfolded.add(choice)
                build()
            }, beside())
            addView(row)
            // Beside the keys, before either is pressed: the build this asks for is not the one installed (CAP-4 #2).
            val problems = if (runnable) Threads.problems(this@InboxPane, launch) else emptyList()
            // A launch this build cannot read (a step added later, such as a 3D model) needs a newer Polydance (2026-10-20).
            val needsNewer = !runnable
            if (problems.isNotEmpty() || needsNewer) addView(Retro.body(this@InboxPane, 14f, Retro.RED).apply {
                text = if (needsNewer) "This needs a newer Polydance. Update it, then come back here."
                    else problems.joinToString("\n") { "$it. Update it before starting." }
                setPadding(0, dp(6f), 0, 0)
            })
            // For Polydance itself, a key to its store page rather than only words (CAP-6 #3, 2026-10-13).
            val store = if ((problems.isNotEmpty() && Threads.requiresSelf(this@InboxPane, launch)) || needsNewer) headsetPlatform.storePage(this@InboxPane) else null
            if (store != null) addView(Retro.button(this@InboxPane, "Update", Retro.AMBER, small = true) {
                Timeline.log("inbox", "store_page", "key" to t.key, "message" to m.id)
                runCatching { startActivity(store) }.onFailure { say("The store did not open: ${it.message}") }
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
            addView(Retro.body(this@InboxPane, 14f, Retro.TAN).apply {
                text = Threads.describe(this@InboxPane, launch, withLabel, switches); maxLines = 2; ellipsize = TextUtils.TruncateAt.END
                setPadding(0, dp(6f), 0, 0)
            })
            if (!shown) return
            val panel = LinearLayout(this@InboxPane).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12f), dp(10f), dp(12f), dp(10f))
                background = Retro.panel(this@InboxPane, Retro.CASING, 10f, Retro.EDGE)
            }
            val chips = LinearLayout(this@InboxPane).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            val spaced = { LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) } }
            chips.addView(Retro.label(this@InboxPane, "RECORD", 12f, Retro.TAN, 0.16f), LinearLayout.LayoutParams(dp(76f), LinearLayout.LayoutParams.WRAP_CONTENT))
            // The deck's switches: changed here, they change there too, for every launch.
            fun flip(key: String, on: Boolean, event: String) { prefs.edit().putBoolean(key, !on).apply(); Timeline.log("inbox", event, "on" to !on); redrawThread() }
            chips.addView(chip("Screen", switches.screen) { flip("screen", switches.screen, "screen") }, spaced())
            chips.addView(chip("Mic", switches.mic) { flip("mic", switches.mic, "mic") }, spaced())
            chips.addView(chip("App sound", switches.app) {
                if (switches.screen) flip("appAudio", switches.appAudio, "app_audio") else say(TakeSwitches.APP_NEEDS_SCREEN)
            }.apply { if (!switches.screen) { alpha = 0.6f; contentDescription = "App sound: off. ${TakeSwitches.APP_NEEDS_SCREEN}" } }, spaced())
            chips.addView(chip("Logs", switches.logs) { flip("logs", switches.logs, "logs") }, spaced())
            // Four chips and the label are wider than a narrow column: they scroll sideways there rather than squeeze.
            panel.addView(HorizontalScrollView(this@InboxPane).apply { isHorizontalScrollBarEnabled = false; addView(chips) },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            val why = when {
                switches.kind == TakeKind.NONE -> TakeSwitches.NOTHING
                !switches.screen -> TakeSwitches.APP_NEEDS_SCREEN
                else -> null
            }
            if (why != null) panel.addView(Retro.body(this@InboxPane, 13f, if (switches.kind == TakeKind.NONE) Retro.RED else Retro.TAN).apply { text = why; setPadding(0, dp(8f), 0, 0) })
            addView(panel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
        }
        build()
    }

    /** The whole thread again: a sound switched for one launch is switched for all of them. */
    private fun redrawThread() { drawn = ""; thread?.let { showThread(it) } }

    /**
     * Record and open, or Just open with [record] false. Hands the launch to the deck after checking the
     * versions it asks for; a mismatch can be started anyway. While a recording runs, either key opens what
     * the launch names into that same recording and the recording notes when, so variants can be compared
     * in one take.
     */
    private fun start(t: Threads.Thread, m: Threads.Message, index: Int, launch: Threads.Launch, record: Boolean) {
        if (CaptureState.recording) {
            // A report is the Polydance team's: a thread's launch has no place in it (Reports).
            if (Reports.isReport(CaptureState.destination)) { say("Recording a report: stop it on the deck first."); return }
            if (!Threads.opens(launch)) { say("Already recording, and there is nothing to open; stop on the deck first."); return }
            val failed = Threads.run(this, launch, t.key)
            Threads.logOpened(launch, m.id, index.takeIf { m.launches.size > 1 })
            Timeline.log("inbox", "opened_while_recording", "key" to t.key, "message" to m.id, "launch" to index)
            say(if (failed.isEmpty()) null else failed.joinToString("; "))
            return
        }
        if (!record) {
            // Just open (CAP-1 #20, 01:37, a switch until 2026-11-07): to look again at something already recorded, without
            // leaving an empty recording to delete. Nothing is recorded, so nothing is logged in a recording.
            val openNow = {
                val failed = Threads.run(this, launch, t.key)
                Timeline.log("inbox", "opened_without_recording", "key" to t.key, "message" to m.id, "launch" to index)
                say(if (failed.isEmpty()) null else failed.joinToString("; "))
            }
            val problems = Threads.problems(this, launch)
            if (problems.isEmpty()) openNow()
            else AlertDialog.Builder(this).setTitle("Not the build this asks for").setMessage(problems.joinToString("\n"))
                .setPositiveButton("Open anyway") { _, _ -> openNow() }.setNegativeButton("Cancel", null).show()
            return
        }
        val go = {
            Timeline.log("inbox", "start", "key" to t.key, "message" to m.id, "launch" to index, "open" to true)
            startActivity(Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_START_THREAD)
                .putExtra("thread", t.key).putExtra("message", m.id).putExtra("launch", index).putExtra("launchJson", launch.raw.toString())
                .putExtra("open", true).putExtra("options", m.launches.size).putExtra(MainActivity.EXTRA_INTERNAL, MainActivity.INTERNAL)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        // Every launch is checked, one that opens nothing most of all: it tests what is installed (CAP-4 #2).
        val problems = Threads.problems(this, launch)
        if (problems.isEmpty()) go()
        else AlertDialog.Builder(this).setTitle("Not the build this asks for").setMessage(problems.joinToString("\n"))
            .setPositiveButton("Start anyway") { _, _ -> go() }.setNegativeButton("Cancel", null).show()
    }

    /** The reactions given, each a chip that gives (or takes back) the same one; the smiley over the message adds another. */
    private fun reactionRow(t: Threads.Thread, m: Threads.Message): View? {
        if (m.reactions.isEmpty()) return null
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(10f), 0, 0)
            for ((name, people) in m.reactions.groupBy { it.reaction }) {
                val mineToo = people.any { it.byId == t.me }
                addView(Retro.body(this@InboxPane, 15f, if (mineToo) Retro.AMBER else Retro.CREAM).apply {
                    text = "${Threads.REACTIONS[name] ?: name}${if (people.size > 1) " ${people.size}" else ""}"
                    setPadding(dp(10f), dp(4f), dp(10f), dp(4f))
                    background = Retro.panel(this@InboxPane, Retro.CASING, 12f, if (mineToo) Retro.AMBER else Retro.EDGE)
                    isClickable = true; isFocusable = true
                    contentDescription = "$name from ${people.joinToString(", ") { it.byName }}${if (mineToo) ": press to take yours back" else ""}"
                    setOnClickListener { react(t.key, m.id, name) }
                }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(6f) })
            }
        }
    }

    /**
     * The six reactions in a pop-up over the thread, with Close, and closed by a press outside it too: the
     * picker had opened in the message with no way to close it (sixth pass, 2026-10-04, 01:34 to 01:44).
     */
    private fun showReactions(t: Threads.Thread, m: Threads.Message) {
        val given = m.reactions.firstOrNull { it.byId == t.me }?.reaction
        plateDialog("REACT TO #${m.id}") { box, dialog ->
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(14f), 0, dp(10f)) }
            for ((name, glyph) in Threads.REACTIONS) {
                row.addView(Retro.button(this, glyph, if (name == given) Retro.AMBER else Retro.EDGE, small = true) { dialog.dismiss(); react(t.key, m.id, name) }.apply { textSize = 22f },
                    LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) })
            }
            box.addView(row)
            box.addView(Retro.body(this, 13f, Retro.TAN).apply {
                text = if (given != null) "Choose ${Threads.REACTIONS[given]} again to take it back." else "What each one means is up to your team."
            })
            box.addView(Retro.button(this, "Close", Retro.CREAM, small = true) { dialog.dismiss() },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14f); gravity = Gravity.END })
        }
        Timeline.log("inbox", "reactions_open", "key" to t.key, "message" to m.id)
    }

    /** A reaction, shown at once and put back only if the receiver refuses (CAP-1 #20). */
    private fun react(key: String, message: Int, reaction: String) {
        val client = client() ?: return
        val before = thread
        before?.takeIf { it.key == key }?.let { cur ->
            cur.messages.firstOrNull { it.id == message }?.let { m ->
                val mine = m.reactions.firstOrNull { it.byId == cur.me }
                val reactions = m.reactions.filter { it.byId != cur.me } + if (mine?.reaction == reaction) emptyList() else listOf(Threads.Reaction(reaction, cur.me, "you"))
                showThread(cur.copy(messages = cur.messages.map { if (it.id == message) it.copy(reactions = reactions) else it }))
            }
        }
        background.execute {
            runCatching { Threads.react(client, key, message, reaction) }
                .onSuccess { t -> ui.post { if (thread?.key == key) showThread(t) } }
                .onFailure { e -> ui.post { if (before != null && thread?.key == key) showThread(before); say("Reaction not sent: ${e.message}") } }
        }
        Timeline.log("inbox", "react", "key" to key, "message" to message, "reaction" to reaction)
    }

    // ---- Building the panel.

    /**
     * Two columns on the cabinet. The list: Gmail's search bar over the threads, New thread floating at its foot.
     * The right column, for a thread or Recordings: its bar, the pinned title, the messages scrolling on wood,
     * and Reply, Share and the smiley fixed along the foot. layoutColumns() sets their widths, again whenever
     * the panel is resized.
     */
    private fun buildUi(): View {
        val pad = dp(24f)
        val density = resources.displayMetrics.density

        // ---- The list.
        val top = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad / 2, pad / 2, pad / 2, dp(6f)) }
        // Gmail's search bar: the menu behind three lines, a search field, and this headset's person in the corner.
        searchBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6f), dp(4f), dp(8f), dp(4f))
            background = Retro.panel(this@InboxPane, Retro.PANEL, 32f, Retro.EDGE)
        }
        searchBar.addView(Glyph.key(this, Glyph.Kind.MENU, Retro.CREAM, "Menu: inbox, archived, projects and recordings") { showMenu() })
        search = EditText(this).apply {
            hint = "Search threads"; setHintTextColor(Retro.TAN); setTextColor(Retro.CREAM)
            textSize = 18f; typeface = Retro.BODY; isSingleLine = true; background = null
            inputType = InputType.TYPE_CLASS_TEXT; imeOptions = EditorInfo.IME_ACTION_SEARCH
            setPadding(dp(6f), dp(10f), dp(6f), dp(10f))
            setOnEditorActionListener { _, _, _ -> hideKeyboard(); true }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    query = s?.toString().orEmpty()
                    clearSearch.visibility = if (query.isEmpty()) View.GONE else View.VISIBLE
                    showList()
                }
            })
        }
        searchBar.addView(search, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        clearSearch = Glyph.key(this, Glyph.Kind.CLOSE, Retro.TAN, "Clear the search") { search.setText(""); hideKeyboard() }.apply { visibility = View.GONE }
        searchBar.addView(clearSearch)
        profile = ProfileBadge(this).apply { setOnClickListener { showAccount() } }
        searchBar.addView(profile, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(4f) })
        top.addView(searchBar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        sectionLine = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(10f), dp(12f), 0, 0) }
        top.addView(sectionLine, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        val listTop = FrameLayout(this).apply {
            background = WoodDrawable(density)
            addView(top, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad / 2, 0, pad / 2, pad) }
        problem = Retro.body(this, 15f, Retro.BURNT).apply { visibility = View.GONE; setPadding(dp(8f), dp(4f), 0, dp(4f)) }
        list.addView(problem)
        flash = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; visibility = View.GONE; setPadding(dp(8f), dp(6f), 0, dp(2f)) }
        list.addView(flash, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        notice = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; visibility = View.GONE; setPadding(dp(8f), dp(4f), 0, dp(6f)) }
        list.addView(notice, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        empty = Retro.body(this, 17f, Retro.BURNT).apply { setPadding(dp(8f), dp(10f), 0, 0); visibility = View.GONE }
        list.addView(empty)
        listView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        list.addView(listView)
        listScroll = ScrollView(this).apply {
            isFillViewport = true
            addView(FrameLayout(this@InboxPane).apply {
                background = WoodDrawable(density)
                addView(list, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
            }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
        composeKey = buildComposeKey()
        listColumn = FrameLayout(this).apply {
            addView(LinearLayout(this@InboxPane).apply {
                orientation = LinearLayout.VERTICAL
                addView(listTop, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
                addView(listScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            addView(composeKey, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
                setMargins(0, 0, dp(22f), dp(22f))
            })
        }

        // ---- The right column: a thread, or Recordings. A ruled edge parts it from the list.
        val detailHead = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad / 2, pad / 2, pad / 2, dp(4f)) }
        head = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        detailHead.addView(head, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        pinned = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        detailHead.addView(pinned, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        deleteKey = Retro.button(this, "Delete", Retro.RED, small = true) { deleteSelected() }.apply { visibility = View.GONE }
        val detailTop = FrameLayout(this).apply {
            background = WoodDrawable(density)
            addView(detailHead, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        }
        val column = ClampedColumn(this, dp(960f)).apply { orientation = LinearLayout.VERTICAL; setPadding(pad / 2, 0, pad / 2, pad) }
        detailProblem = Retro.body(this, 15f, Retro.BURNT).apply { visibility = View.GONE; setPadding(dp(8f), dp(4f), 0, dp(4f)) }
        column.addView(detailProblem)
        recordingsView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        threadView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        draftView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        agentsView = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        column.addView(recordingsView); column.addView(threadView); column.addView(draftView); column.addView(agentsView)
        scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(FrameLayout(this@InboxPane).apply {
                background = WoodDrawable(density)
                addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL))
            }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
            setOnScrollChangeListener { _, _, _, _, _ -> syncPinned() }
        }
        bottomBar = buildBottomBar().apply { visibility = View.GONE }
        detailColumn = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; visibility = View.GONE
            addView(detailTop, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(bottomBar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }

        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Retro.WOOD_SEAM)
            addView(listColumn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
            addView(detailColumn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f).apply { leftMargin = dp(2f) })
            // A resized panel may put the columns side by side again, or stack them.
            addOnLayoutChangeListener { _, l, _, r, _, oldL, _, oldR, _ -> if (r - l != oldR - oldL) post { layoutColumns() } }
        }
    }



    /** New thread, where Gmail has Compose: a light key that stands out from the dark plates, its camera red. */
    private fun buildComposeKey(): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(20f), dp(15f), dp(26f), dp(15f))
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 58, 44, 32)), Retro.panel(this@InboxPane, Retro.PLATE_LIGHT, 20f, Retro.PLATE_EDGE), null)
        elevation = dp(8f).toFloat()
        isClickable = true; isFocusable = true
        contentDescription = "New thread: choose who to copy in, then record"
        setOnClickListener { newThread() }
        addView(ImageView(this@InboxPane).apply { setImageDrawable(Glyph(Glyph.Kind.CAMERA, Retro.RED, resources.displayMetrics.density, 26f)) })
        addView(Retro.label(this@InboxPane, "New thread", 17f, Retro.PRINT, 0.06f),
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12f) })
    }

    /**
     * The foot of a thread, fixed while it scrolls (Robin, 2026-10-12): Reply, with the camera because replying
     * records; Forward, which adds people by email; and a smiley that reacts to the latest message.
     */
    private fun buildBottomBar(): View {
        val row = ClampedColumn(this, dp(640f)).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12f), dp(10f), dp(12f), dp(12f))
        }
        row.addView(pill(Glyph.Kind.REPLY, "Reply", Glyph.Kind.CAMERA, "Reply: record a reply to this thread") { thread?.let { recordReply(it.key) } },
            LinearLayout.LayoutParams(0, dp(58f), 1f).apply { rightMargin = dp(10f) })
        // Share, not Forward (CAP-7 at 0:02, 2026-10-15): for now it adds people by email, as Forward did.
        row.addView(pill(Glyph.Kind.SHARE, "Share", null, "Share: add people to this thread by email") { thread?.takeIf { it.seq > 0 }?.let { showForward(it) } },
            LinearLayout.LayoutParams(0, dp(58f), 1f).apply { rightMargin = dp(10f) })
        row.addView(Glyph.key(this, Glyph.Kind.SMILE, Retro.CREAM, "React to the latest message") {
            thread?.let { t -> t.messages.lastOrNull()?.let { showReactions(t, it) } }
        }.apply {
            background = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 239, 230, 210)), GradientDrawable().apply {
                shape = GradientDrawable.OVAL; setColor(Retro.PANEL); setStroke(dp(1f), Retro.EDGE)
            }, null)
            val p = dp(16f); setPadding(p, p, p, p)
        }, LinearLayout.LayoutParams(dp(58f), dp(58f)))
        return FrameLayout(this).apply {
            background = WoodDrawable(resources.displayMetrics.density)
            addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL))
        }
    }

    /** One of the foot's long keys: an icon, its word, and a second icon after (Reply's camera). */
    private fun pill(lead: Glyph.Kind, label: String, trail: Glyph.Kind?, description: String, onClick: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
        background = RippleDrawable(ColorStateList.valueOf(Color.argb(60, 239, 230, 210)), Retro.panel(this@InboxPane, Retro.PANEL, 29f, Retro.EDGE), null)
        isClickable = true; isFocusable = true
        contentDescription = description
        setOnClickListener { onClick() }
        val d = resources.displayMetrics.density
        addView(ImageView(this@InboxPane).apply { setImageDrawable(Glyph(lead, Retro.CREAM, d, 22f)) })
        addView(Retro.label(this@InboxPane, label.uppercase(Locale.UK), 15f, Retro.CREAM, 0.12f),
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(10f) })
        trail?.let { addView(ImageView(this@InboxPane).apply { setImageDrawable(Glyph(it, Retro.RED, d, 24f)) },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12f) }) }
    }
}
