import { Platform, NativeModules, NativeEventEmitter } from "react-native";
import { openCall, dismissNativeCallNotification } from "@/lib/call-ui-store";
import {
  endCallKeepCall,
  reportCallConnected,
  preAcceptedCallRef,
  pendingAcceptRef,
  incomingCallMetadataMap,
  type PreAcceptedCallData,
} from "@/lib/callkeep-setup";
import { getPrewarmedCalleeRoom } from "@/lib/call-prewarm";
import { isCallActive } from "@/lib/active-call";

const CHANNEL_ID = "incoming_calls_fs";
const CHANNEL_NAME = "Incoming Calls";
const NOTIFICATION_TIMEOUT = 45000;

let listenersRegistered = false;

function getNativeModule() {
  return NativeModules.FullScreenNotificationIncomingCall;
}

export function setupFullScreenCallListeners() {
  if (Platform.OS !== "android" || listenersRegistered) return;
  const nativeModule = getNativeModule();
  if (!nativeModule) return;
  listenersRegistered = true;

  const emitter = new NativeEventEmitter(nativeModule);

  emitter.addListener("RNNotificationAnswerAction", (payload) => {
    const callUUID = payload?.callUUID;
    if (!callUUID) return;
    void acceptCall(callUUID);
  });

  emitter.addListener("RNNotificationEndCallAction", (payload) => {
    const callUUID = payload?.callUUID;
    if (!callUUID) return;
    endCallKeepCall(callUUID);
    if (payload?.endAction === "ACTION_REJECTED_CALL") {
      void rejectCall(callUUID);
    }
  });

  // The listeners above only catch an answer that happens while this JS context
  // is alive. An answer from a killed app never reaches them.
  void drainPendingNativeAccept();
}

/**
 * Pick up an accept the user pressed before this JS context existed.
 *
 * Answering from a killed app is the case every event-based path gets wrong:
 * the tap is what starts the process, so RNNotificationAnswerAction is emitted
 * into a bridge with no listeners, and the deep link only ever said "open the
 * call screen" — never "the user said yes". The app came up on whatever screen
 * it was last on, nothing accepted the call, and it died as "Cancelled" while
 * the user waited.
 *
 * MainActivity now records the decision straight from the launch intent, before
 * the bundle loads (see plugins/withCallKeep.js). This drains it. Called once
 * from setupFullScreenCallListeners(), which runs at module scope in the root
 * layout, so it fires as early as JS can possibly run.
 */
