const fs = require("fs");
const path = require("path");
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} = require("expo/config-plugins");

/**
 * Everything below is generated into the app's own Java package, so the package
 * name is read from `android.package` in app.json rather than hardcoded — a
 * rename there (e.g. the move to the Softmato namespace) must not need edits in
 * this file. Kotlin templates carry `__APP_PACKAGE__` and are resolved by
 * `applyPackage` at write time.
 */
const PACKAGE_TOKEN = /__APP_PACKAGE__/g;

function androidPackageDir(pkg) {
  return path.join("android", "app", "src", "main", "java", ...pkg.split("."));
}

function applyPackage(source, pkg) {
  return source.replace(PACKAGE_TOKEN, pkg);
}

const CALL_FOREGROUND_SERVICE_KT = `package __APP_PACKAGE__

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class CallForegroundService : Service() {
  companion object {
    const val ACTION_START = "__APP_PACKAGE__.CALL_FOREGROUND_START"
    const val ACTION_STOP = "__APP_PACKAGE__.CALL_FOREGROUND_STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    private const val CHANNEL_ID = "questioncall_ongoing_call"
    // Non-private: the JS-facing module cancels this id directly when stopping,
    // to clear notifications left behind by a service that died uncleanly.
    const val NOTIFICATION_ID = 4201
    private const val TAG = "CallForegroundService"
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // A null intent means the system re-created us on its own after the process
    // died — there is no live call and no JS left to ever call stop(), so
    // re-posting the ongoing notification here would strand an undismissable
    // "QuestionCall is running" entry in the shade forever. Bail out instead.
    // (START_NOT_STICKY below makes this path rare, but a pending redelivery
    // queued before the process died can still land here.)
    if (intent == null || intent.action == ACTION_STOP) {
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }

    createNotificationChannel()

    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Call in progress"
    val body = intent?.getStringExtra(EXTRA_BODY) ?: "Tap to return to QuestionCall."
    val notification = buildNotification(title, body)

    // Android 14+ validates every type in the mask against its runtime
    // permission and throws SecurityException when one is missing — which,
    // uncaught here, takes the whole process down. Degrade instead: retry with
    // the bare phoneCall type, and if even that is refused, drop the ongoing
    // notification rather than killing an in-progress call.
    try {
      startForegroundCompat(notification, foregroundServiceType())
    } catch (err: Exception) {
      Log.w(TAG, "startForeground with full type mask failed; retrying phoneCall-only", err)
      try {
        startForegroundCompat(notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
      } catch (retryErr: Exception) {
        Log.w(TAG, "startForeground refused; running without ongoing notification", retryErr)
        stopSelf()
        return START_NOT_STICKY
      }
    }

    // Deliberately NOT sticky. The call this service accompanies lives entirely
    // in JS; if the process dies the call is already over, so letting Android
    // restart the service would only resurrect its ongoing notification with
    // nothing able to dismiss it.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    // stopService() destroys us without routing through onStartCommand, so this
    // is the only guaranteed hook for tearing the notification down.
    stopForegroundCompat()
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // User swiped the app away — the call cannot continue without JS.
    stopForegroundCompat()
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private fun startForegroundCompat(notification: Notification, type: Int) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, type)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(title: String, body: String): Notification {
    val launchIntent = (packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(this, MainActivity::class.java)).apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }

    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setContentTitle(title)
      .setContentText(body)
      .setCategory(Notification.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setOngoing(true)
      .setUsesChronometer(true)
      .setContentIntent(pendingIntent)
      .build()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "Ongoing calls",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Keeps active QuestionCall calls alive in the background."
      setSound(null, null)
      enableVibration(false)
    }

    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(channel)
  }

  /**
   * Only claim the media types we actually hold runtime permission for.
   *
   * From Android 14 the system cross-checks each type in the mask: \`camera\`
   * needs CAMERA granted, \`microphone\` needs RECORD_AUDIO. Claiming either
   * without the grant throws SecurityException. Both cases are routine here —
   * an audio call never asks for CAMERA, and on the caller side neither
   * permission exists yet, because tracks are only published once the callee
   * accepts. \`phoneCall\` is always safe: MANAGE_OWN_CALLS is install-time.
   */
  private fun foregroundServiceType(): Int {
    var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
        type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      }
      if (hasPermission(Manifest.permission.CAMERA)) {
        type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      }
    }

    return type
  }

  private fun hasPermission(permission: String): Boolean =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }
}
`;

