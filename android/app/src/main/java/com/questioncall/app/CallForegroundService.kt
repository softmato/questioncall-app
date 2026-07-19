package com.questioncall.app

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
    const val ACTION_START = "com.questioncall.app.CALL_FOREGROUND_START"
    const val ACTION_STOP = "com.questioncall.app.CALL_FOREGROUND_STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    private const val CHANNEL_ID = "questioncall_ongoing_call"
    private const val NOTIFICATION_ID = 4201
    private const val TAG = "CallForegroundService"
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
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

    return START_STICKY
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
   * From Android 14 the system cross-checks each type in the mask: `camera`
   * needs CAMERA granted, `microphone` needs RECORD_AUDIO. Claiming either
   * without the grant throws SecurityException. Both cases are routine here —
   * an audio call never asks for CAMERA, and on the caller side neither
   * permission exists yet, because tracks are only published once the callee
   * accepts. `phoneCall` is always safe: MANAGE_OWN_CALLS is install-time.
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