export async function drainPendingNativeAccept(): Promise<void> {
  if (Platform.OS !== "android") return;
  const native = NativeModules.CallForegroundService as
    | { consumePendingAccept?: () => Promise<PendingNativeAccept | null> }
    | undefined;
  if (!native?.consumePendingAccept) return;

  try {
    const pending = await native.consumePendingAccept();
    if (!pending?.callSessionId) return;
    const mode =
      pending.mode === "VIDEO" || pending.mode === "AUDIO" ? pending.mode : undefined;
    await acceptCall(pending.callSessionId, mode);
  } catch (err) {
    console.warn(
      "[call] Could not replay the pending accept:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

type PendingNativeAccept = { callSessionId?: string; mode?: string };

// Exported: also invoked by the CallKeep answerCall listener (the only accept
// surface on iOS). Idempotent via the isCallActive guard.
export async function acceptCall(
  callSessionId: string,
  /**
   * Mode from a transport that has it when the metadata cache does not — the
   * accept deep link and the native pending-accept record both carry it. Every
   * cold-start answer to a video call used to open as audio without this.
   */
  modeHint?: "AUDIO" | "VIDEO",
) {
  // Guard: if we're already inside this call, the notification is a stale
  // duplicate (e.g. native FCM re-dispatch). Just clear it instead of
  // re-running /accept and re-navigating to the same live screen.
  if (isCallActive(callSessionId)) {
    incomingCallMetadataMap.delete(callSessionId);
    hideFullScreenCallNotification();
    endCallKeepCall(callSessionId);
    return;
  }

  // An accept for this call is already on the wire. Both the native
  // pending-accept drain and the questioncall://call/<id>?answered=1 deep link
  // land here for the same tap (deliberately — either one alone can be the only
  // survivor of a cold start), so the second arrival must not POST /accept
  // again. Re-focusing the call UI is all it has left to do.
  if (pendingAcceptRef.current?.callSessionId === callSessionId) {
    openCall({ roomId: callSessionId, mode: modeHint });
    return;
  }

  // Stop ringing before anything else. When accept arrives through the native
  // notification the library tears its own service down, but the CallKeep
  // answerCall and in-app accept paths land here directly — leaving
  // IncomingCallService (and its looping ringtone) running until the 45s
  // timeout. Harmless to repeat: hideNotification is a stopService call.
  hideFullScreenCallNotification();

  // Pull cached metadata captured at incoming-call time.  Pusher/push payload
  // mode is authoritative — the server /accept response is a fallback for
  // cases where the user accepts before we cached anything (e.g. cold start).
  const meta = incomingCallMetadataMap.get(callSessionId);
  const mode = meta?.mode ?? modeHint;

  // If realtime-bridge already pre-warmed a LiveKit room from the Pusher
  // payload, the call screen will consume it directly. We can hand it the
  // cached token immediately, skipping the wait on the /accept response.
  const prewarm = getPrewarmedCalleeRoom(callSessionId);
  if (prewarm && meta) {
    preAcceptedCallRef.current = {
      token: prewarm.token.token,
      serverUrl: prewarm.token.serverUrl,
      channelId: prewarm.token.channelId,
      timerDeadline: prewarm.token.timerDeadline,
      timeExtensionCount: prewarm.token.timeExtensionCount,
      mode: meta.mode,
      callerId: meta.callerId,
    };
    incomingCallMetadataMap.delete(callSessionId);
    reportCallConnected(callSessionId);
    openCall({ roomId: callSessionId, mode: meta.mode });
    // Fire the accept API in the background — server still needs to flip
    // status from RINGING to ACTIVE and notify the caller via Pusher. The
    // user is already looking at the call screen by the time it returns.
    //
    // This is the only thing that tells the caller we picked up, so a silent
    // failure here strands both sides: the callee sits in the room on
    // "waiting for user" while the caller keeps ringing. Retry once before
    // giving up, and say so rather than failing quietly.
    void (async () => {
      const { api } = await import("@/lib/api");
      const { getDeviceId } = await import("@/lib/app-identity");

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await api.post(`/calls/${callSessionId}/accept`, {
            deviceId: getDeviceId(),
          });
          return;
        } catch (err: any) {
          // 409 = the server already moved this call out of RINGING (another
          // device accepted, or our own earlier retry landed). Nothing to do.
          if (err?.response?.status === 409) return;
          if (attempt === 2) {
            console.warn(
              "[acceptCall] background /accept failed after retry:",
              err instanceof Error ? err.message : String(err),
            );
            const Toast = (await import("react-native-toast-message")).default;
            Toast.show({
              type: "error",
              text1: "Couldn't connect the call",
              text2: "The other side wasn't told you answered. Try calling back.",
            });
            return;
          }
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    })();
    return;
  }

  // Fallback: no pre-warm available. Either the Pusher payload was missing the
  // token, or — far more often — this is a cold start, where nothing had a
  // chance to pre-warm anything because the process did not exist a second ago.
  //
  // This path used to await POST /accept and only then open the call UI. On a
  // cold start that request queues behind the bundle load, so the user pressed
  // Accept and then watched their chat list for several seconds; if anything
  // went wrong they never saw a call at all, just "Cancelled" in the history.
  // Put the call UI up first and let the request finish underneath it, the way
  // every native dialler does. <CallScreen/> picks the promise up from
  // pendingAcceptRef, so it neither refetches the session nor accepts twice.
  const acceptPromise = (async (): Promise<PreAcceptedCallData | null> => {
    try {
      const { api } = await import("@/lib/api");
      const { getDeviceId } = await import("@/lib/app-identity");
      const res = await api.post(`/calls/${callSessionId}/accept`, {
        deviceId: getDeviceId(),
      });
      const data = res.data as any;
      if (!data?.token || !data?.serverUrl) return null;
      const serverMode =
        data.mode === "VIDEO" || data.mode === "AUDIO" ? data.mode : null;
      return {
        token: data.token,
        serverUrl: data.serverUrl,
        channelId: data.channelId ?? meta?.channelId ?? "",
        timerDeadline: data.timerDeadline,
        timeExtensionCount: data.timeExtensionCount ?? 0,
        // Prefer the mode the user was actually shown ringing. The server
        // response is the last resort.
        mode: mode ?? serverMode ?? "AUDIO",
        callerId: data.callerId ?? meta?.callerId ?? "",
      };
    } catch (err: any) {
      // 409 = already accepted (our own retry, or another device). Fall through
      // to the call screen either way and let it reconcile with the server.
      if (err?.response?.status !== 409) {
        console.warn(
          "[acceptCall] /accept failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      return null;
    }
  })();

  // Park it before opening the UI: openCall() schedules the render that mounts
  // <CallScreen/>, and the screen looks for this on its first pass.
  pendingAcceptRef.current = { callSessionId, promise: acceptPromise };

  incomingCallMetadataMap.delete(callSessionId);
  reportCallConnected(callSessionId);
  openCall({ roomId: callSessionId, mode });

  await acceptPromise;
}

// Exported: also invoked by the notification's Decline action (see _layout).
export async function rejectCall(callSessionId: string) {
  incomingCallMetadataMap.delete(callSessionId);
  hideFullScreenCallNotification();
  // hideFullScreenCallNotification() only stops IncomingCallService. The
  // CallStyle fallback notification is ours and outlives it.
  dismissNativeCallNotification(callSessionId);
  endCallKeepCall(callSessionId);
  try {
    const { api } = await import("@/lib/api");
    const { getDeviceId } = await import("@/lib/app-identity");
    await api.post(`/calls/${callSessionId}/reject`, {
      deviceId: getDeviceId(),
    });
  } catch {}
}

export function showFullScreenCallNotification(
  callSessionId: string,
  callerName: string,
  isVideo: boolean,
) {
  if (Platform.OS !== "android") return;
  const nativeModule = getNativeModule();
  if (!nativeModule) return;

  nativeModule.displayNotification(callSessionId, null, NOTIFICATION_TIMEOUT, {
    channelId: CHANNEL_ID,
    channelName: CHANNEL_NAME,
    notificationIcon: "ic_launcher",
    notificationTitle: callerName,
    notificationBody: isVideo ? "Incoming video call..." : "Incoming voice call...",
    answerText: "Accept",
    declineText: "Decline",
    notificationColor: "notification_icon_color",
    notificationSound: "incoming_ringtone",
    isVideo,
  });
}

export function hideFullScreenCallNotification() {
  if (Platform.OS !== "android") return;
  const nativeModule = getNativeModule();
  if (!nativeModule) return;
  nativeModule.hideNotification();
}
