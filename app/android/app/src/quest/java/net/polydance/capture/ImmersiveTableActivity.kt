package net.polydance.capture

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import com.meta.spatial.core.Color4
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector2
import com.meta.spatial.core.Vector3
import com.meta.spatial.isdk.IsdkBoxCollider
import com.meta.spatial.isdk.IsdkGrabConstraints
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Box
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.Material
import com.meta.spatial.toolkit.Mesh
import com.meta.spatial.toolkit.MeshCollision
import com.meta.spatial.toolkit.Panel
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Scale
import com.meta.spatial.toolkit.SceneObjectSystem
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.ViewPanelRegistration
import com.meta.spatial.vr.VRFeature
import java.io.File
import java.util.concurrent.Executors

/**
 * The immersive scene (Robin, CAP-10, 2026-10-21, the recording of 11:38: "a simple scene where … this is
 * still the main window, but there's a table, and any objects that relate to threads that the user is following are on
 * the table … they're able to pick them up and scale them and look at them and put them down and still interact with
 * this interface. And then they can exit the immersive mode, back to shared space").
 *
 * A Meta Spatial SDK activity: passthrough by default (a key turns the room off for VR), a table in front of the tester,
 * and on it the model the Immersive key was pressed on and the latest model of each thread the inbox follows
 * (Immersive.table). Hands or controllers pick a piece up, move and turn it, and two hands scale it (Interaction SDK
 * through VRFeature); it stays where it is put down, and Reset puts every piece back. Polydance's own panel is started
 * over the scene, which Horizon OS shows beside an immersive activity of the same app (Meta's cooperative mode), so the
 * deck and the threads stay in use. Back to shared space goes Home and reopens that panel there, as Meta's hybrid apps
 * do. The recording carries on: it is the deck's foreground service, and Quest's MediaProjection kept capturing an
 * immersive app on 2026-10-01. Research and sources: docs/IMMERSIVE-VIEWER-RESEARCH.md.
 *
 * Models are this app's own verified copies (Models): fetched through their thread as the message's viewer fetches them
 * and checked against the message's sha256 before they are drawn.
 */
class ImmersiveTableActivity : AppSystemActivity() {
    private companion object {
        const val TAG = "PolydanceCapture"
        /** The table: a metre wide, 60 cm deep, its top at 74 cm, its centre this far ahead of the tester. */
        const val TABLE_WIDTH = 1.0f
        const val TABLE_DEPTH = 0.6f
        const val TABLE_HEIGHT = 0.74f
        const val TABLE_AHEAD = 0.75f
        const val TABLE_TOP_THICKNESS = 0.03f
        /** A piece's longest side as it first stands on the table: the opened model larger, in the middle at the front. */
        const val OPENED_SIZE = 0.22f
        const val PIECE_SIZE = 0.15f
        /** What two hands may make of a piece, as a multiple of its size on the table. */
        const val SCALE_MIN = 0.1f
        const val SCALE_MAX = 30f
        /** A model that has not drawn by then is reported as one that could not be shown. */
        const val LOAD_TIMEOUT_MS = 30_000L
        /** Where each piece stands, across (x) and away from the tester (z), in the table's own frame; 0 is front middle. */
        val SLOTS = listOf(0f to -0.13f, -0.33f to -0.13f, 0.33f to -0.13f, 0f to 0.13f, -0.33f to 0.13f, 0.33f to 0.13f)
        val LABEL_IDS = intArrayOf(R.id.immersive_label_0, R.id.immersive_label_1, R.id.immersive_label_2, R.id.immersive_label_3, R.id.immersive_label_4, R.id.immersive_label_5)
    }

    /** A piece on its way to the table and, once its mesh has bounds, on it. */
    private class OnTable(val piece: Immersive.Piece, val slot: Int, val file: File) {
        var entity: Entity? = null
        var label: Entity? = null
        var started = 0L
        var placed = false
        var fit = 1f
        /** The bottom middle of the model's bounds, in its own units: what stands on the table. */
        var foot = Vector3(0f)
    }

    private val background = Executors.newSingleThreadExecutor()
    private val onTable = mutableListOf<OnTable>()
    private val labels = arrayOfNulls<String>(Immersive.TABLE_SIZE)
    private var opened: Immersive.Piece? = null
    private var sceneReady = false
    /** The table's centre on the floor, turned to face the way the tester faced when the scene began. */
    private var table: Pose? = null
    private val tableParts = mutableListOf<Entity>()
    private var keys: Entity? = null
    private var passthrough = true
    private var status: TextView? = null
    private var roomKey: TextView? = null

