// Tracks call sessions the user is currently engaged with (i.e. the call
// screen for that session is mounted). This is the single source of truth used
// to suppress *duplicate* incoming-call surfaces.
//
// Why this exists: a CALL_INCOMING_EVENT can be re-delivered by Pusher after a
// reconnect once the 30s dedupe window in realtime-bridge has expired (and the
// native FCM path can dispatch independently). If that happens while the user
// is already inside the call, the native CallKeep UI + full-screen notification
// pop up *on top of the live call*. Accepting it just re-runs /accept (409) and
// re-navigates to the same screen; declining fires /reject on a call that's
// already active — so the overlay feels stuck. Guarding on an active-call set
// stops the duplicate surface from ever appearing.

import { NativeModules, Platform } from "react-native";

const activeCallSessions = new Set<string>();

type CallStateNativeModule = {
  setCallActive?: (callSessionId: string, active: boolean) => void;
};

/**
 * Mirror the set into the native store so CallNotificationService can see it.
 *
 * This set alone is not enough. It lives in JS memory, and the FCM service that
 * can also raise a call runs with no JS at all — so a ring-fallback push that
 * lost the race with an answer rang ON TOP of a live call, on a device that had
 * already been connected for several seconds. The native guard reads the
 * mirrored flag out of SharedPreferences instead.
 */
function mirrorToNative(callSessionId: string, active: boolean): void {
  if (Platform.OS !== "android") return;
  const native = NativeModules.CallForegroundService as CallStateNativeModule | undefined;
  try {
    native?.setCallActive?.(callSessionId, active);
  } catch {
    // Older binary without the method — the JS guard still covers app-alive.
  }
}

export function markCallActive(callSessionId: string): void {
  if (!callSessionId) return;
  activeCallSessions.add(callSessionId);
  mirrorToNative(callSessionId, true);
}

export function clearActiveCall(callSessionId: string): void {
  if (!callSessionId) return;
  activeCallSessions.delete(callSessionId);
  mirrorToNative(callSessionId, false);
}

export function isCallActive(callSessionId: string): boolean {
  return activeCallSessions.has(callSessionId);
}

export function hasAnyActiveCall(): boolean {
  return activeCallSessions.size > 0;
}