const CALL_DISPATCH_STORE_KT = `package __APP_PACKAGE__

import android.content.Context

/**
 * Cross-process dedupe for "ring the user for this call" decisions.
 *
 * One call reaches the device over two transports that cannot see each other:
 * Pusher (handled in JS) and FCM (handled by CallNotificationService, which runs
 * even when there is no JS at all). An in-memory JS map cannot arbitrate that —
 * the native service may be the only thing running. SharedPreferences is the
 * one piece of state both sides can reach, and it survives process death.
 *
 * claim() is the whole protocol: the first caller to claim a session id gets
 * true and rings; everyone else inside the window gets false and stays quiet.
 */
object CallDispatchStore {
  private const val PREFS_NAME = "questioncall_call_dispatch"
  // Matches CALL_DEDUPE_WINDOW_MS in app/lib/call-dispatch.ts.
  private const val WINDOW_MS = 30_000L

  @Synchronized
  @JvmStatic
  fun claim(context: Context, callSessionId: String): Boolean {
    if (callSessionId.isEmpty()) return false

    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    val last = prefs.getLong(callSessionId, 0L)
    val elapsed = now - last

    // A negative elapsed means the wall clock moved backwards; treat the entry
    // as expired rather than muting calls until the clock catches up.
    if (last != 0L && elapsed in 0 until WINDOW_MS) return false

    val editor = prefs.edit()
    editor.putLong(callSessionId, now)
    // Evict expired ids so this file cannot grow without bound.
    for ((key, value) in prefs.all) {
      val ts = value as? Long ?: continue
      if (now - ts > WINDOW_MS) editor.remove(key)
    }
    editor.apply()
    return true
  }

  @Synchronized
  @JvmStatic
  fun forget(context: Context, callSessionId: String) {
    if (callSessionId.isEmpty()) return
    context
      .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(callSessionId)
      .apply()
  }

  // ── Call state, deliberately in a SECOND prefs file ──────────────────────
  //
  // Not PREFS_NAME: claim() evicts every Long in its file older than WINDOW_MS,
  // so an "I am in this call" marker parked there would vanish 30s into a call
  // and the guard it exists for would silently stop working.
  //
  // What this is for: lib/call-dispatch.ts has always refused to resurface a
  // call the user is already inside (isCallActive), but that set is in JS
  // memory and CallNotificationService cannot see it. The native path had no
  // equivalent, so a ring-fallback push that lost the race with an answer rang
  // ON TOP of the live call. Mirroring the flag here closes that.

  // ── Pending accept ───────────────────────────────────────────────────────
  //
  // The user pressing Accept is a decision, and until now it was only ever an
  // *event*: the notification's PendingIntent launched MainActivity and the
  // library emitted RNNotificationAnswerAction over the React bridge. Both
  // assume JS is already running. On a cold start it is not — the process is
  // being created by that very tap — so the answer was emitted into a bridge
  // with no listeners and simply lost. The app came up on whatever screen it
  // was last on, the server was never told anyone answered, and the call died
  // as "Cancelled" while the user sat there looking at their chat list.
  //
  // So write the decision down instead. MainActivity records it straight from
  // the launch intent, before a line of JS exists, and JS drains it on boot.
  // A tap can no longer be lost to a race with the bundle loader.

  private const val PENDING_ACCEPT_PREFS = "questioncall_pending_accept"
  private const val PENDING_CALL_ID = "callId"
  private const val PENDING_MODE = "mode"
  private const val PENDING_AT = "at"
  // Older than this and the tap cannot honestly be called "the user is waiting
  // for this call to connect" — better to drop it than to drag someone into a
  // call they pressed Accept on minutes ago.
  private const val PENDING_ACCEPT_TTL_MS = 60_000L

  @Synchronized
  @JvmStatic
  fun recordPendingAccept(context: Context, callSessionId: String, mode: String?) {
    if (callSessionId.isEmpty()) return
    context
      .getSharedPreferences(PENDING_ACCEPT_PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(PENDING_CALL_ID, callSessionId)
      .putString(PENDING_MODE, mode ?: "")
      .putLong(PENDING_AT, System.currentTimeMillis())
      .apply()
  }

  /**
   * Read and clear the pending accept. Returns null when there is none, or when
   * the one on disk is too old to act on.
   *
   * Clearing on read is deliberate: this must fire exactly once, and a JS reload
   * (fast refresh, an error-boundary remount) would otherwise replay a stale
   * accept and pull the user into a finished call.
   */
  @Synchronized
  @JvmStatic
  fun consumePendingAccept(context: Context): Pair<String, String>? {
    val prefs = context.getSharedPreferences(PENDING_ACCEPT_PREFS, Context.MODE_PRIVATE)
    val callId = prefs.getString(PENDING_CALL_ID, null)
    val mode = prefs.getString(PENDING_MODE, "") ?: ""
    val at = prefs.getLong(PENDING_AT, 0L)
    prefs.edit().clear().apply()

    if (callId.isNullOrEmpty()) return null
    val age = System.currentTimeMillis() - at
    if (at == 0L || age < 0 || age > PENDING_ACCEPT_TTL_MS) return null
    return Pair(callId, mode)
  }

  @Synchronized
  @JvmStatic
  fun clearPendingAccept(context: Context) {
    context
      .getSharedPreferences(PENDING_ACCEPT_PREFS, Context.MODE_PRIVATE)
      .edit()
      .clear()
      .apply()
  }

  private const val STATE_PREFS_NAME = "questioncall_call_state"
  private const val ACTIVE_KEY_PREFIX = "active."
  private const val DECLINED_KEY_PREFIX = "declined."
  // Comfortably longer than the 30s ring window, short enough that a session id
  // can never be muted for a meaningful length of time by a stale entry.
  private const val DECLINED_WINDOW_MS = 300_000L
  // An active marker is normally cleared when the call screen unmounts, so it
  // has no expiry of its own — a call must stay guarded for its whole length,
  // however long that is. But if the app is killed mid-call that cleanup never
  // runs, so sweep anything old enough that it cannot be a live call. A stale
  // marker only mutes its own dead session; the reason to bound it is to stop
  // this file growing for ever.
  private const val ACTIVE_STALE_MS = 21_600_000L

  private fun statePrefs(context: Context) =
    context.getSharedPreferences(STATE_PREFS_NAME, Context.MODE_PRIVATE)

  @Synchronized
  @JvmStatic
  fun setActive(context: Context, callSessionId: String, active: Boolean) {
    if (callSessionId.isEmpty()) return
    val prefs = statePrefs(context)
    val now = System.currentTimeMillis()
    val editor = prefs.edit()
    if (active) {
      editor.putLong(ACTIVE_KEY_PREFIX + callSessionId, now)
      // The user is demonstrably in the call, so the "they pressed Accept" note
      // has done its job. Dropping it here stops a cold start inside the TTL
      // from replaying an accept for a call that is already answered, or since
      // over — the app would otherwise reopen straight into a dead session.
      clearPendingAccept(context)
    } else {
      editor.remove(ACTIVE_KEY_PREFIX + callSessionId)
    }
    for ((key, value) in prefs.all) {
      if (!key.startsWith(ACTIVE_KEY_PREFIX)) continue
      val ts = value as? Long ?: continue
      if (now - ts > ACTIVE_STALE_MS) editor.remove(key)
    }
    editor.apply()
  }

  @Synchronized
  @JvmStatic
  fun isActive(context: Context, callSessionId: String): Boolean {
    if (callSessionId.isEmpty()) return false
    return statePrefs(context).contains(ACTIVE_KEY_PREFIX + callSessionId)
  }

  @Synchronized
  @JvmStatic
  fun markDeclined(context: Context, callSessionId: String) {
    if (callSessionId.isEmpty()) return
    val now = System.currentTimeMillis()
    val editor = statePrefs(context).edit()
    editor.putLong(DECLINED_KEY_PREFIX + callSessionId, now)
    // Only declined markers expire; an active marker is cleared explicitly when
    // the call ends, because a long call must stay guarded for its whole life.
    for ((key, value) in statePrefs(context).all) {
      if (!key.startsWith(DECLINED_KEY_PREFIX)) continue
      val ts = value as? Long ?: continue
      if (now - ts > DECLINED_WINDOW_MS) editor.remove(key)
    }
    editor.apply()
  }

  @Synchronized
  @JvmStatic
  fun isDeclined(context: Context, callSessionId: String): Boolean {
    if (callSessionId.isEmpty()) return false
    val ts = statePrefs(context).getLong(DECLINED_KEY_PREFIX + callSessionId, 0L)
    if (ts == 0L) return false
    val elapsed = System.currentTimeMillis() - ts
    return elapsed in 0 until DECLINED_WINDOW_MS
  }
}
`;

