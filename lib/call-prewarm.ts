// Pre-warms a LiveKit room before the call button is pressed. We open the
// signaling WebSocket + DTLS to a deterministic per-channel room while the
// user is sitting in the workspace, so call-button → media-flowing collapses
// from ~3-5s to ~500ms-1s (only track publishing remains).
//
// One pre-warm slot per role (caller-in-workspace, callee-from-pusher). The
// caller slot is keyed by channelId; the callee slot by callSessionId.
//
// IMPORTANT: livekit-client must be loaded LAZILY (dynamic import) inside the
// async functions below. This module is reachable from app startup via
// _layout.tsx → setupFullScreenCallListeners / RealtimeBridge → call-prewarm,
// and livekit-client references DOMException at module-load time. The polyfill
// (registerGlobals) only runs after the import graph resolves, so a static
// import here would crash with "Property 'DOMException' doesn't exist".

import type { Room as LKRoom } from "livekit-client";

import { api } from "@/lib/api";

export type PrewarmTokenPayload = {
  token: string;
  serverUrl: string;
  channelId: string;
  timerDeadline: string;
  timeExtensionCount: number;
};

type CallerSlot = {
  channelId: string;
  room: LKRoom;
  token: PrewarmTokenPayload;
  ready: Promise<void>;
  failed: boolean;
};

type CalleeSlot = {
  callSessionId: string;
  channelId: string;
  room: LKRoom;
  token: PrewarmTokenPayload;
  ready: Promise<void>;
  failed: boolean;
};

let callerSlot: CallerSlot | null = null;
let calleeSlot: CalleeSlot | null = null;

// Tracks the most recent in-flight POST /calls/create promise so the call
// screen — which we navigate to optimistically before the API returns — can
// await it instead of firing its own duplicate request.
let pendingCreatePromise: Promise<any> | null = null;
let pendingCreateMeta: { channelId: string; mode: "AUDIO" | "VIDEO" } | null = null;

function teardownRoom(room: LKRoom | null | undefined) {
  if (!room) return;
  try {
    room.removeAllListeners();
    room.disconnect();
  } catch {}
}

// ── Caller pre-warm (mounted from the workspace screen) ───────────────────
export function getPrewarmedCallerRoom(channelId: string): CallerSlot | null {
  if (!callerSlot || callerSlot.channelId !== channelId) return null;
  if (callerSlot.failed) return null;
  return callerSlot;
}

