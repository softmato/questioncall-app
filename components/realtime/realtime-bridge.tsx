import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import Toast from "react-native-toast-message";

import {
  CHANNEL_UPDATED_EVENT,
  NEW_CHANNEL_EVENT,
  NOTIFICATION_EVENT,
  SUBSCRIPTION_UPDATED_EVENT,
  CALL_INCOMING_EVENT,
  CALL_CANCELLED_EVENT,
  CALL_MISSED_EVENT,
  CALL_HANDLED_EVENT,
  getPusherClient,
  getPusherConfig,
  getUserPusherName,
  resetPusherClient,
} from "@/lib/realtime";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import {
  addRealtimeNotification,
  clearRealtime,
  setRealtimeReconnectAttempts,
  setRealtimeStatus,
  setRealtimeUserChannel,
} from "@/store/slices/realtimeSlice";
import { updateChannelLastMessage, upsertChannel } from "@/store/slices/channelsSlice";
import { updateUser } from "@/store/slices/userSlice";
import { prependNotification } from "@/store/slices/notificationsSlice";
import { endCallKeepCall, incomingCallMetadataMap } from "@/lib/callkeep-setup";
import { hideFullScreenCallNotification } from "@/lib/full-screen-call-notification";
import { prewarmCalleeRoom, clearCalleePrewarm } from "@/lib/call-prewarm";
import { isCallActive } from "@/lib/active-call";
import { surfaceIncomingCall, forgetCallDispatch } from "@/lib/call-dispatch";
import { getDeviceId } from "@/lib/app-identity";

type ChannelUpdatedPayload = {
  channelId: string;
  unreadCountCleared?: boolean;
  unreadCountIncrement?: number;
  lastMessagePreview?: string;
  lastMessageAt?: string;
};

