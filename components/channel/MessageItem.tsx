import React, { useState, useRef, useEffect, useCallback } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Linking } from "react-native";
import { Image } from "expo-image";
import Animated, { FadeInDown } from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { InlineVideo } from "@/components/media/inline-video";
import { Audio } from "expo-av";
import { hasAnyActiveCall } from "@/lib/active-call";
import type { ChatMessage } from "@/store/slices/channelSlice";

type Props = {
  item: ChatMessage | { __dateSeparator: string };
  /** First message of a run from this sender — gets the full outer radius. */
  isGroupStart?: boolean;
  /** Last of the run — carries the timestamp and the flattened tail corner. */
  isGroupEnd?: boolean;
  userId: string | null;
  isAcceptor: boolean;
  isActive: boolean;
  isAnswerSubmitted: boolean;
  primaryColor: string;
  cardColor: string;
  borderColor: string;
  mutedIconColor: string;
  isDark: boolean;
  formatMessageTime: (iso: string) => string;
  onImageOpen: (url: string) => void;
  onRetry: (msg: ChatMessage) => void;
  onToggleMark: (id: string, isMarked: boolean) => void;
  /** Arrived or was sent while the chat is open — slides in instead of popping. */
  animateIn?: boolean;
};

const MEDIA_WIDTH = 240;

/** Chat-sized Cloudinary rendition; the viewer still opens the original. */
function thumbUrl(url: string) {
  return url.includes("res.cloudinary.com") && url.includes("/image/upload/")
    ? url.replace("/image/upload/", "/image/upload/c_limit,w_720,q_auto/")
    : url;
}

function mediaHeight(m: ChatMessage) {
  const w = m.localMedia?.width;
  const h = m.localMedia?.height;
  if (!w || !h) return MEDIA_WIDTH;
  return Math.round(Math.min(320, Math.max(160, (MEDIA_WIDTH * h) / w)));
}

function ChatImage({
  msg,
  frameColor,
  onOpen,
}: {
  msg: ChatMessage;
  frameColor: string;
  onOpen: (url: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = msg.mediaUrl!;
  const isRemote = /^https?:\/\//.test(url);
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={msg.isSending}
      onPress={() => {
        if (!failed) return onOpen(url);
        setFailed(false);
        setAttempt((a) => a + 1);
      }}
      style={{
        width: MEDIA_WIDTH,
        height: mediaHeight(msg),
        borderRadius: 16,
        overflow: "hidden",
        backgroundColor: frameColor,
      }}
    >
      <Image
        key={attempt}
        source={{ uri: isRemote ? thumbUrl(url) : url }}
        // While the uploaded copy downloads, keep showing the file we just
        // picked — swapping straight to the remote URL is what left the bubble
        // blank (black/white) until the chat was reopened.
        placeholder={msg.localPreviewUri ? { uri: msg.localPreviewUri } : undefined}
        placeholderContentFit="cover"
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={180}
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%" }}
      />
      {msg.isSending || failed ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.28)",
          }}
        >
          {msg.isSending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Ionicons name="refresh" size={26} color="#fff" />
          )}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// ── Waveform bars (static decorative) ────────────────────────
const BARS = [4, 8, 14, 10, 18, 12, 20, 14, 10, 16, 8, 18, 12, 6, 14, 10, 18, 8, 12, 16];

function WaveformBars({
  progress,
  onAccent,
  isDark,
}: {
  progress: number;
  /** True when the bubble behind these bars is the solid accent fill. */
  onAccent: boolean;
  isDark: boolean;
}) {
  const activeColor = onAccent ? "#ffffff" : isDark ? "#d6d3d1" : "#44403c";
  const inactiveColor = onAccent
    ? "rgba(255,255,255,0.35)"
    : isDark
      ? "rgba(214,211,209,0.25)"
      : "rgba(0,0,0,0.15)";
  const cutoff = Math.round(progress * BARS.length);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height: 24 }}>
      {BARS.map((h, i) => (
        <View
          key={i}
          style={{
            width: 3,
            height: h,
            borderRadius: 2,
            backgroundColor: i < cutoff ? activeColor : inactiveColor,
          }}
        />
      ))}
    </View>
  );
}

