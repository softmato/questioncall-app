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
}
`;

const CALL_NOTIFICATION_SERVICE_KT = `package __APP_PACKAGE__

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
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
  }

  private data class IncomingCall(
    val id: String,
    val callerName: String,
    val isVideo: Boolean,
  )

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
      return
    }

    try {
      showIncomingCall(call)
    } catch (err: Exception) {
      // Most likely a refused background foreground-service start. Fall back to
      // a plain notification we build ourselves.
      //
      // NOT super.onMessageReceived(): Expo renders from the top-level
      // data["title"]/data["message"] keys, which a data-only call push does
      // not carry, so delegating here produces nothing at all and the call
      // vanishes silently. A notification without the full-screen ring is a bad
      // outcome; no notification whatsoever is a much worse one.
      Log.w(TAG, "Full-screen call UI failed; posting fallback notification", err)
      try {
        showFallbackNotification(call)
      } catch (fallbackErr: Exception) {
        Log.e(TAG, "Fallback notification failed too; call is lost", fallbackErr)
        try {
          // Release the claim so the Pusher path can still surface this call if
          // the app happens to come back within the dedupe window.
          CallDispatchStore.forget(applicationContext, call.id)
        } catch (_: Exception) {
          // Best effort.
        }
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

    return IncomingCall(id, callerName, mode == "VIDEO")
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
   * Last-resort visible surface for an incoming call.
   *
   * Posting a notification needs no background-start allowance, so this works
   * in situations where starting IncomingCallService is refused outright. It
   * still asks for a full-screen intent — if the grant is there the system will
   * honour it and the call rings properly anyway; if not, it degrades to a
   * heads-up notification the user can still tap to answer.
   */
  private fun showFallbackNotification(call: IncomingCall) {
    val manager =
      applicationContext.getSystemService(NotificationManager::class.java) ?: return

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        FALLBACK_CHANNEL_ID,
        "Incoming Calls",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = "Incoming QuestionCall calls."
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 1000, 800, 1000)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
      manager.createNotificationChannel(channel)
    }

    // Same deep link the patched notification handlers use on a cold start, so
    // tapping this lands on the call screen, which auto-accepts for the callee.
    val deepLink = Intent(
      Intent.ACTION_VIEW,
      Uri.parse("questioncall://call/" + call.id),
    ).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val pendingIntent = PendingIntent.getActivity(
      applicationContext,
      call.id.hashCode(),
      deepLink,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val notification = NotificationCompat.Builder(applicationContext, FALLBACK_CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setContentTitle(call.callerName)
      .setContentText(
        if (call.isVideo) "Incoming video call" else "Incoming voice call",
      )
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setAutoCancel(true)
      .setContentIntent(pendingIntent)
      .setFullScreenIntent(pendingIntent, true)
      .build()

    manager.notify(call.id.hashCode(), notification)
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
function patchMainActivity(mainActivityPath) {
  if (!fs.existsSync(mainActivityPath)) return;

  let contents = fs.readFileSync(mainActivityPath, "utf8");
  if (contents.includes("applyShowOverKeyguard")) return;

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
    super.onCreate(null)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // Answering while the app is merely backgrounded re-delivers here rather
    // than through onCreate. Non-null param: Activity.onNewIntent is annotated
    // @NonNull, so a nullable override does not compile.
    setIntent(intent)
    applyShowOverKeyguard(intent)
  }

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
