package net.polydance.capture

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import org.json.JSONArray
import net.polydance.capture.platform.headsetPlatform
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder

/**
 * Threads on the headset (docs/THREADS.md in the repository): every recording lives in one. The team
 * posts messages whose launches Polydance runs when the tester presses Start; the tester replies by
 * recording. This file holds what the receiver sends, read strictly (a launch with a step this build does
 * not know cannot be started), the calls that fetch and mark threads, and the shared state between the
 * deck and the inbox panel: which thread is open, so the deck's key replies to it.
 */
object Threads {
    /** [mine] when it is this person's own project (2026-11-13, docs/THREADS.md "Projects of your own"), not the team's. */
    data class Project(val key: String, val name: String, val mine: Boolean = false)
    data class Summary(
        val key: String, val project: String, val title: String, val state: String, val updatedAt: String,
        val unread: Boolean, val waiting: Boolean, val lastBy: String, val lastText: String,
        /** Counts every change in the thread, so a reply not yet told about shows as a higher number. */
        val seq: Int = 0,
        /** The latest words in it, a message's text or a recording's summary, for the row under the title (2026-10-12). */
        val snippet: String? = null,
        /** When its newest message was posted: the time on the row, as Gmail shows the last message's. */
        val lastMessageAt: String? = null,
        /** The first few people in it, for the row's avatars, and how many in all. */
        val people: List<Person> = emptyList(),
        val peopleCount: Int = people.size,
    )
    /**
     * Someone in a thread (2026-10-12): a person who has posted, or an address invited by email. [email] is
     * given only to people in the thread and the team; [initial] is the letter their circle shows.
     */
    data class Person(val name: String, val initial: String, val colour: String? = null, val invited: Boolean = false, val email: String? = null)
    /**
     * An address added to a thread (2026-10-12). Since 2026-11-10 the receiver emails it an invitation when someone
     * on the team adds it: [emailed] says whether it went and [emailedAt] when; [emailNote] is the receiver's word on
     * why not, or what happened (a tester's addition is kept but not emailed). A receiver older than email sends
     * `emailed: false` and no note.
     */
    data class Participant(
        val email: String, val addedBy: String, val addedAt: String, val emailed: Boolean,
        val emailedAt: String? = null, val emailNote: String? = null,
    )
    data class Listing(
        val me: String, val projects: List<Project>, val unread: Int, val threads: List<Summary>,
        /** Whether the receiver takes reports from the bug key; null from a receiver older than reports (2026-10-12). */
        val reports: Boolean? = null,
        /** Whether it makes a project of your own (POST /v1/projects), so New thread's list ends in New project. */
        val newProjects: Boolean = false,
        /** Whether a device may ask it for a code to connect an agent (POST /v1/agents/codes, 2026-11-20), so the inbox offers it. */
        val agents: Boolean = false,
    )