// ── Audio player ──────────────────────────────────────────────
function AudioMessagePlayer({
  mediaUrl,
  onAccent,
  isDark,
}: {
  mediaUrl: string;
  /** True when this player sits on the solid accent bubble. */
  onAccent: boolean;
  isDark: boolean;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    return () => {
      soundRef.current?.stopAsync().catch(() => {});
      soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
    };
  }, []);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const handlePress = useCallback(async () => {
    if (isPlaying && soundRef.current) {
      try {
        await soundRef.current.pauseAsync();
        setIsPlaying(false);
      } catch {}
      return;
    }
    if (soundRef.current) {
      try {
        await soundRef.current.playAsync();
        setIsPlaying(true);
      } catch {}
      return;
    }
    setIsLoading(true);
    try {
      // Never touch the audio mode while a call is live — flipping Android out
      // of MODE_IN_COMMUNICATION would knock the call's voice onto the media
      // stream (the "remote voice missing/tiny" bug).
      if (!hasAnyActiveCall()) {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
      }
      const { sound } = await Audio.Sound.createAsync(
        { uri: mediaUrl },
        { shouldPlay: true },
        (status) => {
          if (!status.isLoaded) return;
          setPositionSec((status.positionMillis ?? 0) / 1000);
          setDurationSec((status.durationMillis ?? 0) / 1000);
          if (status.didJustFinish) {
            setIsPlaying(false);
            setPositionSec(0);
            sound.unloadAsync().catch(() => {});
            soundRef.current = null;
          }
        },
      );
      soundRef.current = sound;
      setIsPlaying(true);
    } catch {
      // silent
    } finally {
      setIsLoading(false);
    }
  }, [isPlaying, mediaUrl]);

  const progress = durationSec > 0 ? positionSec / durationSec : 0;
  const timeLabel =
    durationSec > 0 ? formatTime(isPlaying ? positionSec : durationSec) : "0:00";
  const iconColor = onAccent ? "#fff" : isDark ? "#e7e5e4" : "#44403c";

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minWidth: 200 }}>
      <TouchableOpacity
        onPress={handlePress}
        disabled={isLoading}
        style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: onAccent
            ? "rgba(255,255,255,0.2)"
            : isDark
              ? "rgba(255,255,255,0.1)"
              : "rgba(0,0,0,0.06)",
        }}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : (
          <Ionicons name={isPlaying ? "pause" : "play"} size={18} color={iconColor} />
        )}
      </TouchableOpacity>

      <View style={{ flex: 1 }}>
        <WaveformBars progress={progress} onAccent={onAccent} isDark={isDark} />
        <Text
          style={{
            fontSize: 11,
            marginTop: 3,
            color: onAccent
              ? "rgba(255,255,255,0.7)"
              : isDark
                ? "rgba(231,229,228,0.6)"
                : "rgba(0,0,0,0.45)",
          }}
        >
          {timeLabel}
        </Text>
      </View>
    </View>
  );
}

