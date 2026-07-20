import { useSyncExternalStore } from "react";
import * as Notifications from "expo-notifications";

/**
 * Global call-UI state — the mobile mirror of the web's persistent call host.
 *
 * The active call lives in <PersistentCallHost/> at the ROOT layout, not in a
 * routed screen, so navigating anywhere in the app never unmounts the LiveKit
 * room. This store only tracks WHICH call is active and whether the overlay is
 * fullscreen or minimized to the floating bubble; all call/room state stays
 * inside <CallScreen/> exactly as before.
 *
 * Deliberately not Redux: the values are ephemeral per-call UI state that must
 * never be persisted or rehydrated.
 */
export type CallUiParams = {
  /** Call-session id, or "pending" for the optimistic caller path. */
  roomId: string;
  /** Channel id — required when roomId === "pending". */
  channelId?: string;
  mode?: "AUDIO" | "VIDEO";
};

type CallUiState = {
  params: CallUiParams | null;
  minimized: boolean;
  /**
   * Remount key. openCall() after a previous call bumps it so <CallScreen/>
   * always starts with fresh state (the old screen fully unmounted + cleaned
   * up via closeCall()).
   */
  instance: number;
};

let state: CallUiState = { params: null, minimized: false, instance: 0 };

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function setState(next: CallUiState) {
  state = next;
  emit();
}

/**
 * Open (or re-focus) the call overlay. If a call is already active, this only
 * expands it — it never replaces the live call, so duplicate navigations
 * (notification tap, deep link re-delivery) are harmless.
 */
export function openCall(params: CallUiParams) {
  dismissCallTrayNotifications(params.roomId);
  if (state.params) {
    setState({ ...state, minimized: false });
    return;
  }
  setState({ params, minimized: false, instance: state.instance + 1 });
}

/**
 * Clear tray copies of the incoming-call push once the call is being answered.
 *
 * The server's ring-fallback tier (web/app/api/calls/create/route.ts) re-sends
 * a call that is still unanswered ~5s in as a system-rendered notification, so
 * OEMs that refuse to start our process for the data-only push still show
 * something. On devices where the real ring DID fire, that fallback lands as
 * an extra tray entry — and answering via the full-screen UI never routes
 * through JS notification handling, so nothing else would clean it up. A stale
 * "Incoming call — tap to answer" that navigates to a dead session looks like
 * a bug; sweep it the moment any path opens this call.
 *
 * Targeted on purpose: only notifications carrying this call's id. Chat and
 * question notifications must survive a call.
 */
function dismissCallTrayNotifications(roomId: string) {
  if (!roomId || roomId === "pending") return;
  void Notifications.getPresentedNotificationsAsync()
    .then((presented) => {
      for (const notification of presented) {
        const data = notification.request.content.data as
          | Record<string, unknown>
          | undefined;
        if (data?.callSessionId === roomId) {
          void Notifications.dismissNotificationAsync(
            notification.request.identifier,
          ).catch(() => {});
        }
      }
    })
    .catch(() => {});
}

/**
 * Swap the optimistic "pending" placeholder for the real call-session id once
 * POST /calls/create resolves.
 *
 * Without this the resolved id would live only in <CallScreen/>'s local state,
 * so any remount of that component (fast refresh, an error boundary, a future
 * refactor of the host) would read roomId === "pending" again and fire a SECOND
 * /calls/create — re-dialling the callee mid-call. `instance` is deliberately
 * left alone: this is the same call, not a new one.
 */
export function resolveCallRoomId(realRoomId: string) {
  if (!realRoomId || !state.params) return;
  if (state.params.roomId === realRoomId) return;
  if (state.params.roomId !== "pending") return;
  setState({ ...state, params: { ...state.params, roomId: realRoomId } });
}

export function minimizeCall() {
  if (!state.params || state.minimized) return;
  setState({ ...state, minimized: true });
}

export function expandCall() {
  if (!state.params || !state.minimized) return;
  setState({ ...state, minimized: false });
}

/** Tear down the overlay — unmounts <CallScreen/> (its cleanup effect ends the room). */
export function closeCall() {
  if (!state.params) return;
  setState({ params: null, minimized: false, instance: state.instance });
}

export function hasActiveCallUi() {
  return state.params !== null;
}

export function subscribeCallUi(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

export function useCallUi(): CallUiState {
  return useSyncExternalStore(subscribeCallUi, getSnapshot, getSnapshot);
}
