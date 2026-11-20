package net.polydance.capture

import android.app.Activity
import android.content.Context

/**
 * How a headset gets its receiver token, and whether it may record before it has one. Shared code asks
 * [signIn] and never a vendor SDK; each flavor supplies exactly one [createSignIn] (app/PLATFORMS.md).
 * Quest signs in with Meta's Platform SDK (src/quest MetaSignIn): Horizon OS entitlement gates recording
 * and the account proof buys a token, with no screen of its own. Android XR signs in with Google (src/androidXr
 * GoogleSignIn): Credential Manager needs an activity for its account chooser, so the deck calls [begin], quietly
 * on resume and in full when the person presses the sign-in line. A debug build can still be configured over adb.
 * The words live with the provider because only it knows what the person signs in with.
 */
interface HeadsetSignIn {
    /** False until this flavor's own gate allows recording; never a reason to start one. */
    fun mayRecord(): Boolean
    /** Starts or retries sign-in while there is no token; [completed] runs when this attempt settles. */
    fun ensure(context: Context, completed: (() -> Unit)? = null)
    /** The receiver refused [rejectedToken]: forget it if it is still the saved one, and sign in again if this flavor can. */
    fun rejected(context: Context, rejectedToken: String)
    /** Durable sign-in work that outlives the process, for flavors that sign in by themselves. */
    fun retryLater(context: Context)

    /** The deck's line while there is no token. */
    fun deckText(context: Context): String
    /** The inbox's line while there is no token, where server history would be. */
    fun inboxText(): String
    /** After the receiver refused the saved token. */
    val expiredText: String
    /** Why a start was refused while [mayRecord] is false. */
    fun refusedText(): String
    /** Whose name the first-recording notice says shows on each recording (Consent). */
    val consentName: String

    /** True when [begin] can show something: the deck makes its sign-in line a key. */
    val interactive: Boolean get() = false
    /** Starts sign-in that needs the screen; [quiet] tries only an account already chosen, with no chooser. */
    fun begin(activity: Activity, quiet: Boolean) = Unit
    /** The inbox profile's line for a token from this sign-in. */
    fun signedInText(model: String): String
    /** The Recordings page's line naming the signed-in account by its id. */
    fun accountText(id: String): String
    /** The deck settings' line under the server address. */
    fun signedInAs(name: String): String
}

val signIn: HeadsetSignIn = createSignIn()

/** Where a headset that signs itself in uploads; adb's CONFIGURE can point a debug build elsewhere. */
fun defaultServer(context: Context): String = context.getString(R.string.default_server)
