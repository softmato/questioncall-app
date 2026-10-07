package com.softmato.questioncall.bootsplash

import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS side of [BootSplash] — `components/branding/brand-splash.tsx`. */
class QuestionCallBootSplashModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("QuestionCallBootSplash")

    // Resolves when the splash has finished fading.
    AsyncFunction("hide") { promise: Promise ->
      BootSplash.hide { promise.resolve(null) }
    }.runOnQueue(Queues.MAIN)
  }
}
