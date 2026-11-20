package net.polydance.capture.platform

import android.content.Context
import android.content.Intent
import net.polydance.capture.ImmersiveTableActivity
import net.polydance.capture.R

/** Horizon OS policy; this is the only source set allowed to name Oculus APIs/packages. */
fun createHeadsetPlatform() = HeadsetPlatform(
    id = "quest",
    label = "Meta Quest",
    capturePermission = CapturePermission("com.oculus.permission.USE_SCENE", "Ask for Quest spatial data permission"),
    preferredBrowserPackage = "com.oculus.browser",
    storePage = ::horizonStorePage,
    immersiveViewer = ImmersiveTableActivity::class.java,
)

private const val SHELL = "com.oculus.vrshell"

/**
 * Polydance's own page in the Horizon Store, for the Update key beside START's warning (CAP-6 #3, 2026-10-13).
 * Meta's system deep link: the shell with intent_data systemux://store and uri /item/<app id>
 * (developers.meta.com/horizon/documentation/unreal/ps-system-deep-linking, updated 2026-10-05). The shell's
 * launch intent as Meta's sample does, else its MainActivity as in Meta's adb example; null without the shell
 * or an app id, and then no key is shown.
 */
private fun horizonStorePage(context: Context): Intent? {
    val appId = context.getString(R.string.meta_app_id).takeIf { it.isNotBlank() } ?: return null
    val shell = context.packageManager.getLaunchIntentForPackage(SHELL)
        ?: Intent(Intent.ACTION_VIEW).setClassName(SHELL, "$SHELL.MainActivity").takeIf { it.resolveActivity(context.packageManager) != null }
        ?: return null
    return shell.putExtra("intent_data", "systemux://store").putExtra("uri", "/item/$appId").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
