import { Platform } from "react-native";
import RNCallKeep from "react-native-callkeep";

let initialized = false;

export interface PreAcceptedCallData {
  token: string;
  serverUrl: string;
  channelId: string;
  timerDeadline: string;
  timeExtensionCount: number;
  mode: "AUDIO" | "VIDEO";
  callerId: string;
}
export const preAcceptedCallRef: { current: PreAcceptedCallData | null } = {
  current: null,
};

/**
 * An accept whose POST /calls/:id/accept has not come back yet.
 *
 * preAcceptedCallRef above only helps when a token is already in hand, which
 * means the Pusher pre-warm path. A cold start has no pre-warm: the process is
 * being created by the very tap that answered the call, so acceptCall() has to
 * go to the network. It used to await that POST before opening the call UI, and
 * on a cold start that lands on top of a bundle load, so the user sat looking at
 * their chat list for several seconds after answering.
 *
 * Now the call UI opens immediately and the in-flight request is parked here.
 * <CallScreen/> picks it up on mount and awaits it instead of re-deriving the
 * session with its own GET /calls/:id (and then accepting a second time, which
 * is where the 409s came from).
 */
export const pendingAcceptRef: {
  current: {
    callSessionId: string;
    promise: Promise<PreAcceptedCallData | null>;
  } | null;
} = { current: null };

/** Take the in-flight accept for this call, if it is the one waiting. */
export function consumePendingAccept(
  callSessionId: string,
): Promise<PreAcceptedCallData | null> | null {
  const pending = pendingAcceptRef.current;
  if (!pending || pending.callSessionId !== callSessionId) return null;
  pendingAcceptRef.current = null;
  return pending.promise;
}

// Metadata captured from the pusher CALL_INCOMING_EVENT (and push notifications)
// at the moment the call comes in.  The native full-screen notification's
// accept event only delivers a callUUID, so without this cache the only source
// of mode/callerId at accept-time is the server's /accept response — and any
// flake there (cold-start race, missing env, network blip) silently downgrades
// a video call to audio.  Pusher payload is authoritative; we read from here
// first and only fall back to the server response.
export type IncomingCallMetadata = {
  mode: "AUDIO" | "VIDEO";
  callerId: string;
  channelId: string;
  callerName: string;
};
export const incomingCallMetadataMap = new Map<string, IncomingCallMetadata>();

const CALLKEEP_OPTIONS = {
  ios: {
    appName: "QuestionCall",
    supportsVideo: true,
  },
  android: {
    alertTitle: "Permissions required",
    alertDescription: "QuestionCall needs phone account permission for incoming calls",
    cancelButton: "Cancel",
    okButton: "OK",
    additionalPermissions: [],
    selfManaged: true,
  },
};

/**
 * CallKeep is iOS-only (CallKit is the incoming-call UI there).
 *
 * On Android it ran self-managed with no UI of its own, and was pure liability:
 * every RNCallKeep.endCall() — which this app calls on EVERY teardown (hangup,
 * cancel, unmount, a duplicate accept) — fires CallKeep's own "endCall" event,
 * and the listener below turns that into POST /reject. A ringing call whose
 * screen was merely closed got rejected, and endCall also reset the audio mode
 * to NORMAL in the middle of a live call. The native ringing surfaces in
 * plugins/withCallKeep.js do everything it was standing in for.
 */
const USE_CALLKEEP = Platform.OS === "ios";

export function setupCallKeep() {
  if (initialized || !USE_CALLKEEP) return;
  initialized = true;

  try {
    RNCallKeep.setup(CALLKEEP_OPTIONS);
  } catch (err) {
    console.warn(
      "[callkeep] Setup failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Non-fatal — calls still work in-app without native call UI
  }

  RNCallKeep.addEventListener("answerCall", ({ callUUID }) => {
    if (!callUUID) return;
    RNCallKeep.setCurrentCallActive(callUUID);
    // On iOS the CallKit sheet is the only accept surface (there is no
    // full-screen notification), so run the shared accept flow from here.
    // Android's accept comes through the full-screen notification events —
    // acceptCall() is idempotent via the isCallActive guard either way.
    // Dynamic import avoids a module cycle with full-screen-call-notification.
    void import("@/lib/full-screen-call-notification")
      .then((mod) => mod.acceptCall(callUUID))
      .catch((err) => {
        console.warn(
          "[callkeep] answerCall accept failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
  });

  RNCallKeep.addEventListener("endCall", ({ callUUID }) => {
    // User declined from system UI — fire the reject API
    void fetch_reject(callUUID);
  });
}

export function displayIncomingCall(
  callSessionId: string,
  callerName: string,
  isVideo: boolean,
) {
  if (!USE_CALLKEEP) return;
  if (!initialized) setupCallKeep();

  RNCallKeep.displayIncomingCall(
    callSessionId,
    callerName,
    callerName,
    "generic",
    isVideo,
  );
}

export function endCallKeepCall(callSessionId: string) {
  if (!USE_CALLKEEP) return;
  try {
    RNCallKeep.endCall(callSessionId);
  } catch (err) {
    console.warn(
      "[callkeep] endCall failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function reportCallConnected(callSessionId: string) {
  if (!USE_CALLKEEP) return;
  try {
    RNCallKeep.setCurrentCallActive(callSessionId);
  } catch (err) {
    console.warn(
      "[callkeep] reportConnected failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Speaker/earpiece routing now lives in lib/call-audio-session.ts (LiveKit's
// native AudioSession) — the old expo-av based setSpeakerphone was the source
// of the "remote voice on the media stream" bug and has been removed.

async function fetch_reject(callSessionId: string) {
  try {
    const { api } = await import("@/lib/api");
    const { getDeviceId } = await import("@/lib/app-identity");
    await api.post(`/calls/${callSessionId}/reject`, {
      deviceId: getDeviceId(),
    });
  } catch (err) {
    console.warn(
      "[callkeep] reject API call failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