const CALL_NOTIFICATION_SERVICE_KT = `package __APP_PACKAGE__

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.RemoteMessage
import com.reactnativefullscreennotificationincomingcall.Constants
import com.reactnativefullscreennotificationincomingcall.IncomingCallService
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONObject

/**
 * Intercepts incoming-call pushes before Firebase renders them, so a call can
 * ring with a full-screen intent — screen on, over the lock screen, WhatsApp
 * style — even when the app has been killed and there is no JS to run.
 *
 * Why this class exists at all: a push carrying a \`notification\` payload is
 * rendered by the FCM SDK itself and onMessageReceived is never called while
 * the app is dead, which is why a killed app used to show a flat line of text.
 * Call pushes are therefore sent data-only (see web/lib/push/web-push.ts) and
 * this service turns them into the real ringing UI.
 *
 * It is the ONLY MESSAGING_EVENT service in the merged manifest: the config
 * plugin removes Expo's own service outright (tools:node="remove") because
 * relying on intent-filter priority to outrank it proved untrustworthy on OEM
 * resolvers — a killed-app push on XOS never reached this class while both
 * were registered. Everything that is not a call is handed straight back to
 * Expo via super, so ordinary notifications keep their existing behaviour.
 *
 * DELIBERATE CONSTRAINTS — a previous attempt at this ANR'd the app badly
 * enough to be reverted, so this implementation stays inside a very small box:
 *   • never touch the React context or ReactInstanceManager. Reaching for those
 *     from here can kick off a full JS bundle load on a background thread,
 *     which is the most likely cause of the original hang.
 *   • no network and no disk beyond one SharedPreferences read/write.
 *   • every path is wrapped so a failure degrades to Expo's normal handling
 *     rather than swallowing the notification.
 */
class CallNotificationService : ExpoFirebaseMessagingService() {
  companion object {
    private const val TAG = "CallNotificationService"
    // Keep in step with NOTIFICATION_TIMEOUT in
    // app/lib/full-screen-call-notification.ts.
    private const val RING_TIMEOUT_MS = 45000
    private const val CHANNEL_ID = "incoming_calls_fs"
    private const val CHANNEL_NAME = "Incoming Calls"
    // Separate from CHANNEL_ID: that one belongs to IncomingCallService and is
    // created with its own settings, which we must not fight over.
    private const val FALLBACK_CHANNEL_ID = "incoming_calls_fallback"

    // Replaces FALLBACK_CHANNEL_ID. A channel's sound, importance and vibration
    // are frozen the moment it is first created, and that one shipped with no
    // sound at all — so every call that fell back to it rang with the stock
    // notification blip for about three seconds and read as "just another
    // notification". Fixing it needs a NEW id, not an edit; the old channel is
    // deleted on sight so nobody is left with two "Incoming Calls" rows in
    // system settings.
    private const val RING_CHANNEL_ID = "incoming_calls_ring"

    const val ACTION_DECLINE = "__APP_PACKAGE__.CALL_DECLINE"
    const val EXTRA_CALL_ID = "questioncall.callId"
    const val EXTRA_DECLINE_TOKEN = "questioncall.declineToken"
    const val EXTRA_DECLINE_URL = "questioncall.declineUrl"

    /**
     * Stable per-call notification id. Shared with CallActionReceiver (clears it
     * on Decline) and CallForegroundServiceModule (clears it once JS has the
     * call on screen), so all three agree on which notification is which.
     */
    @JvmStatic
    fun notificationId(callId: String): Int = callId.hashCode()
  }

  private data class IncomingCall(
    val id: String,
    val callerName: String,
    val isVideo: Boolean,
    /**
     * Single-purpose, server-minted, short-lived proof that the holder is this
     * call's callee, so Decline can reach the API from a process that has no
     * credentials and no way to read the ones JS holds. Scoped to one call id
     * and good for nothing else. Null on a push from an older server.
     */
    val declineToken: String?,
    /** Absolute endpoint the token is good for, supplied by the same push. */
    val declineUrl: String?,
  )

  /**
   * Firebase draws a push that carries a "notification" payload itself, and
   * when the app is backgrounded or killed it does so WITHOUT ever calling
   * onMessageReceived. The server's ring-fallback tier
   * (web/app/api/calls/create/route.ts) is deliberately one of those, because
   * on OEMs that refuse to start our process for a data-only message it is the
   * only thing that arrives at all.
   *
   * Left to Firebase it draws a flat line of text: no Accept, no Decline, and
   * whatever sound the channel happens to carry. handleIntent is the one hook
   * that runs BEFORE Firebase decides to draw, so claim call payloads here and
   * put them through the same path a data-only push takes. Anything that is not
   * a call goes straight back to Firebase, untouched.
   *
   * This is also what stops the two tiers stacking: a fallback push for a call
   * the primary already surfaced now reaches CallDispatchStore.claim() and is
   * dropped, instead of landing as a second, worse-looking entry next to a ring
   * that is already going.
   */
  override fun handleIntent(intent: Intent) {
    val call = try {
      intent.extras?.let { parseCall(RemoteMessage(it)) }
    } catch (err: Exception) {
      Log.w(TAG, "handleIntent: could not inspect payload; deferring to Firebase", err)
      null
    }

    if (call == null) {
      super.handleIntent(intent)
      return
    }

    Log.d(TAG, "handleIntent intercepted call " + call.id)
    val surfaced = try {
      dispatchCall(call)
    } catch (err: Exception) {
      Log.e(TAG, "handleIntent dispatch failed", err)
      false
    }

    // Interception is only ever an UPGRADE. If we could not put anything in
    // front of the user, hand the message back so Firebase draws its plain
    // version — which is what this tier did before, and is still far better
    // than a call that arrives as nothing at all.
    if (!surfaced) {
      Log.w(TAG, "Nothing surfaced for call " + call.id + "; deferring to Firebase")
      super.handleIntent(intent)
    }
  }

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    // Deliberately noisy: this single line is how you tell "the service never
    // ran" (old binary, or another service won the MESSAGING_EVENT filter)
    // apart from "the service ran and something inside it failed".
    //   adb logcat -s CallNotificationService
    Log.d(TAG, "onMessageReceived keys=" + remoteMessage.data.keys)

    val call = try {
      parseCall(remoteMessage)
    } catch (err: Exception) {
      Log.w(TAG, "Failed to parse push payload; treating as a normal message", err)
      null
    }

    // Not a call — Expo's delegate handles it exactly as before.
    if (call == null) {
      super.onMessageReceived(remoteMessage)
      return
    }

    dispatchCall(call)
  }

  /**
   * Surface one incoming call, whichever transport carried it.
   *
   * Order matters. The full-screen ringing service is tried FIRST because it is
   * the best surface by a wide margin: screen on, over the lock screen, looping
   * ringtone. But it is a FOREGROUND SERVICE, and starting one from the
   * background is the most restricted thing an app can do on Android 12+ and on
   * OEM builds generally. When that start is refused we no longer settle for a
   * line of text — posting a notification needs no background-start allowance
   * at all, so a CallStyle notification still puts the caller's name, Accept
   * and Decline in front of the user.
   *
   * Returns false only when the call reached the user through NOTHING — not
   * even the notification. handleIntent uses that to fall back to Firebase's
   * own rendering rather than leave a call completely silent. A call that was
   * deliberately suppressed as a duplicate counts as handled, not as a failure.
   */
  private fun dispatchCall(call: IncomingCall): Boolean {
    // Guards that must run BEFORE the claim, because both mean "handled" rather
    // than "first to arrive" — claiming here would burn the id for a transport
    // that legitimately needs it later.
    //
    // Already inside this call: the JS funnel (lib/call-dispatch.ts) has always
    // refused to resurface one, but its set lives in JS memory and this service
    // often runs with no JS at all. Without the mirror in CallDispatchStore a
    // ring-fallback push that lost the race with an answer rings on top of the
    // live call — reported from a real session where both sides were connected
    // and the callee's phone started ringing for the call it was already in.
    try {
      if (CallDispatchStore.isActive(applicationContext, call.id)) {
        Log.d(TAG, "Call " + call.id + " is already active on this device; staying quiet")
        return true
      }
      // Just declined here. The reject POST may still be in flight, or may have
      // failed outright, so the session can legitimately still be RINGING when
      // the fallback tier re-sends. Ringing again would undo the user's answer.
      if (CallDispatchStore.isDeclined(applicationContext, call.id)) {
        Log.d(TAG, "Call " + call.id + " was declined on this device; staying quiet")
        return true
      }
    } catch (err: Exception) {
      // A broken state store must never mute a call — fall through and ring.
      Log.w(TAG, "Call state store failed; continuing", err)
    }

    val claimed = try {
      CallDispatchStore.claim(applicationContext, call.id)
    } catch (err: Exception) {
      // Never drop a call because the dedupe store misbehaved. A rare double
      // ring is a far better failure than a silently missed call.
      Log.w(TAG, "Dedupe store failed; ringing anyway", err)
      true
    }
    if (!claimed) {
      Log.d(TAG, "Call " + call.id + " already surfaced elsewhere; staying quiet")
      return true
    }

    try {
      showIncomingCall(call)
      return true
    } catch (err: Exception) {
      // Most likely a refused background foreground-service start.
      //
      // NOT super.onMessageReceived(): Expo renders from the top-level
      // data title/message keys, which a data-only call push does not carry, so
      // delegating here produces nothing at all and the call vanishes silently.
      Log.w(TAG, "Full-screen ring unavailable; posting CallStyle notification", err)
      try {
        showCallStyleNotification(call)
        return true
      } catch (fallbackErr: Exception) {
        Log.e(TAG, "CallStyle notification failed too", fallbackErr)
        try {
          // Release the claim so the Pusher path — or the server's ring-fallback
          // tier a few seconds later — can still surface this call.
          CallDispatchStore.forget(applicationContext, call.id)
        } catch (_: Exception) {
          // Best effort.
        }
        return false
      }
    }
  }

  /**
   * Expo's push service nests the JS \`data\` object as a JSON string under the
   * \`body\` key of the FCM data map (see expo-notifications' NotificationData).
   * Raw FCM sends would put the fields at the top level, so read both.
   */
  private fun parseCall(remoteMessage: RemoteMessage): IncomingCall? {
    val data = remoteMessage.data
    val body = data["body"]?.let {
      try {
        JSONObject(it)
      } catch (_: Exception) {
        null
      }
    }

    val id = body?.optString("callSessionId")?.takeIf { it.isNotEmpty() }
      ?: data["callSessionId"]?.takeIf { it.isNotEmpty() }
      ?: return null

    val callerName = body?.optString("callerName")?.takeIf { it.isNotEmpty() }
      ?: data["callerName"]?.takeIf { it.isNotEmpty() }
      ?: "Incoming call"

    val mode = body?.optString("mode")?.takeIf { it.isNotEmpty() } ?: data["mode"]

    val declineToken = body?.optString("declineToken")?.takeIf { it.isNotEmpty() }
      ?: data["declineToken"]?.takeIf { it.isNotEmpty() }

    val declineUrl = body?.optString("declineUrl")?.takeIf { it.isNotEmpty() }
      ?: data["declineUrl"]?.takeIf { it.isNotEmpty() }

    return IncomingCall(id, callerName, mode == "VIDEO", declineToken, declineUrl)
  }

  /**
   * Mirrors the extras that FullScreenNotificationIncomingCallModule.displayNotification
   * sets from JS, so the notification looks identical whichever path raised it.
   */
  private fun showIncomingCall(call: IncomingCall) {
    val intent = Intent(applicationContext, IncomingCallService::class.java).apply {
      action = Constants.ACTION_SHOW_INCOMING_CALL
      putExtra("uuid", call.id)
      putExtra("name", call.callerName)
      putExtra("avatar", null as String?)
      putExtra(
        "info",
        if (call.isVideo) "Incoming video call..." else "Incoming voice call...",
      )
      putExtra("channelId", CHANNEL_ID)
      putExtra("channelName", CHANNEL_NAME)
      putExtra("timeout", RING_TIMEOUT_MS)
      putExtra("icon", "ic_launcher")
      putExtra("answerText", "Accept")
      putExtra("declineText", "Decline")
      putExtra("notificationColor", "notification_icon_color")
      putExtra("notificationSound", "incoming_ringtone")
      putExtra("isVideo", call.isVideo)
    }

    // startForegroundService, not startService: from a killed app the plain
    // variant throws IllegalStateException. A high-priority FCM message grants
    // a short background-start allowance, and IncomingCallService calls
    // startForeground immediately, so this stays inside the 5s contract.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      applicationContext.startForegroundService(intent)
    } else {
      applicationContext.startService(intent)
    }
  }

  /**
   * The surface an incoming call gets when the full-screen ringing service
   * cannot be started.
   *
   * This used to be a bare notification — title, text, tap to answer — and on
   * any device that refuses a background foreground-service start (which is
   * most of them, once the app has been killed) it was ALL a call ever got.
   * CallStyle is the fix: the same boxed caller row with Answer and Decline
   * that the ringing service draws, except NotificationManager.notify() needs
   * no background-start allowance, so it cannot be refused the way the service
   * can.
   *
   * Two things keep it in call form instead of degrading to an ordinary
   * notification: the full-screen intent — Android requires a CallStyle
   * notification to have one or to belong to a foreground service, and we have
   * no service here, which is the entire reason this path exists — and the
   * dedicated ring channel carrying the real ringtone. If the Android 14
   * USE_FULL_SCREEN_INTENT grant is missing the system quietly drops it to a
   * heads-up banner, which still carries both buttons and still rings.
   */
  private fun showCallStyleNotification(call: IncomingCall) {
    val manager =
      applicationContext.getSystemService(NotificationManager::class.java) ?: return

    ensureRingChannel(manager)

    // Tapping the body and pressing Answer both land on the call screen, which
    // shows the in-app incoming overlay — the user still presses Accept there.
    // That matters because a full-screen intent fires on its own on a locked
    // phone: if this deep link answered by itself it would pick up calls
    // nobody agreed to take.
    val answer = buildAnswerIntent(call)
    val decline = buildDeclineIntent(call)
    // Deliberately not the answer intent: a full-screen intent fires BY ITSELF
    // on a locked or idle phone, and the body is tappable by accident. Neither
    // may pick up a call. Only the Answer button carries answered=1.
    val show = buildShowCallIntent(call)

    val caller = Person.Builder()
      .setName(call.callerName)
      .setImportant(true)
      .build()

    val notification = NotificationCompat.Builder(applicationContext, RING_CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setContentTitle(call.callerName)
      .setContentText(
        if (call.isVideo) "Incoming video call" else "Incoming voice call",
      )
      .setStyle(
        NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer),
      )
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      // Colorizing is normally reserved for foreground-service notifications;
      // CallStyle is the exception, and it is what gives the filled, full-width
      // caller row rather than a tinted icon on grey. Ignored where the
      // platform declines it.
      .setColorized(true)
      .setColor(
        ContextCompat.getColor(applicationContext, R.color.notification_icon_color),
      )
      // Ongoing so a ringing call cannot be swiped away by accident. The two
      // buttons, the timeout below and CallActionReceiver are the ways out.
      .setOngoing(true)
      .setAutoCancel(false)
      // Same 45s window the ringing service uses, so an unanswered call clears
      // itself rather than sitting in the tray for ever on a dead process.
      .setTimeoutAfter(RING_TIMEOUT_MS.toLong())
      .setContentIntent(show)
      .setFullScreenIntent(show, true)
      .build()

    manager.notify(notificationId(call.id), notification)
  }

  /**
   * Deep link into the call screen — the same one the patched library uses for
   * a cold-start accept, so both routes land in exactly the same place.
   */
  private fun buildAnswerIntent(call: IncomingCall): PendingIntent {
    val mode = if (call.isVideo) "VIDEO" else "AUDIO"
    val deepLink = Intent(
      Intent.ACTION_VIEW,
      // answered=1 says the user pressed Accept, as opposed to merely tapping
      // their way into the call screen. Without it the app could only open the
      // call UI and then re-discover the state from the server — three network
      // round trips deep into a cold start — which is why answering used to
      // take the best part of ten seconds and frequently timed out into
      // "Cancelled". mode rides along because the deep link was the one accept
      // path with no access to the cached Pusher payload, so every cold-start
      // answer to a video call opened as audio.
      Uri.parse("questioncall://call/" + call.id + "?answered=1&mode=" + mode),
    ).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      // Lets MainActivity show over the keyguard instead of landing behind the
      // lock screen — see IncomingCallActivity and the MainActivity patch.
      putExtra("questioncall.showOverKeyguard", true)
      putExtra("questioncall.answeredCallId", call.id)
      putExtra("questioncall.answeredMode", mode)
    }
    return PendingIntent.getActivity(
      applicationContext,
      notificationId(call.id),
      deepLink,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /**
   * Open the call screen without answering.
   *
   * Backs the notification body and the full-screen intent. The full-screen
   * intent in particular is fired by the system on its own when the phone is
   * locked, so anything it launches must stop at the in-app incoming overlay
   * and wait for a real press.
   */
  private fun buildShowCallIntent(call: IncomingCall): PendingIntent {
    val mode = if (call.isVideo) "VIDEO" else "AUDIO"
    val deepLink = Intent(
      Intent.ACTION_VIEW,
      Uri.parse("questioncall://call/" + call.id + "?mode=" + mode),
    ).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      putExtra("questioncall.showOverKeyguard", true)
    }
    return PendingIntent.getActivity(
      applicationContext,
      // Its own request code: FLAG_UPDATE_CURRENT would otherwise let this and
      // the answer intent overwrite each other, and whichever lost would start
      // answering (or stop answering) calls.
      notificationId(call.id) xor 0x5303,
      deepLink,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun buildDeclineIntent(call: IncomingCall): PendingIntent {
    val intent = Intent(applicationContext, CallActionReceiver::class.java).apply {
      action = ACTION_DECLINE
      setPackage(applicationContext.packageName)
      putExtra(EXTRA_CALL_ID, call.id)
      putExtra(EXTRA_DECLINE_TOKEN, call.declineToken)
      putExtra(EXTRA_DECLINE_URL, call.declineUrl)
    }
    return PendingIntent.getBroadcast(
      applicationContext,
      // Deliberately a different request code from the answer intent, so
      // FLAG_UPDATE_CURRENT cannot have the two overwrite each other.
      notificationId(call.id) xor 0x5EC1,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun ensureRingChannel(manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    // The soundless channel this path used to post on. Deleting it keeps the
    // app's notification settings honest for anyone upgrading.
    try {
      manager.deleteNotificationChannel(FALLBACK_CHANNEL_ID)
    } catch (_: Exception) {
      // Never had one, or the platform refused. Neither matters.
    }

    if (manager.getNotificationChannel(RING_CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      RING_CHANNEL_ID,
      "Incoming Calls",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "Rings when someone calls you."
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 1000, 800, 1000, 800, 1000, 800, 1000)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      setShowBadge(false)
      // USAGE_NOTIFICATION_RINGTONE puts this on the ring stream rather than the
      // notification one, so it is as loud as a phone call should be. The asset
      // is the same ringtone IncomingCallService loops.
      setSound(
        Uri.parse(
          "android.resource://" + applicationContext.packageName + "/raw/incoming_ringtone",
        ),
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      // Silently ignored without notification-policy access, which this app
      // does not ask for. Worth setting for anyone who has granted it.
      try {
        setBypassDnd(true)
      } catch (_: Exception) {
        // Not ours to have.
      }
    }
    manager.createNotificationChannel(channel)
  }
}
`;