    sealed class Step {
        data class Require(val pkg: String, val versionName: String?, val versionCode: Long?, val minVersionCode: Long?) : Step()
        data class Open(val url: String) : Step()
        data class App(val pkg: String, val activity: String?, val data: String?, val extras: JSONObject?) : Step()
        /** A 3D model pushed with the message, drawn in the message by ModelView (2026-10-19; in a panel of its own until 10-20). */
        data class Model(val sha256: String, val name: String, val bytes: Long) : Step()
    }
    /** [steps] is null when a step is one this build cannot run: the launch is shown but cannot start. */
    data class Launch(val label: String?, val steps: List<Step>?, val raw: JSONObject)
    data class Reaction(val reaction: String, val byId: String, val byName: String)
    /** A star on one of a message's options (0-based [launch]), at most one per person. */
    data class Pick(val launch: Int, val byId: String, val byName: String)
    data class Recording(
        val status: String, val sessionId: String?, val title: String?, val summary: String?, val durationMs: Long?,
        val replyTo: Int?, val error: String?,
        /** Which headset install made it, as `<deviceId>-<run>`, so this headset finds its own on the cards. */
        val clientId: String, val stepsDone: Int?, val stepsTotal: Int?,
        /** Which launch of the answered message it was started from, and which of its options it put on screen. */
        val replyLaunch: Int? = null, val tried: List<Int> = emptyList(),
        /**
         * What it holds (docs/LOGS.md, 2026-11-16): "video" (a picture, as before), "sound" (no picture) or "none" (logs
         * alone, nothing to play); [logs] when it kept the headset's logs.
         */
        val content: String = "video", val logs: Boolean = false,
    )
    /**
     * [byName] is how the sender reads ("Opus 5.5 on Robin's Mac", "Robin · Quest 3"); [byUser] the person
     * behind the token, [byColour] their colour, [byAgent] what an agent called itself.
     */
    data class Message(
        val id: Int, val at: String, val byId: String, val byName: String, val text: String?,
        val launches: List<Launch>, val recording: Recording?, val reactions: List<Reaction>,
        val byUser: String? = null, val byColour: String? = null, val byAgent: String? = null,
        /** The thread's count when it was posted, against the read mark. */
        val seq: Int = 0,
        val picks: List<Pick> = emptyList(),
        /** Photos (2026-11-07), and whether this headset may see them (people in the thread and whoever sent them). */
        val photos: List<Photo> = emptyList(), val canView: Boolean = true,
        /** The sender's own name for this message, which the receiver's Welcome uses for its answer (Agents.isWelcomeAnswer). */
        val deliveryId: String? = null,
    )
    /** A photo in a message, as the receiver kept it: fetched through the thread by its sha256 (Photos). */
    data class Photo(val sha256: String, val type: String, val width: Int, val height: Int, val bytes: Long)
    data class Thread(
        val me: String, val key: String, val projectKey: String, val projectName: String, val title: String, val state: String,
        val seq: Int, val readSeq: Int, val messages: List<Message>,
        /** Everyone in it, posters then invited addresses (2026-10-12). */
        val people: List<Person> = emptyList(),
        /** The invited addresses with who added them; null when this headset may not see addresses. */
        val participants: List<Participant>? = null,
        val participantCount: Int = participants?.size ?: 0,
        /** Whether this headset is in it (posted, or the team) and so may play its recordings and add people; null from an older receiver. */
        val canPlay: Boolean? = null,
        /** Deleted from this headset's inbox: it is not listed until someone else adds to it. */
        val hidden: Boolean = false,
    )

    /** The six reactions, by the names the receiver uses, with the emoji drawn. */
    val REACTIONS = linkedMapOf("heart" to "❤️", "thumbs-up" to "👍", "thumbs-down" to "👎", "haha" to "😂", "emphasis" to "‼️", "question" to "❓")

    // ---- Shared between the deck and the inbox panel.
    @Volatile var listing: Listing? = null
    /** The thread the inbox panel is showing; the deck's key replies to it. */
    @Volatile var openKey: String? = null
    @Volatile var openTitle: String? = null
    /** Shows a launch's 3D model in its message (the inbox sets it, the deck's launches call it): thread key, sha256. */
    @Volatile var showModel: ((String, String) -> Unit)? = null
    /** The inbox is in front, so a reply needs no notification. */
    @Volatile var inboxInFront = false

    /** The projects the inbox shows, by key; empty shows them all (seventh pass, 2026-10-04: a filter, not a cycling name). */
    fun filter(context: Context): Set<String> =
        context.getSharedPreferences("settings", Context.MODE_PRIVATE).getString("filter", "").orEmpty().split(',').filter { it.isNotBlank() }.toSet()

    fun setFilter(context: Context, keys: Set<String>) {
        context.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putString("filter", keys.sorted().joinToString(",")).apply()
    }

    /**
     * Where new threads go: the one project the inbox is filtered to, else the project last chosen for a
     * new thread, else the first one this token sees.
     */
    fun currentProject(context: Context): Project? {
        val projects = listing?.projects.orEmpty()
        val filtered = filter(context).let { keys -> projects.filter { it.key in keys } }
        if (filtered.size == 1) return filtered[0]
        val chosen = context.getSharedPreferences("settings", Context.MODE_PRIVATE).getString("project", null)
        return projects.firstOrNull { it.key == chosen } ?: projects.firstOrNull()
    }

    fun chooseProject(context: Context, key: String) {
        context.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putString("project", key).apply()
    }

