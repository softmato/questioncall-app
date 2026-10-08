import { useSyncExternalStore } from "react";
import { NativeModules, Platform } from "react-native";
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
  /**
   * Whether arriving at the call screen counts as answering.
   *
   * True everywhere the user has actually pressed Accept. False only for the
   * surfaces that just *show* an incoming call: the notification body, and the
   * full-screen intent — which Android fires on its own when the phone is
   * locked. Those must stop at the Accept/Decline screen, or a locked phone
   * answers calls nobody agreed to take.
   */
  autoAccept?: boolean;
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
 *
 * The one thing a repeat open CAN change is answering: Accept pressed on a
 * notification while the in-app incoming screen for the same call is already
 * up flips that screen to answer, instead of being swallowed as a duplicate.
 */
export function openCall(params: CallUiParams) {
  // A show-only open keeps the native ring going: the user has not answered
  // yet, and silencing it here left a locked phone showing a silent screen.
  dismissCallTrayNotifications(params.roomId, params.autoAccept !== false);
  if (state.params) {
    const answersShownCall =
      params.autoAccept !== false &&
      state.params.autoAccept === false &&
      state.params.roomId === params.roomId;
    setState({
      ...state,
      params: answersShownCall ? { ...state.params, autoAccept: true } : state.params,
      minimized: false,
    });
    return;
  }
  setState({ params, minimized: false, instance: state.instance + 1 });
}

/**
 * Close the overlay if it is showing this call as an unanswered incoming call
 * (opened show-only and never answered on this device). Used when the call
 * stops ringing elsewhere — caller hung up, declined from a notification,
 * answered on another device — so the incoming screen vanishes the way it
 * does on any phone, instead of lingering with live buttons.
 */
export function closeRingingCall(callSessionId: string) {
  if (state.params?.roomId !== callSessionId) return;
  if (state.params.autoAccept !== false) return;
  closeCall();
}

/**
 * Clear the CallStyle notification the native FCM service posts when the
 * full-screen ringing service cannot be started (see plugins/withCallKeep.js).
 *
 * That notification is built straight from NotificationManager rather than
 * through expo-notifications, so the tray sweep below cannot see it, and it is
 * deliberately ongoing so the user cannot swipe it away either. Only native
 * code can retire it.
 *
 * On a binary with IncomingCallRinger this stops every native ring surface for
 * the call (notification, ringing service, ring screen); older binaries can
 * only clear the notification. A no-op on binaries that predate both.
 */
export function dismissNativeCallNotification(callSessionId: string) {
  if (Platform.OS !== "android") return;
  if (!callSessionId || callSessionId === "pending") return;
  const native = NativeModules.CallForegroundService as
    | {
        stopIncomingCall?: (id: string) => void;
        dismissIncomingCallNotification?: (id: string) => void;
      }
    | undefined;
  try {
    if (native?.stopIncomingCall) native.stopIncomingCall(callSessionId);
    else native?.dismissIncomingCallNotification?.(callSessionId);
  } catch {
    // Older binary without the method — nothing of ours to clear.
  }
}

/**
 * Clear tray copies of the incoming-call push once the call is being answered.
 *
 * The server's ring-fallback tier (web/app/api/calls/create/route.ts) re-sends
 * a call that is still unanswered ~5s in as a notification-payload push, so
 * OEMs that refuse to start our process for the data-only push still show
 * something. CallNotificationService.handleIntent now claims those before
 * Firebase can draw them, so a duplicate should no longer reach the tray — but
 * a build that predates it, or any other path that renders a call push through
 * expo-notifications, still can. Answering via the full-screen UI never routes
 * through JS notification handling either, so nothing else would clean it up,
 * and a stale "Incoming call — tap to answer" that navigates to a dead session
 * looks like a bug. Sweep the moment any path opens this call.
 *
 * Targeted on purpose: only notifications carrying this call's id. Chat and
 * question notifications must survive a call.
 */
function dismissCallTrayNotifications(roomId: string, includeNativeRing: boolean) {
  if (!roomId || roomId === "pending") return;

  // The CallStyle notification the native FCM service posts when the
  // full-screen ringing service cannot start (see plugins/withCallKeep.js) is
  // built straight from NotificationManager, so getPresentedNotificationsAsync
  // below never sees it — and it is deliberately ongoing, so the user cannot
  // swipe it away either. Clear it natively or it sits there ringing at a call
  // that is already answered.
  if (includeNativeRing) dismissNativeCallNotification(roomId);

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

/**
 * Tear down the overlay — unmounts <CallScreen/> (its cleanup effect ends the
 * room). Pass the call id when acting on a specific call, so a late callback
 * can never close a different one.
 */
export function closeCall(roomId?: string) {
  if (!state.params) return;
  if (roomId !== undefined && state.params.roomId !== roomId) return;
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
