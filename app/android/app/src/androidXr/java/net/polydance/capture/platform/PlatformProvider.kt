package net.polydance.capture.platform

import android.content.Context
import android.content.Intent
import android.net.Uri

/** XREAL AURA/Android XR starts as a compatible 2D app. No vendor SDK or spatial permissions needed.
 * Same-task inbox is intentional until adjacent panels are verified on the device. Android chooses
 * the URL handler; do not guess a Chrome/XREAL package or promise automatic WebXR immersion.
 */
fun createHeadsetPlatform() = HeadsetPlatform(
    id = "android-xr",
    label = "Android XR · XREAL AURA test build",
    capturePermission = null,
    preferredBrowserPackage = null,
    storePage = ::playStorePage,
)

private const val PLAY_STORE = "com.android.vending"

/**
 * Polydance's page in Google Play, for the inbox's Update key beside START's build warning, as Quest opens
 * its Horizon Store page. Only when Play installed this copy: then the listing exists and this account can
 * see it, internal testing included (private/docs/PLAY.md), and Play's own Update button finishes the job. A copy
 * installed over adb shows no key; `npm run app -- install` updates it.
 */
private fun playStorePage(context: Context): Intent? {
    val installer = runCatching { context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName }.getOrNull()
    if (installer != PLAY_STORE) return null
    return Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=${context.packageName}"))
        .setPackage(PLAY_STORE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        .takeIf { it.resolveActivity(context.packageManager) != null }
}