    /**
     * What a recording started now belongs to, as the upload will name it: the launch's message in its
     * thread, else the open thread, else a new thread in the current project. Null with threads off.
     */
    fun destination(context: Context, key: String? = openKey, replyTo: Int? = null, launch: Int? = null): JSONObject? = when {
        key != null -> JSONObject().put("key", key).also { if (replyTo != null) it.put("replyTo", JSONObject().put("message", replyTo).also { r -> if (launch != null) r.put("launch", launch) }) }
        else -> currentProject(context)?.let { JSONObject().put("project", it.key) }
    }

    // ---- Calls.
    fun list(client: ReceiverClient): Listing = parseListing(client.json("GET", "/v1/threads?state=open")).also { listing = it }
    fun get(client: ReceiverClient, key: String): Thread = parseThread(client.json("GET", "/v1/threads/${URLEncoder.encode(key, "UTF-8")}"))
    fun markRead(client: ReceiverClient, key: String, seq: Int): Thread = parseThread(client.json("POST", "/v1/threads/$key/read", JSONObject().put("seq", seq)))
    fun react(client: ReceiverClient, key: String, message: Int, reaction: String): Thread =
        parseThread(client.json("POST", "/v1/threads/$key/reactions", JSONObject().put("message", message).put("reaction", reaction)))
    /** Stars an option; the same one again takes the star back. */
    fun pick(client: ReceiverClient, key: String, message: Int, launch: Int): Thread =
        parseThread(client.json("POST", "/v1/threads/$key/picks", JSONObject().put("message", message).put("launch", launch)))
    /** The open threads (the inbox) or the closed ones (Archived); only the inbox's is shared with the deck. */
    fun listIn(client: ReceiverClient, state: String): Listing =
        parseListing(client.json("GET", "/v1/threads?state=$state")).also { if (state == "open") listing = it }
    /** Adds and takes away addresses; Forward and Add people (2026-10-12). The receiver decides who is emailed. */
    fun people(client: ReceiverClient, key: String, add: List<String> = emptyList(), remove: List<String> = emptyList()): Thread =
        parseThread(client.json("POST", "/v1/threads/$key/participants", JSONObject().apply {
            if (add.isNotEmpty()) put("add", JSONArray(add))
            if (remove.isNotEmpty()) put("remove", JSONArray(remove))
        }))
    /** Archive (closed) or back to the inbox (open), over POST: the receiver's nginx refuses PATCH. */
    fun setState(client: ReceiverClient, key: String, state: String): Thread =
        parseThread(client.json("POST", "/v1/threads/$key/state", JSONObject().put("state", state)))
    /** Delete from this headset's inbox: the thread stays for everyone else and comes back when someone adds to it. */
    fun hide(client: ReceiverClient, key: String) { client.json("POST", "/v1/threads/$key/hide", JSONObject()) }
    fun unhide(client: ReceiverClient, key: String) { client.json("POST", "/v1/threads/$key/unhide", JSONObject()) }
    /** A project of this person's own (2026-11-13): the receiver makes its key from the name; the list learns it at once. */
    fun newProject(client: ReceiverClient, name: String): Project {
        val j = client.json("POST", "/v1/projects", JSONObject().put("name", name))
        val projects = j.optJSONArray("projects").items(::parseProject)
        if (projects.isNotEmpty()) listing = listing?.copy(projects = projects)
        return parseProject(j.getJSONObject("project"))
    }

    // ---- Reading the receiver's answers.
    private fun JSONObject.str(name: String): String? = if (has(name) && !isNull(name)) optString(name).ifEmpty { null } else null
    private inline fun <T> JSONArray?.items(read: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).map { read(getJSONObject(it)) }

    fun parseListing(j: JSONObject) = Listing(
        j.getString("me"),
        j.optJSONArray("projects").items(::parseProject),
        j.optInt("unread"),
        j.optJSONArray("threads").items {
            val last = it.optJSONObject("last") ?: JSONObject()
            // A receiver older than people (2026-10-12) names only who started it and who acted last.
            val people = it.optJSONArray("people")?.items(::parsePerson)
                ?: listOfNotNull(it.optJSONObject("by"), last.optJSONObject("by")).map(::authorPerson).distinctBy { p -> p.name }
            Summary(
                it.getString("key"), it.getString("project"), it.getString("title"), it.getString("state"), it.getString("updatedAt"),
                it.optBoolean("unread"), it.optBoolean("waiting"), last.optJSONObject("by")?.let { b -> b.str("display") ?: b.optString("name") }.orEmpty(), last.optString("text"),
                it.optInt("seq"), it.str("snippet"), it.str("lastMessageAt"), people, it.optInt("peopleCount", people.size),
            )
        },
        if (j.has("reports")) j.optBoolean("reports") else null,
        j.optBoolean("newProjects"),
        j.optBoolean("agents"),
    )