const CALL_ACTION_RECEIVER_KT = `package __APP_PACKAGE__

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.reactnativefullscreennotificationincomingcall.Constants
import com.reactnativefullscreennotificationincomingcall.FullScreenNotificationIncomingCallModule
import com.reactnativefullscreennotificationincomingcall.IncomingCallService
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Decline, pressed on the CallStyle notification CallNotificationService posts
 * when the full-screen ringing service cannot be started.
 *
 * Still no React context and no bundle load: this runs on a cold process more
 * often than not, and reaching for the JS runtime from here is what ANR'd an
 * earlier attempt at this pipeline.
 *
 * It DOES make one network call, and that is the point. Declining used to
 * silence this device only — the caller kept ringing until the server's RINGING
 * timeout, and the ring-fallback tier would re-push the same call a few seconds
 * later because the session was still, as far as the server knew, unanswered.
 * The blocker was credentials: the real /reject wants a bearer token that only
 * JS can read. So the push now carries a server-minted token good for exactly
 * one thing — rejecting this one call — and the POST below spends it. No user
 * credentials ever enter this process.
 *
 * Both paths fire on purpose. If JS happens to be alive it runs the real
 * reject with full auth and tears down its own call state; the raw POST then
 * lands on an already-REJECTED session and is refused. Rejecting twice is
 * harmless and idempotent, whereas guessing wrong about whether JS is listening
 * is how a decline silently goes nowhere.
 */
class CallActionReceiver : BroadcastReceiver() {
  companion object {
    private const val TAG = "CallActionReceiver"
    // goAsync() buys roughly 10s before the system reclaims the receiver, so
    // stay well inside it: a decline that hangs is worse than one that fails.
    private const val CONNECT_TIMEOUT_MS = 7000
    private const val READ_TIMEOUT_MS = 7000
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != CallNotificationService.ACTION_DECLINE) return
    val callId = intent.getStringExtra(CallNotificationService.EXTRA_CALL_ID)
    if (callId.isNullOrEmpty()) return

    val appContext = context.applicationContext

    // Silence this device first, before anything that can block. Whatever the
    // network does next, the user pressed Decline and the ringing stops now.
    try {
      appContext
        .getSystemService(NotificationManager::class.java)
        ?.cancel(CallNotificationService.notificationId(callId))
    } catch (err: Exception) {
      Log.w(TAG, "Could not clear the call notification", err)
    }

    // If the ringing service did come up after all — a late start racing this
    // press — stop it so the ringtone dies with the notification.
    try {
      appContext.stopService(Intent(appContext, IncomingCallService::class.java))
    } catch (_: Exception) {
      // Not running; nothing to stop.
    }

    // Remember it, so a ring-fallback push already in flight cannot ring this
    // same call back at us a few seconds from now. Needed even when the POST
    // below succeeds: the push may already have left the server.
    try {
      CallDispatchStore.markDeclined(appContext, callId)
    } catch (err: Exception) {
      Log.w(TAG, "Could not record the decline", err)
    }

    notifyJs(callId)

    val token = intent.getStringExtra(CallNotificationService.EXTRA_DECLINE_TOKEN)
    val url = intent.getStringExtra(CallNotificationService.EXTRA_DECLINE_URL)
    if (token.isNullOrEmpty() || url.isNullOrEmpty()) {
      // A push minted before the server started sending the token. Falls back
      // to the old behaviour: silent here, caller rings to the timeout.
      Log.w(TAG, "No decline token on this push; leaving the session to time out")
      return
    }

    val pending = goAsync()
    Thread {
      try {
        postDecline(url, callId, token)
      } catch (err: Exception) {
        Log.w(TAG, "Decline POST failed; leaving the session to time out", err)
      } finally {
        pending.finish()
      }
    }.start()
  }

  /** Reaches the app only when it is alive; a no-op otherwise. */
  private fun notifyJs(callId: String) {
    try {
      val params = Arguments.createMap()
      params.putString("callUUID", callId)
      params.putString("endAction", Constants.ACTION_REJECTED_CALL)
      FullScreenNotificationIncomingCallModule.sendEventToJs(
        Constants.RNNotificationEndCallAction,
        params,
      )
    } catch (_: Throwable) {
      // No JS running — the POST below is the one that counts.
    }
  }

  private fun postDecline(rawUrl: String, callId: String, token: String) {
    val url = URL(rawUrl)

    // The endpoint rides in the push rather than being baked into the build, so
    // it always matches the server that actually sent the call and there is no
    // EXPO_PUBLIC_* constant to drift out of sync. The body is only a call id
    // and a single-purpose token, but require https anyway — there is no reason
    // to let a malformed payload put even that on the wire in the clear.
    if (!"https".equals(url.protocol, ignoreCase = true)) {
      Log.w(TAG, "Refusing a non-https decline URL")
      return
    }

    val body = JSONObject()
    body.put("callSessionId", callId)
    body.put("token", token)
    val payload = body.toString().toByteArray(Charsets.UTF_8)

    val conn = url.openConnection() as HttpURLConnection
    try {
      conn.requestMethod = "POST"
      conn.connectTimeout = CONNECT_TIMEOUT_MS
      conn.readTimeout = READ_TIMEOUT_MS
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setFixedLengthStreamingMode(payload.size)
      conn.outputStream.use { it.write(payload) }
      // Reading the code is what actually flushes the request.
      Log.d(TAG, "Decline POST for " + callId + " -> HTTP " + conn.responseCode)
    } finally {
      conn.disconnect()
    }
  }
}
`;