export async function prewarmCallerRoom(channelId: string) {
  if (callerSlot && callerSlot.channelId === channelId && !callerSlot.failed) {
    return; // already pre-warming this channel
  }
  // Different channel cached — tear it down.
  if (callerSlot && callerSlot.channelId !== channelId) {
    teardownRoom(callerSlot.room);
    callerSlot = null;
  }

  let tokenPayload: PrewarmTokenPayload;
  try {
    const res = await api.get(`/channels/${channelId}/call-token`);
    tokenPayload = res.data as PrewarmTokenPayload;
  } catch (err) {
    // Channel might not be ACTIVE, user might lack permission, LiveKit might
    // be misconfigured — any failure just disables pre-warm. The call screen
    // falls back to the normal create-then-connect path.
    console.warn(
      "[call-prewarm] caller token fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const { Room, RoomEvent } = await import("livekit-client");
  const room = new Room({ adaptiveStream: false, dynacast: false });
  const slot: CallerSlot = {
    channelId,
    room,
    token: tokenPayload,
    ready: Promise.resolve(),
    failed: false,
  };

  room.on(RoomEvent.Disconnected, () => {
    // If the pre-warmed room drops (network blip, server-side timeout), mark
    // the slot failed so consumers fall back to the cold path.
    if (callerSlot === slot) {
      slot.failed = true;
    }
  });

  slot.ready = room
    .connect(tokenPayload.serverUrl, tokenPayload.token, { autoSubscribe: true })
    .catch((err) => {
      slot.failed = true;
      console.warn(
        "[call-prewarm] caller LiveKit connect failed:",
        err instanceof Error ? err.message : String(err),
      );
    });

  callerSlot = slot;
}

// Hand the pre-warmed room to the call screen. The caller takes ownership;
// the singleton forgets about it (no double-disconnect on cleanup).
export function consumeCallerPrewarm(channelId: string): CallerSlot | null {
  const slot = callerSlot;
  if (!slot || slot.channelId !== channelId || slot.failed) return null;
  callerSlot = null;
  return slot;
}

export function clearCallerPrewarm(channelId?: string) {
  if (!callerSlot) return;
  if (channelId && callerSlot.channelId !== channelId) return;
  teardownRoom(callerSlot.room);
  callerSlot = null;
}

// ── Callee pre-warm (kicked off by realtime-bridge on CALL_INCOMING_EVENT) ─
export function getPrewarmedCalleeRoom(callSessionId: string): CalleeSlot | null {
  if (!calleeSlot || calleeSlot.callSessionId !== callSessionId) return null;
  if (calleeSlot.failed) return null;
  return calleeSlot;
}

export async function prewarmCalleeRoom(args: {
  callSessionId: string;
  channelId: string;
  token: string;
  serverUrl: string;
  timerDeadline: string;
  timeExtensionCount: number;
}) {
  // If we already have a slot for this exact call, no-op.
  if (
    calleeSlot &&
    calleeSlot.callSessionId === args.callSessionId &&
    !calleeSlot.failed
  ) {
    return;
  }
  // Stale slot from a previous call — discard.
  if (calleeSlot && calleeSlot.callSessionId !== args.callSessionId) {
    teardownRoom(calleeSlot.room);
    calleeSlot = null;
  }

  const { Room, RoomEvent } = await import("livekit-client");
  const room = new Room({ adaptiveStream: false, dynacast: false });
  const slot: CalleeSlot = {
    callSessionId: args.callSessionId,
    channelId: args.channelId,
    room,
    token: {
      token: args.token,
      serverUrl: args.serverUrl,
      channelId: args.channelId,
      timerDeadline: args.timerDeadline,
      timeExtensionCount: args.timeExtensionCount,
    },
    ready: Promise.resolve(),
    failed: false,
  };

  room.on(RoomEvent.Disconnected, () => {
    if (calleeSlot === slot) {
      slot.failed = true;
    }
  });

  slot.ready = room
    .connect(args.serverUrl, args.token, { autoSubscribe: true })
    .catch((err) => {
      slot.failed = true;
      console.warn(
        "[call-prewarm] callee LiveKit connect failed:",
        err instanceof Error ? err.message : String(err),
      );
    });

  calleeSlot = slot;
}

export function consumeCalleePrewarm(callSessionId: string): CalleeSlot | null {
  const slot = calleeSlot;
  if (!slot || slot.callSessionId !== callSessionId || slot.failed) return null;
  calleeSlot = null;
  return slot;
}

export function clearCalleePrewarm(callSessionId?: string) {
  if (!calleeSlot) return;
  if (callSessionId && calleeSlot.callSessionId !== callSessionId) return;
  teardownRoom(calleeSlot.room);
  calleeSlot = null;
}

// NOTE: the outgoing ringback used to be pre-started here on button press and
// handed to the call screen via a singleton. That handoff raced with the call
// screen's consume (double ring / orphaned loop), and starting before the
// server confirmed ringing wasn't WhatsApp behavior anyway. The ringback now
// lives entirely in call-screen.tsx and starts once /calls/create resolves.

// ── In-flight POST /calls/create (caller's optimistic-navigation buffer) ──
export function setPendingCreate(
  channelId: string,
  mode: "AUDIO" | "VIDEO",
  promise: Promise<any>,
) {
  pendingCreatePromise = promise;
  pendingCreateMeta = { channelId, mode };
}

export function consumePendingCreate(channelId: string) {
  if (!pendingCreatePromise || !pendingCreateMeta) return null;
  if (pendingCreateMeta.channelId !== channelId) return null;
  const result = { promise: pendingCreatePromise, meta: pendingCreateMeta };
  pendingCreatePromise = null;
  pendingCreateMeta = null;
  return result;
}

export function clearPendingCreate() {
  pendingCreatePromise = null;
  pendingCreateMeta = null;
}