    private fun parseProject(j: JSONObject) = Project(j.getString("key"), j.getString("name"), j.optBoolean("mine"))

    /** A recording's content, fail closed to what a receiver older than 2026-11-16 always meant: a video with a player. */
    fun content(value: String?): String = value?.takeIf { it == "sound" || it == "none" } ?: "video"

    fun parseThread(j: JSONObject): Thread {
        val project = j.getJSONObject("project")
        return Thread(
            j.getString("me"), j.getString("key"), project.getString("key"), project.getString("name"), j.getString("title"), j.getString("state"),
            j.getInt("seq"), j.optInt("readSeq"),
            j.getJSONArray("messages").items { m ->
                val by = m.getJSONObject("by")
                val user = by.optJSONObject("user")
                Message(
                    m.getInt("id"), m.getString("at"), by.getString("id"), by.str("display") ?: by.getString("name"), m.str("text"),
                    m.optJSONArray("launches").items(::parseLaunch),
                    m.optJSONObject("recording")?.let { r ->
                        Recording(
                            r.str("status") ?: "unknown", r.str("sessionId"), r.str("title"), r.str("summary"),
                            if (r.has("durationMs")) r.optLong("durationMs") else null, r.optJSONObject("replyTo")?.optInt("message"), r.str("error"),
                            r.optString("clientId"), r.optJSONObject("steps")?.optInt("done"), r.optJSONObject("steps")?.optInt("total"),
                            r.optJSONObject("replyTo")?.takeIf { it.has("launch") }?.optInt("launch"),
                            r.optJSONArray("tried")?.let { a -> (0 until a.length()).map { a.getInt(it) } }.orEmpty(),
                            content(r.str("content")), r.optBoolean("logs"),
                        )
                    },
                    m.optJSONArray("reactions").items { x -> val b = x.getJSONObject("by"); Reaction(x.getString("reaction"), b.getString("id"), b.str("display") ?: b.getString("name")) },
                    user?.str("name"), user?.str("colour"), by.str("as"), m.optInt("seq"),
                    m.optJSONArray("picks").items { p -> val b = p.getJSONObject("by"); Pick(p.getInt("launch"), b.getString("id"), b.str("display") ?: b.getString("name")) },
                    // A photo with fields this build would not fetch is left out, never guessed at.
                    m.optJSONArray("photos").items { p -> Photo(p.optString("sha256"), p.optString("type"), p.optInt("width"), p.optInt("height"), p.optLong("bytes")) }
                        .filter { Photos.valid(it.sha256, it.type, it.width, it.height, it.bytes) },
                    m.optBoolean("canView", true),
                    m.str("deliveryId"),
                )
            },
        ).let { t ->
            val people = j.optJSONArray("people")?.items(::parsePerson)
                ?: t.messages.distinctBy { m -> m.byUser ?: m.byId }.map { m -> (m.byUser ?: m.byName).let { n -> Person(n, InboxText.initial(null, n), m.byColour) } }
            val participants = j.optJSONArray("participants")?.items { p ->
                Participant(
                    p.getString("email"), p.str("addedBy").orEmpty(), p.str("addedAt").orEmpty(), p.optBoolean("emailed"),
                    p.str("emailedAt"), p.str("emailNote"),
                )
            }
            t.copy(
                people = people, participants = participants, participantCount = j.optInt("participantCount", participants?.size ?: 0),
                canPlay = if (j.has("canPlay")) j.optBoolean("canPlay") else null, hidden = j.optBoolean("hidden"),
            )
        }
    }