const CALL_FOREGROUND_SERVICE_MODULE_KT = `package __APP_PACKAGE__

import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.WindowManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class CallForegroundServiceModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CallForegroundService"

  private var userPresentReceiver: BroadcastReceiver? = null

  @ReactMethod
  fun start(title: String?, body: String?) {
    val intent = Intent(reactContext, CallForegroundService::class.java).apply {
      action = CallForegroundService.ACTION_START
      putExtra(CallForegroundService.EXTRA_TITLE, title ?: "Call in progress")
      putExtra(
        CallForegroundService.EXTRA_BODY,
        body ?: "Tap to return to QuestionCall.",
      )
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      reactContext.startForegroundService(intent)
    } else {
      reactContext.startService(intent)
    }
  }

  @ReactMethod
  fun stop() {
    val intent = Intent(reactContext, CallForegroundService::class.java)
    try {
      reactContext.stopService(intent)
    } catch (_: Exception) {
      // Service already gone — nothing to stop.
    }

    // Belt and braces: if the service died without running onDestroy (process
    // kill, "don't keep activities", an earlier build that leaked one), its
    // ongoing notification can outlive it and the user cannot swipe an
    // ongoing notification away. Cancelling by id clears those strays too.
    try {
      val manager =
        reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.cancel(CallForegroundService.NOTIFICATION_ID)
    } catch (_: Exception) {
      // Best effort only.
    }
  }

  /**
   * JS half of CallDispatchStore.claim — see that class for the protocol.
   *
   * Resolves true when the caller is the first to surface this call and should
   * ring, false when the native FCM service (or an earlier JS delivery) already
   * did. Async rather than synchronous on purpose: a blocking bridge call is
   * unnecessary here and behaves badly under the new architecture.
   */
  @ReactMethod
  fun claimCallDispatch(callSessionId: String?, promise: Promise) {
    try {
      promise.resolve(CallDispatchStore.claim(reactContext, callSessionId ?: ""))
    } catch (_: Exception) {
      // Never mute a call because the store failed — ring and risk a duplicate.
      promise.resolve(true)
    }
  }

  /**
   * Hand JS the accept the user pressed before JS existed.
   *
   * Answering an incoming call is delivered two ways, and on a cold start both
   * of them are lost. The ringing library emits RNNotificationAnswerAction over
   * the React bridge, which nothing is listening to yet because the tap is what
   * created the process; and the notification's PendingIntent opens
   * questioncall://call/<id>, which only ever meant "show me the call screen",
   * so the app came up, worked out from the server that the call was still
   * RINGING, and only then accepted it. Three round trips into a cold start,
   * with a splash screen in front of them, and any hiccup along the way left
   * the user staring at their chat list while the call timed out as
   * "Cancelled".
   *
   * MainActivity now writes the decision down the moment it is launched, so it
   * is waiting here by the time the bundle finishes loading. Drained exactly
   * once (see CallDispatchStore.consumePendingAccept); resolves null when there
   * is nothing pending, which is the normal case.
   */
  @ReactMethod
  fun consumePendingAccept(promise: Promise) {
    try {
      val pending = CallDispatchStore.consumePendingAccept(reactContext)
      if (pending == null) {
        promise.resolve(null)
        return
      }
      val map = Arguments.createMap()
      map.putString("callSessionId", pending.first)
      if (pending.second.isNotEmpty()) map.putString("mode", pending.second)
      promise.resolve(map)
    } catch (_: Exception) {
      // Nothing to hand over is the safe answer: the deep-link route still
      // opens the call screen, just without the head start.
      promise.resolve(null)
    }
  }

  /**
   * Clear the CallStyle notification CallNotificationService posts when the
   * full-screen ringing service cannot start.
   *
   * It is posted natively, outside expo-notifications, so the JS tray sweep in
   * call-ui-store.ts cannot see it. Without this it would sit there ongoing —
   * deliberately un-swipeable — while the call is already on screen.
   */
  @ReactMethod
  fun dismissIncomingCallNotification(callSessionId: String?) {
    val id = callSessionId ?: return
    if (id.isEmpty()) return
    try {
      val manager =
        reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.cancel(CallNotificationService.notificationId(id))
    } catch (_: Exception) {
      // Best effort only.
    }
  }

  /**
   * Mirror lib/active-call.ts into the native store.
   *
   * That set is the guard stopping a re-delivered call from surfacing on top of
   * the live one, but it lives in JS memory, and CallNotificationService
   * frequently runs with no JS at all — so the native path had no guard and a
   * late ring-fallback push could ring during an active call. Mirroring costs
   * one SharedPreferences write per call transition.
   */
  @ReactMethod
  fun setCallActive(callSessionId: String?, active: Boolean) {
    val id = callSessionId ?: return
    if (id.isEmpty()) return
    try {
      CallDispatchStore.setActive(reactContext, id, active)
    } catch (_: Exception) {
      // Best effort — the JS-side guard still covers the app-alive case.
    }
  }

  @ReactMethod
  fun forgetCallDispatch(callSessionId: String?) {
    try {
      CallDispatchStore.forget(reactContext, callSessionId ?: "")
    } catch (_: Exception) {
      // Best effort only.
    }
  }

  /**
   * Android 14 stopped granting USE_FULL_SCREEN_INTENT at install time to most
   * apps. Declaring it is no longer enough: without the grant the system
   * quietly downgrades our ringing notification to an ordinary heads-up
   * banner, so the screen never turns on and the call looks like a message.
   * There is no error and nothing in logcat — it just silently does less.
   */
  @ReactMethod
  fun canUseFullScreenIntent(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        promise.resolve(true)
        return
      }
      val manager =
        reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      promise.resolve(manager.canUseFullScreenIntent())
    } catch (_: Exception) {
      // Assume granted rather than nagging the user over a failed check.
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun openFullScreenIntentSettings() {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
      val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
        data = Uri.parse("package:" + reactContext.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
    } catch (_: Exception) {
      // Best effort — the screen may not exist on some OEM builds.
    }
  }

  /**
   * Let MainActivity render over the lock screen, and wake the display when it
   * comes to the front.
   *
   * Answering a call on a locked phone used to connect the call but show the
   * lock screen: the library's ringing activity carries these flags, but on
   * accept it finishes itself and launches MainActivity, which does not — so
   * Android put it behind the keyguard. Audio was flowing the whole time; the
   * UI only appeared after an unlock.
   *
   * Armed per-call and cleared the moment the call ends, never left on: a
   * permanently show-when-locked MainActivity would expose the entire app
   * (chats, wallet, admin) above the lock screen. MainActivity has a matching
   * intent-driven path for the cold-start case where no JS exists yet.
   */
  @ReactMethod
  fun setShowWhenLocked(enabled: Boolean) {
    // NOT the inherited getCurrentActivity(): RN 0.80 converted
    // ReactContextBaseJavaModule to Kotlin, where that is a deprecated
    // *function*, so there is no \`currentActivity\` synthetic property on the
    // module itself. The context's property is the documented replacement.
    val activity = reactContext.currentActivity ?: return
    activity.runOnUiThread {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          activity.setShowWhenLocked(enabled)
          activity.setTurnScreenOn(enabled)
        } else {
          @Suppress("DEPRECATION")
          val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
          if (enabled) {
            activity.window.addFlags(flags)
          } else {
            activity.window.clearFlags(flags)
          }
        }
      } catch (_: Exception) {
        // Never let a window-flag failure take down a live call.
      }
    }

    if (enabled) registerUserPresent() else unregisterUserPresent()
  }

  /**
   * Whether the keyguard is currently up. The call UI uses this to hide the
   * minimize affordance — without it the user could shrink the call to the
   * bubble and browse the whole app over the lock screen.
   */
  @ReactMethod
  fun isDeviceLocked(promise: Promise) {
    try {
      val keyguard =
        reactContext.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      promise.resolve(keyguard.isKeyguardLocked)
    } catch (_: Exception) {
      // Assume unlocked: the cost of guessing wrong here is a visible minimize
      // button, not exposed data.
      promise.resolve(false)
    }
  }

  /**
   * ACTION_USER_PRESENT fires when the user finishes unlocking. Without it a
   * call answered on the lock screen would keep its minimize button hidden for
   * the rest of the call, because nothing else tells JS the keyguard is gone.
   */
  private fun registerUserPresent() {
    if (userPresentReceiver != null) return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != Intent.ACTION_USER_PRESENT) return
        try {
          reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("QuestionCallUserPresent", null)
        } catch (_: Exception) {
          // JS went away — nothing to notify.
        }
      }
    }
    try {
      ContextCompat.registerReceiver(
        reactContext,
        receiver,
        IntentFilter(Intent.ACTION_USER_PRESENT),
        ContextCompat.RECEIVER_NOT_EXPORTED,
      )
      userPresentReceiver = receiver
    } catch (_: Exception) {
      // Best effort only.
    }
  }

  private fun unregisterUserPresent() {
    val receiver = userPresentReceiver ?: return
    userPresentReceiver = null
    try {
      reactContext.unregisterReceiver(receiver)
    } catch (_: Exception) {
      // Already gone.
    }
  }

  override fun invalidate() {
    unregisterUserPresent()
    super.invalidate()
  }
}
`;

