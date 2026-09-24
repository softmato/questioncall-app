import React, { useState, useRef, useEffect, useCallback } from "react";
import { View, Text, TouchableOpacity, Image, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
};

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
  const activeColor = onAccent ? "#ffffff" : isDark ? "#cbd5e1" : "#374151";
  const inactiveColor = onAccent
    ? "rgba(255,255,255,0.3)"
    : isDark
      ? "rgba(203,213,225,0.22)"
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
  primaryColor,
}: {
  mediaUrl: string;
  /** True when this player sits on the solid accent bubble. */
  onAccent: boolean;
  isDark: boolean;
  primaryColor: string;
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

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minWidth: 200 }}>
      {/* Play/Pause circle */}
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
              ? "rgba(255,255,255,0.12)"
              : "rgba(0,0,0,0.08)",
        }}
      >
        {isLoading ? (
          <ActivityIndicator
            size="small"
            color={onAccent ? "#fff" : isDark ? "#e2e8f0" : "#374151"}
          />
        ) : (
          <Ionicons
            name={isPlaying ? "pause" : "play"}
            size={18}
            color={onAccent ? "#fff" : isDark ? "#e2e8f0" : "#374151"}
          />
        )}
      </TouchableOpacity>

      {/* Waveform + duration */}
      <View style={{ flex: 1 }}>
        <WaveformBars progress={progress} onAccent={onAccent} isDark={isDark} />
        <Text
          style={{
            fontSize: 11,
            marginTop: 3,
            color: onAccent
              ? "rgba(255,255,255,0.65)"
              : isDark
                ? "rgba(226,232,240,0.62)"
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
}: Props) {
  // ── Date separator ────────────────────────────────────────
  if ("__dateSeparator" in item) {
    return (
      <View style={{ alignItems: "center", marginVertical: 14 }}>
        <View
          style={{
            backgroundColor: isDark ? "rgba(32,44,39,0.9)" : "rgba(100,116,139,0.15)",
            borderRadius: 20,
            paddingHorizontal: 14,
            paddingVertical: 4,
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "500", color: mutedIconColor }}>
            {item.__dateSeparator}
          </Text>
        </View>
      </View>
    );
  }

  const msg = item;

  // ── Deleted ───────────────────────────────────────────────
  if (msg.isDeleted) {
    return (
      <View style={{ alignItems: "center", marginVertical: 4 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: isDark ? "rgba(32,44,39,0.9)" : "rgba(100,116,139,0.1)",
            borderRadius: 20,
            paddingHorizontal: 14,
            paddingVertical: 6,
          }}
        >
          <Ionicons name="trash-outline" size={14} color={mutedIconColor} />
          <Text style={{ fontSize: 13, color: mutedIconColor }}>Message deleted</Text>
        </View>
      </View>
    );
  }

  // ── System message ────────────────────────────────────────
  if (msg.isSystemMessage) {
    return (
      <View style={{ alignItems: "center", marginVertical: 6, paddingHorizontal: 32 }}>
        <View
          style={{
            backgroundColor: "rgba(14,165,233,0.1)",
            borderRadius: 14,
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          <Text
            style={{
              fontSize: 13,
              textAlign: "center",
              color: "#0ea5e9",
              lineHeight: 20,
            }}
          >
            {msg.content}
          </Text>
        </View>
      </View>
    );
  }

  // ── Regular message ───────────────────────────────────────
  const isOwn = msg.isOwn || msg.senderId === userId;
  const showMark = isAcceptor && isActive && isOwn && !isAnswerSubmitted;

  // Bubble colours.
  //
  // The incoming side carries the brand green at full strength with white text
  // (~4.9:1) so the other person's messages are what draws the eye. Own
  // messages sit back on the same hue dropped to a low-opacity tint — heavier
  // in dark mode so it still separates from the near-black chat surface — with
  // near-solid foreground text, so legibility comes from the text rather than
  // from the tint.
  const sentBg = isDark ? "rgba(10,138,75,0.22)" : "rgba(10,138,75,0.09)";
  const receivedBg = primaryColor;
  const bubbleBg = isOwn ? sentBg : receivedBg;
  const textColor = isOwn ? (isDark ? "#e9edef" : "#0f172a") : "#ffffff";
  // The meta line now sits outside the bubble, so it reads against the chat
  // surface rather than the bubble fill.
  const metaColor = isDark ? "rgba(233,237,239,0.55)" : "rgba(15,23,42,0.5)";

  // Answer-marked overlay
  const isMarked = !!msg.isMarkedAsAnswer;

  return (
    <View
      style={{
        // Tight inside a run, open between runs — the grouping does the
        // visual separating so the bubbles themselves can stay quiet.
        marginTop: isGroupStart ? 8 : 2,
        marginBottom: isGroupEnd ? 2 : 0,
        paddingHorizontal: 14,
        alignItems: isOwn ? "flex-end" : "flex-start",
      }}
    >
      <View
        style={{
          maxWidth: "78%",
          borderRadius: 20,
          // Only the tail of a run gets its outer corner flattened; messages
          // stacked above it stay fully rounded.
          ...(isGroupEnd
            ? isOwn
              ? { borderBottomRightRadius: 6 }
              : { borderBottomLeftRadius: 6 }
            : {}),
          paddingHorizontal: 14,
          paddingVertical: 10,
          backgroundColor: bubbleBg,
          // Answer highlighted border
          ...(isMarked ? { borderWidth: 2, borderColor: "#f59e0b" } : {}),
        }}
      >
        {/* Image */}
        {msg.mediaUrl && msg.mediaType === "IMAGE" ? (
          <TouchableOpacity
            onPress={() => onImageOpen(msg.mediaUrl!)}
            style={{ marginBottom: 6 }}
          >
            <Image
              source={{ uri: msg.mediaUrl }}
              style={{ width: 220, height: 220, borderRadius: 12 }}
              resizeMode="cover"
            />
          </TouchableOpacity>
        ) : null}

        {/* Audio */}
        {msg.mediaType === "AUDIO" && msg.mediaUrl ? (
          <AudioMessagePlayer
            mediaUrl={msg.mediaUrl}
            onAccent={!isOwn}
            isDark={isDark}
            primaryColor={primaryColor}
          />
        ) : null}

        {/* Text */}
        {msg.content ? (
          <Text style={{ fontSize: 15, lineHeight: 22, color: textColor }}>
            {msg.content}
          </Text>
        ) : null}

        {/* Mark as answer star (acceptor only) */}
        {showMark ? (
          <TouchableOpacity
            onPress={() => onToggleMark(msg.id || msg._id || "", isMarked)}
            style={{
              position: "absolute",
              top: -10,
              right: -10,
              width: 30,
              height: 30,
              borderRadius: 15,
              backgroundColor: isDark ? "#2a3942" : cardColor,
              borderWidth: 1,
              borderColor: isDark ? "rgba(255,255,255,0.08)" : borderColor,
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
              size={16}
              color="#f59e0b"
            />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Meta line — outside the bubble, and only under the last message of a
          run, so a burst of messages doesn't repeat the same timestamp. */}
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
          <Text style={{ fontSize: 11, color: "#ef4444" }}>Tap to retry</Text>
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
            {formatMessageTime(msg.sentAt)}
          </Text>
          {isOwn ? (
            msg.isSending ? (
              <Ionicons name="time-outline" size={12} color={metaColor} />
            ) : msg.isSeen ? (
              <Ionicons name="checkmark-done" size={13} color={primaryColor} />
            ) : msg.isDelivered ? (
              <Ionicons name="checkmark" size={13} color={metaColor} />
            ) : null
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export const MessageItem = React.memo(MessageItemInner);