    private fun parsePerson(p: JSONObject): Person {
        val email = p.str("email")
        val name = p.str("name") ?: email ?: "Someone"
        return Person(name, p.str("initial") ?: InboxText.initial(email, name), p.str("colour"), p.optBoolean("invited"), email)
    }

    /** A message's author as a person: their own name when the token names one, else how it reads. */
    private fun authorPerson(by: JSONObject): Person {
        val user = by.optJSONObject("user")
        val name = user?.str("name") ?: by.str("display") ?: by.optString("name", "Someone")
        return Person(name, InboxText.initial(null, name), user?.str("colour"))
    }

    private val PACKAGE = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")

    /** Strict: an unknown step, an http link, a malformed package or model makes the whole launch unstartable. */
    fun parseLaunch(j: JSONObject): Launch {
        val steps = runCatching {
            j.getJSONArray("steps").items<Step> { s ->
                when (s.getString("do")) {
                    "require" -> Step.Require(
                        s.getString("package").also { require(PACKAGE.matches(it)) }, s.str("versionName"),
                        if (s.has("versionCode")) s.getLong("versionCode") else null, if (s.has("minVersionCode")) s.getLong("minVersionCode") else null,
                    )
                    "open" -> Step.Open(s.getString("url").also { require(Uri.parse(it).scheme == "https") })
                    "app" -> Step.App(s.getString("package").also { require(PACKAGE.matches(it)) }, s.str("activity"), s.str("data"), s.optJSONObject("extras"))
                    "model" -> Step.Model(s.getString("sha256"), s.getString("name"), s.getLong("bytes")).also { require(Models.validStep(it.sha256, it.name, it.bytes)) }
                    else -> throw IllegalArgumentException("unknown step")
                }
            }.also { steps -> require(steps.count { it is Step.Model } <= 1) }
        }.getOrNull()
        return Launch(j.str("label"), steps, j)
    }

    // ---- Launches.
    private fun installed(context: Context, pkg: String) =
        runCatching { context.packageManager.getPackageInfo(pkg, 0) }.getOrNull()

    /** What the launch's require steps find wrong on this headset, in words; empty when it can start. */
    fun problems(context: Context, launch: Launch): List<String> = launch.steps.orEmpty().filterIsInstance<Step.Require>().mapNotNull { step ->
        val info = installed(context, step.pkg) ?: return@mapNotNull "${step.pkg} is not installed"
        val name = runCatching { context.packageManager.getApplicationLabel(info.applicationInfo!!).toString() }.getOrDefault(step.pkg)
        val have = "${info.versionName} (${info.longVersionCode})"
        when {
            step.versionCode != null && info.longVersionCode != step.versionCode -> "$name needs build ${step.versionCode}; this headset has $have"
            step.versionName != null && info.versionName != step.versionName -> "$name needs ${step.versionName}; this headset has $have"
            step.minVersionCode != null && info.longVersionCode < step.minVersionCode -> "$name needs build ${step.minVersionCode} or later; this headset has $have"
            else -> null
        }
    }

    /**
     * What Record and open does, in words, under the keys; Just open needs none. A launch's label names a
     * variant. What the take leaves out (the picture, a sound, the logs) is said, so the folded settings never hide
     * it (CAP-1 #24, and the switches of 2026-11-16: TakeSwitches.records).
     */
    fun describe(context: Context, launch: Launch, withLabel: Boolean = true, switches: TakeSwitches = TakeSwitches(true, true, true, true)): String {
        val steps = launch.steps ?: return "needs a newer Polydance"
        val goes = steps.mapNotNull { step ->
            when (step) {
                is Step.Open -> "${Uri.parse(step.url).host} in the Browser"
                is Step.App -> installed(context, step.pkg)?.let { context.packageManager.getApplicationLabel(it.applicationInfo!!).toString() } ?: step.pkg
                is Step.Model -> "${step.name} in 3D"
                is Step.Require -> null
            }
        }
        val records = switches.records()
        val does = when {
            switches.kind == TakeKind.NONE -> "$records: Screen, Mic and Logs are off"
            goes.isEmpty() -> "$records here; nothing else opens"
            else -> "$records, then opens ${goes.joinToString(", then ")}"
        }
        return launch.label?.takeIf { withLabel }?.let { "$it: $does" } ?: does
    }