const CALL_FOREGROUND_SERVICE_PACKAGE_KT = `package __APP_PACKAGE__

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class CallForegroundServicePackage : ReactPackage {
  override fun createNativeModules(
    reactContext: ReactApplicationContext,
  ): List<NativeModule> = listOf(CallForegroundServiceModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = emptyList()
}
`;

function ensurePermission(manifest, name) {
  if (!manifest["uses-permission"]) {
    manifest["uses-permission"] = [];
  }

  const exists = manifest["uses-permission"].some(
    (permission) => permission.$?.["android:name"] === name,
  );

  if (!exists) {
    manifest["uses-permission"].push({
      $: {
        "android:name": name,
      },
    });
  }
}

function findService(application, name) {
  return application.service.find((service) => service.$?.["android:name"] === name);
}

/**
 * Add the service, or bring an existing declaration up to date.
 *
 * "Add only if missing" is not enough: prebuild merges into whatever
 * AndroidManifest.xml is already on disk, so a service declared by an earlier
 * prebuild keeps its old attributes forever and plugin edits appear to do
 * nothing locally — while a clean CI build silently gets different ones. Always
 * writing the attributes keeps the two in step.
 */
function upsertService(application, name, attributes) {
  const existing = findService(application, name);
  if (existing) {
    existing.$ = { ...existing.$, ...attributes };
    return;
  }
  application.service.push({ $: { ...attributes } });
}

