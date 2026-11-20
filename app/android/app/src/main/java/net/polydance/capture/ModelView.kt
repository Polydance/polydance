package net.polydance.capture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import net.polydance.capture.platform.headsetPlatform
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

/**
 * A 3D model in its message (Robin, 2026-10-20: the viewer belongs in the message, not a panel of its own;
 * from 2026-10-19 to 20 it was ModelActivity, a third panel). Neither Horizon OS nor Android XR lets an app put
 * a free-standing 3D object beside panels outside immersive mode, so the model is drawn here by Google's
 * <model-viewer> in a WebView (assets/viewer): drag to turn it, pinch or the thumbstick to zoom, and keys for
 * the same. The model comes from the receiver through its thread, is checked against the message's sha256
 * (Models) and is served to the page from this app's files; every other request the page makes is refused,
 * so nothing in the viewer reaches the network. The inbox keeps one of these per message across redraws, so
 * a model stays as it was turned; [destroy] when the thread closes.
 *
 * Where the platform has one, an Immersive key beside Controls opens the immersive scene: this model and the followed
 * threads' models on a table, with Polydance's panel still in use (Robin, CAP-10, 2026-10-21; on Quest,
 * ImmersiveTableActivity in src/quest).
 */
@SuppressLint("ViewConstructor")
class ModelView(context: Context, private val key: String, private val step: Threads.Step.Model) : LinearLayout(context) {
    companion object {
        private const val TAG = "PolydanceCapture"
        /** Android's reserved name for an app's own content in a WebView: it never resolves to the network. */
        private const val ORIGIN = "https://appassets.androidplatform.net"
        private const val PAGE = "$ORIGIN/viewer/index.html"
    }

    private val ui = Handler(Looper.getMainLooper())
    private val background = Executors.newSingleThreadExecutor()
    private val web: WebView? = webView()
    private val status: TextView
    private val spinKey: TextView
    private val controlsKey: TextView
    /** The verified copy the page may load; nothing else under model/ is served. */
    @Volatile private var model: File? = null
    private var spinning = false
    private var started = false
    private var gone = false

    private fun dp(v: Float) = Retro.dp(context, v).toInt()