// ── Main message item ─────────────────────────────────────────
function MessageItemInner({
  item,
  isGroupStart = true,
  isGroupEnd = true,
  userId,
  isAcceptor,
  isActive,
  isAnswerSubmitted,
  primaryColor,
  cardColor,
  borderColor,
  mutedIconColor,
  isDark,
  formatMessageTime,
  onImageOpen,
  onRetry,
  onToggleMark,
  animateIn = false,
}: Props) {
  const pillBg = isDark ? "rgba(255,255,255,0.07)" : "rgba(28,25,23,0.06)";

  // ── Date separator ────────────────────────────────────────
  if ("__dateSeparator" in item) {
    return (
      <View style={{ alignItems: "center", marginVertical: 12 }}>
        <View
          style={{
            backgroundColor: pillBg,
            borderRadius: 20,
            paddingHorizontal: 12,
            paddingVertical: 4,
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: "600", color: mutedIconColor }}>
            {item.__dateSeparator}
          </Text>
        </View>
      </View>
    );
  }

  const msg = item;
  const entering = animateIn ? FadeInDown.duration(220) : undefined;

  // ── Deleted ───────────────────────────────────────────────
  if (msg.isDeleted) {
    return (
      <View style={{ alignItems: "center", marginVertical: 4 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: pillBg,
            borderRadius: 20,
            paddingHorizontal: 14,
            paddingVertical: 6,
          }}
        >
          <Ionicons name="trash-outline" size={13} color={mutedIconColor} />
          <Text style={{ fontSize: 12, color: mutedIconColor, fontStyle: "italic" }}>
            Message deleted
          </Text>
        </View>
      </View>
    );
  }

  // ── System message ────────────────────────────────────────
  if (msg.isSystemMessage) {
    return (
      <Animated.View
        entering={entering}
        style={{ alignItems: "center", marginVertical: 8, paddingHorizontal: 32 }}
      >
        <View
          style={{
            backgroundColor: pillBg,
            borderRadius: 14,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          <Text
            style={{
              fontSize: 12.5,
              textAlign: "center",
              color: mutedIconColor,
              lineHeight: 18,
            }}
          >
            {msg.content}
          </Text>
        </View>
      </Animated.View>
    );
  }

  // ── Regular message ───────────────────────────────────────
  const isOwn = msg.isOwn || msg.senderId === userId;
  const showMark = isAcceptor && isActive && isOwn && !isAnswerSubmitted;

  // Own messages carry the brand accent; the other person's sit on a neutral
  // card. Nothing else in the chat is tinted, so the accent reads as "you".
  const bubbleBg = isOwn ? primaryColor : isDark ? cardColor : "#FFFFFF";
  const textColor = isOwn ? "#ffffff" : isDark ? "#F5F5F4" : "#1C1917";
  const metaColor = isDark ? "rgba(245,245,244,0.5)" : "rgba(28,25,23,0.45)";
  const frameColor = isDark ? "#3a3532" : "#E7E5E4";

  const isMarked = !!msg.isMarkedAsAnswer;
  // Optimistic sends have used a lowercase "image"; the server sends uppercase.
  const mediaType = msg.mediaType?.toUpperCase() ?? null;
  const isImage = mediaType === "IMAGE" && !!msg.mediaUrl;
  const isVideo = mediaType === "VIDEO" && !!msg.mediaUrl;
  // The web sends a document's file name as its text, shown on the file row.
  const isDocument = mediaType === "DOCUMENT" && !!msg.mediaUrl;
  const isVisual = isImage || isVideo;
  const hasCaption = !!msg.content && !isDocument;

  const tail = isGroupEnd
    ? isOwn
      ? { borderBottomRightRadius: 6 }
      : { borderBottomLeftRadius: 6 }
    : {};

  return (
    <Animated.View
      entering={entering}
      style={{
        // Tight inside a run, open between runs.
        marginTop: isGroupStart ? 8 : 2,
        marginBottom: isGroupEnd ? 2 : 0,
        paddingHorizontal: 12,
        alignItems: isOwn ? "flex-end" : "flex-start",
      }}
    >
      <View
        style={{
          maxWidth: "80%",
          borderRadius: 20,
          ...tail,
          // Photos/videos fill the bubble with a thin frame, like any chat app.
          paddingHorizontal: isVisual ? 3 : 14,
          paddingVertical: isVisual ? 3 : 9,
          backgroundColor: bubbleBg,
          opacity: msg.isSending && !isVisual ? 0.75 : 1,
          ...(!isOwn && !isDark ? { borderWidth: 0.5, borderColor } : {}),
          ...(isMarked ? { borderWidth: 2, borderColor: "#f59e0b" } : {}),
        }}
      >
        {isImage ? (
          <ChatImage msg={msg} frameColor={frameColor} onOpen={onImageOpen} />
        ) : null}

        {isVideo ? (
          <View style={{ borderRadius: 16, overflow: "hidden" }}>
            <InlineVideo uri={msg.mediaUrl!} width={MEDIA_WIDTH} height={170} />
            {msg.isSending ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "rgba(0,0,0,0.35)",
                  gap: 6,
                }}
              >
                <ActivityIndicator color="#fff" />
                <Text style={{ color: "#fff", fontSize: 12 }}>Uploading…</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {isDocument ? (
          <TouchableOpacity
            disabled={msg.isSending}
            onPress={() => Linking.openURL(msg.mediaUrl!).catch(() => {})}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, minWidth: 180 }}
          >
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: isOwn ? "rgba(255,255,255,0.18)" : pillBg,
              }}
            >
              {msg.isSending ? (
                <ActivityIndicator size="small" color={textColor} />
              ) : (
                <Ionicons name="document-text" size={20} color={textColor} />
              )}
            </View>
            <View style={{ flexShrink: 1 }}>
              <Text
                numberOfLines={2}
                style={{ fontSize: 14, fontWeight: "600", color: textColor }}
              >
                {msg.content || "Document"}
              </Text>
              <Text
                style={{ fontSize: 11, color: textColor, opacity: 0.7, marginTop: 1 }}
              >
                {msg.isSending ? "Uploading…" : "Tap to open"}
              </Text>
            </View>
          </TouchableOpacity>
        ) : null}

        {mediaType === "AUDIO" && msg.mediaUrl ? (
          <AudioMessagePlayer mediaUrl={msg.mediaUrl} onAccent={isOwn} isDark={isDark} />
        ) : null}

        {hasCaption ? (
          <Text
            style={{
              fontSize: 15,
              lineHeight: 21,
              color: textColor,
              ...(isVisual
                ? { paddingHorizontal: 9, paddingTop: 6, paddingBottom: 4 }
                : {}),
            }}
          >
            {msg.content}
          </Text>
        ) : null}

        {/* Mark as answer star (acceptor only) */}
        {showMark ? (
          <TouchableOpacity
            onPress={() => onToggleMark(msg.id || msg._id || "", isMarked)}
            hitSlop={6}
            style={{
              position: "absolute",
              top: -10,
              left: -12,
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: cardColor,
              borderWidth: 1,
              borderColor,
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#000",
              shadowOpacity: 0.1,
              shadowRadius: 4,
              elevation: 3,
            }}
          >
            <Ionicons
              name={isMarked ? "star" : "star-outline"}
              size={15}
              color="#f59e0b"
            />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Meta line — outside the bubble, only under the last message of a run. */}
      {msg.sendFailed ? (
        <TouchableOpacity
          onPress={() => onRetry(msg)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            marginTop: 3,
            paddingHorizontal: 4,
          }}
        >
          <Ionicons name="alert-circle" size={13} color="#ef4444" />
          <Text style={{ fontSize: 11, color: "#ef4444" }}>Not sent · Tap to retry</Text>
        </TouchableOpacity>
      ) : isGroupEnd ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            marginTop: 3,
            paddingHorizontal: 4,
          }}
        >
          <Text style={{ fontSize: 11, color: metaColor }}>
            {msg.isSending ? "Sending…" : formatMessageTime(msg.sentAt)}
          </Text>
          {isOwn && !msg.isSending ? (
            msg.isSeen ? (
              <Ionicons name="checkmark-done" size={14} color={primaryColor} />
            ) : msg.isDelivered ? (
              <Ionicons name="checkmark" size={14} color={metaColor} />
            ) : null
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}

export const MessageItem = React.memo(MessageItemInner);