    /** What a launch puts on screen, in words, for the recording's log: "open https://…", "open app com.x (variant=b)". */
    fun steps(launch: Launch): String = launch.steps.orEmpty().mapNotNull { step ->
        when (step) {
            is Step.Open -> "open ${step.url}"
            is Step.App -> {
                val extras = step.extras?.let { e -> e.keys().asSequence().map { "$it=${e.get(it)}" }.toList() }.orEmpty()
                "open app ${step.pkg}${step.activity?.let { "/$it" } ?: ""}${step.data?.let { " with $it" } ?: ""}${if (extras.isEmpty()) "" else " (${extras.joinToString(", ")})"}"
            }
            is Step.Model -> "open model ${step.name} (${Models.size(step.bytes)})"
            is Step.Require -> null
        }
    }.joinToString("; ").ifEmpty { "nothing to open" }

    /** True when the launch requires a build of this app itself: the test of Polydance, where Update can help. */
    fun requiresSelf(context: Context, launch: Launch) = launch.steps.orEmpty().any { it is Step.Require && it.pkg == context.packageName }

    /** True when a launch opens something, as opposed to only checking versions and recording. */
    fun opens(launch: Launch) = launch.steps.orEmpty().any { it !is Step.Require }

    /**
     * Notes in the recording's folder that this launch was opened now (opened.json), so the bundle says which
     * build or variant was on screen from when; the upload sends it (2026-10-04: variants within one take).
     */
    fun logOpened(launch: Launch, message: Int? = null, option: Int? = null) {
        val dir = CaptureState.runDir ?: return
        if (!CaptureState.recording) return
        runCatching {
            val file = File(dir, "opened.json")
            val list = runCatching { JSONArray(file.readText()) }.getOrElse { JSONArray() }
            val entry = JSONObject().put("atMs", (SystemClock.elapsedRealtime() - CaptureState.startedElapsed).coerceAtLeast(0)).put("what", steps(launch).take(300))
            launch.label?.let { entry.put("label", it.take(40)) }
            // Which message, and which of its options when it offered several, so the bundle can say "option 2".
            message?.let { entry.put("message", it) }
            option?.let { entry.put("launch", it) }
            file.writeText(list.put(entry).toString(2))
        }.onFailure { Timeline.log("thread", "opened_log_failed", "error" to it.toString()) }
    }

    /**
     * Runs the open, app and model steps in order, once recording has started; returns what failed. A model
     * is fetched through its thread, [key], by the viewer panel itself.
     */
    fun run(context: Context, launch: Launch, key: String?): List<String> {
        val failed = ArrayList<String>()
        for (step in launch.steps.orEmpty()) {
            if (step is Step.Model) {
                // The model is drawn in its message; opening it brings that message into view.
                val show = showModel
                if (key == null || show == null) failed += "${step.name} has no thread open to show it in" else show(key, step.sha256)
                Timeline.log("thread", "launch_step", "model" to step.sha256.take(12), "ok" to failed.isEmpty())
                continue
            }
            val intent = when (step) {
                is Step.Require, is Step.Model -> null
                is Step.Open -> headsetPlatform.browserIntent(context, step.url)
                is Step.App -> {
                    val base = if (step.activity != null) Intent().setClassName(step.pkg, if (step.activity.startsWith(".")) step.pkg + step.activity else step.activity)
                    else context.packageManager.getLaunchIntentForPackage(step.pkg)
                    base?.apply {
                        if (step.data != null) data = Uri.parse(step.data)
                        val extras = step.extras
                        if (extras != null) for (name in extras.keys()) when (val v = extras.get(name)) {
                            is Boolean -> putExtra(name, v); is Int -> putExtra(name, v); is Long -> putExtra(name, v)
                            is Double -> putExtra(name, v); else -> putExtra(name, v.toString())
                        }
                    } ?: run { failed += "${step.pkg} is not installed"; null }
                }
            } ?: continue
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(intent) }.onFailure { failed += "could not open ${intent.data ?: intent.`package` ?: intent.component}: ${it.message}" }
            Timeline.log("thread", "launch_step", "intent" to intent.toUri(0).take(300), "ok" to failed.isEmpty())
        }
        return failed
    }

}
