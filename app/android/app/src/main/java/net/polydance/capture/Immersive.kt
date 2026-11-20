package net.polydance.capture

/**
 * What the immersive scene puts on its table (Robin, CAP-10, 2026-10-21: "any objects that relate to threads that the
 * user is following are on the table"). Following is the inbox: the open threads it lists, in the projects its filter
 * shows (all of them when none is chosen), newest first. Each thread gives its latest model, the last message whose
 * launch carries one, and the model whose Immersive key was pressed goes first. Plain Kotlin, so the JVM tests run it;
 * the scene itself is platform code (on Quest, ImmersiveTableActivity in src/quest).
 */
object Immersive {
    /** What a model's Immersive key hands the scene: the thread, and the model its launch names. */
    const val EXTRA_THREAD = "thread"
    const val EXTRA_TITLE = "title"
    const val EXTRA_SHA256 = "sha256"
    const val EXTRA_NAME = "name"
    const val EXTRA_BYTES = "bytes"

    /** At most this many on the table: six fit a metre-wide table, three across and two deep. */
    const val TABLE_SIZE = 6
    /** Threads looked into for a model, newest first; each is one request to the receiver. */
    const val THREADS_LOOKED_AT = 12

    /** One object on the table: a thread and the model that stands for it. */
    data class Piece(val key: String, val title: String, val model: Threads.Step.Model)

    /** The threads the tester follows, as the inbox shows them, newest first, at most [limit]. */
    fun followed(threads: List<Threads.Summary>, filter: Set<String>, limit: Int = THREADS_LOOKED_AT): List<Threads.Summary> =
        threads.filter { it.state == "open" && (filter.isEmpty() || it.project in filter) }
            .sortedByDescending { it.lastMessageAt ?: it.updatedAt }
            .take(limit)

    /** Each message's models, oldest message first, as the receiver sends a thread. */
    fun modelsOf(thread: Threads.Thread): List<List<Threads.Step.Model>> =
        thread.messages.map { m -> m.launches.flatMap { it.steps.orEmpty() }.filterIsInstance<Threads.Step.Model>() }

    /** The newest model in a thread: the last one of the last message that has any. */
    fun latestModel(messages: List<List<Threads.Step.Model>>): Threads.Step.Model? = messages.lastOrNull { it.isNotEmpty() }?.last()

    /** The table: the opened piece first, then the followed threads' in order, each model once, at most [size]. */
    fun table(opened: Piece?, others: List<Piece>, size: Int = TABLE_SIZE): List<Piece> =
        (listOfNotNull(opened) + others).distinctBy { it.model.sha256 }.take(size)
}
