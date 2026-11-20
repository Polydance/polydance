package net.polydance.capture.platform

import net.polydance.capture.BuildConfig
import org.junit.Assert.*
import org.junit.Test

/** Runs for both flavors against their actual provider; no headset behaviour is simulated here. */
class HeadsetPlatformTest {
    private val platform = createHeadsetPlatform()

    @Test fun providerHasKnownPolicy() {
        assertEquals(if (BuildConfig.FLAVOR == "quest") "quest" else "android-xr", platform.id)
        if (platform.id == "quest") {
            assertNotNull(platform.capturePermission)
            assertNotNull(platform.preferredBrowserPackage)
        } else {
            assertNull(platform.capturePermission)
            assertNull(platform.preferredBrowserPackage)
        }
    }

    @Test fun stalePermissionPreferenceCannotEnableVendorPermissionInXr() {
        assertTrue(platform.additionalCapturePermissions(false).isEmpty())
        assertEquals(platform.capturePermission?.let { listOf(it.name) } ?: emptyList<String>(),
            platform.additionalCapturePermissions(true))
    }

    @Test fun absentVendorBrowserFallsBackToSystem() {
        assertNull(platform.browserPackage { false })
        assertEquals(platform.preferredBrowserPackage, platform.browserPackage { true })
        var queries = 0
        platform.browserPackage { queries++; true }
        assertEquals(if (platform.preferredBrowserPackage == null) 0 else 1, queries)
    }

    @Test fun immersiveViewerIsQuestOnly() {
        // Quest's is the Spatial SDK activity in src/quest; Android XR shows no Immersive key until Full Space is built.
        if (platform.id == "quest") assertEquals("net.polydance.capture.ImmersiveTableActivity", platform.immersiveViewer?.name)
        else assertNull(platform.immersiveViewer)
    }
}
