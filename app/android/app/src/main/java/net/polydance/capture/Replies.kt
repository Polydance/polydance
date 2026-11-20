package net.polydance.capture

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * A notification in the headset when someone replies in a thread this headset has not read (Robin,
 * 2026-10-05: Horizon OS's own notifications, which the user turns on and off, and no other notification
 * system). Off until the user turns it on behind the gear, which asks for the notification permission;
 * the headset grants or refuses it. A WorkManager job asks the receiver every 15 minutes, the shortest
 * period Android gives background work, which threads are unread, and posts one notification per thread
 * for messages by others not yet told about: who sent the latest and its first line. Opening the thread
 * clears it, and so does reading it anywhere else. Nothing can wake the headset sooner: Horizon OS has
 * no Google push. Meta documents Android notifications as unsupported (PLATFORM-NOTES); turning these on
 * posts one at once, so the headset shows straight away whether they appear.
 */
object Replies {
    private const val CHANNEL = "replies"
    private const val PREFS = "replies"
    private const val WORK = "replies"
    /** One notification per thread, told apart by its tag: the thread key, or "on" for the first. */
    private const val ID = 1
    private const val LOG = "PolydanceCapture"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)
    private fun network() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun enabled(context: Context) = prefs(context).getBoolean("on", false)

    /** The headset lets this app notify: the permission (Android 13 on) and its notifications not blocked. */
    fun allowed(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            manager(context).areNotificationsEnabled()

    /** Called once the permission is granted. */
    fun turnOn(context: Context) {
        prefs(context).edit().putBoolean("on", true).apply()
        schedule(context)
        post(context, "on", "Notifications are on", "Polydance will tell you here when someone replies in a thread you have not read.", null)
        WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<ReplyWorker>().setConstraints(network()).build())
    }

    fun turnOff(context: Context) {
        prefs(context).edit().putBoolean("on", false).apply()
        WorkManager.getInstance(context).cancelUniqueWork(WORK)
        // Only this channel's: the recorder's own notification is not ours to clear.
        for (shown in manager(context).activeNotifications) if (shown.notification.channelId == CHANNEL) manager(context).cancel(shown.tag, shown.id)
    }

    /** Keeps the 15-minute check queued while notifications are on; the deck calls it when it opens. */
    fun schedule(context: Context) {
        if (!enabled(context)) return
        val request = PeriodicWorkRequestBuilder<ReplyWorker>(15, TimeUnit.MINUTES).setConstraints(network()).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** The thread is on screen, so read: its notification goes. */
    fun seen(context: Context, key: String) = manager(context).cancel(key, ID)

    /**
     * Asks the receiver which threads are unread and tells about messages by others since the last time,
     * one notification per thread. A thread read meanwhile, here or anywhere with this token, loses its
     * notification. While Polydance is in front nothing is posted: the inbox already shows it.
     */
    fun check(context: Context) {
        if (!enabled(context) || !allowed(context)) return
        val config = UploadSettings.load(context) ?: return
        val client = ReceiverClient(config)
        val listing = Threads.list(client)
        val told = prefs(context)
        val edit = told.edit()
        val inFront = Threads.inboxInFront || CaptureState.activityState == "resume"
        for (summary in listing.threads) {
            if (!summary.unread) { seen(context, summary.key); continue }
            val last = told.getInt(summary.key, 0)
            if (summary.seq <= last) continue
            val thread = Threads.get(client, summary.key)
            val news = thread.messages.filter { it.seq > maxOf(last, thread.readSeq) && it.byId != thread.me }
            edit.putInt(summary.key, thread.seq)
            if (news.isEmpty() || inFront) continue
            val latest = news.last()
            val what = latest.text?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()?.take(160)
                ?: when {
                    latest.launches.isNotEmpty() -> "something to try"; latest.recording != null -> "a recording"
                    latest.photos.isNotEmpty() -> if (latest.photos.size == 1) "a photo" else "${latest.photos.size} photos"
                    else -> "a message"
                }
            val more = if (news.size > 1) " (and ${news.size - 1} more)" else ""
            post(context, summary.key, "${summary.key} · ${thread.title}", "${latest.byName}: $what$more", summary.key)
            Log.i(LOG, "replies: told about ${news.size} new in ${summary.key}")
        }
        edit.apply()
    }

    /** Tapping it opens the deck with the inbox beside it, on the thread. */
    private fun post(context: Context, tag: String, title: String, text: String, thread: String?) {
        val manager = manager(context)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Replies in threads", NotificationManager.IMPORTANCE_DEFAULT))
        val open = Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_THREAD).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (thread != null) open.putExtra("thread", thread)
        val tap = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title).setContentText(text).setStyle(Notification.BigTextStyle().bigText(text))
            .setCategory(Notification.CATEGORY_MESSAGE).setContentIntent(tap).setAutoCancel(true)
            .build()
        runCatching { manager.notify(tag, ID, notification) }.onFailure { Log.w(LOG, "replies: $tag not posted: $it") }
    }
}

/** The 15-minute check; a failed one waits for the next. */
class ReplyWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        runCatching { Replies.check(applicationContext) }.onFailure { Log.w("PolydanceCapture", "replies: check failed: $it") }
        return Result.success()
    }
}