    override fun registerFeatures(): List<SpatialFeature> = listOf(VRFeature(this))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        opened = intent.getStringExtra(Immersive.EXTRA_THREAD)?.let { key ->
            val model = Threads.Step.Model(intent.getStringExtra(Immersive.EXTRA_SHA256).orEmpty(), intent.getStringExtra(Immersive.EXTRA_NAME).orEmpty(), intent.getLongExtra(Immersive.EXTRA_BYTES, 0))
            Immersive.Piece(key, intent.getStringExtra(Immersive.EXTRA_TITLE) ?: key, model).takeIf { Models.validStep(model.sha256, model.name, model.bytes) }
        }
        Timeline.log("immersive", "open", "key" to opened?.key, "sha256" to opened?.model?.sha256?.take(12))
        background.execute { gather() }
    }

    override fun onDestroy() {
        background.shutdownNow()
        Timeline.log("immersive", "close", "pieces" to onTable.count { it.placed })
        super.onDestroy()
    }

    // ---- The scene.

    override fun onSceneReady() {
        super.onSceneReady()
        scene.enablePassthrough(passthrough)
        scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
        scene.setLightingEnvironment(ambientColor = Vector3(0.6f), sunColor = Vector3(5f), sunDirection = -Vector3(1f, 3f, -2f), environmentIntensity = 0.6f)
        val at = tableAhead()
        table = at
        buildTable(at)
        keys = Entity.create(listOf(Panel(R.id.immersive_keys), Transform(keysPose(at)), Grabbable()))
        sceneReady = true
        onTable.forEach(::spawn)
        showDeck()
    }

    /** The floor point [TABLE_AHEAD] in front of the tester, facing the way they face, level. */
    private fun tableAhead(): Pose {
        val head = runCatching { scene.getViewerPose() }.getOrNull()
        if (head == null || head.t.length() == 0f) return Pose(Vector3(0f, 0f, TABLE_AHEAD), Quaternion())
        val level = head.removePitchAndRoll()
        val ahead = head.t + level.forward() * TABLE_AHEAD
        return Pose(Vector3(ahead.x, 0f, ahead.z), level.q)
    }

    /** A point in the table's frame (x across, y up from the floor, z away from the tester) in the room. */
    private fun onTableFrame(at: Pose, x: Float, y: Float, z: Float) = at.t + at.q.times(Vector3(x, y, z))

    private fun buildTable(at: Pose) {
        val wood = Color4(0.55f, 0.38f, 0.22f, 1f)
        val legs = Color4(0.32f, 0.21f, 0.12f, 1f)
        fun part(min: Vector3, max: Vector3, x: Float, y: Float, z: Float, colour: Color4) = Entity.create(listOf(
            Mesh(Uri.parse("mesh://box"), MeshCollision.NoCollision), Box(min, max),
            Material().apply { baseColor = colour },
            Transform(Pose(onTableFrame(at, x, y, z), at.q)),
        )).also { tableParts += it }
        val w = TABLE_WIDTH / 2; val d = TABLE_DEPTH / 2; val t = TABLE_TOP_THICKNESS
        part(Vector3(-w, -t, -d), Vector3(w, 0f, d), 0f, TABLE_HEIGHT, 0f, wood)
        val leg = 0.025f
        for ((x, z) in listOf(-w + 0.05f to -d + 0.05f, w - 0.05f to -d + 0.05f, -w + 0.05f to d - 0.05f, w - 0.05f to d - 0.05f)) {
            part(Vector3(-leg, 0f, -leg), Vector3(leg, TABLE_HEIGHT - t, leg), x, 0f, z, legs)
        }
    }

    /** The keys stand at the table's front left, turned towards the tester. */
    private fun keysPose(at: Pose) = Pose(onTableFrame(at, -0.72f, 1.05f, -0.2f), at.q.times(Quaternion.fromEuler(0f, -30f, 0f)))

    /** Polydance's own panel over the scene, so the deck and the threads stay in use (Meta's cooperative mode). */
    private fun showDeck() {
        runCatching { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { Log.w(TAG, "deck over the scene: ${it.javaClass.simpleName}"); say("Polydance's panel could not be opened here.") }
    }

    // ---- Which models, and getting them.

    /** Off the main thread: the opened model first, then each followed thread's latest, fetched and checked. */
    private fun gather() {
        val config = UploadSettings.load(this)
        if (config == null) { say("Not signed in, so the threads' models can't be fetched."); return }
        val client = ReceiverClient(config)
        opened?.let { fetch(client, it) }
        say("Looking for your threads' models…")
        val listing = Threads.listing ?: runCatching { Threads.list(client) }.getOrNull()
        val others = mutableListOf<Immersive.Piece>()
        for (summary in Immersive.followed(listing?.threads.orEmpty(), Threads.filter(this))) {
            if (Immersive.table(opened, others).size >= Immersive.TABLE_SIZE) break
            val thread = runCatching { Threads.get(client, summary.key) }.onFailure { Log.w(TAG, "thread ${summary.key}: ${it.javaClass.simpleName}") }.getOrNull() ?: continue
            Immersive.latestModel(Immersive.modelsOf(thread))?.let { others += Immersive.Piece(thread.key, thread.title, it) }
        }
        val pieces = Immersive.table(opened, others)
        Timeline.log("immersive", "table", "pieces" to pieces.size, "threads" to pieces.joinToString(",") { it.key })
        if (pieces.isEmpty()) { say("None of your threads has a 3D model yet."); return }
        pieces.filter { it != opened }.forEach { fetch(client, it) }
        say(null)
    }

    private fun fetch(client: ReceiverClient, piece: Immersive.Piece) {
        val model = piece.model
        val file = runCatching {
            Models.obtain(filesDir, model.sha256, model.bytes) { part -> client.download("/v1/threads/${piece.key}/models/${model.sha256}", part, model.bytes) }
        }.onFailure {
            Log.w(TAG, "model ${model.sha256.take(12)}: ${it.javaClass.simpleName}")
            Timeline.log("immersive", "fetch_failed", "key" to piece.key, "sha256" to model.sha256.take(12), "error" to it.toString().take(200))
        }.getOrNull() ?: return
        runOnUiThread {
            if (isDestroyed || onTable.any { it.piece.model.sha256 == model.sha256 } || onTable.size >= Immersive.TABLE_SIZE) return@runOnUiThread
            val placing = OnTable(piece, onTable.size, file)
            onTable += placing
            if (sceneReady) spawn(placing)
        }
    }

    /** Starts drawing a piece: out of sight and tiny until its bounds say how to stand it on the table. */
    private fun spawn(piece: OnTable) {
        if (piece.entity != null) return
        piece.started = System.currentTimeMillis()
        piece.entity = Entity.create(listOf(Mesh(Uri.fromFile(piece.file)), Transform(Pose(Vector3(0f, -10f, 0f))), Scale(Vector3(0.001f))))
    }

    override fun onSceneTick() {
        super.onSceneTick()
        for (piece in onTable) if (!piece.placed && piece.entity != null) place(piece)
    }

    /** Once the mesh has loaded: sized, made grabbable, stood in its slot and labelled with its thread. */
    private fun place(piece: OnTable) {
        val entity = piece.entity ?: return
        val mesh = runCatching { systemManager.tryFindSystem<SceneObjectSystem>()?.getSceneObject(entity)?.getNow(null)?.mesh }.getOrNull()
        val bounds = mesh?.let { runCatching { it.computeCombinedBounds() }.getOrNull() }
        val size = bounds?.size()
        if (bounds == null || size == null || maxOf(size.x, size.y, size.z) <= 0f) {
            if (System.currentTimeMillis() - piece.started > LOAD_TIMEOUT_MS) {
                // Gone rather than left hidden, so Reset cannot bring an unsized model into view.
                entity.destroy(); piece.entity = null; piece.placed = true
                Timeline.log("immersive", "piece_failed", "key" to piece.piece.key, "sha256" to piece.piece.model.sha256.take(12))
                say("${piece.piece.model.name} could not be shown here; its message can still show it.")
            }
            return
        }
        piece.placed = true
        val largest = maxOf(size.x, size.y, size.z)
        piece.fit = (if (piece.piece == opened) OPENED_SIZE else PIECE_SIZE) / largest
        val centre = bounds.center()
        piece.foot = Vector3(centre.x, bounds.min.y, centre.z)
        // The box the hands grab is the model's own bounds; one hand moves and turns it, two scale it too.
        entity.setComponent(IsdkBoxCollider(size, centre))
        entity.setComponent(Grabbable())
        entity.setComponent(IsdkGrabConstraints(IsdkGrabConstraints.LockFlags.NONE.value, Vector2(piece.fit * SCALE_MIN, piece.fit * SCALE_MAX), maxGrabbers = 2))
        labels[piece.slot] = "${piece.piece.key}  ·  ${piece.piece.title}"
        standInSlot(piece)
        Timeline.log("immersive", "piece_shown", "key" to piece.piece.key, "sha256" to piece.piece.model.sha256.take(12), "slot" to piece.slot)
    }

    /** A piece back on the table in its slot at its table size, its label in front of it. */
    private fun standInSlot(piece: OnTable) {
        val at = table ?: return
        val entity = piece.entity ?: return
        val (x, z) = SLOTS[piece.slot]
        val spot = onTableFrame(at, x, TABLE_HEIGHT, z)
        entity.setComponent(Scale(Vector3(piece.fit)))
        entity.setComponent(Transform(Pose(spot - at.q.times(piece.foot * piece.fit), at.q)))
        val labelPose = Pose(onTableFrame(at, x, TABLE_HEIGHT + 0.03f, z - 0.11f), at.q.times(Quaternion.fromEuler(-35f, 0f, 0f)))
        val label = piece.label
        if (label == null) piece.label = Entity.create(listOf(Panel(LABEL_IDS[piece.slot]), Transform(labelPose)))
        else label.setComponent(Transform(labelPose))
    }

    private fun resetTable() {
        onTable.filter { it.placed }.forEach(::standInSlot)
        Timeline.log("immersive", "reset")
    }

    private fun toggleRoom() {
        passthrough = !passthrough
        scene.enablePassthrough(passthrough)
        roomKey?.text = roomKeyText()
        Timeline.log("immersive", "passthrough", "on" to passthrough)
    }

    private fun roomKeyText() = if (passthrough) "◐ VR" else "◑ Room"

    /**
     * Back to shared space with Polydance's panel, the way Meta's hybrid apps leave an immersive activity: Home opens
     * the panel's intent once it is up. Lint takes the Home intent for one that could reach this activity, by its MAIN
     * action; it cannot, since this activity's filter has neither HOME nor DEFAULT and is not exported.
     */
    @SuppressLint("UnsafeImplicitIntentLaunch")
    private fun backToSharedSpace() {
        val panel = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(this, 0, panel, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        runCatching {
            startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("extra_launch_in_home_pending_intent", pending))
        }.onFailure { Log.w(TAG, "home: ${it.javaClass.simpleName}") }
        Timeline.log("immersive", "exit")
        finish()
    }

    private fun say(text: String?) = runOnUiThread {
        status?.text = text ?: "Pick a piece up to look at it. Both hands make it bigger or smaller."
    }

    // ---- The scene's panels, drawn with the deck's own views.

    override fun registerPanels(): List<PanelRegistration> = listOf(
        ViewPanelRegistration(R.id.immersive_keys, { _, context -> keysView(context) }, { _ -> UIPanelSettings(QuadShapeOptions(0.42f, 0.3f), DpPerMeterDisplayOptions()) }),
    ) + LABEL_IDS.mapIndexed { slot, id ->
        ViewPanelRegistration(id, { _, context -> labelView(context, slot) }, { _ -> UIPanelSettings(QuadShapeOptions(0.24f, 0.045f), DpPerMeterDisplayOptions()) })
    }

    private fun labelView(context: Context, slot: Int): View =
        Retro.label(context, labels[slot].orEmpty(), 13f, Retro.CREAM, 0.06f).apply {
            gravity = Gravity.CENTER; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            val pad = Retro.dp(context, 6f).toInt()
            setPadding(pad, pad / 2, pad, pad / 2)
            background = Retro.panel(context, Retro.PANEL, 8f, Retro.EDGE)
        }

    private fun keysView(context: Context): View {
        fun dp(v: Float) = Retro.dp(context, v).toInt()
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
            background = Retro.panel(context, Retro.WOOD_MID, 14f, Retro.WOOD_SEAM)
        }
        column.addView(Retro.label(context, "POLYDANCE  ·  IMMERSIVE", 13f, Retro.BURNT, 0.14f).apply { gravity = Gravity.CENTER })
        status = Retro.body(context, 15f, Retro.BURNT).apply { gravity = Gravity.CENTER; text = "Looking for your threads' models…"; setPadding(0, dp(6f), 0, dp(4f)) }
        column.addView(status, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        fun row() = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }.also { column.addView(it) }
        fun key(row: LinearLayout, text: String, onClick: () -> Unit) = Retro.button(context, text, Retro.CREAM, small = true, onClick = onClick).also {
            row.addView(it, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(dp(5f), dp(6f), dp(5f), 0) })
        }
        val first = row()
        key(first, "⟲ Reset table") { resetTable() }
        roomKey = key(first, roomKeyText()) { toggleRoom() }
        val second = row()
        key(second, "▣ Polydance") { showDeck() }
        key(second, "↩ Shared space") { backToSharedSpace() }
        return column
    }
}