export function RealtimeBridge() {
  const dispatch = useAppDispatch();
  const userId = useAppSelector((s) => s.user.data?._id ?? null);
  const activeChannelId = useAppSelector((s) => s.channels.activeChannelId);
  const activeChannelIdRef = useRef(activeChannelId);
  activeChannelIdRef.current = activeChannelId;

  useEffect(() => {
    if (!userId) {
      resetPusherClient();
      dispatch(clearRealtime());
      return;
    }

    const config = getPusherConfig();
    if (!config) {
      dispatch(
        setRealtimeStatus({
          status: "unavailable",
          error: "Pusher keys are not configured for the mobile app.",
        }),
      );
      return;
    }

    const client = getPusherClient();
    if (!client) return;

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const channelName = getUserPusherName(userId);
    dispatch(setRealtimeUserChannel(channelName));

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = (error?: string) => {
      if (disposed) return;
      clearReconnectTimer();
      attempts += 1;
      dispatch(setRealtimeReconnectAttempts(attempts));
      dispatch(
        setRealtimeStatus({
          status: error ? "error" : "disconnected",
          error: error ?? null,
        }),
      );

      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
      reconnectTimer = setTimeout(() => {
        if (disposed) return;
        dispatch(setRealtimeStatus({ status: "connecting" }));
        client.connect();
      }, delay);
    };

    const channel = client.subscribe(channelName);

    channel.bind(NOTIFICATION_EVENT, (payload: any) => {
      const notification = payload?.notification ?? payload;
      if (!notification?.id && !notification?._id) return;

      const id = String(notification.id ?? notification._id);
      const type = String(notification.type ?? "notification");
      const message = String(notification.message ?? "New notification");
      const href = notification.href ?? null;
      const isRead = Boolean(notification.isRead);
      const createdAt = notification.createdAt ?? new Date().toISOString();

      // Transient: fed into the legacy realtime feed (kept for backwards compat
      // with any consumers reading state.realtime.notifications).
      dispatch(addRealtimeNotification({ id, type, message, href, isRead, createdAt }));
      // Persistent: notification center slice. Prepend de-dupes by id so a
      // Pusher re-delivery after reconnect doesn't double-count unread.
      dispatch(prependNotification({ id, type, message, href, isRead, createdAt }));
      Toast.show({
        type: "info",
        text1: "New notification",
        text2: message,
      });
    });

    channel.bind(NEW_CHANNEL_EVENT, (payload: any) => {
      const ch = payload?.channel;
      if (!ch) return;
      const id = ch.id ?? ch._id;
      if (id) {
        dispatch(upsertChannel({ ...ch, id }));
      }
    });

    channel.bind(CHANNEL_UPDATED_EVENT, (payload: ChannelUpdatedPayload) => {
      if (!payload?.channelId) return;

      const isActive = activeChannelIdRef.current === payload.channelId;
      dispatch(
        updateChannelLastMessage({
          channelId: payload.channelId,
          lastMessagePreview: payload.lastMessagePreview,
          lastMessageAt: payload.lastMessageAt,
          ...(payload.unreadCountCleared || isActive
            ? { unreadCount: 0 }
            : payload.unreadCountIncrement
              ? { unreadCountIncrement: payload.unreadCountIncrement }
              : {}),
        }),
      );
    });

    channel.bind(CALL_INCOMING_EVENT, async (payload: any) => {
      if (!payload?.callSessionId) return;
      const callSessionId = String(payload.callSessionId);
      const callerName = String(payload.callerName ?? "Unknown");
      const mode: "AUDIO" | "VIDEO" = payload.mode === "VIDEO" ? "VIDEO" : "AUDIO";
      const channelId = String(payload.channelId ?? "");

      // Shared funnel: caches metadata, then rings only if the native FCM
      // service (or an earlier Pusher delivery) hasn't already rung this call.
      // The claim it awaits is a SharedPreferences round-trip, sub-millisecond.
      const surfaced = await surfaceIncomingCall({
        callSessionId,
        callerName,
        mode,
        callerId: String(payload.callerId ?? ""),
        channelId,
      });
      if (!surfaced) return;

      // Pre-warm the callee's LiveKit room in the background while the
      // ringtone plays. The token was minted at create-time on the server
      // and shipped in this Pusher payload, so we can open the WS + DTLS
      // handshake before the user has even tapped Accept.
      if (payload.token && payload.serverUrl && payload.timerDeadline && channelId) {
        prewarmCalleeRoom({
          callSessionId,
          channelId,
          token: String(payload.token),
          serverUrl: String(payload.serverUrl),
          timerDeadline: String(payload.timerDeadline),
          timeExtensionCount:
            typeof payload.timeExtensionCount === "number"
              ? payload.timeExtensionCount
              : 0,
        });
      }
    });

    channel.bind(CALL_CANCELLED_EVENT, (payload: any) => {
      if (!payload?.callSessionId) return;
      const callSessionId = String(payload.callSessionId);
      incomingCallMetadataMap.delete(callSessionId);
      forgetCallDispatch(callSessionId);
      endCallKeepCall(callSessionId);
      hideFullScreenCallNotification();
      clearCalleePrewarm(callSessionId);
    });

    channel.bind(CALL_MISSED_EVENT, (payload: any) => {
      if (!payload?.callSessionId) return;
      const callSessionId = String(payload.callSessionId);
      incomingCallMetadataMap.delete(callSessionId);
      forgetCallDispatch(callSessionId);
      endCallKeepCall(callSessionId);
      hideFullScreenCallNotification();
      clearCalleePrewarm(callSessionId);
    });

    // The call was accepted/rejected on another of THIS user's devices (same
    // account on web + another phone) — dismiss our ringing surfaces
    // immediately instead of letting them ring until the 45s timeout.
    channel.bind(CALL_HANDLED_EVENT, (payload: any) => {
      if (!payload?.callSessionId) return;
      const callSessionId = String(payload.callSessionId);
      // Ignore our own action's echo, and never tear down a call we're inside
      // (this device is the one that accepted).
      if (payload.byDeviceId && payload.byDeviceId === getDeviceId()) return;
      if (isCallActive(callSessionId)) return;
      incomingCallMetadataMap.delete(callSessionId);
      forgetCallDispatch(callSessionId);
      endCallKeepCall(callSessionId);
      hideFullScreenCallNotification();
      clearCalleePrewarm(callSessionId);
    });

    channel.bind(SUBSCRIPTION_UPDATED_EVENT, (payload: any) => {
      dispatch(
        updateUser({
          subscriptionStatus: payload.subscriptionStatus,
          subscriptionEnd: payload.subscriptionEnd,
          planSlug: payload.planSlug,
          ...(payload.questionsAsked !== undefined
            ? { questionsAsked: payload.questionsAsked }
            : {}),
          ...(payload.bonusQuestions !== undefined
            ? { bonusQuestions: payload.bonusQuestions }
            : {}),
        }),
      );
    });

    client.connection.bind("connected", () => {
      attempts = 0;
      clearReconnectTimer();
      dispatch(setRealtimeStatus({ status: "connected" }));
    });
    client.connection.bind("disconnected", () => scheduleReconnect());
    client.connection.bind("unavailable", () =>
      scheduleReconnect("Realtime connection unavailable."),
    );
    client.connection.bind("error", (error: any) =>
      scheduleReconnect(error?.message ?? "Realtime connection error."),
    );

    dispatch(setRealtimeStatus({ status: "connecting" }));
    client.connect();

    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        clearReconnectTimer();
        dispatch(setRealtimeStatus({ status: "connecting" }));
        client.connect();
      }
    });

    return () => {
      disposed = true;
      clearReconnectTimer();
      appStateSubscription.remove();
      channel.unbind_all();
      client.unsubscribe(channelName);
      client.connection.unbind("connected");
      client.connection.unbind("disconnected");
      client.connection.unbind("unavailable");
      client.connection.unbind("error");
    };
  }, [dispatch, userId]);

  return null;
}
