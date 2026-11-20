package net.polydance.capture

import android.app.Application
import java.util.concurrent.Executors

/** Covers launcher, inbox, service and WorkManager-only process starts, including saved credentials. */
class CaptureApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // No connectivity constraint here: Quest's SDK can establish local entitlement while offline.
        signIn.ensure(this)
        signIn.retryLater(this)
        // A take of logs alone has no service to outlive a killed process: its run folder brings it back (LogsTake).
        runCatching { LogsTake.restore(this) }
        val recovery = Executors.newSingleThreadExecutor()
        recovery.execute {
            try {
                // Recover old terminal auth jobs and persisted deletion markers after an update/crash.
                Uploads.resumeWaiting(this)
                // Reports sent, unsendable or a week old leave the headset; refused ones go again (ReportPolicy).
                Reports.sweep(this)
            } finally { recovery.shutdown() }
        }
    }
}