function writeFileIfChanged(filePath, contents) {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === contents) {
    return;
  }

  fs.writeFileSync(filePath, contents);
}

function patchMainApplication(mainApplicationPath) {
  if (!fs.existsSync(mainApplicationPath)) return;

  let contents = fs.readFileSync(mainApplicationPath, "utf8");
  let changed = false;

  if (!contents.includes("add(CallForegroundServicePackage())")) {
    contents = contents.replace(
      "PackageList(this).packages.apply {",
      "PackageList(this).packages.apply {\n              add(CallForegroundServicePackage())",
    );
    changed = true;
  }

  // LiveKit's Android SDK needs its JavaAudioDeviceModule initialised from
  // Application.onCreate, before any other React Native init. Without it, the
  // first AudioSession.configureAudio() of a call throws IllegalStateException
  // ("Audio device module is not initialized!") on the native module thread —
  // which JS cannot catch, so it becomes a fatal host exception and the app
  // dies the moment a call starts, on every Android version. registerGlobals()
  // in lib/livekit-setup.ts is the JS half of setup and does NOT cover this.
  if (!contents.includes("LiveKitReactNative.setup(")) {
    contents = contents.replace(
      "import expo.modules.ApplicationLifecycleDispatcher",
      "import com.livekit.reactnative.LiveKitReactNative\n\nimport expo.modules.ApplicationLifecycleDispatcher",
    );
    contents = contents.replace(
      "  override fun onCreate() {\n    super.onCreate()",
      "  override fun onCreate() {\n    LiveKitReactNative.setup(this)\n    super.onCreate()",
    );
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(mainApplicationPath, contents);
  }
}

/**
 * Teach MainActivity to show over the lock screen when it was launched to
 * answer a call.
 *
 * The JS-callable setShowWhenLocked() covers the case where the app is already
 * running, but on a cold start (app killed, user answers from the lock screen)
 * the activity is created and drawn long before any JS exists to call it — the
 * user would see the lock screen while the call was already connected. So the
 * decision is also made natively, straight from the launch intent: the patched
 * IncomingCallActivity tags its accept intent with EXTRA_SHOW_OVER_KEYGUARD,
 * and the questioncall://call/ deep link is recognised as well for the paths
 * that go through it. JS clears the flag when the call ends.
 */
const PENDING_ACCEPT_FN = `
  /**
   * Persist "the user pressed Accept" the instant this activity is launched.
   *
   * The notification's Accept button is a PendingIntent straight to us, and the
   * ringing library emits its answer over the React bridge. Both are useless on
   * a cold start: the process is being created by the tap itself, so no JS is
   * listening yet and the answer is dropped on the floor. The user then waits
   * through a splash screen and lands on their chat list while the call they
   * just accepted quietly times out as "Cancelled".
   *
   * Writing the decision to disk here, before super.onCreate and before the
   * bundle loads, means JS can pick it up whenever it finishes booting. See
   * CallDispatchStore.consumePendingAccept and lib/full-screen-call-notification.ts.
   */
  private fun recordPendingAccept(intent: Intent?) {
    if (intent == null) return
    try {
      val uri = intent.data
      val fromExtras = intent.getStringExtra("questioncall.answeredCallId")
      val answeredViaUri =
        uri != null &&
          uri.toString().startsWith("questioncall://call/") &&
          uri.getQueryParameter("answered") == "1"

      val callId =
        fromExtras?.takeIf { it.isNotEmpty() }
          ?: (if (answeredViaUri) uri?.lastPathSegment else null)
      if (callId.isNullOrEmpty()) return

      val mode =
        intent.getStringExtra("questioncall.answeredMode")?.takeIf { it.isNotEmpty() }
          ?: uri?.getQueryParameter("mode")

      // Already in this call, so JS handled the accept and this record would
      // only be drained by some later cold start inside its TTL, dropping the
      // user back into a call that has since ended.
      if (CallDispatchStore.isActive(applicationContext, callId)) return

      CallDispatchStore.recordPendingAccept(applicationContext, callId, mode)
    } catch (_: Exception) {
      // A malformed intent must never stop the activity from starting; the
      // deep-link route in JS is still there as the slower fallback.
    }
  }`;

function patchMainActivity(mainActivityPath) {
  if (!fs.existsSync(mainActivityPath)) return;

  let contents = fs.readFileSync(mainActivityPath, "utf8");
  // Sentinel is the newest thing this function adds, so an android/ tree left
  // over from a prebuild that predates the pending-accept store is upgraded
  // rather than skipped as "already patched".
  if (contents.includes("recordPendingAccept")) return;

  // Carries the keyguard patch from an older prebuild: add only the missing
  // half, in place, instead of re-inserting everything.
  if (contents.includes("applyShowOverKeyguard")) {
    contents = contents.replace(
      "    applyShowOverKeyguard(intent)",
      "    applyShowOverKeyguard(intent)\n    recordPendingAccept(intent)",
    );
    contents = contents.replace(
      "  private fun applyShowOverKeyguard(intent: Intent?) {",
      `${PENDING_ACCEPT_FN}

  private fun applyShowOverKeyguard(intent: Intent?) {`,
    );
    fs.writeFileSync(mainActivityPath, contents);
    return;
  }

  contents = contents.replace(
    "import android.os.Bundle",
    `import android.content.Intent
import android.os.Bundle
import android.view.WindowManager`,
  );

  contents = contents.replace(
    "    super.onCreate(null)\n  }",
    `    // Before super.onCreate so the flags are in place for the first frame —
    // otherwise the call UI can flash behind the keyguard on a cold answer.
    applyShowOverKeyguard(intent)
    recordPendingAccept(intent)
    super.onCreate(null)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // Answering while the app is merely backgrounded re-delivers here rather
    // than through onCreate. Non-null param: Activity.onNewIntent is annotated
    // @NonNull, so a nullable override does not compile.
    setIntent(intent)
    applyShowOverKeyguard(intent)
    recordPendingAccept(intent)
  }
${PENDING_ACCEPT_FN}

  private fun applyShowOverKeyguard(intent: Intent?) {
    if (intent == null) return
    val launchedForCall =
      intent.getBooleanExtra("questioncall.showOverKeyguard", false) ||
        (intent.data?.toString()?.startsWith("questioncall://call/") == true)
    if (!launchedForCall) return

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        setShowWhenLocked(true)
        setTurnScreenOn(true)
      } else {
        @Suppress("DEPRECATION")
        window.addFlags(
          WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
        )
      }
    } catch (_: Exception) {
      // A refused window flag must never block the call from starting.
    }
  }`,
  );

  fs.writeFileSync(mainActivityPath, contents);
}

