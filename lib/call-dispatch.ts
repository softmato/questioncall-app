// Single funnel for "an incoming call arrived on this device".
//
// One call reaches us over two independent transports, by design:
//   1. Pusher CALL_INCOMING_EVENT (components/realtime/realtime-bridge.tsx)
//      — fastest, but only while the app is alive and connected.
//   2. The Expo/FCM push (lib/push-notifications.ts) — slower, but the only
//      transport that survives the app being backgrounded or killed.
//
// Both must be able to raise the ringing UI on their own, and neither can know
// whether the other already did. The dedupe window used to live inside
// realtime-bridge, so only the Pusher path consulted it: a single call from web
// rang once via Pusher and then *again* about a second later when the push
// landed. If the user had already accepted the first one, the second sheet
// appeared on top of the live call.
//
// Everything that can surface a call now goes through surfaceIncomingCall(),
// which owns the dedupe, the already-in-this-call guard, and the metadata
// cache. The window matches the one on the native side.

import { NativeModules, Platform } from "react-native";

import { displayIncomingCall, incomingCallMetadataMap } from "@/lib/callkeep-setup";
import { showFullScreenCallNotification } from "@/lib/full-screen-call-notification";
import { isCallActive } from "@/lib/active-call";

// Matches WINDOW_MS in CallDispatchStore.kt (see plugins/withCallKeep.js).
const CALL_DEDUPE_WINDOW_MS = 30_000;

const recentCallDispatches = new Map<string, number>();

type CallDispatchNativeModule = {
  claimCallDispatch?: (callSessionId: string) => Promise<boolean>;
  forgetCallDispatch?: (callSessionId: string) => void;
};

const nativeDispatch = NativeModules.CallForegroundService as
  | CallDispatchNativeModule
  | undefined;

export type IncomingCallSignal = {
  callSessionId: string;
  callerName: string;
  mode: "AUDIO" | "VIDEO";
  callerId: string;
  channelId: string;
};

/**
 * In-memory fallback for platforms (or builds) without the native store.
 * On Android the native SharedPreferences-backed store is authoritative,
 * because the FCM service that also rings may be running with no JS at all.
 */
function claimInMemory(callSessionId: string): boolean {
  const now = Date.now();
  // Evict stale entries opportunistically so the map can't grow unbounded.
  for (const [id, ts] of recentCallDispatches) {
    if (now - ts > CALL_DEDUPE_WINDOW_MS) recentCallDispatches.delete(id);
  }
  const last = recentCallDispatches.get(callSessionId);
  if (last !== undefined && now - last < CALL_DEDUPE_WINDOW_MS) {
    return false;
  }
  recentCallDispatches.set(callSessionId, now);
  return true;
}

async function claimDispatch(callSessionId: string): Promise<boolean> {
  if (Platform.OS !== "android" || !nativeDispatch?.claimCallDispatch) {
    return claimInMemory(callSessionId);
  }
  try {
    return await nativeDispatch.claimCallDispatch(callSessionId);
  } catch {
    // Never mute a call because the bridge hiccuped — a duplicate ring is the
    // better failure here.
    return claimInMemory(callSessionId);
  }
}

/**
 * Raise the ringing UI for an incoming call, unless it has already been raised.
 *
 * Returns true only for the transport that actually surfaced the call, so the
 * caller can attach work that must happen exactly once (e.g. pre-warming the
 * LiveKit room). Metadata is always cached, even for a suppressed duplicate —
 * a later accept reads mode/callerId from there, and the second delivery may
 * carry fresher values than the first.
 */
export async function surfaceIncomingCall(signal: IncomingCallSignal): Promise<boolean> {
  const { callSessionId, callerName, mode, callerId, channelId } = signal;
  if (!callSessionId) return false;

  incomingCallMetadataMap.set(callSessionId, {
    mode,
    callerId,
    channelId,
    callerName,
  });

  // Never resurface a call we're already inside. A Pusher reconnect can
  // re-deliver CALL_INCOMING long after the dedupe window has expired;
  // without this the native call UI pops up over the live call and
  // accept/decline just bounce back to the same session.
  if (isCallActive(callSessionId)) return false;

  if (!(await claimDispatch(callSessionId))) return false;

  displayIncomingCall(callSessionId, callerName, mode === "VIDEO");
  showFullScreenCallNotification(callSessionId, callerName, mode === "VIDEO");
  return true;
}

/**
 * Forget a call so a genuinely new one with the same id could ring again, and
 * so a stale entry doesn't sit in the store. Called when a call is cancelled,
 * missed, or handled on another device.
 */
export function forgetCallDispatch(callSessionId: string): void {
  recentCallDispatches.delete(callSessionId);
  try {
    nativeDispatch?.forgetCallDispatch?.(callSessionId);
  } catch {
    // Best effort — a stale entry just expires on its own.
  }
}
