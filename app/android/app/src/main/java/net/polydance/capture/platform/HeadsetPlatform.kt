package net.polydance.capture.platform

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri

/** Only vendor policy lives here. Recording, consent, UI, threads and uploads remain shared Android.
 * Each Gradle flavor supplies exactly one [createHeadsetPlatform]; no manufacturer checks in the UI.
 */
data class CapturePermission(val name: String, val label: String, val defaultEnabled: Boolean = true)

class HeadsetPlatform(
    val id: String,
    val label: String,
    val capturePermission: CapturePermission?,
    val preferredBrowserPackage: String?,
    /** This app's page in the platform's store, for the inbox's Update key; null shows no key. */
    val storePage: (Context) -> Intent? = { null },
    /**
     * The immersive scene a model's Immersive key opens (CAP-10, 2026-10-21: a table with the followed threads' models,
     * beside this app's panel): on Quest a Spatial SDK activity in src/quest; null shows no key, as on Android XR until
     * Full Space has been built and tried there.
     */
    val immersiveViewer: Class<out Activity>? = null,
) {
    /** A stale preference or adb extra must never request a permission absent from this flavor. */
    fun additionalCapturePermissions(enabled: Boolean): List<String> =
        capturePermission?.takeIf { enabled }?.let { listOf(it.name) } ?: emptyList()

    fun browserPackage(canHandle: (String) -> Boolean): String? = preferredBrowserPackage?.takeIf(canHandle)

    fun browserIntent(context: Context, url: String): Intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        // Prefer the vendor browser only if it can actually handle this URL; otherwise use Android.
        browserPackage { preferred -> context.packageManager.resolveActivity(Intent(this).setPackage(preferred), 0) != null }
            ?.let { setPackage(it) }
    }

    /** The immersive scene in a task of its own, as Meta's hybrid apps open theirs; null without one. */
    fun immersiveIntent(context: Context): Intent? =
        immersiveViewer?.let { Intent(context, it).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
}

val headsetPlatform: HeadsetPlatform = createHeadsetPlatform()