function withCallForegroundSource(config) {
  return withDangerousMod(config, [
    "android",
    (mod) => {
      const pkg = mod.android?.package;
      if (!pkg) {
        throw new Error(
          "withCallKeep: android.package is missing from app.json — the call " +
            "foreground service sources cannot be generated without it.",
        );
      }

      const packageDir = path.join(mod.modRequest.projectRoot, androidPackageDir(pkg));
      fs.mkdirSync(packageDir, { recursive: true });

      writeFileIfChanged(
        path.join(packageDir, "CallForegroundService.kt"),
        applyPackage(CALL_FOREGROUND_SERVICE_KT, pkg),
      );
      writeFileIfChanged(
        path.join(packageDir, "CallForegroundServiceModule.kt"),
        applyPackage(CALL_FOREGROUND_SERVICE_MODULE_KT, pkg),
      );
      writeFileIfChanged(
        path.join(packageDir, "CallForegroundServicePackage.kt"),
        applyPackage(CALL_FOREGROUND_SERVICE_PACKAGE_KT, pkg),
      );
      writeFileIfChanged(
        path.join(packageDir, "CallDispatchStore.kt"),
        applyPackage(CALL_DISPATCH_STORE_KT, pkg),
      );
      writeFileIfChanged(
        path.join(packageDir, "CallNotificationService.kt"),
        applyPackage(CALL_NOTIFICATION_SERVICE_KT, pkg),
      );
      writeFileIfChanged(
        path.join(packageDir, "CallActionReceiver.kt"),
        applyPackage(CALL_ACTION_RECEIVER_KT, pkg),
      );
      patchMainApplication(path.join(packageDir, "MainApplication.kt"));
      patchMainActivity(path.join(packageDir, "MainActivity.kt"));

      return mod;
    },
  ]);
}

function withCallKeepManifest(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const application = manifest.application[0];

    // Needed by the tools:node="remove" marker below.
    manifest.$ = manifest.$ || {};
    if (!manifest.$["xmlns:tools"]) {
      manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    }

    ensurePermission(manifest, "android.permission.FOREGROUND_SERVICE");
    ensurePermission(manifest, "android.permission.FOREGROUND_SERVICE_CAMERA");
    ensurePermission(manifest, "android.permission.FOREGROUND_SERVICE_MICROPHONE");
    ensurePermission(manifest, "android.permission.FOREGROUND_SERVICE_PHONE_CALL");
    // Screen-share publishing: react-native-webrtc's MediaProjectionService
    // (declared with foregroundServiceType="mediaProjection" in its own library
    // manifest) needs this app-level permission on API 34+.
    ensurePermission(manifest, "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION");
    ensurePermission(manifest, "android.permission.MANAGE_OWN_CALLS");
    ensurePermission(manifest, "android.permission.WAKE_LOCK");

    if (!application.service) {
      application.service = [];
    }

    const alreadyAdded = application.service.some(
      (service) =>
        service.$?.["android:name"] === "io.wazo.callkeep.VoiceConnectionService",
    );

    if (!alreadyAdded) {
      application.service.push({
        $: {
          "android:name": "io.wazo.callkeep.VoiceConnectionService",
          "android:label": "@string/app_name",
          "android:permission": "android.permission.BIND_TELECOM_CONNECTION_SERVICE",
          "android:exported": "true",
        },
        "intent-filter": [
          {
            action: [{ $: { "android:name": "android.telecom.ConnectionService" } }],
          },
        ],
      });
    }

    // Our FirebaseMessagingService, and — critically — the ONLY one left in the
    // merged manifest. In theory our default filter priority of 0 outranks
    // expo-notifications' service (which declares -1 to be overridable), but a
    // killed-app call push on a real device (Infinix/XOS) never reached this
    // service while it was registered alongside Expo's: service intent-filter
    // priority is not a contract OEM resolvers honour. So instead of competing
    // with Expo's service, the marker below deletes it from the merged manifest
    // entirely. CallNotificationService extends it and hands every non-call
    // message back through super.onMessageReceived, so ordinary notifications
    // render exactly as before — the same code runs, just via our subclass.
    // (firebase-messaging's own default service stays declared at -500; it is
    // unreachable while any higher-priority handler exists and is harmless.)
    //
    // Note there is deliberately NO default_notification_channel_id meta-data
    // here: that would route every notification-payload push to the calls
    // channel, not just calls.
    upsertService(application, ".CallNotificationService", {
      "android:name": ".CallNotificationService",
      "android:exported": "false",
    });
    upsertService(
      application,
      "expo.modules.notifications.service.ExpoFirebaseMessagingService",
      {
        "android:name": "expo.modules.notifications.service.ExpoFirebaseMessagingService",
        "tools:node": "remove",
      },
    );
    const messagingService = findService(application, ".CallNotificationService");
    messagingService["intent-filter"] = [
      {
        action: [{ $: { "android:name": "com.google.firebase.MESSAGING_EVENT" } }],
      },
    ];

    upsertService(application, ".CallForegroundService", {
      "android:name": ".CallForegroundService",
      "android:enabled": "true",
      "android:exported": "false",
      "android:foregroundServiceType": "phoneCall|camera|microphone",
      // "true" on purpose: the call itself lives in JS, so once the task is
      // swiped away the call is over. Leaving this "false" kept the service
      // — and its undismissable ongoing notification — alive with nothing
      // able to stop it.
      "android:stopWithTask": "true",
    });

    // Decline on the CallStyle notification. Not exported: the only thing that
    // ever sends this is our own PendingIntent.
    if (!application.receiver) {
      application.receiver = [];
    }
    const existingReceiver = application.receiver.find(
      (receiver) => receiver.$?.["android:name"] === ".CallActionReceiver",
    );
    if (existingReceiver) {
      existingReceiver.$ = {
        ...existingReceiver.$,
        "android:name": ".CallActionReceiver",
        "android:exported": "false",
      };
    } else {
      application.receiver.push({
        $: { "android:name": ".CallActionReceiver", "android:exported": "false" },
      });
    }

    return mod;
  });
}

/**
 * CallNotificationService compiles against FirebaseMessagingService/RemoteMessage.
 * expo-notifications pulls firebase-messaging in, but as an `implementation`
 * dependency it is not guaranteed to reach the app module's compile classpath,
 * so declare it explicitly. The BoM that Expo applies decides the version.
 */
function withFirebaseMessagingDep(config) {
  return withAppBuildGradle(config, (mod) => {
    const marker = "// CallNotificationService deps";
    if (!mod.modResults.contents.includes(marker)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        'implementation("com.facebook.react:react-android")',
        `implementation("com.facebook.react:react-android")
    ${marker}
    implementation("com.google.firebase:firebase-messaging")`,
      );
    }
    return mod;
  });
}

module.exports = function withCallKeep(config) {
  return withFirebaseMessagingDep(withCallForegroundSource(withCallKeepManifest(config)));
};
