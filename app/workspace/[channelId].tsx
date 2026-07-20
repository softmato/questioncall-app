import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { Audio } from "expo-av";
import { router, useLocalSearchParams } from "expo-router";
import Toast from "react-native-toast-message";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useImageViewer } from "@/components/image-viewer/image-viewer-context";
import ChannelTimer from "@/components/channel/ChannelTimer";
import { MessageItem } from "@/components/channel/MessageItem";

import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import {
  ANSWER_SUBMITTED_EVENT,
  CHANNEL_CLOSED_EVENT,
  CHANNEL_MESSAGE_EVENT,
  CHANNEL_MESSAGES_SEEN_EVENT,
  CHANNEL_STATUS_EVENT,
  CHANNEL_TIMER_UPDATED_EVENT,
  MESSAGE_DELETED_EVENT,
  MESSAGE_MARKED_EVENT,
  getChannelPusherName,
  getPusherClient,
} from "@/lib/realtime";
import {
  appendMessage,
  addPendingMessage,
  clearChannel,
  failPendingMessage,
  markMessagesAsSeen,
  resolvePendingMessage,
  setAnswerSubmitted,
  setChannelData,
  setChannelError,
  setChannelLoading,
  setChannelStatus,
  setChannelTimer,
  setMessageDeleted,
  toggleMessageMarked,
  type ChatMessage,
  type ChannelDetail,
} from "@/store/slices/channelSlice";
import { markChannelRead, setActiveChannelId } from "@/store/slices/channelsSlice";
import {
  enqueueFailedMessage,
  dequeueMessage,
  getFailedMessages,
} from "@/lib/message-retry-queue";
import {
  prewarmCallerRoom,
  clearCallerPrewarm,
  setPendingCreate,
} from "@/lib/call-prewarm";
import { openCall } from "@/lib/call-ui-store";
import { hasAnyActiveCall } from "@/lib/active-call";

function formatMessageTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function formatMessageDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function WorkspaceScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const dispatch = useAppDispatch();
  const userId = useAppSelector((s) => s.user.data?._id ?? null);
  const cached = useAppSelector((s) =>
    channelId ? (s.channel.cache[channelId] ?? null) : null,
  );
  const isLoading = useAppSelector((s) => s.channel.isLoading);
  const channelError = useAppSelector((s) => s.channel.error);
  const {
    statusBarStyle,
    backgroundColor,
    cardColor,
    borderColor,
    primaryColor,
    primarySoftColor,
    mutedIconColor,
    isDark,
  } = useAppTheme();

  const detail = cached?.detail ?? null;
  const messages = useMemo(() => cached?.messages ?? [], [cached?.messages]);
  const { openImageViewer } = useImageViewer();
  const chatSurfaceColor = isDark ? "#0b1411" : backgroundColor;
  const chatHeaderColor = isDark ? "#111b18" : backgroundColor;
  const chatPanelColor = isDark ? "#17231f" : cardColor;
  const chatInputColor = isDark ? "#202c27" : "#f1f5f9";
  const chatPrimaryActionColor = isDark ? "#00a884" : "#111827";
  const chatPrimaryActionTextColor = "#ffffff";
  const chatTextColor = isDark ? "#e9edef" : "#111827";
  const chatSubtleIconColor = isDark ? "#8696a0" : "#64748b";

  const isAsker = userId === detail?.askerId;
  const isAcceptor = userId === detail?.acceptorId;
  const isActive = detail?.status === "ACTIVE";

  const insets = useSafeAreaInsets();

  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [ratingModalVisible, setRatingModalVisible] = useState(false);
  const [selectedRating, setSelectedRating] = useState(0);
  const [isClosing, setIsClosing] = useState(false);
  const [questionBannerExpanded, setQuestionBannerExpanded] = useState(false);
  const [startingCallType, setStartingCallType] = useState<"AUDIO" | "VIDEO" | null>(
    null,
  );

  const flatListRef = useRef<FlatList<any>>(null);
  const isLoadingOlderRef = useRef(false);
  // Declared here with null; assigned after fetchChannel useCallback below
  // to avoid Temporal Dead Zone errors (fetchChannel is a const).
  const fetchChannelRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
  // Set to true while a system permission dialog is in-flight (camera /
  // microphone). The dialog briefly triggers AppState → active, which would
  // cause a spurious full DB reload; we skip that refetch while this is set.
  const suppressForegroundRefetchRef = useRef(false);

  const PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const CACHE_TTL_MS = 30_000;

  // ─── Fetch channel data ────────────────────────────────────────
  const fetchChannel = useCallback(
    async (force = false) => {
      if (!channelId) return;
      if (!force) dispatch(setChannelLoading(true));
      try {
        const res = await api.get(`/channels/${channelId}`);
        const { channel, messages: msgs } = res.data;
        // Diagnostic: log questionImages so we can verify the API is returning them.
        console.warn(
          `[workspace] channel API questionImages for ${channelId}:`,
          channel?.questionImages,
        );
        const serverMessages = (msgs as ChatMessage[]) ?? [];
        const persisted = await getFailedMessages(channelId);
        const failedMessages: ChatMessage[] = persisted.map((p) => ({
          id: p.localId,
          localId: p.localId,
          channelId: p.channelId,
          senderId: userId ?? "",
          senderName: "You",
          content: p.content ?? "",
          mediaUrl: p.mediaUrl ?? null,
          mediaType: p.mediaType ?? null,
          isSystemMessage: false,
          isOwn: true,
          isSeen: false,
          isDelivered: false,
          isMarkedAsAnswer: false,
          isDeleted: false,
          sentAt: p.createdAt,
          isSending: false,
          sendFailed: true,
        }));
        // Normalize the detail so stale cache entries that pre-date the
        // questionImages field never break the banner (rehydrated entries
        // from redux-persist may have questionImages === undefined).
        const normalizedDetail: ChannelDetail = {
          ...(channel as ChannelDetail),
          questionImages: Array.isArray(channel?.questionImages)
            ? channel.questionImages
            : [],
        };
        dispatch(
          setChannelData({
            channelId,
            detail: normalizedDetail,
            messages: [...serverMessages, ...failedMessages],
          }),
        );
      } catch (err: any) {
        if (!cached) {
          dispatch(
            setChannelError(err?.response?.data?.error ?? "Failed to load channel"),
          );
        }
      }
    },
    [channelId, dispatch, userId, cached],
  );
  fetchChannelRef.current = fetchChannel;

  const cachedRef = useRef(cached);
  cachedRef.current = cached;

  useEffect(() => {
    if (!channelId) return;
    const isFresh =
      cachedRef.current && Date.now() - cachedRef.current.fetchedAt < CACHE_TTL_MS;
    if (isFresh && cachedRef.current) {
      const cachedDetail = cachedRef.current.detail;
      // If this cache entry pre-dates the questionImages field (redux-persist
      // rehydration of old data), force a fresh fetch instead of serving
      // stale data that would make the banner show "No images attached."
      if (!Array.isArray(cachedDetail.questionImages)) {
        fetchChannelRef.current?.();
      } else {
        dispatch(
          setChannelData({
            channelId,
            detail: cachedDetail,
            messages: cachedRef.current.messages,
          }),
        );
      }
    } else if (fetchChannelRef.current) {
      fetchChannelRef.current();
    }
    return () => {
      dispatch(clearChannel());
    };
  }, [channelId, dispatch]);

  // ─── Track active channel so the realtime bridge skips incrementing unread ──
  useEffect(() => {
    if (!channelId) return;
    dispatch(setActiveChannelId(channelId));
    return () => {
      dispatch(setActiveChannelId(null));
    };
  }, [channelId, dispatch]);

  // ─── Mark as read on mount ─────────────────────────────────────
  useEffect(() => {
    if (!channelId || !detail) return;
    api.post(`/channels/${channelId}/read`).catch(() => {});
    dispatch(markChannelRead(channelId));
    dispatch(markMessagesAsSeen());
  }, [channelId, detail, dispatch]);

  // ─── Pusher subscription ───────────────────────────────────────
  useEffect(() => {
    if (!channelId) return;
    const client = getPusherClient();
    if (!client) return;

    console.log(
      `[workspace] Subscribing to Pusher channel=${getChannelPusherName(channelId)}`,
    );

    const pusherChannel = client.subscribe(getChannelPusherName(channelId));

    pusherChannel.bind(CHANNEL_MESSAGE_EVENT, (payload: any) => {
      const msg = payload?.message ?? payload;
      if (!msg?.id && !msg?._id) return;
      const normalized: ChatMessage = {
        id: msg.id || msg._id,
        channelId: msg.channelId || channelId,
        senderId: msg.senderId || "",
        senderName: msg.senderName || "",
        content: msg.content || "",
        mediaUrl: msg.mediaUrl ?? null,
        mediaType: msg.mediaType ?? null,
        isSystemMessage: Boolean(msg.isSystemMessage),
        isOwn: msg.senderId === userId,
        isSeen: Boolean(msg.isSeen),
        isDelivered: true,
        isMarkedAsAnswer: Boolean(msg.isMarkedAsAnswer),
        isDeleted: Boolean(msg.isDeleted),
        sentAt: msg.sentAt || new Date().toISOString(),
      };
      console.log(
        `[workspace] CHANNEL_MESSAGE_EVENT received: id=${normalized.id} sender=${normalized.senderId} isOwn=${normalized.isOwn} channelId=${normalized.channelId}`,
      );
      if (!normalized.isOwn) {
        dispatch(appendMessage(normalized));
        api.post(`/channels/${channelId}/read`).catch(() => {});
        dispatch(markChannelRead(channelId));
      } else {
        console.log(`[workspace] Skipping own message from Pusher`);
      }
    });

    pusherChannel.bind(CHANNEL_TIMER_UPDATED_EVENT, (payload: any) => {
      if (payload?.timerDeadline) {
        dispatch(
          setChannelTimer({
            timerDeadline: payload.timerDeadline,
            timeExtensionCount: payload.timeExtensionCount ?? 0,
          }),
        );
        if (payload.extendedBy && payload.extendedBy !== userId) {
          Toast.show({
            type: "info",
            text1: `${payload.extendedByName || "Someone"} added ${payload.extensionMinutes || 5} more minutes.`,
          });
        }
      }
    });

    pusherChannel.bind(CHANNEL_CLOSED_EVENT, (payload: any) => {
      dispatch(
        setChannelStatus({
          status: "CLOSED",
          ratingGiven: payload?.ratingGiven ?? null,
        }),
      );
    });

    pusherChannel.bind(CHANNEL_STATUS_EVENT, (payload: any) => {
      if (payload?.status) {
        dispatch(
          setChannelStatus({
            status: payload.status,
            ratingGiven: payload.ratingGiven,
          }),
        );
      }
    });

    pusherChannel.bind(MESSAGE_MARKED_EVENT, (payload: any) => {
      if (payload?.messageId) {
        dispatch(
          toggleMessageMarked({
            messageId: payload.messageId,
            isMarkedAsAnswer: Boolean(payload.isMarkedAsAnswer),
          }),
        );
      }
    });

    pusherChannel.bind(MESSAGE_DELETED_EVENT, (payload: any) => {
      if (payload?.messageId) dispatch(setMessageDeleted(payload.messageId));
    });

    pusherChannel.bind(CHANNEL_MESSAGES_SEEN_EVENT, () => {
      dispatch(markMessagesAsSeen());
    });

    pusherChannel.bind(ANSWER_SUBMITTED_EVENT, () => {
      dispatch(setAnswerSubmitted(true));
    });

    // Listen for Pusher reconnection to re-fetch (uses ref to avoid effect churn)
    const onReconnect = () => {
      console.log(
        `[workspace] Pusher reconnected — re-fetching messages for channelId=${channelId}`,
      );
      void fetchChannelRef.current!();
    };
    client.connection.bind("connected", onReconnect);

    return () => {
      pusherChannel.unbind_all();
      client.unsubscribe(getChannelPusherName(channelId));
      client.connection.unbind("connected", onReconnect);
    };
  }, [channelId, userId, dispatch]);

  // ─── Re-fetch on app foreground to recover missed messages ────
  useEffect(() => {
    if (!channelId) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // Skip if we triggered the inactive→active transition ourselves by
        // opening a system permission dialog (camera / microphone / gallery).
        if (suppressForegroundRefetchRef.current) return;
        // Skip if the cached data is still fresh — avoids a full-screen
        // spinner and a redundant DB round-trip when the user briefly
        // minimises the app and immediately returns.
        const cache = cachedRef.current;
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return;
        // Re-fetch silently (force = true skips the loading spinner) so the
        // UI doesn't flash white while the request is in-flight.
        void fetchChannelRef.current!(true);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [channelId]);

  // ─── Send message ──────────────────────────────────────────────
  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isSending || !isActive) return;

    const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: ChatMessage = {
      id: localId,
      localId,
      channelId: channelId!,
      senderId: userId!,
      senderName: "You",
      content: text,
      isSystemMessage: false,
      isOwn: true,
      isSeen: false,
      isDelivered: false,
      isMarkedAsAnswer: false,
      isDeleted: false,
      sentAt: new Date().toISOString(),
      isSending: true,
    };

    setInputText("");
    dispatch(addPendingMessage(optimistic));
    setIsSending(true);

    try {
      const res = await api.post(`/channels/${channelId}/messages`, {
        content: text,
      });
      const serverMsg = res.data as ChatMessage;
      dispatch(
        resolvePendingMessage({
          localId,
          message: {
            ...serverMsg,
            isOwn: true,
            isDelivered: true,
            isSending: false,
          },
        }),
      );
      dequeueMessage(localId).catch(() => {});
    } catch {
      dispatch(failPendingMessage(localId));
      enqueueFailedMessage(optimistic).catch(() => {});
      Toast.show({ type: "error", text1: "Failed to send message" });
    } finally {
      setIsSending(false);
    }
  };

  // ─── Take photo with camera ────────────────────────────────────
  const handleOpenCamera = async () => {
    if (!isActive) return;
    suppressForegroundRefetchRef.current = true;
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    suppressForegroundRefetchRef.current = false;
    if (!permission.granted) {
      Toast.show({ type: "error", text1: "Camera permission required." });
      return;
    }
    suppressForegroundRefetchRef.current = true;
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.85,
    });
    suppressForegroundRefetchRef.current = false;
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    const isVideo = asset.type === "video";
    const localId = `local_cam_${Date.now()}`;
    const optimistic: ChatMessage = {
      id: localId,
      localId,
      channelId: channelId!,
      senderId: userId!,
      senderName: "You",
      content: "",
      mediaUrl: asset.uri,
      mediaType: isVideo ? "VIDEO" : "image",
      isSystemMessage: false,
      isOwn: true,
      isSeen: false,
      isDelivered: false,
      isMarkedAsAnswer: false,
      isDeleted: false,
      sentAt: new Date().toISOString(),
      isSending: true,
    };
    dispatch(addPendingMessage(optimistic));

    try {
      const form = new FormData();
      form.append("file", {
        uri: asset.uri,
        name: asset.fileName ?? `cam-${Date.now()}.${isVideo ? "mp4" : "jpg"}`,
        type: asset.mimeType ?? (isVideo ? "video/mp4" : "image/jpeg"),
      } as unknown as Blob);
      const uploadRes = await api.post("/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 60000,
      });
      const mediaUrl = uploadRes.data?.secure_url ?? uploadRes.data?.url;

      const res = await api.post(`/channels/${channelId}/messages`, {
        mediaUrl,
        mediaType: isVideo ? "VIDEO" : "IMAGE",
      });
      dispatch(
        resolvePendingMessage({
          localId,
          message: { ...(res.data as ChatMessage), isOwn: true, isDelivered: true },
        }),
      );
      dequeueMessage(localId).catch(() => {});
    } catch {
      dispatch(failPendingMessage(localId));
      enqueueFailedMessage(optimistic).catch(() => {});
      Toast.show({ type: "error", text1: "Failed to send photo" });
    }
  };

  // ─── Send image ────────────────────────────────────────────────
  const handlePickImage = async () => {
    if (!isActive) return;
    suppressForegroundRefetchRef.current = true;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    suppressForegroundRefetchRef.current = false;
    if (!permission.granted) {
      Toast.show({ type: "error", text1: "Photo library permission required." });
      return;
    }
    suppressForegroundRefetchRef.current = true;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
    });
    suppressForegroundRefetchRef.current = false;
    if (result.canceled || !result.assets[0]) return;

    const asset = result.assets[0];
    const localId = `local_img_${Date.now()}`;
    const optimistic: ChatMessage = {
      id: localId,
      localId,
      channelId: channelId!,
      senderId: userId!,
      senderName: "You",
      content: "",
      mediaUrl: asset.uri,
      mediaType: "image",
      isSystemMessage: false,
      isOwn: true,
      isSeen: false,
      isDelivered: false,
      isMarkedAsAnswer: false,
      isDeleted: false,
      sentAt: new Date().toISOString(),
      isSending: true,
    };
    dispatch(addPendingMessage(optimistic));

    try {
      const form = new FormData();
      form.append("file", {
        uri: asset.uri,
        name: asset.fileName ?? `chat-${Date.now()}.jpg`,
        type: asset.mimeType ?? "image/jpeg",
      } as unknown as Blob);
      const uploadRes = await api.post("/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 30000,
      });
      const mediaUrl = uploadRes.data?.secure_url ?? uploadRes.data?.url;

      const res = await api.post(`/channels/${channelId}/messages`, {
        mediaUrl,
        mediaType: "IMAGE",
      });
      dispatch(
        resolvePendingMessage({
          localId,
          message: { ...(res.data as ChatMessage), isOwn: true, isDelivered: true },
        }),
      );
      dequeueMessage(localId).catch(() => {});
    } catch {
      dispatch(failPendingMessage(localId));
      enqueueFailedMessage(optimistic).catch(() => {});
      Toast.show({ type: "error", text1: "Failed to send image" });
    }
  };

  // ─── Mark as answer (teacher only) ─────────────────────────────
  const handleToggleMark = useCallback(
    async (messageId: string, currentMark: boolean) => {
      const next = !currentMark;
      dispatch(toggleMessageMarked({ messageId, isMarkedAsAnswer: next }));
      try {
        await api.post(`/channels/${channelId}/mark-answer`, {
          messageId,
          isMarkedAsAnswer: next,
        });
      } catch {
        dispatch(toggleMessageMarked({ messageId, isMarkedAsAnswer: currentMark }));
        Toast.show({ type: "error", text1: "Failed to mark answer" });
      }
    },
    [channelId, dispatch],
  );

  // ─── Close & Rate (asker only) ─────────────────────────────────
  const handleClose = async () => {
    if (!selectedRating || isClosing) return;
    setIsClosing(true);
    try {
      await api.post(`/channels/${channelId}/close`, {
        rating: selectedRating,
      });
      dispatch(setChannelStatus({ status: "CLOSED", ratingGiven: selectedRating }));
      setRatingModalVisible(false);
      Toast.show({ type: "success", text1: "Channel closed. Thank you for rating!" });
    } catch (err: any) {
      Toast.show({
        type: "error",
        text1: err?.response?.data?.error ?? "Failed to close channel",
      });
    } finally {
      setIsClosing(false);
    }
  };

  // ─── Submit answer (teacher only) ──────────────────────────────
  const markedMessageIds = useMemo(
    () =>
      messages
        .filter((m) => m.isMarkedAsAnswer && !m.localId)
        .map((m) => m.id || m._id)
        .filter(Boolean) as string[],
    [messages],
  );

  const handleSubmitAnswer = async () => {
    if (markedMessageIds.length === 0) {
      Toast.show({
        type: "error",
        text1: "Mark at least one message as the answer first.",
      });
      return;
    }
    Alert.alert(
      "Submit Answer",
      `Submit ${markedMessageIds.length} marked message${markedMessageIds.length > 1 ? "s" : ""} as your answer?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Submit",
          onPress: async () => {
            try {
              await api.post("/answers", {
                channelId,
                markedMessageIds,
              });
              dispatch(setAnswerSubmitted(true));
              Toast.show({ type: "success", text1: "Answer submitted!" });
            } catch (err: any) {
              Toast.show({
                type: "error",
                text1: err?.response?.data?.error ?? "Failed to submit answer",
              });
            }
          },
        },
      ],
    );
  };

  // ─── Retry failed message ─────────────────────────────────────
  const handleRetry = useCallback(
    async (msg: ChatMessage) => {
      if (!msg.localId) return;
      dispatch(
        resolvePendingMessage({
          localId: msg.localId,
          message: { ...msg, isSending: true, sendFailed: false },
        }),
      );
      try {
        const payload: Record<string, string> = {};
        if (msg.content) payload.content = msg.content;
        if (msg.mediaUrl) {
          payload.mediaUrl = msg.mediaUrl;
          payload.mediaType = msg.mediaType ?? "image";
        }
        const res = await api.post(`/channels/${channelId}/messages`, payload);
        dispatch(
          resolvePendingMessage({
            localId: msg.localId,
            message: { ...(res.data as ChatMessage), isOwn: true, isDelivered: true },
          }),
        );
        dequeueMessage(msg.localId).catch(() => {});
      } catch {
        dispatch(failPendingMessage(msg.localId));
      }
    },
    [channelId, dispatch],
  );

  // ─── Voice recording implementation (expo-av) ──────────────────
  const recordingRef = useRef<Audio.Recording | null>(null);
  const playbackRef = useRef<Audio.Sound | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [pendingAudio, setPendingAudio] = useState<{
    uri: string;
    duration: number;
  } | null>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);

  const startVoiceRecording = async () => {
    if (isRecording) return;
    try {
      suppressForegroundRefetchRef.current = true;
      const { granted } = await Audio.requestPermissionsAsync();
      suppressForegroundRefetchRef.current = false;
      if (!granted) {
        Toast.show({ type: "error", text1: "Microphone permission required" });
        return;
      }
      // Skip audio-mode changes while a call is live — they'd knock the
      // call's voice off the communication stream.
      if (!hasAnyActiveCall()) {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
      }
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Failed to start recording",
        text2: String(err),
      });
    }
  };

  const stopVoiceRecording = async () => {
    if (!isRecording || !recordingRef.current) return;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    const duration = recordingDuration;
    try {
      await recordingRef.current.stopAndUnloadAsync();
      if (!hasAnyActiveCall()) {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        });
      }
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      setIsRecording(false);
      setRecordingDuration(0);
      if (uri) {
        setPendingAudio({ uri, duration });
      }
    } catch {
      recordingRef.current = null;
      setIsRecording(false);
      setRecordingDuration(0);
      Toast.show({ type: "error", text1: "Failed to stop recording" });
    }
  };

  const togglePreviewPlayback = async () => {
    if (!pendingAudio) return;
    if (isPlayingPreview && playbackRef.current) {
      await playbackRef.current.stopAsync().catch(() => {});
      await playbackRef.current.unloadAsync().catch(() => {});
      playbackRef.current = null;
      setIsPlayingPreview(false);
      return;
    }
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: pendingAudio.uri },
        { shouldPlay: true },
      );
      playbackRef.current = sound;
      setIsPlayingPreview(true);
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) return;
        if (status.didJustFinish) {
          setIsPlayingPreview(false);
          void sound.unloadAsync();
          playbackRef.current = null;
        }
      });
    } catch {
      Toast.show({ type: "error", text1: "Failed to play preview" });
    }
  };

  const cancelPendingAudio = async () => {
    if (playbackRef.current) {
      await playbackRef.current.stopAsync().catch(() => {});
      await playbackRef.current.unloadAsync().catch(() => {});
      playbackRef.current = null;
    }
    setIsPlayingPreview(false);
    setPendingAudio(null);
  };

  const formatRecordingTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  const sendVoiceMessage = async (audioUri: string) => {
    if (!isActive) return;
    const localId = `local_audio_${Date.now()}`;
    const optimistic: ChatMessage = {
      id: localId,
      localId,
      channelId: channelId!,
      senderId: userId!,
      senderName: "You",
      content: "",
      mediaUrl: audioUri,
      mediaType: "AUDIO",
      isSystemMessage: false,
      isOwn: true,
      isSeen: false,
      isDelivered: false,
      isMarkedAsAnswer: false,
      isDeleted: false,
      sentAt: new Date().toISOString(),
      isSending: true,
    };
    dispatch(addPendingMessage(optimistic));

    try {
      const form = new FormData();
      form.append("file", {
        uri: audioUri,
        name: `voice-${Date.now()}.m4a`,
        type: "audio/m4a",
      } as unknown as Blob);
      const uploadRes = await api.post("/upload", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 30000,
      });
      const mediaUrl = uploadRes.data?.secure_url ?? uploadRes.data?.url;

      const res = await api.post(`/channels/${channelId}/messages`, {
        mediaUrl,
        mediaType: "AUDIO",
      });
      dispatch(
        resolvePendingMessage({
          localId,
          message: { ...(res.data as ChatMessage), isOwn: true, isDelivered: true },
        }),
      );
      dequeueMessage(localId).catch(() => {});
      Toast.show({ type: "success", text1: "Voice message sent" });
    } catch {
      dispatch(failPendingMessage(localId));
      enqueueFailedMessage(optimistic).catch(() => {});
      Toast.show({ type: "error", text1: "Failed to send voice message" });
    }
  };

  // ─── Start call ───────────────────────────────────────────────
  // Optimistic navigation: jump straight to the call screen with a "pending"
  // marker the moment the button is pressed. The /calls/create POST happens
  // in the background and the call screen swaps in the real session id when
  // it resolves. No button spinner, no white delay.
  const handleStartCall = (mode: "AUDIO" | "VIDEO") => {
    if (!channelId || startingCallType) return;
    setStartingCallType(mode);
    // The outgoing ringback is owned by the call screen and starts once
    // /calls/create resolves (WhatsApp behavior: silence while "Calling…").
    const createPromise = api
      .post("/calls/create", { channelId, mode })
      .finally(() => setStartingCallType(null));
    setPendingCreate(channelId, mode, createPromise);
    // Swallow rejection here — the call screen owns user-visible error
    // reporting via the same promise, but we still want this catch so that
    // an unhandled rejection doesn't crash the JS thread.
    createPromise.catch(() => {});
    // Open the root-level call overlay (no navigation — the workspace stays
    // mounted underneath and the call survives any subsequent navigation).
    openCall({ roomId: "pending", channelId, mode });
  };

  // ─── Pre-warm the per-channel LiveKit room ────────────────────
  // Opens the WS + DTLS handshake to channel_${channelId} while the user is
  // reading messages. When they press the call button the room connection
  // is already established — only track publishing remains.
  useEffect(() => {
    if (!channelId || !isActive) return;
    void prewarmCallerRoom(channelId);
    return () => {
      // Tear down only this channel's pre-warm; leave any other slot alone
      // (e.g. when navigating to the call screen which consumes the slot,
      // this cleanup must be a no-op for the consumed slot).
      clearCallerPrewarm(channelId);
    };
  }, [channelId, isActive]);

  // ─── Voice record toggle ──────────────────────────────────────
  const handleVoiceRecord = () => {
    if (isRecording) {
      void stopVoiceRecording();
    } else {
      void startVoiceRecording();
    }
  };

  // ─── Send pending audio ───────────────────────────────────────
  const handleSendPendingAudio = async () => {
    if (!pendingAudio || !isActive) return;
    const { uri } = pendingAudio;
    await cancelPendingAudio();
    await sendVoiceMessage(uri);
  };

  const handleLoadOlder = useCallback(() => {
    isLoadingOlderRef.current = true;
    setVisibleCount((c) => c + PAGE_SIZE);
  }, []);

  // Reset pagination when channel changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [channelId]);

  // ─── Date separators ──────────────────────────────────────────
  const messagesWithDates = useMemo(() => {
    const visible = messages.slice(Math.max(0, messages.length - visibleCount));
    const result: (ChatMessage | { __dateSeparator: string })[] = [];
    let lastDate = "";
    for (const msg of visible) {
      const date = formatMessageDate(msg.sentAt);
      if (date !== lastDate) {
        result.push({ __dateSeparator: date });
        lastDate = date;
      }
      result.push(msg);
    }
    return result;
  }, [messages, visibleCount]);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage | { __dateSeparator: string } }) => (
      <MessageItem
        item={item}
        userId={userId}
        isAcceptor={isAcceptor}
        isActive={isActive}
        isAnswerSubmitted={!!detail?.isAnswerSubmitted}
        primaryColor={primaryColor}
        cardColor={cardColor}
        borderColor={borderColor}
        mutedIconColor={mutedIconColor}
        isDark={isDark}
        formatMessageTime={formatMessageTime}
        onImageOpen={openImageViewer}
        onRetry={handleRetry}
        onToggleMark={handleToggleMark}
      />
    ),
    [
      userId,
      isAcceptor,
      isActive,
      detail?.isAnswerSubmitted,
      primaryColor,
      cardColor,
      borderColor,
      mutedIconColor,
      isDark,
      openImageViewer,
      handleRetry,
      handleToggleMark,
    ],
  );

  // ─── Loading state ────────────────────────────────────────────
  if (isLoading || !detail) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />
        {channelError ? (
          <View className="items-center px-8">
            <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
            <Text className="mt-3 text-center text-base text-foreground">
              {channelError}
            </Text>
            <TouchableOpacity
              onPress={() => void fetchChannel(true)}
              className="mt-4 rounded-full px-6 py-2.5"
              style={{ backgroundColor: primaryColor }}
            >
              <Text className="font-semibold text-white">Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ActivityIndicator color={primaryColor} size="large" />
        )}
      </View>
    );
  }

  const counterpartName = isAsker ? detail.acceptorName : detail.askerName;
  const counterpartImage = isAsker ? detail.acceptorImage : detail.askerImage;

  // ─── Rating Modal ─────────────────────────────────────────────
  const renderRatingModal = () => (
    <Modal
      visible={ratingModalVisible}
      transparent
      animationType="fade"
      onRequestClose={() => setRatingModalVisible(false)}
    >
      <Pressable
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.5)",
          justifyContent: "center",
          alignItems: "center",
        }}
        onPress={() => setRatingModalVisible(false)}
      >
        <Pressable
          onPress={() => {}}
          style={{
            width: "85%",
            backgroundColor: cardColor,
            borderRadius: 24,
            padding: 24,
          }}
        >
          <Text className="mb-2 text-center text-lg font-bold text-foreground">
            Rate this answer
          </Text>
          <Text className="mb-5 text-center text-sm text-muted-foreground">
            How would you rate the teacher&apos;s response?
          </Text>

          <View className="mb-6 flex-row items-center justify-center gap-3">
            {[1, 2, 3, 4, 5].map((star) => (
              <TouchableOpacity key={star} onPress={() => setSelectedRating(star)}>
                <Ionicons
                  name={star <= selectedRating ? "star" : "star-outline"}
                  size={36}
                  color={star <= selectedRating ? "#f59e0b" : mutedIconColor}
                />
              </TouchableOpacity>
            ))}
          </View>

          <View className="flex-row gap-3">
            <TouchableOpacity
              onPress={() => setRatingModalVisible(false)}
              className="flex-1 items-center rounded-xl border border-border py-3"
            >
              <Text className="font-semibold text-foreground">Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!selectedRating || isClosing}
              onPress={handleClose}
              className="flex-1 items-center rounded-xl py-3"
              style={{
                backgroundColor: selectedRating ? primaryColor : `${primaryColor}55`,
              }}
            >
              {isClosing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="font-semibold text-white">Submit</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-background"
      style={{ backgroundColor: chatSurfaceColor }}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}
    >
      <StatusBar barStyle={statusBarStyle} backgroundColor={chatHeaderColor} />

      {renderRatingModal()}

      {/* ── Header ──────────────────────────────────────────── */}
      <View
        style={{
          backgroundColor: chatHeaderColor,
          borderBottomWidth: 0.5,
          borderBottomColor: borderColor,
          paddingTop:
            Platform.OS === "ios"
              ? Math.max(insets.top, 44)
              : (StatusBar.currentHeight ?? 0) + 8,
          paddingBottom: 10,
          paddingHorizontal: 16,
        }}
      >
        {/* Row 1: back + avatar/name + call icons */}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {/* Back */}
          <TouchableOpacity
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace("/(tabs)" as any)
            }
            hitSlop={12}
            style={{ marginRight: 6 }}
          >
            <Ionicons
              name="chevron-back"
              size={26}
              color={isDark ? "#f1f5f9" : "#111827"}
            />
          </TouchableOpacity>

          {/* Avatar */}
          {counterpartImage ? (
            <Image
              source={{ uri: counterpartImage }}
              style={{ width: 38, height: 38, borderRadius: 19, marginRight: 10 }}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                backgroundColor: primarySoftColor,
                alignItems: "center",
                justifyContent: "center",
                marginRight: 10,
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: "700", color: primaryColor }}>
                {counterpartName.charAt(0).toUpperCase()}
              </Text>
            </View>
          )}

          {/* Name + subtitle */}
          <View style={{ flex: 1 }}>
            <Text
              style={{
                fontSize: 16,
                fontWeight: "700",
                color: isDark ? "#f1f5f9" : "#111827",
              }}
              numberOfLines={1}
            >
              {counterpartName}
            </Text>
            <Text
              style={{ fontSize: 11, color: mutedIconColor, marginTop: 1 }}
              numberOfLines={1}
            >
              {detail.questionTitle}
            </Text>
          </View>

          {/* Call icons (right side) */}
          {isActive ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <TouchableOpacity
                onPress={() => handleStartCall("VIDEO")}
                disabled={!!startingCallType}
                hitSlop={8}
              >
                {startingCallType === "VIDEO" ? (
                  <ActivityIndicator size={18} color={primaryColor} />
                ) : (
                  <Ionicons
                    name="videocam-outline"
                    size={24}
                    color={isDark ? "#f1f5f9" : "#111827"}
                  />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleStartCall("AUDIO")}
                disabled={!!startingCallType}
                hitSlop={8}
              >
                {startingCallType === "AUDIO" ? (
                  <ActivityIndicator size={18} color={primaryColor} />
                ) : (
                  <Ionicons
                    name="call-outline"
                    size={22}
                    color={isDark ? "#f1f5f9" : "#111827"}
                  />
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View
              style={{
                backgroundColor: chatPanelColor,
                borderRadius: 8,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "600", color: mutedIconColor }}>
                {detail.status === "CLOSED" ? "Closed" : detail.status}
              </Text>
            </View>
          )}
        </View>

        {/* Row 2: timer + action buttons (only when active) */}
        {isActive && (
          <View
            style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 }}
          >
            <ChannelTimer
              timerDeadline={detail?.timerDeadline ?? null}
              channelId={channelId}
              isActive={isActive}
              isAnswerSubmitted={!!detail?.isAnswerSubmitted}
              timeExtensionCount={detail?.timeExtensionCount ?? 0}
              primaryColor={primaryColor}
            />

            <View style={{ flex: 1 }} />

            {isAcceptor && !detail.isAnswerSubmitted && markedMessageIds.length > 0 ? (
              <TouchableOpacity
                onPress={handleSubmitAnswer}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  backgroundColor: "#10b981",
                  borderRadius: 20,
                  paddingHorizontal: 12,
                  paddingVertical: 5,
                }}
              >
                <Ionicons name="checkmark-done-outline" size={13} color="#fff" />
                <Text style={{ fontSize: 12, fontWeight: "600", color: "#fff" }}>
                  Submit Answer
                </Text>
              </TouchableOpacity>
            ) : null}

            {isAsker && detail.isAnswerSubmitted ? (
              <TouchableOpacity
                onPress={() => {
                  setSelectedRating(0);
                  setRatingModalVisible(true);
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  backgroundColor: primaryColor,
                  borderRadius: 20,
                  paddingHorizontal: 12,
                  paddingVertical: 5,
                }}
              >
                <Ionicons name="checkmark-circle-outline" size={13} color="#fff" />
                <Text style={{ fontSize: 12, fontWeight: "600", color: "#fff" }}>
                  Close & Rate
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </View>

      {/* ── Answer submitted banner (asker view) ────────────── */}
      {isAsker && detail.isAnswerSubmitted && isActive && (
        <View
          style={{
            backgroundColor: "#10b98115",
            borderBottomWidth: 1,
            borderBottomColor: "#10b98130",
            paddingHorizontal: 16,
            paddingVertical: 8,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Ionicons name="checkmark-circle" size={16} color="#10b981" />
          <Text style={{ fontSize: 13, color: "#10b981", fontWeight: "500", flex: 1 }}>
            Teacher submitted an answer — review and close the channel when ready.
          </Text>
        </View>
      )}

      {/* ── Question context banner ─────────────────────────── */}
      {/* Collapsed by default — tap to expand and see the question title +
          the images the student attached when posting the question.           */}
      {detail.questionTitle ? (
        <View
          style={{
            backgroundColor: isDark ? "#15231f" : "#f0f9ff",
            borderBottomWidth: 1,
            borderBottomColor: isDark ? "rgba(255,255,255,0.08)" : "#bae6fd",
          }}
        >
          {/* Always-visible header row — tap to expand / collapse */}
          <TouchableOpacity
            onPress={() => setQuestionBannerExpanded((v) => !v)}
            activeOpacity={0.8}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 14,
              paddingVertical: 8,
              gap: 8,
            }}
          >
            <Ionicons name="help-circle" size={15} color={primaryColor} />
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                fontSize: 12,
                fontWeight: "600",
                color: chatTextColor,
              }}
            >
              {detail.questionTitle}
            </Text>
            <Ionicons
              name={questionBannerExpanded ? "chevron-up" : "chevron-down"}
              size={14}
              color={mutedIconColor}
            />
          </TouchableOpacity>

          {/* Expanded: only images posted with the question */}
          {questionBannerExpanded ? (
            <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
              {Array.isArray(detail.questionImages) &&
              detail.questionImages.length > 0 ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {detail.questionImages.map((uri, idx) => (
                    <TouchableOpacity key={idx} onPress={() => openImageViewer(uri)}>
                      <Image
                        source={{ uri }}
                        style={{ width: 80, height: 80, borderRadius: 10 }}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <Text style={{ fontSize: 12, color: mutedIconColor }}>
                  No images attached to this question.
                </Text>
              )}
            </View>
          ) : null}
        </View>
      ) : null}

      {/* ── Messages ────────────────────────────────────────── */}
      <FlatList
        ref={flatListRef}
        data={messagesWithDates}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        keyExtractor={(item, i) =>
          "__dateSeparator" in item
            ? `sep-${item.__dateSeparator}-${i}`
            : item.id || item.localId || `msg-${i}`
        }
        renderItem={renderItem as any}
        style={{ backgroundColor: chatSurfaceColor }}
        contentContainerStyle={{ paddingVertical: 10 }}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => {
          if (!isLoadingOlderRef.current) {
            flatListRef.current?.scrollToEnd({ animated: false });
          }
          isLoadingOlderRef.current = false;
        }}
        ListHeaderComponent={
          messages.length > visibleCount ? (
            <TouchableOpacity
              onPress={handleLoadOlder}
              className="mx-auto my-3 flex-row items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2"
              activeOpacity={0.7}
            >
              <Ionicons name="arrow-up-circle-outline" size={15} color={mutedIconColor} />
              <Text className="text-xs text-muted-foreground">Load older messages</Text>
            </TouchableOpacity>
          ) : null
        }
      />

      {/* ── Input bar ───────────────────────────────────────── */}
      {isActive ? (
        <View
          style={{
            backgroundColor: chatHeaderColor,
            borderTopWidth: 0.5,
            borderTopColor: borderColor,
            paddingHorizontal: 12,
            paddingTop: 10,
            paddingBottom: Math.max(insets.bottom, Platform.OS === "ios" ? 20 : 8) + 4,
          }}
        >
          {/* ── Recording in progress ── */}
          {isRecording ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 4,
              }}
            >
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: "#ef4444",
                }}
              />
              <Text
                style={{
                  flex: 1,
                  fontFamily: "monospace",
                  fontSize: 16,
                  color: "#ef4444",
                }}
              >
                {formatRecordingTime(recordingDuration)}
              </Text>
              <TouchableOpacity
                onPress={handleVoiceRecord}
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  backgroundColor: "#ef4444",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="stop" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : pendingAudio ? (
            /* ── Audio preview ── */
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <TouchableOpacity
                onPress={togglePreviewPlayback}
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  backgroundColor: chatInputColor,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons
                  name={isPlayingPreview ? "pause" : "play"}
                  size={20}
                  color={chatTextColor}
                />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "500",
                    color: chatTextColor,
                  }}
                >
                  Voice message
                </Text>
                <Text style={{ fontSize: 12, color: mutedIconColor }}>
                  {formatRecordingTime(pendingAudio.duration)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={cancelPendingAudio}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  backgroundColor: isDark ? "#3f1212" : "#fee2e2",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="trash-outline" size={17} color="#ef4444" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSendPendingAudio}
                disabled={isSending}
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  backgroundColor: chatPrimaryActionColor,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {isSending ? (
                  <ActivityIndicator color={chatPrimaryActionTextColor} size="small" />
                ) : (
                  <Ionicons name="send" size={18} color={chatPrimaryActionTextColor} />
                )}
              </TouchableOpacity>
            </View>
          ) : (
            /* ── Normal input — matches screenshot: + | input | mic circle ── */
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10 }}>
              {/* + button (gallery + camera) */}
              <TouchableOpacity
                onPress={handlePickImage}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: 2,
                }}
                hitSlop={6}
              >
                <Ionicons name="add" size={26} color={chatSubtleIconColor} />
              </TouchableOpacity>

              {/* Text input pill */}
              <View
                style={{
                  flex: 1,
                  backgroundColor: chatInputColor,
                  borderRadius: 22,
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  maxHeight: 120,
                }}
              >
                <TextInput
                  value={inputText}
                  onChangeText={setInputText}
                  placeholder="Type Here..."
                  placeholderTextColor={mutedIconColor}
                  multiline
                  style={{
                    fontSize: 15,
                    color: chatTextColor,
                    textAlignVertical: "top",
                    maxHeight: 100,
                    padding: 0,
                  }}
                />
              </View>

              {/* Send / Mic — dark circle like screenshot */}
              <TouchableOpacity
                onPress={inputText.trim() ? handleSend : handleVoiceRecord}
                disabled={isSending}
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  backgroundColor: chatPrimaryActionColor,
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: 2,
                }}
              >
                {isSending ? (
                  <ActivityIndicator color={chatPrimaryActionTextColor} size="small" />
                ) : inputText.trim() ? (
                  <Ionicons name="send" size={18} color={chatPrimaryActionTextColor} />
                ) : (
                  <Ionicons
                    name="mic-outline"
                    size={20}
                    color={chatPrimaryActionTextColor}
                  />
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      ) : (
        <View
          style={{
            backgroundColor: cardColor,
            borderTopWidth: 1,
            borderTopColor: borderColor,
            paddingHorizontal: 16,
            paddingVertical: 14,
            paddingBottom: Math.max(insets.bottom, Platform.OS === "ios" ? 20 : 8) + 6,
          }}
        >
          <Text className="text-center text-sm text-muted-foreground">
            This channel is {detail.status.toLowerCase()}.
            {detail.ratingGiven ? ` Rated ${detail.ratingGiven}/5.` : ""}
          </Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
