package com.questioncall.app

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class CallForegroundServiceModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "CallForegroundService"

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
    reactContext.stopService(intent)
  }
}
