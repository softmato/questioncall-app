import { Platform, NativeModules, NativeEventEmitter } from "react-native";
import { openCall } from "@/lib/call-ui-store";
import {
  endCallKeepCall,
  reportCallConnected,
  preAcceptedCallRef,
  incomingCallMetadataMap,
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
}

// Exported: also invoked by the CallKeep answerCall listener (the only accept
// surface on iOS). Idempotent via the isCallActive guard.
export async function acceptCall(callSessionId: string) {
  // Guard: if we're already inside this call, the notification is a stale
  // duplicate (e.g. native FCM re-dispatch). Just clear it instead of
  // re-running /accept and re-navigating to the same live screen.
  if (isCallActive(callSessionId)) {
    incomingCallMetadataMap.delete(callSessionId);
    hideFullScreenCallNotification();
    endCallKeepCall(callSessionId);
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

  // Fallback: no pre-warm available (e.g. Pusher payload was missing the
  // token for some reason). Use the original blocking /accept path.
  try {
    const { api } = await import("@/lib/api");
    const { getDeviceId } = await import("@/lib/app-identity");
    const res = await api.post(`/calls/${callSessionId}/accept`, {
      deviceId: getDeviceId(),
    });
    const data = res.data as any;
    if (data?.token && data?.serverUrl) {
      const serverMode =
        data.mode === "VIDEO" || data.mode === "AUDIO" ? data.mode : null;
      preAcceptedCallRef.current = {
        token: data.token,
        serverUrl: data.serverUrl,
        channelId: data.channelId ?? meta?.channelId ?? "",
        timerDeadline: data.timerDeadline,
        timeExtensionCount: data.timeExtensionCount ?? 0,
        // Prefer the mode from the original pusher payload — that's what
        // displayed "video call" to the user.  Only fall back to the server
        // response when we have no cached metadata.
        mode: meta?.mode ?? serverMode ?? "AUDIO",
        callerId: data.callerId ?? meta?.callerId ?? "",
      };
    }
  } catch (err: any) {
    if (err?.response?.status === 409) {
      // Already accepted elsewhere — still navigate to the call
    }
  }
  incomingCallMetadataMap.delete(callSessionId);
  reportCallConnected(callSessionId);
  openCall({ roomId: callSessionId, mode: meta?.mode });
}

// Exported: also invoked by the notification's Decline action (see _layout).
export async function rejectCall(callSessionId: string) {
  incomingCallMetadataMap.delete(callSessionId);
  hideFullScreenCallNotification();
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
