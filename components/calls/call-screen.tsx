import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Vibration,
  StyleSheet,
  Platform,
  useWindowDimensions,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Toast from "react-native-toast-message";
import { Audio } from "expo-av";
import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type VideoTrack as LKVideoTrack,
} from "livekit-client";
import { VideoView } from "@livekit/react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { api } from "@/lib/api";
import { useAppSelector } from "@/hooks/redux";
import { closeCall, minimizeCall, resolveCallRoomId } from "@/lib/call-ui-store";
import {
  endCallKeepCall,
  reportCallConnected,
  preAcceptedCallRef,
} from "@/lib/callkeep-setup";
import {
  consumeCallerPrewarm,
  consumeCalleePrewarm,
  consumePendingCreate,
} from "@/lib/call-prewarm";
import { startCallAudio, setCallSpeaker, stopCallAudio } from "@/lib/call-audio-session";
import { getDeviceId } from "@/lib/app-identity";
import {
  startOngoingCallService,
  stopOngoingCallService,
} from "@/lib/ongoing-call-service";
import { hideFullScreenCallNotification } from "@/lib/full-screen-call-notification";
import { markCallActive, clearActiveCall } from "@/lib/active-call";
import {
  getPusherClient,
  getUserPusherName,
  getChannelPusherName,
  CALL_ACCEPTED_EVENT,
  CALL_REJECTED_EVENT,
  CALL_ENDED_EVENT,
  CALL_CANCELLED_EVENT,
  CALL_MISSED_EVENT,
  CHANNEL_TIMER_UPDATED_EVENT,
} from "@/lib/realtime";

type CallStatus = "RINGING" | "ACTIVE" | "ENDED" | "REJECTED" | "MISSED" | "CANCELLED";

type CallSession = {
  callSessionId: string;
  channelId: string;
  teacherId: string;
  studentId: string;
  callerId: string | null;
  status: CallStatus;
  mode: "AUDIO" | "VIDEO";
  roomName: string;
  // Callee presence at create time — drives the caller's "Ringing…" vs
  // "Calling…" outgoing label. Only meaningful on the caller side.
  calleeIsOnline?: boolean;
  teacherName?: string | null;
  studentName?: string | null;
  teacherImage?: string | null;
  studentImage?: string | null;
};

type TokenPayload = {
  token: string;
  serverUrl: string;
  channelId: string;
  timerDeadline: string;
  timeExtensionCount: number;
};

const EXTENSION_MINUTES = 5;
const MAX_EXTENSIONS = 3;
const WARNING_THRESHOLD_MS = 5 * 60 * 1000;
const CONNECTION_TIMEOUT_MS = 20_000;
// Grace before treating "remote participant left the room" as a possible call
// end — covers transient peer network blips without delaying real hangups.
const REMOTE_LEFT_GRACE_MS = 2_000;

// Android renders each VideoView into its own SurfaceView, and SurfaceViews sit
// outside React Native's view hierarchy — stacking order comes from these
// values, not from JSX order or zIndex. Anything drawn ON TOP of another video
// surface (the PiP tile, the minimized bubble) must claim the overlay level or
// it is composited underneath and shows as a black rectangle. No-op on iOS.
const VIDEO_Z_STAGE = 0;
const VIDEO_Z_OVERLAY = 1;