    init {
        orientation = VERTICAL
        setPadding(0, dp(12f), 0, 0)
        // The model on the deck's dark panel; the words over it say what is happening until it shows. A drag that
        // starts on the model turns it, never the thread around it.
        val frame = object : FrameLayout(context) {
            override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
                if (ev.actionMasked == MotionEvent.ACTION_DOWN) parent?.requestDisallowInterceptTouchEvent(true)
                return super.dispatchTouchEvent(ev)
            }
        }.apply { background = Retro.panel(context, Retro.CASING, 10f, Retro.EDGE); clipToOutline = true }
        web?.let { frame.addView(it, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)) }
        status = Retro.body(context, 15f, Retro.CREAM).apply {
            gravity = Gravity.CENTER; setPadding(dp(16f), dp(8f), dp(16f), dp(8f))
            background = Retro.panel(context, Retro.PANEL, 8f, Retro.EDGE); visibility = View.GONE
        }
        frame.addView(status, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { setMargins(dp(24f), 0, dp(24f), 0) })
        // Its name, and Controls, which shows the keys: folded by default, so the model has the room (CAP-10, 2026-10-21).
        val title = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, 0, 0, dp(6f)) }
        title.addView(Retro.label(context, "3D  ·  ${step.name}  ·  ${Models.size(step.bytes)}", 12f, Retro.TAN, 0.14f), LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        lateinit var keys: LinearLayout
        controlsKey = Retro.button(context, "▾  Controls", Retro.TAN, small = true) {
            keys.visibility = if (keys.visibility == View.VISIBLE) View.GONE else View.VISIBLE
            controlsKey.text = if (keys.visibility == View.VISIBLE) "▴  Controls" else "▾  Controls"
            Timeline.log("model", "controls", "shown" to (keys.visibility == View.VISIBLE))
        }
        title.addView(controlsKey)
        // Into the room, where the platform has an immersive scene.
        if (headsetPlatform.immersiveViewer != null) title.addView(Retro.button(context, "⬚  Immersive", Retro.TAN, small = true) { immersive() },
            LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
        addView(title)
        addView(frame, LayoutParams(LayoutParams.MATCH_PARENT, dp(440f)))

        // Keys for what a drag or a pinch does, since a controller's ray makes those awkward; 48 dp tall at least (Meta).
        keys = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(8f), 0, 0); visibility = View.GONE }
        fun key(text: String, onClick: () -> Unit) = Retro.button(context, text, Retro.CREAM, small = true, onClick = onClick).also {
            keys.addView(it, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8f) })
        }
        key("◀ Turn") { call("turn(-45)") }
        key("Turn ▶") { call("turn(45)") }
        key("－ Zoom") { call("zoom(-3)") }
        key("Zoom ＋") { call("zoom(3)") }
        spinKey = key("↻ Spin") { spinning = !spinning; drawSpin(); call("spin($spinning)") }
        key("⟲ Reset") { spinning = false; drawSpin(); call("reset()") }
        addView(keys)
    }

    /** Fetches the model once the view is on screen; again after a failure, when it is shown again. */
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!started && !gone) open()
    }

    fun destroy() {
        gone = true
        ui.removeCallbacksAndMessages(null)
        background.shutdownNow()
        (parent as? android.view.ViewGroup)?.removeView(this)
        web?.destroy()
    }

    private fun open() {
        started = true
        val config = UploadSettings.load(context)
        if (config == null) { say("Not signed in, so the model can't be fetched."); started = false; return }
        if (web == null) { say("This headset has no web view to draw the model in."); return }
        Timeline.log("model", "open", "key" to key, "sha256" to step.sha256.take(12), "bytes" to step.bytes)
        say("Fetching ${step.name}…")
        background.execute {
            val result = runCatching {
                Models.obtain(context.filesDir, step.sha256, step.bytes) { part ->
                    var shownPercent = -1
                    ReceiverClient(config).download("/v1/threads/$key/models/${step.sha256}", part, step.bytes) { got ->
                        val percent = (got * 100 / step.bytes).toInt()
                        if (percent / 10 != shownPercent / 10) { shownPercent = percent; ui.post { if (!gone && model == null) say("Fetching ${step.name}… $percent%") } }
                    }
                }
            }
            ui.post {
                if (gone) return@post
                result.onSuccess { file ->
                    model = file
                    say("Opening ${step.name}…")
                    web.loadUrl("$PAGE?src=model/${step.sha256}.glb")
                }.onFailure { e ->
                    started = false
                    Log.w(TAG, "model ${step.sha256.take(12)}: ${e.javaClass.simpleName}")
                    Timeline.log("model", "fetch_failed", "sha256" to step.sha256.take(12), "error" to e.toString().take(200))
                    say(when {
                        (e as? ReceiverClient.Refused)?.code == 404 -> "The server doesn't have this model, or this thread doesn't send it."
                        e is ReceiverClient.Refused -> "The server refused the model: ${e.message}"
                        e is IOException -> "Can't fetch the model: ${e.message}. Check the connection; it tries again when the thread is opened."
                        else -> "The model could not be opened: ${e.message}"
                    })
                }
            }
        }
    }

    // ---- The page.

    /** Answers the page from the app: its own folder in assets, and the one verified model. */
    private fun answer(request: WebResourceRequest): WebResourceResponse {
        val url = request.url
        val path = url.path.orEmpty()
        val refused = WebResourceResponse("text/plain", "utf-8", 404, "Not here", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        if ("${url.scheme}://${url.host}" != ORIGIN || !path.startsWith("/viewer/") || ".." in path) return refused
        val name = path.removePrefix("/viewer/")
        if (name.startsWith("model/")) {
            val file = model?.takeIf { name == "model/${it.name}" } ?: return refused
            return WebResourceResponse("model/gltf-binary", null, file.inputStream())
        }
        if (!Regex("[a-z0-9_/.-]+").matches(name)) return refused
        val type = when (name.substringAfterLast('.')) {
            "html" -> "text/html"; "js" -> "text/javascript"; "wasm" -> "application/wasm"; "txt" -> "text/plain"
            else -> return refused
        }
        return runCatching { WebResourceResponse(type, "utf-8", context.assets.open("viewer/$name")) }.getOrElse { refused }
    }

    private fun onPageTitle(text: String?) {
        when (val state = Models.pageState(text)) {
            is Models.PageState.Loading -> say(state.progress?.let { "Opening ${step.name}… ${(it * 100).toInt()}%" } ?: "Opening ${step.name}…")
            is Models.PageState.Loaded -> {
                say(null)
                Timeline.log("model", "shown", "sha256" to step.sha256.take(12), "animations" to state.animations)
            }
            is Models.PageState.Failed -> {
                say("${step.name} could not be shown: ${state.reason}.")
                Timeline.log("model", "page_failed", "sha256" to step.sha256.take(12), "reason" to state.reason)
            }
        }
    }

    /** The platform's immersive scene, with this model first on its table, once this view has a verified copy. */
    private fun immersive() {
        if (model == null) { say("The model is still on its way; Immersive opens it once it's here."); return }
        val intent = headsetPlatform.immersiveIntent(context) ?: return
        val title = Threads.openTitle?.takeIf { Threads.openKey == key } ?: key
        Timeline.log("model", "immersive", "key" to key, "sha256" to step.sha256.take(12))
        runCatching {
            context.startActivity(intent.putExtra(Immersive.EXTRA_THREAD, key).putExtra(Immersive.EXTRA_TITLE, title)
                .putExtra(Immersive.EXTRA_SHA256, step.sha256).putExtra(Immersive.EXTRA_NAME, step.name).putExtra(Immersive.EXTRA_BYTES, step.bytes))
        }.onFailure {
            Log.w(TAG, "immersive: ${it.javaClass.simpleName}")
            Timeline.log("model", "immersive_failed", "error" to it.toString().take(200))
            say("The immersive scene could not be opened: ${it.message}")
        }
    }

    private fun call(js: String) {
        web?.evaluateJavascript("window.polydance && window.polydance.$js", null)
        Timeline.log("model", "key", "do" to js.substringBefore('('), "sha256" to step.sha256.take(12))
    }

    private fun say(text: String?) {
        status.text = text.orEmpty()
        status.visibility = if (text == null) View.GONE else View.VISIBLE
    }

    private fun drawSpin() { spinKey.text = if (spinning) "■ Stop" else "↻ Spin" }

    @SuppressLint("SetJavaScriptEnabled")
    private fun webView(): WebView? = runCatching {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        WebView(context).apply {
            setBackgroundColor(Retro.CASING)
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            settings.mediaPlaybackRequiresUserGesture = true
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = answer(request)
                // The page never goes anywhere else.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = !request.url.toString().startsWith(PAGE)
                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { spinning = false; drawSpin() }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView, title: String?) = onPageTitle(title)
            }
        }
    }.onFailure { Log.w(TAG, "no WebView: ${it.javaClass.simpleName}"); Timeline.log("model", "no_webview", "error" to it.toString().take(200)) }.getOrNull()
}