function formatCountdown(ms: number) {
  if (ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type CallScreenProps = {
  /** Call-session id, or "pending" for the optimistic caller path. */
  roomId: string;
  channelId?: string | null;
  mode?: string | null;
  /** True when the persistent host is showing the floating bubble. */
  minimized: boolean;
  /**
   * False while the device is locked — the call is showing over the keyguard,
   * so shrinking it to the bubble would expose the rest of the app without
   * authentication. Hides every minimize affordance.
   */
  canMinimize?: boolean;
};

/**
 * The full call surface. Mounted by <PersistentCallHost/> at the ROOT layout —
 * NOT by a routed screen — so navigating around the app never unmounts it (and
 * never drops the LiveKit room). It unmounts only when the call actually ends
 * (closeCall()), which is when the cleanup effect below tears the room down.
 */
export function CallScreen({
  roomId: routeRoomId,
  channelId: routeChannelId,
  mode: routeMode,
  minimized,
  canMinimize = true,
}: CallScreenProps) {
  const pendingChannelId = routeChannelId ?? null;
  const pendingModeParam = routeMode === "VIDEO" ? "VIDEO" : "AUDIO";
  // Sticky for the lifetime of this mount. resolveCallRoomId() rewrites the
  // store's roomId from "pending" to the real id as soon as create resolves,
  // which would otherwise flip this mid-call and let the non-pending init
  // effect below re-fetch and overwrite the session we are already running.
  // A genuine remount re-reads the prop, which is exactly what we want.
  const isPendingRouteRef = useRef(routeRoomId === "pending");
  const isPendingRoute = isPendingRouteRef.current;

  const userId = useAppSelector((s) => s.user.data?._id ?? null);

  // The resolved call-session id. When we navigate to /call/pending optimistically
  // from the workspace button, this stays null until the create POST resolves;
  // after that everything in this screen keys off resolvedRoomId.
  const [resolvedRoomId, setResolvedRoomId] = useState<string | null>(
    isPendingRoute ? null : (routeRoomId ?? null),
  );
  const roomId = resolvedRoomId;

  // The call is a root-level overlay, not a routed screen — "exiting" the call
  // just closes the overlay and reveals whatever screen the user is on. No
  // navigation, no back-stack management.
  const goBack = () => closeCall();

  // Register this session as the active call so realtime-bridge / the native
  // accept handler suppress any duplicate incoming-call surface (e.g. a Pusher
  // re-delivery after the 30s dedupe window) for a call we're already inside.
  useEffect(() => {
    if (!roomId) return;
    markCallActive(roomId);
    // Once this screen is up the ringing surfaces are redundant — the user is
    // looking at the call UI. Tearing them down here covers every entry point
    // (accept from the notification, accept from this screen, tapping the
    // notification body, an outgoing call) with one rule. It also stops the
    // library's IncomingCallService, which is a *foreground* service: left
    // running it shows its own undismissable "QuestionCall is running" entry
    // until its 45s timeout fires.
    hideFullScreenCallNotification();
    return () => clearActiveCall(roomId);
  }, [roomId]);

  const [session, setSession] = useState<CallSession | null>(null);

  // While minimized there is no "Call ended / Go back" surface — when the call
  // reaches a terminal state, drop the bubble entirely.
  const sessionStatusForMin = session?.status;
  useEffect(() => {
    if (!minimized || !sessionStatusForMin) return;
    if (sessionStatusForMin !== "RINGING" && sessionStatusForMin !== "ACTIVE") {
      closeCall();
    }
  }, [minimized, sessionStatusForMin]);
  // For the optimistic-pending path we render the RINGING UI immediately and
  // never block on a "loading" spinner, so default to false there.
  const [loading, setLoading] = useState(!isPendingRoute);
  const [isAccepting, setIsAccepting] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const [isEnding, setIsEnding] = useState(false);

  // LiveKit state
  const roomRef = useRef<Room | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [localVideoTrack, setLocalVideoTrack] = useState<LKVideoTrack | null>(null);
  const [remoteCameraTrack, setRemoteCameraTrack] = useState<LKVideoTrack | null>(null);
  const [remoteScreenTrack, setRemoteScreenTrack] = useState<LKVideoTrack | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  // WhatsApp defaults: voice calls start on the earpiece, video calls on the
  // loudspeaker. routeMode can be null on deep-link cold starts — the effect
  // below re-aligns once the session (and its mode) loads, unless the user
  // has already toggled manually.
  const [speakerOn, setSpeakerOn] = useState(routeMode === "VIDEO");
  const userToggledSpeakerRef = useRef(false);
  const sessionMode = session?.mode;
  useEffect(() => {
    if (!sessionMode || userToggledSpeakerRef.current) return;
    setSpeakerOn(sessionMode === "VIDEO");
  }, [sessionMode]);
  // Local screen-share publishing (Android only — MediaProjection via
  // react-native-webrtc; iOS needs a ReplayKit broadcast extension, deferred).
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenShareBusy, setScreenShareBusy] = useState(false);
  // Flipped once enableCameraAndMicrophone() has resolved, i.e. once the OS has
  // actually granted RECORD_AUDIO/CAMERA. Drives the service re-arm below.
  const [tracksPublished, setTracksPublished] = useState(false);

  // Deliberately NOT gated on `connected`. Android 12+ refuses foreground
  // service starts from the background, and the accept → connected window is
  // long enough for the user to leave the app in it — the start would then be
  // refused and the call would die as soon as the process was backgrounded.
  // Starting at ACTIVE means we are still foreground when we ask. The
  // `phoneCall` type is always legal here; the effect below upgrades the type
  // mask to microphone/camera once tracks are actually published.
  useEffect(() => {
    if (session?.status !== "ACTIVE") return;

    startOngoingCallService(session.mode);
    return () => {
      stopOngoingCallService();
    };
  }, [session?.status, session?.mode]);

  // This first start can only claim the `phoneCall` foreground-service type:
  // on the caller side it runs the moment the callee accepts, before any track
  // is published, so RECORD_AUDIO/CAMERA aren't granted yet. Re-invoking
  // startForeground() after publishing upgrades the mask to include
  // microphone/camera, which Android 14+ requires to keep capturing while the
  // app is backgrounded. No stop/start — startForeground on a running service
  // just updates it, so the notification doesn't flicker.
  useEffect(() => {
    if (!tracksPublished || !connected || session?.status !== "ACTIVE") return;
    startOngoingCallService(session.mode);
  }, [tracksPublished, connected, session?.status, session?.mode]);
  // Whether the local PiP is the fullscreen view (and remote sits in the corner)
  const [pipSwapped, setPipSwapped] = useState(false);
  const remoteVideoTrack = remoteScreenTrack ?? remoteCameraTrack;
  const isViewingRemoteScreen = Boolean(remoteScreenTrack);

  const syncRemoteVideoTracks = useCallback((room: Room) => {
    let nextCameraTrack: LKVideoTrack | null = null;
    let nextScreenTrack: LKVideoTrack | null = null;

    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.videoTrackPublications.values()) {
        const track = publication.track;
        if (!track || publication.isMuted || track.kind !== Track.Kind.Video) {
          continue;
        }

        const videoTrack = track as LKVideoTrack;
        const isScreenShare =
          publication.source === Track.Source.ScreenShare ||
          videoTrack.source === Track.Source.ScreenShare;

        if (isScreenShare) {
          nextScreenTrack = videoTrack;
        } else if (publication.source === Track.Source.Camera || !nextCameraTrack) {
          nextCameraTrack = videoTrack;
        }
      }
    }

    setRemoteCameraTrack(nextCameraTrack);
    setRemoteScreenTrack(nextScreenTrack);
  }, []);

  useEffect(() => {
    if (remoteScreenTrack) {
      setPipSwapped(false);
    }
  }, [remoteScreenTrack]);

  // ── PiP drag ──────────────────────────────────────────────────────────────
  // The PiP is absolutely positioned anchored at bottom-right; the user can
  // grab it and drag it anywhere on the call surface.  translateX/Y are
  // offsets from that default position.  Bounds keep the whole PiP on screen.
  const { width: screenW, height: screenH } = useWindowDimensions();
  const PIP_W = 110;
  const PIP_H = 150;
  const PIP_DEFAULT_BOTTOM = Platform.OS === "ios" ? 132 : 116;
  const PIP_DEFAULT_RIGHT = 16;
  const PIP_EDGE_PAD = 12;
  const PIP_TOP_SAFE = Platform.OS === "ios" ? 70 : 50;
  const pipMinX = -(screenW - PIP_W - PIP_DEFAULT_RIGHT - PIP_EDGE_PAD);
  const pipMaxX = 0;
  const pipMinY = -(screenH - PIP_H - PIP_DEFAULT_BOTTOM - PIP_TOP_SAFE);
  const pipMaxY = 0;

  const pipTranslateX = useSharedValue(0);
  const pipTranslateY = useSharedValue(0);
  const pipStartX = useSharedValue(0);
  const pipStartY = useSharedValue(0);

  const togglePipSwapped = useCallback(() => {
    setPipSwapped((s) => !s);
  }, []);

  const pipPanGesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(6)
        .onStart(() => {
          pipStartX.value = pipTranslateX.value;
          pipStartY.value = pipTranslateY.value;
        })
        .onUpdate((e) => {
          const nx = pipStartX.value + e.translationX;
          const ny = pipStartY.value + e.translationY;
          pipTranslateX.value = Math.min(pipMaxX, Math.max(pipMinX, nx));
          pipTranslateY.value = Math.min(pipMaxY, Math.max(pipMinY, ny));
        })
        .onEnd(() => {
          // Soft spring settle so the corner doesn't feel rubbery on release
          pipTranslateX.value = withSpring(pipTranslateX.value, {
            damping: 20,
            stiffness: 200,
          });
          pipTranslateY.value = withSpring(pipTranslateY.value, {
            damping: 20,
            stiffness: 200,
          });
        }),
    [
      pipMaxX,
      pipMaxY,
      pipMinX,
      pipMinY,
      pipStartX,
      pipStartY,
      pipTranslateX,
      pipTranslateY,
    ],
  );

  const pipAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pipTranslateX.value }, { translateY: pipTranslateY.value }],
  }));

  // ── Pulse ring animation for ringing screen ───────────────────────────────
  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0.5);
  useEffect(() => {
    pulseScale.value = withRepeat(
      withSequence(
        withTiming(1.5, { duration: 1000 }),
        withTiming(1, { duration: 1000 }),
      ),
      -1,
      false,
    );
    pulseOpacity.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 1000 }),
        withTiming(0.5, { duration: 1000 }),
      ),
      -1,
      false,
    );
  }, [pulseOpacity, pulseScale]);

  const pulseRingStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  // ── Peer info (other call participant) ───────────────────────────────────
  const peerName = session
    ? userId === session.teacherId
      ? (session.studentName ?? null)
      : (session.teacherName ?? null)
    : null;
  const peerImage = session
    ? userId === session.teacherId
      ? (session.studentImage ?? null)
      : (session.teacherImage ?? null)
    : null;
  const peerInitial = peerName ? peerName.charAt(0).toUpperCase() : null;

  // Latest session + peer name held in refs so the Pusher lifecycle handlers
  // (bound once per roomId) can read current values without stale closures —
  // used to compose the "why wasn't the call answered" toast for the caller.
  const sessionRef = useRef<CallSession | null>(null);
  sessionRef.current = session;
  const peerNameRef = useRef<string | null>(null);
  peerNameRef.current = peerName;

  // Refs to break the infinite-retry loop and enforce single-flight connections
  const connectingRef = useRef(false);
  const connectionBlockedRef = useRef(false);

  // OPT-6: Store token from accept response to skip separate /token fetch
  const prefetchedTokenRef = useRef<TokenPayload | null>(null);

  // Channel timer
  const [timerDeadline, setTimerDeadline] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [timeExtensionCount, setTimeExtensionCount] = useState(0);
  const [isExtending, setIsExtending] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);

  const endingRef = useRef(false);
  // Grace timer armed when the only remote participant leaves the room
  // mid-call — see the ParticipantDisconnected handler in connectToRoom.
  const remoteLeftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const acceptHandlerRef = useRef<() => Promise<void>>(async () => {});
  // Tracks whether mic/camera have been published. Deferred past RINGING so
  // enableCameraAndMicrophone() doesn't claim the AVAudioSession while the
  // outgoing ringtone is playing.
  const tracksEnabledRef = useRef(false);

  // ── Outgoing ringtone (for the caller while the callee hasn't answered) ───
  const outgoingRingtoneRef = useRef<Audio.Sound | null>(null);
  const stopOutgoingRingtone = useCallback(async () => {
    const sound = outgoingRingtoneRef.current;
    if (sound) {
      outgoingRingtoneRef.current = null;
      try {
        await sound.stopAsync();
        await sound.unloadAsync();
      } catch {}
    }
  }, []);

  // ── Pre-warmed room (caller or callee) ────────────────────────────────────
  // If the workspace pre-warmed a LiveKit room for this channel, or if the
  // realtime-bridge pre-warmed one from the incoming-call Pusher payload,
  // we hand it directly to LiveKit state below instead of doing room.connect()
  // again. Set once on first non-pending mount and consumed lazily.
  const prewarmedRoomRef = useRef<Room | null>(null);

  // ── Optimistic-pending bootstrap ──────────────────────────────────────────
  // When this screen was opened via the workspace call button we navigated
  // optimistically to /call/pending while POST /calls/create was still in
  // flight. Render the caller-ringing UI immediately, then swap to the real
  // session id once create resolves.
  useEffect(() => {
    if (!isPendingRoute || !pendingChannelId || !userId) return;
    if (resolvedRoomId) return; // already resolved

    // Show the "Calling…" UI right away with a synthetic session.
    setSession({
      callSessionId: "pending",
      channelId: pendingChannelId,
      callerId: userId,
      teacherId: "",
      studentId: "",
      mode: pendingModeParam,
      status: "RINGING" as CallStatus,
      roomName: `channel_${pendingChannelId}`,
    });

    const pending = consumePendingCreate(pendingChannelId);
    const createPromise =
      pending?.promise ??
      api.post("/calls/create", {
        channelId: pendingChannelId,
        mode: pendingModeParam,
      });

    let cancelled = false;
    createPromise
      .then((res: any) => {
        if (cancelled) return;
        const data = res?.data ?? {};
        const realId = data.callSessionId ?? data.id;
        if (!realId) {
          throw new Error("Server did not return a call session id.");
        }
        // Cache caller token so connectToRoom skips a separate /token fetch.
        if (data.token && data.serverUrl) {
          prefetchedTokenRef.current = {
            token: data.token,
            serverUrl: data.serverUrl,
            channelId: data.channelId ?? pendingChannelId,
            timerDeadline: data.timerDeadline,
            timeExtensionCount: data.timeExtensionCount ?? 0,
          };
        }
        setSession({
          callSessionId: realId,
          channelId: data.channelId ?? pendingChannelId,
          callerId: data.callerId ?? userId,
          teacherId: data.teacherId ?? "",
          studentId: data.studentId ?? "",
          mode: (data.mode ?? pendingModeParam) as "AUDIO" | "VIDEO",
          // Normally RINGING, but the server dedupes a duplicate create back to
          // the call already in flight — which may already be ACTIVE. Assuming
          // RINGING there would leave us waiting for an accept event that has
          // already been delivered.
          status: (data.status === "ACTIVE" ? "ACTIVE" : "RINGING") as CallStatus,
          roomName: data.roomName ?? `channel_${pendingChannelId}`,
          calleeIsOnline: data.calleeIsOnline === true,
        });
        setResolvedRoomId(realId);
        // Promote the id into the global store too, so "pending" cannot
        // survive into any future remount and re-trigger this create.
        resolveCallRoomId(realId);
      })
      .catch((err: any) => {
        if (cancelled) return;
        const message =
          err?.response?.data?.error ??
          (err instanceof Error ? err.message : "Failed to start call");
        Toast.show({ type: "error", text1: message });
        goBack();
      });

    return () => {
      cancelled = true;
    };
  }, [isPendingRoute, pendingChannelId, pendingModeParam, userId, resolvedRoomId]);

  // ── Session initialization (non-pending route) ────────────────────────────
  // Callee path: preAcceptedCallRef may already hold a token from
  // full-screen-notification.acceptCall — go straight to ACTIVE in that case.
  // Otherwise fetch the session from the server.
  useEffect(() => {
    if (isPendingRoute) return;
    if (!routeRoomId) return;
    hideFullScreenCallNotification();

    const pre = preAcceptedCallRef.current;
    if (pre) {
      preAcceptedCallRef.current = null; // consume immediately
      prefetchedTokenRef.current = {
        token: pre.token,
        serverUrl: pre.serverUrl,
        channelId: pre.channelId,
        timerDeadline: pre.timerDeadline,
        timeExtensionCount: pre.timeExtensionCount,
      };
      // Pull in any pre-warmed callee room (started by realtime-bridge).
      const calleePrewarm = consumeCalleePrewarm(routeRoomId);
      if (calleePrewarm) {
        prewarmedRoomRef.current = calleePrewarm.room;
      }
      setSession({
        callSessionId: routeRoomId,
        channelId: pre.channelId,
        callerId: pre.callerId,
        mode: pre.mode,
        status: "ACTIVE" as CallStatus,
      } as CallSession);
      setLoading(false);
      return;
    }

    api
      .get(`/calls/${routeRoomId}`)
      .then((res) => setSession(res.data as CallSession))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[call] Failed to fetch session:", msg);
        Toast.show({
          type: "error",
          text1: "Couldn't load this call. Please try again.",
        });
      })
      .finally(() => setLoading(false));
  }, [isPendingRoute, routeRoomId]);

  // ── Consume the caller-side pre-warmed room ───────────────────────────────
  // Workspace pre-warms `channel_${channelId}` while the user is in chat.
  // Pick it up here so room.connect() in connectToRoom() becomes a no-op.
  useEffect(() => {
    if (prewarmedRoomRef.current) return;
    const channelIdToConsume = session?.channelId;
    if (!channelIdToConsume) return;
    const slot = consumeCallerPrewarm(channelIdToConsume);
    if (slot) {
      prewarmedRoomRef.current = slot.room;
      // If the pre-warm endpoint returned a fresher token than the caller
      // got from /calls/create, prefer that one (covers the rare case where
      // create response had no token because LiveKit wasn't yet configured
      // at the moment of the POST).
      if (!prefetchedTokenRef.current) {
        prefetchedTokenRef.current = slot.token;
      }
    }
  }, [session?.channelId]);

  // ── Connect to LiveKit ─────────────────────────────────────────────────────
  // Supports both ACTIVE (both users) and RINGING (caller only, OPT-3).
  // Pass skipTracks=true during RINGING so enableCameraAndMicrophone() is
  // deferred until ACTIVE — this keeps the AVAudioSession free for the ringtone.
  const connectToRoom = useCallback(
    async (skipTracks = false) => {
      if (
        !roomId ||
        connectingRef.current ||
        connected ||
        endingRef.current ||
        connectionBlockedRef.current
      )
        return;
      connectingRef.current = true;
      setConnecting(true);
      setConnectionError(null);

      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        connectionBlockedRef.current = true;
        connectingRef.current = false;
        setConnecting(false);
        setConnectionError("Connection timed out — check your internet and try again.");
        roomRef.current?.disconnect();
        roomRef.current = null;
      }, CONNECTION_TIMEOUT_MS);

      try {
        // OPT-6: Use prefetched token from accept response if available
        let data: TokenPayload;
        if (prefetchedTokenRef.current) {
          data = prefetchedTokenRef.current;
          prefetchedTokenRef.current = null;
        } else {
          const res = await api.get(`/calls/${roomId}/token`);
          data = res.data as TokenPayload;
        }

        if (timedOut) return;

        setChannelId(data.channelId);
        setTimerDeadline(data.timerDeadline);
        setTimeExtensionCount(data.timeExtensionCount);

        // Reuse a pre-warmed room if one is waiting. The WebSocket + DTLS
        // handshake (the slowest part of room.connect, ~1.5-3s) is already done
        // — we just attach our event listeners and skip straight to publishing.
        const prewarmed = prewarmedRoomRef.current;
        prewarmedRoomRef.current = null;
        const room = prewarmed ?? new Room({ adaptiveStream: false, dynacast: false });
        roomRef.current = room;

        const syncRoomVideoTracks = () => {
          if (roomRef.current === room) {
            syncRemoteVideoTracks(room);
          }
        };

        room.on(RoomEvent.TrackPublished, syncRoomVideoTracks);
        room.on(RoomEvent.TrackSubscribed, syncRoomVideoTracks);
        room.on(RoomEvent.TrackMuted, syncRoomVideoTracks);
        room.on(RoomEvent.TrackUnmuted, syncRoomVideoTracks);
        room.on(RoomEvent.TrackUnpublished, syncRoomVideoTracks);
        room.on(RoomEvent.TrackUnsubscribed, syncRoomVideoTracks);
        room.on(RoomEvent.Disconnected, () => {
          // Immediately null out the ref so no further operations touch this room
          roomRef.current = null;
          setConnected(false);
          setLocalVideoTrack(null);
          setRemoteCameraTrack(null);
          setRemoteScreenTrack(null);
          setScreenSharing(false);
          if (!endingRef.current) {
            connectingRef.current = false;
            connectionBlockedRef.current = false;
            tracksEnabledRef.current = false;
            setConnecting(false);
            setConnectionError(null);
            Toast.show({ type: "info", text1: "Reconnecting call..." });
          }
        });
        room.on(RoomEvent.LocalTrackPublished, (pub) => {
          if (pub.source === Track.Source.ScreenShare) {
            setScreenSharing(true);
            return; // never treat our own screen capture as the camera PiP feed
          }
          if (pub.track?.kind === Track.Kind.Video)
            setLocalVideoTrack(pub.track as LKVideoTrack);
        });
        room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
          if (pub.source === Track.Source.ScreenShare) {
            // Covers the system-side stop (user taps "Stop casting" in the
            // Android notification shade) as well as our own toggle.
            setScreenSharing(false);
            return;
          }
          if (pub.track?.kind === Track.Kind.Video) setLocalVideoTrack(null);
        });

        // WhatsApp-style instant drop: when the only remote participant leaves
        // the room mid-call, verify the session with the server after a short
        // grace and end locally. Covers peers whose `call:ended` Pusher event
        // was dropped and peers whose app was killed — the SFU's
        // participant-left signal arrives near-instantly on explicit hangups.
        const clearRemoteLeftTimer = () => {
          if (remoteLeftTimerRef.current) {
            clearTimeout(remoteLeftTimerRef.current);
            remoteLeftTimerRef.current = null;
          }
        };
        room.on(RoomEvent.ParticipantConnected, clearRemoteLeftTimer);
        room.on(RoomEvent.ParticipantDisconnected, () => {
          if (endingRef.current) return;
          if (sessionRef.current?.status !== "ACTIVE") return;
          if (room.remoteParticipants.size > 0) return;
          clearRemoteLeftTimer();
          remoteLeftTimerRef.current = setTimeout(() => {
            remoteLeftTimerRef.current = null;
            if (endingRef.current || roomRef.current !== room) return;
            if (room.remoteParticipants.size > 0) return;
            void (async () => {
              try {
                const res = await api.get(`/calls/${roomId}`);
                const status = (res.data as { status?: string } | null)?.status;
                if (
                  status &&
                  status !== "ACTIVE" &&
                  status !== "RINGING" &&
                  !endingRef.current
                ) {
                  endingRef.current = true;
                  Toast.show({ type: "info", text1: "Call ended" });
                  roomRef.current?.disconnect();
                  goBack();
                }
              } catch {
                // Status check failed — leave teardown to the Pusher event.
              }
            })();
          }, REMOTE_LEFT_GRACE_MS);
        });

        const isVideo = session?.mode === "VIDEO";
        if (prewarmed && prewarmed.state === ConnectionState.Connected) {
          // Pre-warm already finished — nothing to do.
        } else if (prewarmed && prewarmed.state === ConnectionState.Connecting) {
          // Pre-warm raced with accept; wait for the in-flight handshake.
          await new Promise<void>((resolve, reject) => {
            const onState = (state: ConnectionState) => {
              if (state === ConnectionState.Connected) {
                room.off(RoomEvent.ConnectionStateChanged, onState);
                resolve();
              } else if (state === ConnectionState.Disconnected) {
                room.off(RoomEvent.ConnectionStateChanged, onState);
                reject(new Error("Pre-warmed room disconnected before activation."));
              }
            };
            room.on(RoomEvent.ConnectionStateChanged, onState);
          });
        } else {
          // Cold path — no pre-warm, or pre-warm dropped — do the full connect.
          await room.connect(data.serverUrl, data.token);
        }

        if (timedOut) {
          room.disconnect();
          return;
        }

        // Pick up any remote tracks the pre-warmed room subscribed to before we
        // attached the listener above (race: caller publishes between callee
        // pre-warm-connect and callee accept).
        syncRemoteVideoTracks(room);

        // Same race on our own camera: a pre-warmed room may already have
        // published it before LocalTrackPublished was bound, in which case
        // nothing would ever populate localVideoTrack and the PiP would sit on
        // its placeholder until the user toggled the camera.
        const existingLocalPub = room.localParticipant.getTrackPublication(
          Track.Source.Camera,
        );
        if (existingLocalPub?.track) {
          setLocalVideoTrack(existingLocalPub.track as LKVideoTrack);
        }

        // Only publish tracks immediately when the call is already ACTIVE.
        // During RINGING pre-join (caller side), defer publishing so the
        // AVAudioSession stays in Playback mode and the ringtone plays cleanly.
        if (!skipTracks) {
          await startCallAudio(isVideo ? "VIDEO" : "AUDIO", speakerOn);
          tracksEnabledRef.current = true;
          await room.localParticipant.enableCameraAndMicrophone();
          setTracksPublished(true);

          if (!isVideo) {
            await room.localParticipant.setCameraEnabled(false);
            setCamEnabled(false);
          }

          const localVideoPub = room.localParticipant.getTrackPublication(
            Track.Source.Camera,
          );
          if (localVideoPub?.track)
            setLocalVideoTrack(localVideoPub.track as LKVideoTrack);
        }

        clearTimeout(timeoutId);
        setConnected(true);
        if (roomId) reportCallConnected(roomId);
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (!timedOut) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Filter out NegotiationError from closed PC manager — this is
          // expected when the room was torn down during connection.
          const isStaleNegotiation = errMsg.includes("PC manager is closed");
          if (!isStaleNegotiation) {
            console.error("[call] Room connection failed:", errMsg);
            connectionBlockedRef.current = true;
            setConnectionError(
              "Couldn't connect to the call. Check your internet and try again.",
            );
          }
          roomRef.current?.disconnect();
          roomRef.current = null;
        }
      } finally {
        if (!timedOut) {
          connectingRef.current = false;
          setConnecting(false);
        }
      }
    },
    [roomId, connected, session?.mode, speakerOn, syncRemoteVideoTracks],
  );

  // OPT-3: Caller can connect during RINGING; callee auto-accepts on RINGING
  useEffect(() => {
    if (connected || connecting || connectionError) return;
    if (session?.status === "ACTIVE") {
      void connectToRoom();
    } else if (session?.status === "RINGING" && session.callerId && userId) {
      if (session.callerId === userId) {
        // Caller pre-joins the LiveKit room while ringing but defers
        // enableCameraAndMicrophone() so the ringtone audio session is undisturbed.
        void connectToRoom(true);
      } else {
        // Callee arrived at call screen (from overlay) — auto-accept
        void acceptHandlerRef.current();
      }
    }
  }, [
    session?.status,
    session?.callerId,
    userId,
    connected,
    connecting,
    connectionError,
    connectToRoom,
  ]);

  // ── Enable tracks when RINGING → ACTIVE (caller side) ───────────────────
  // connectToRoom() was called with skipTracks=true during pre-join; once the
  // callee accepts the session flips to ACTIVE — publish mic/cam at that point.
  useEffect(() => {
    if (session?.status !== "ACTIVE" || !connected || tracksEnabledRef.current) return;
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    tracksEnabledRef.current = true;
    const isVideo = session.mode === "VIDEO";
    (async () => {
      try {
        await startCallAudio(isVideo ? "VIDEO" : "AUDIO", speakerOn);
        await room.localParticipant.enableCameraAndMicrophone();
        setTracksPublished(true);
        if (!isVideo) {
          await room.localParticipant.setCameraEnabled(false);
          setCamEnabled(false);
        }
        const localVideoPub = room.localParticipant.getTrackPublication(
          Track.Source.Camera,
        );
        if (localVideoPub?.track) setLocalVideoTrack(localVideoPub.track as LKVideoTrack);
      } catch (err) {
        console.warn(
          "[call] Failed to enable tracks on ACTIVE:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }, [session?.status, session?.mode, connected, speakerOn]);

  // ── Outgoing ringback: play while RINGING for the caller ──────────────────
  // WhatsApp behavior: silence while POST /calls/create is in flight
  // ("Calling…"), ringback starts only once the server confirms the callee is
  // being rung (roomId resolves — the same moment the Pusher call:incoming
  // event went out), routed through the earpiece at call volume for voice
  // calls (speaker for video calls).
  useEffect(() => {
    const status = session?.status;
    const callerId = session?.callerId;
    const isVideo = session?.mode === "VIDEO";
    if (!status || !userId) return;

    const isCaller = callerId === userId;

    if (status === "RINGING" && isCaller && roomId) {
      let cancelled = false;
      const play = async () => {
        try {
          // Enter communication audio mode first — the ringback (and the
          // pre-joined WebRTC room) then live on the voice-call stream, so
          // hardware volume keys adjust call volume while it plays.
          await startCallAudio(isVideo ? "VIDEO" : "AUDIO");
          await Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            staysActiveInBackground: true,
            shouldDuckAndroid: false,
            // Android-only: route through the earpiece for voice calls.
            playThroughEarpieceAndroid: !isVideo,
          });
          if (cancelled) return;
          const { sound } = await Audio.Sound.createAsync(
            require("../../assets/sounds/outgoing_ringtone.mp3"),
            { shouldPlay: true, isLooping: true, volume: 1.0 },
          );
          if (cancelled) {
            // Status flipped while the sound was loading — never let it ring
            // into the live call.
            try {
              await sound.stopAsync();
              await sound.unloadAsync();
            } catch {}
            return;
          }
          await sound.setIsLoopingAsync(true);
          outgoingRingtoneRef.current = sound;
        } catch (err) {
          console.warn("[call] Failed to play outgoing ringtone:", err);
        }
      };
      void play();
      return () => {
        cancelled = true;
        void stopOutgoingRingtone();
      };
    }

    // Not (or no longer) in the caller-RINGING state — ensure silence.
    void stopOutgoingRingtone();
    return () => {
      void stopOutgoingRingtone();
    };
  }, [
    session?.status,
    session?.callerId,
    session?.mode,
    userId,
    roomId,
    stopOutgoingRingtone,
  ]);

  const handleRetry = useCallback(() => {
    connectionBlockedRef.current = false;
    connectingRef.current = false;
    tracksEnabledRef.current = false;
    setConnectionError(null);
    void connectToRoom();
  }, [connectToRoom]);

  // ── Cleanup room on unmount ───────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopOngoingCallService();
      stopOutgoingRingtone();
      if (remoteLeftTimerRef.current) {
        clearTimeout(remoteLeftTimerRef.current);
        remoteLeftTimerRef.current = null;
      }
      if (roomId) endCallKeepCall(roomId);
      const room = roomRef.current;
      if (room) {
        room.removeAllListeners();
        if (room.state !== ConnectionState.Disconnected) {
          room.disconnect();
        }
      }
      roomRef.current = null;
      // Pre-warmed room that we consumed but never promoted to roomRef
      // (e.g. user backed out before connectToRoom ran).
      const stale = prewarmedRoomRef.current;
      if (stale) {
        stale.removeAllListeners();
        if (stale.state !== ConnectionState.Disconnected) {
          stale.disconnect();
        }
        prewarmedRoomRef.current = null;
      }
      // Hand the device back to its default audio state (media on the
      // loudspeaker, volume keys on the ringer) — stops the LiveKit audio
      // session and resets expo-av to neutral defaults.
      void stopCallAudio();
    };
  }, [stopOutgoingRingtone, roomId]);

  // ── Channel timer countdown ───────────────────────────────────────────────
  useEffect(() => {
    if (!timerDeadline) return;
    const update = () => {
      setCountdown(Math.max(0, new Date(timerDeadline).getTime() - Date.now()));
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [timerDeadline]);

  // ── Pusher: listen for call lifecycle + timer events ──────────────────────
  useEffect(() => {
    if (!userId || !roomId) return;
    const client = getPusherClient();
    if (!client) return;

    const userChannel = client.subscribe(getUserPusherName(userId));

    // Caller-only: explain why the call wasn't answered, then bounce back to
    // the channel list with the toast still visible. These events only reach
    // the caller (the server emits reject/missed to the caller's channel), but
    // we guard on callerId anyway. "declined" = they were reachable and said
    // no; "missed" splits on presence at create time — online-but-no-pickup vs
    // simply offline (only the push wake-up reached them).
    const notifyUnanswered = (kind: "declined" | "missed") => {
      const s = sessionRef.current;
      if (!s || s.callerId !== userId || endingRef.current) return;
      endingRef.current = true;
      const peer = peerNameRef.current || "They";
      if (kind === "declined") {
        Toast.show({
          type: "info",
          text1: "Call declined",
          text2: `${peer} declined your call.`,
        });
      } else if (s.calleeIsOnline) {
        Toast.show({
          type: "info",
          text1: "No answer",
          text2: `${peer} was online but didn't pick up.`,
        });
      } else {
        Toast.show({
          type: "info",
          text1: "No answer",
          text2: `${peer} isn't online right now — they'll get a missed-call notification.`,
        });
      }
      goBack();
    };

    const handleAccepted = (payload: any) => {
      if (payload?.callSessionId !== roomId) return;
      setSession((prev) => (prev ? { ...prev, status: "ACTIVE" } : prev));
    };
    const handleRejected = (payload: any) => {
      if (payload?.callSessionId !== roomId) return;
      setSession((prev) => (prev ? { ...prev, status: "REJECTED" } : prev));
      notifyUnanswered("declined");
    };
    const handleMissed = (payload: any) => {
      if (payload?.callSessionId !== roomId) return;
      setSession((prev) => (prev ? { ...prev, status: "MISSED" } : prev));
      notifyUnanswered("missed");
    };
    const handleCancelled = (payload: any) => {
      if (payload?.callSessionId !== roomId) return;
      setSession((prev) => (prev ? { ...prev, status: "CANCELLED" } : prev));
    };

    userChannel.bind(CALL_ACCEPTED_EVENT, handleAccepted);
    userChannel.bind(CALL_REJECTED_EVENT, handleRejected);
    userChannel.bind(CALL_MISSED_EVENT, handleMissed);
    userChannel.bind(CALL_CANCELLED_EVENT, handleCancelled);

    return () => {
      userChannel.unbind(CALL_ACCEPTED_EVENT, handleAccepted);
      userChannel.unbind(CALL_REJECTED_EVENT, handleRejected);
      userChannel.unbind(CALL_MISSED_EVENT, handleMissed);
      userChannel.unbind(CALL_CANCELLED_EVENT, handleCancelled);
    };
  }, [userId, roomId]);

  // Channel-scoped Pusher for timer updates + call ended
  useEffect(() => {
    const chId = channelId ?? session?.channelId;
    if (!chId) return;
    const client = getPusherClient();
    if (!client) return;

    const ch = client.subscribe(getChannelPusherName(chId));

    const handleTimerUpdate = (payload: any) => {
      if (payload?.timerDeadline) setTimerDeadline(payload.timerDeadline);
      if (typeof payload?.timeExtensionCount === "number")
        setTimeExtensionCount(payload.timeExtensionCount);
    };

    const handleEnded = (payload: any) => {
      if (payload?.callSessionId !== roomId) return;
      if (!endingRef.current) {
        endingRef.current = true;
        Toast.show({ type: "info", text1: "Call ended" });
        roomRef.current?.disconnect();
        goBack();
      }
    };

    ch.bind(CHANNEL_TIMER_UPDATED_EVENT, handleTimerUpdate);
    ch.bind(CALL_ENDED_EVENT, handleEnded);

    return () => {
      ch.unbind(CHANNEL_TIMER_UPDATED_EVENT, handleTimerUpdate);
      ch.unbind(CALL_ENDED_EVENT, handleEnded);
      client.unsubscribe(getChannelPusherName(chId));
    };
  }, [channelId, session?.channelId, roomId]);

  // ── Call actions ──────────────────────────────────────────────────────────
  const handleAccept = async () => {
    if (!session) return;
    setIsAccepting(true);
    try {
      const res = await api.post(`/calls/${session.callSessionId}/accept`, {
        deviceId: getDeviceId(),
      });
      // OPT-6: Accept response includes token — store it so connectToRoom skips /token fetch
      const data = res.data as any;
      if (data?.token && data?.serverUrl) {
        prefetchedTokenRef.current = {
          token: data.token,
          serverUrl: data.serverUrl,
          channelId: data.channelId,
          timerDeadline: data.timerDeadline,
          timeExtensionCount: data.timeExtensionCount ?? 0,
        };
      }
      setSession((prev) => (prev ? { ...prev, status: "ACTIVE" } : prev));
      Vibration.cancel();
    } catch (err: unknown) {
      console.error(
        "[call] Accept failed:",
        err instanceof Error ? err.message : String(err),
      );
      Toast.show({ type: "error", text1: "Couldn't accept the call. Please try again." });
    } finally {
      setIsAccepting(false);
    }
  };
  acceptHandlerRef.current = handleAccept;

  const handleDecline = async () => {
    if (!session) return;
    setIsDeclining(true);
    try {
      await api.post(`/calls/${session.callSessionId}/reject`, {
        deviceId: getDeviceId(),
      });
      Vibration.cancel();
      goBack();
    } catch (err: unknown) {
      console.error(
        "[call] Decline failed:",
        err instanceof Error ? err.message : String(err),
      );
      goBack();
    } finally {
      setIsDeclining(false);
    }
  };

  const handleEnd = async () => {
    if (!session || endingRef.current) return;
    stopOutgoingRingtone();
    stopOngoingCallService();
    endingRef.current = true;
    setIsEnding(true);

    // Caller pressed end while /calls/create was still in flight. We don't
    // have a real session id yet, so just bail to channels — the in-flight
    // POST will land and the server will mark the call MISSED when the
    // 30s RINGING timeout fires. (Could await + cancel for cleaner UX,
    // but this is a sub-second race window.)
    if (isPendingRoute && !resolvedRoomId) {
      setIsEnding(false);
      goBack();
      return;
    }

    // Fire the end/cancel API FIRST so the server's Pusher event races to the
    // peer immediately; the room disconnect below reaches them in parallel via
    // the SFU participant-left signal. If the call is still RINGING and we are
    // the caller, this is a cancellation — /cancel broadcasts
    // CALL_CANCELLED_EVENT so the callee's ringing surfaces dismiss instantly.
    const isCallerCancelling =
      session.status === "RINGING" && session.callerId === userId;
    const endpoint = isCallerCancelling
      ? `/calls/${session.callSessionId}/cancel`
      : `/calls/${session.callSessionId}/end`;
    const endRequest = api.post(endpoint);

    endCallKeepCall(session.callSessionId);

    // Disconnect room to prevent NegotiationError from stale PC
    const room = roomRef.current;
    if (room) {
      room.removeAllListeners();
      room.disconnect();
      roomRef.current = null;
    }

    try {
      await endRequest;
    } catch (err: unknown) {
      console.error(
        "[call] End/cancel call API failed:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setIsEnding(false);
      goBack();
    }
  };

  const toggleMic = async () => {
    const room = roomRef.current;
    if (!room || room.state === ConnectionState.Disconnected) return;
    const next = !micEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
    } catch (err: unknown) {
      console.warn(
        "[call] Toggle mic failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const toggleCam = async () => {
    const room = roomRef.current;
    if (!room || room.state === ConnectionState.Disconnected) return;
    const next = !camEnabled;
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCamEnabled(next);
      if (next) {
        const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (pub?.track) setLocalVideoTrack(pub.track as LKVideoTrack);
      } else {
        setLocalVideoTrack(null);
      }
    } catch (err: unknown) {
      console.warn(
        "[call] Toggle camera failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const toggleSpeaker = async () => {
    const next = !speakerOn;
    userToggledSpeakerRef.current = true;
    setSpeakerOn(next);
    await setCallSpeaker(next);
  };

  // Android-only for now: react-native-webrtc drives the MediaProjection
  // consent dialog + its own mediaProjection foreground service. iOS needs a
  // ReplayKit broadcast extension (deferred), so the button is hidden there.
  const toggleScreenShare = async () => {
    const room = roomRef.current;
    if (!room || room.state === ConnectionState.Disconnected || screenShareBusy) return;
    const next = !screenSharing;
    setScreenShareBusy(true);
    try {
      await room.localParticipant.setScreenShareEnabled(next);
      setScreenSharing(next);
    } catch (err: unknown) {
      // Most common failure: the user dismissed the system consent dialog.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/permission|denied|cancel/i.test(msg)) {
        console.warn("[call] Toggle screen share failed:", msg);
        Toast.show({
          type: "error",
          text1: "Couldn't share your screen. Please try again.",
        });
      }
    } finally {
      setScreenShareBusy(false);
    }
  };

  const facingModeRef = useRef<"user" | "environment">("user");
  const switchCamera = async () => {
    const room = roomRef.current;
    if (!room || room.state === ConnectionState.Disconnected) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (pub?.track && "restartTrack" in pub.track) {
      facingModeRef.current = facingModeRef.current === "user" ? "environment" : "user";
      try {
        await (pub.track as any).restartTrack({
          facingMode: facingModeRef.current,
        });
      } catch (err: unknown) {
        console.warn(
          "[call] Switch camera failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  const handleExtendTime = async () => {
    if (!channelId || isExtending) return;
    setIsExtending(true);
    try {
      const res = await api.post(`/channels/${channelId}/extend`);
      setTimerDeadline(res.data.timerDeadline);
      setTimeExtensionCount(res.data.timeExtensionCount);
      Toast.show({ type: "success", text1: `Added ${EXTENSION_MINUTES} more minutes` });
    } catch {
      Toast.show({
        type: "error",
        text1: "Couldn't extend the call. Please try again.",
      });
    } finally {
      setIsExtending(false);
    }
  };

  // ── Render: minimized floating bubble ────────────────────────────────────
  // The host provides the draggable/tappable container; this renders only the
  // bubble CONTENT (remote video or avatar + timer). pointerEvents flows to
  // the host's touchable, which expands on tap.
  if (minimized) {
    const bubbleTrack = session?.status === "ACTIVE" ? remoteVideoTrack : null;
    return (
      <View style={styles.miniRoot} pointerEvents="none">
        {bubbleTrack ? (
          <VideoView
            videoTrack={bubbleTrack}
            style={styles.miniVideo}
            objectFit="cover"
            mirror={false}
            // The bubble floats over whatever screen the user navigated to,
            // which may itself be playing video (a course lesson, say).
            zOrder={VIDEO_Z_OVERLAY}
          />
        ) : (
          <View style={styles.miniAvatarWrap}>
            {peerImage ? (
              <Image source={{ uri: peerImage }} style={styles.miniAvatar} />
            ) : (
              <View style={styles.miniAvatarFallback}>
                {peerInitial ? (
                  <Text style={styles.miniInitial}>{peerInitial}</Text>
                ) : (
                  <Ionicons name="call" size={22} color="#fff" />
                )}
              </View>
            )}
          </View>
        )}
        <View style={styles.miniFooter}>
          <Ionicons
            name={
              session?.status === "RINGING"
                ? "call-outline"
                : micEnabled
                  ? "mic"
                  : "mic-off"
            }
            size={11}
            color="#fff"
          />
          {screenSharing ? (
            <Ionicons name="phone-portrait-outline" size={11} color="#4ade80" />
          ) : null}
          <Text style={styles.miniTimer}>
            {session?.status === "RINGING" ? "Ringing…" : formatCountdown(countdown)}
          </Text>
        </View>
      </View>
    );
  }

  // ── Render: Loading ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.centered}>
        <Ionicons name="call-outline" size={56} color="#ffffff40" />
        <Text style={styles.mutedText}>Call not found</Text>
        <TouchableOpacity onPress={() => goBack()} style={styles.backBtn}>
          <Text style={styles.whiteText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isIncoming = session.callerId !== null && session.callerId !== userId;
  const isVideo = session.mode === "VIDEO";

  const extensionsRemaining = Math.max(0, MAX_EXTENSIONS - timeExtensionCount);
  const canExtend =
    channelId != null &&
    countdown > 0 &&
    countdown <= WARNING_THRESHOLD_MS &&
    extensionsRemaining > 0;

  // ── Render: RINGING ───────────────────────────────────────────────────────
  if (session.status === "RINGING") {
    const gradientColors = isIncoming
      ? (["#0f0c29", "#302b63", "#24243e"] as const)
      : (["#0d1b2a", "#1b4332", "#0d1b2a"] as const);

    return (
      <LinearGradient colors={gradientColors} style={styles.ringingContainer}>
        {/* Caller can tuck the ringing screen away and keep browsing; the
            bubble keeps ringing state visible. Incoming calls stay fullscreen
            so Accept/Decline are always reachable. */}
        {!isIncoming && canMinimize ? (
          <TouchableOpacity
            onPress={minimizeCall}
            style={styles.ringingMinimizeBtn}
            hitSlop={8}
          >
            <Ionicons name="chevron-down" size={22} color="#fff" />
          </TouchableOpacity>
        ) : null}
        <View style={styles.ringingTop}>
          {/* Pulsing ring behind avatar */}
          <View style={styles.avatarWrapper}>
            <Animated.View style={[styles.pulseRing, pulseRingStyle]} />
            <View style={styles.avatarCircle}>
              {peerImage ? (
                <Image source={{ uri: peerImage }} style={styles.avatarImage} />
              ) : peerInitial ? (
                <Text style={styles.avatarInitial}>{peerInitial}</Text>
              ) : (
                <Ionicons name={isVideo ? "videocam" : "call"} size={48} color="#fff" />
              )}
            </View>
          </View>

          {peerName ? <Text style={styles.peerNameText}>{peerName}</Text> : null}
          <Text style={styles.titleText}>
            {isIncoming
              ? "Incoming call"
              : session.calleeIsOnline
                ? "Ringing…"
                : "Calling…"}
          </Text>
          <Text style={styles.subtitleText}>
            {!isIncoming && !session.calleeIsOnline
              ? `${isVideo ? "Video call" : "Voice call"} · Reaching them…`
              : isVideo
                ? "Video call"
                : "Voice call"}
          </Text>
        </View>

        {isIncoming ? (
          <View style={styles.ringingButtons}>
            <View style={styles.ringingBtnGroup}>
              <TouchableOpacity
                onPress={handleDecline}
                disabled={isDeclining}
                style={[styles.circleBtn, { backgroundColor: "#ef4444" }]}
              >
                {isDeclining ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Ionicons
                    name="call"
                    size={32}
                    color="#fff"
                    style={{ transform: [{ rotate: "135deg" }] }}
                  />
                )}
              </TouchableOpacity>
              <Text style={styles.btnLabel}>Decline</Text>
            </View>
            <View style={styles.ringingBtnGroup}>
              <TouchableOpacity
                onPress={handleAccept}
                disabled={isAccepting}
                style={[styles.circleBtn, { backgroundColor: "#22c55e" }]}
              >
                {isAccepting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Ionicons name={isVideo ? "videocam" : "call"} size={32} color="#fff" />
                )}
              </TouchableOpacity>
              <Text style={styles.btnLabel}>Accept</Text>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            onPress={handleEnd}
            style={[styles.circleBtn, { backgroundColor: "#ef4444" }]}
          >
            <Ionicons
              name="call"
              size={32}
              color="#fff"
              style={{ transform: [{ rotate: "135deg" }] }}
            />
          </TouchableOpacity>
        )}
      </LinearGradient>
    );
  }

  // ── Render: ACTIVE — LiveKit room ─────────────────────────────────────────
  if (session.status === "ACTIVE") {
    if (connectionError) {
      return (
        <View style={styles.centered}>
          <Ionicons name="wifi-outline" size={56} color="#ffffff40" />
          <Text
            style={[
              styles.whiteText,
              { fontSize: 18, fontWeight: "600", marginTop: 16, textAlign: "center" },
            ]}
          >
            Failed to connect
          </Text>
          <Text
            style={[
              styles.mutedText,
              { textAlign: "center", fontSize: 14, marginTop: 4 },
            ]}
          >
            {connectionError}
          </Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 28 }}>
            <TouchableOpacity
              onPress={handleRetry}
              style={[styles.backBtn, { backgroundColor: "#3b82f660" }]}
            >
              <Text style={styles.whiteText}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => goBack()} style={styles.backBtn}>
              <Text style={styles.whiteText}>Leave</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    // Render the active call UI as soon as we hit ACTIVE — even before the
    // LiveKit room finishes connecting. The user sees their own camera feed
    // (or a "Voice call" placeholder) instead of a black "Connecting…" screen,
    // and remote tracks pop in as they arrive. WhatsApp-style perceived speed.
    // No early return here; falls through to the layout below.

    // PiP / swap layout: by default the remote feed is fullscreen and the
    // local camera sits in the corner.  Tapping the PiP swaps them so the
    // local feed fills the screen and the remote feed becomes the overlay.
    const localAvailable = !!localVideoTrack && camEnabled;
    const remoteAvailable = !!remoteVideoTrack;
    const effectiveSwap = !isViewingRemoteScreen && pipSwapped && localAvailable;
    const mainIsLocal = effectiveSwap;
    const mainIsRemoteScreen = !mainIsLocal && isViewingRemoteScreen;
    const mainTrack = mainIsLocal ? localVideoTrack : remoteVideoTrack;
    const pipIsLocal = !mainIsLocal;
    const pipIsRemoteScreen = !pipIsLocal && isViewingRemoteScreen;
    const pipTrackAvailable = pipIsLocal ? localAvailable : remoteAvailable;
    const pipTrack = pipIsLocal ? localVideoTrack : remoteVideoTrack;
    const showPip = isVideo && (localAvailable || remoteAvailable);

    return (
      <View style={styles.activeContainer}>
        {/* Main video (fullscreen) */}
        {mainTrack ? (
          mainIsRemoteScreen ? (
            <View style={styles.screenShareStage}>
              <VideoView
                videoTrack={mainTrack}
                style={styles.screenShareVideo}
                objectFit="contain"
                mirror={false}
                zOrder={VIDEO_Z_STAGE}
              />
            </View>
          ) : (
            <VideoView
              videoTrack={mainTrack}
              style={StyleSheet.absoluteFillObject}
              objectFit="cover"
              mirror={mainIsLocal}
              zOrder={VIDEO_Z_STAGE}
            />
          )
        ) : (
          <LinearGradient
            colors={["#0d1b2a", "#1a1a2e", "#0f0c29"]}
            style={styles.noVideoPlaceholder}
          >
            {peerImage ? (
              <Image source={{ uri: peerImage }} style={styles.audioAvatarImage} />
            ) : peerInitial ? (
              <View style={styles.audioAvatarCircle}>
                <Text style={styles.audioAvatarInitial}>{peerInitial}</Text>
              </View>
            ) : (
              <Ionicons name="person" size={80} color="#ffffff30" />
            )}
            {peerName ? <Text style={styles.audioPeerName}>{peerName}</Text> : null}
            <Text style={styles.mutedText}>
              {isVideo ? "Waiting for video…" : "Voice call"}
            </Text>
          </LinearGradient>
        )}

        {/* PiP overlay — drag to reposition, tap to swap with main */}
        {showPip && (
          <GestureDetector gesture={pipPanGesture}>
            <Animated.View style={[styles.pipContainer, pipAnimatedStyle]}>
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={isViewingRemoteScreen}
                onPress={isViewingRemoteScreen ? undefined : togglePipSwapped}
                style={styles.pipTouchInner}
              >
                {pipTrackAvailable && pipTrack ? (
                  <VideoView
                    videoTrack={pipTrack}
                    style={
                      pipIsRemoteScreen ? styles.pipScreenShareVideo : styles.pipVideo
                    }
                    objectFit={pipIsRemoteScreen ? "contain" : "cover"}
                    mirror={pipIsLocal}
                    // Android composites each video track in its own SurfaceView,
                    // which ignores React's view order: without this the PiP
                    // surface renders BEHIND the fullscreen one and the tile looks
                    // black until a camera toggle happens to recreate it on top.
                    zOrder={VIDEO_Z_OVERLAY}
                  />
                ) : (
                  <View style={[styles.pipVideo, styles.pipPlaceholder]}>
                    <Ionicons name="person" size={32} color="#ffffff40" />
                  </View>
                )}
              </TouchableOpacity>

              {/* Camera-flip overlay on PiP (only when local camera is the PiP feed) */}
              {pipIsLocal && camEnabled && (
                <TouchableOpacity
                  onPress={switchCamera}
                  style={styles.pipFlipBtn}
                  hitSlop={8}
                >
                  <Ionicons name="camera-reverse" size={16} color="#fff" />
                </TouchableOpacity>
              )}
            </Animated.View>
          </GestureDetector>
        )}

        {/* Top bar: minimize + timer + extend */}
        <View style={styles.topBar}>
          {canMinimize ? (
            <TouchableOpacity
              onPress={minimizeCall}
              style={styles.minimizeBtn}
              hitSlop={8}
            >
              <Ionicons name="chevron-down" size={20} color="#fff" />
            </TouchableOpacity>
          ) : null}
          <View style={styles.timerPill}>
            <Ionicons
              name="time-outline"
              size={14}
              color={countdown <= WARNING_THRESHOLD_MS ? "#fbbf24" : "#ffffffb0"}
            />
            <Text
              style={[
                styles.timerText,
                countdown <= WARNING_THRESHOLD_MS && { color: "#fbbf24" },
              ]}
            >
              {formatCountdown(countdown)}
            </Text>
          </View>
          {canExtend && (
            <TouchableOpacity
              onPress={handleExtendTime}
              disabled={isExtending}
              style={styles.extendBtn}
            >
              {isExtending ? (
                <ActivityIndicator color="#fbbf24" size="small" />
              ) : (
                <Text style={styles.extendText}>+{EXTENSION_MINUTES}m</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Screen-share banner — persists while sharing so the user always
            knows their screen is visible, even after minimizing + reopening */}
        {screenSharing && (
          <View style={styles.sharingBanner}>
            <Ionicons name="phone-portrait-outline" size={14} color="#fff" />
            <Text style={styles.sharingBannerText}>You&apos;re sharing your screen</Text>
            <TouchableOpacity onPress={toggleScreenShare} hitSlop={8}>
              <Text style={styles.sharingBannerStop}>Stop</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Bottom controls */}
        <View style={styles.controlBar}>
          <TouchableOpacity
            onPress={toggleMic}
            style={[styles.controlBtn, !micEnabled && styles.controlBtnOff]}
          >
            <Ionicons name={micEnabled ? "mic" : "mic-off"} size={22} color="#fff" />
          </TouchableOpacity>

          {isVideo && (
            <TouchableOpacity
              onPress={toggleCam}
              style={[styles.controlBtn, !camEnabled && styles.controlBtnOff]}
            >
              <Ionicons
                name={camEnabled ? "videocam" : "videocam-off"}
                size={22}
                color="#fff"
              />
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={toggleSpeaker}
            style={[styles.controlBtn, !speakerOn && styles.controlBtnOff]}
          >
            <Ionicons
              name={speakerOn ? "volume-high" : "volume-mute"}
              size={22}
              color="#fff"
            />
          </TouchableOpacity>

          {Platform.OS === "android" && (
            <TouchableOpacity
              onPress={toggleScreenShare}
              disabled={screenShareBusy}
              style={[styles.controlBtn, screenSharing && styles.controlBtnSharing]}
            >
              {screenShareBusy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Ionicons
                  name={screenSharing ? "stop-circle-outline" : "phone-portrait-outline"}
                  size={22}
                  color="#fff"
                />
              )}
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={handleEnd}
            disabled={isEnding}
            style={styles.endCallBtn}
          >
            {isEnding ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Ionicons
                name="call"
                size={28}
                color="#fff"
                style={{ transform: [{ rotate: "135deg" }] }}
              />
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Render: Ended / Rejected / Missed ─────────────────────────────────────
  return (
    <View style={styles.centered}>
      <Ionicons name="call-outline" size={56} color="#ffffff40" />
      <Text
        style={[styles.whiteText, { fontSize: 20, fontWeight: "600", marginTop: 16 }]}
      >
        {session.status === "MISSED"
          ? "Call missed"
          : session.status === "REJECTED"
            ? "Call declined"
            : "Call ended"}
      </Text>
      <TouchableOpacity onPress={() => goBack()} style={styles.backBtn}>
        <Text style={styles.whiteText}>Go back</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    backgroundColor: "#0d1b2a",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  mutedText: {
    color: "#ffffff60",
    fontSize: 16,
    marginTop: 16,
  },
  whiteText: {
    color: "#fff",
    fontSize: 16,
  },
  backBtn: {
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: "#ffffff18",
    borderRadius: 999,
  },

  // Ringing
  ringingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 96,
    paddingHorizontal: 24,
  },
  ringingTop: {
    alignItems: "center",
    gap: 12,
  },
  avatarWrapper: {
    width: 130,
    height: 130,
    alignItems: "center",
    justifyContent: "center",
  },
  pulseRing: {
    position: "absolute",
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 3,
    borderColor: "#ffffff60",
    backgroundColor: "transparent",
  },
  avatarCircle: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: {
    width: 112,
    height: 112,
    borderRadius: 56,
  },
  avatarInitial: {
    color: "#fff",
    fontSize: 44,
    fontWeight: "700",
  },
  peerNameText: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
    marginTop: 4,
  },
  titleText: {
    color: "#ffffffb0",
    fontSize: 16,
    fontWeight: "500",
    marginTop: 4,
  },
  subtitleText: {
    color: "#ffffff60",
    fontSize: 14,
  },
  ringingButtons: {
    flexDirection: "row",
    justifyContent: "space-around",
    width: "100%",
  },
  ringingBtnGroup: {
    alignItems: "center",
    gap: 10,
  },
  circleBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  btnLabel: {
    color: "#ffffff90",
    fontSize: 13,
  },

  // Active
  activeContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  screenShareStage: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingTop: Platform.OS === "ios" ? 72 : 64,
    paddingBottom: Platform.OS === "ios" ? 144 : 128,
  },
  screenShareVideo: {
    width: "100%",
    height: "100%",
    backgroundColor: "#000",
  },
  noVideoPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  audioAvatarCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "#3b82f640",
    borderWidth: 2,
    borderColor: "#3b82f660",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  audioAvatarImage: {
    width: 100,
    height: 100,
    borderRadius: 50,
    marginBottom: 12,
  },
  audioAvatarInitial: {
    color: "#ffffffcc",
    fontSize: 42,
    fontWeight: "700",
  },
  audioPeerName: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 4,
  },
  pipContainer: {
    position: "absolute",
    bottom: Platform.OS === "ios" ? 132 : 116,
    right: 16,
    width: 110,
    height: 150,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "#ffffff30",
    backgroundColor: "#000",
    zIndex: 10,
    elevation: 10,
  },
  pipTouchInner: {
    flex: 1,
  },
  pipVideo: {
    flex: 1,
  },
  pipScreenShareVideo: {
    flex: 1,
    backgroundColor: "#000",
  },
  pipPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1a1a1a",
  },
  pipFlipBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#00000090",
    alignItems: "center",
    justifyContent: "center",
  },

  // Top bar
  topBar: {
    position: "absolute",
    top: Platform.OS === "ios" ? 60 : 40,
    left: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    zIndex: 10,
  },
  timerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#00000080",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ffffff20",
  },
  timerText: {
    color: "#ffffffb0",
    fontSize: 14,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
  },
  extendBtn: {
    backgroundColor: "#78350f80",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#fbbf2440",
  },
  extendText: {
    color: "#fbbf24",
    fontSize: 13,
    fontWeight: "600",
  },

  // Bottom controls
  controlBar: {
    position: "absolute",
    bottom: Platform.OS === "ios" ? 48 : 32,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    zIndex: 10,
  },
  controlBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#ffffff25",
    alignItems: "center",
    justifyContent: "center",
  },
  controlBtnOff: {
    backgroundColor: "#ffffff10",
  },
  controlBtnSharing: {
    backgroundColor: "#16a34a",
  },
  sharingBanner: {
    position: "absolute",
    top: Platform.OS === "ios" ? 104 : 84,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#16a34ae0",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    zIndex: 10,
  },
  sharingBannerText: {
    color: "#fff",
    fontSize: 12.5,
    fontWeight: "600",
  },
  sharingBannerStop: {
    color: "#fff",
    fontSize: 12.5,
    fontWeight: "800",
    textDecorationLine: "underline",
    marginLeft: 4,
  },
  endCallBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },

  // Minimize controls
  minimizeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#00000080",
    borderWidth: 1,
    borderColor: "#ffffff20",
    alignItems: "center",
    justifyContent: "center",
  },
  ringingMinimizeBtn: {
    position: "absolute",
    top: Platform.OS === "ios" ? 60 : 40,
    left: 16,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#ffffff18",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },

  // Minimized bubble content (container/drag lives in PersistentCallHost)
  miniRoot: {
    flex: 1,
    backgroundColor: "#0d1b2a",
  },
  miniVideo: {
    flex: 1,
  },
  miniAvatarWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  miniAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  miniAvatarFallback: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
  },
  miniInitial: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
  },
  miniFooter: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 4,
    backgroundColor: "#000000a0",
  },
  miniTimer: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
});
