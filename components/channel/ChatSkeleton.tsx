import { memo, useEffect } from "react";
import { Platform, StatusBar, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * Placeholder chat screen shown while a channel loads.
 *
 * It mirrors the real layout of `workspace/[channelId]` — header, question
 * banner, message bubbles, composer — so the swap to real content does not
 * shift anything. When the channels list already knows who the chat is with,
 * the header renders the real name and avatar instead of a grey block, which
 * makes the open read as instant even on a cold cache.
 */

/**
 * Breathing room under the composer. Keep in sync with COMPOSER_BOTTOM_GAP in
 * app/workspace/[channelId].tsx — a mismatch makes the bar jump when the real
 * chat replaces the skeleton.
 */
const COMPOSER_BOTTOM_GAP = 10;

/** Placeholder bubbles, alternating incoming / outgoing. */
const BUBBLE_ROWS: { own: boolean; width: number; lines: number }[] = [
  { own: false, width: 0.62, lines: 2 },
  { own: true, width: 0.45, lines: 1 },
  { own: false, width: 0.5, lines: 1 },
  { own: true, width: 0.68, lines: 2 },
  { own: false, width: 0.4, lines: 1 },
  { own: true, width: 0.55, lines: 1 },
  { own: false, width: 0.72, lines: 2 },
];

function useShimmer() {
  const progress = useSharedValue(0.4);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [progress]);

  return useAnimatedStyle(() => ({ opacity: progress.value }));
}

function Block({
  width,
  height,
  radius = 6,
  color,
  style,
}: {
  width: number | string;
  height: number;
  radius?: number;
  color: string;
  style?: any;
}) {
  return (
    <View
      style={[
        { width: width as any, height, borderRadius: radius, backgroundColor: color },
        style,
      ]}
    />
  );
}

function SkeletonBubble({
  own,
  width,
  lines,
  bubbleColor,
  lineColor,
  maxWidth,
}: {
  own: boolean;
  width: number;
  lines: number;
  bubbleColor: string;
  lineColor: string;
  maxWidth: number;
}) {
  return (
    <View
      style={{
        alignSelf: own ? "flex-end" : "flex-start",
        marginHorizontal: 12,
        marginVertical: 4,
        maxWidth: maxWidth * 0.78,
        width: maxWidth * width,
        backgroundColor: bubbleColor,
        borderRadius: 12,
        borderTopRightRadius: own ? 3 : 12,
        borderTopLeftRadius: own ? 12 : 3,
        paddingHorizontal: 11,
        paddingVertical: 9,
        gap: 6,
      }}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Block
          key={i}
          width={i === lines - 1 ? "72%" : "100%"}
          height={9}
          radius={4}
          color={lineColor}
        />
      ))}
      <Block
        width={34}
        height={7}
        radius={4}
        color={lineColor}
        style={{ alignSelf: "flex-end" }}
      />
    </View>
  );
}

function ChatSkeletonBase({
  counterpartName,
  counterpartImage,
  questionTitle,
  screenWidth,
}: {
  counterpartName?: string;
  counterpartImage?: string;
  questionTitle?: string;
  screenWidth: number;
}) {
  const insets = useSafeAreaInsets();
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
  const shimmerStyle = useShimmer();

  const chatSurfaceColor = isDark ? "#0b1411" : backgroundColor;
  const chatHeaderColor = isDark ? "#111b18" : backgroundColor;
  const chatPanelColor = isDark ? "#17231f" : cardColor;
  const chatInputColor = isDark ? "#202c27" : "#f1f5f9";
  const blockColor = isDark ? "rgba(255,255,255,0.09)" : "rgba(15,23,42,0.08)";
  const bubbleColor = isDark ? "#17231f" : "#f1f5f9";
  const bubbleLineColor = isDark ? "rgba(255,255,255,0.11)" : "rgba(15,23,42,0.09)";

  return (
    <View style={{ flex: 1, backgroundColor: chatSurfaceColor }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={chatHeaderColor} />

      {/* ── Header (real identity when the list already has it) ── */}
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
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ marginRight: 6 }}>
            <Ionicons
              name="chevron-back"
              size={26}
              color={isDark ? "#f1f5f9" : "#111827"}
            />
          </View>

          {counterpartImage ? (
            <Animated.Image
              source={{ uri: counterpartImage }}
              style={{ width: 38, height: 38, borderRadius: 19, marginRight: 10 }}
              resizeMode="cover"
            />
          ) : counterpartName ? (
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
          ) : (
            <Animated.View style={[{ marginRight: 10 }, shimmerStyle]}>
              <Block width={38} height={38} radius={19} color={blockColor} />
            </Animated.View>
          )}

          <View style={{ flex: 1 }}>
            {counterpartName ? (
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
            ) : (
              <Animated.View style={shimmerStyle}>
                <Block width={130} height={13} color={blockColor} />
              </Animated.View>
            )}
            {questionTitle ? (
              <Text
                style={{ fontSize: 11, color: mutedIconColor, marginTop: 3 }}
                numberOfLines={1}
              >
                {questionTitle}
              </Text>
            ) : (
              <Animated.View style={[{ marginTop: 6 }, shimmerStyle]}>
                <Block width={180} height={9} color={blockColor} />
              </Animated.View>
            )}
          </View>

          {/* Call icon placeholders */}
          <Animated.View
            style={[
              { flexDirection: "row", alignItems: "center", gap: 12 },
              shimmerStyle,
            ]}
          >
            <Block width={24} height={24} radius={7} color={blockColor} />
            <Block width={22} height={22} radius={7} color={blockColor} />
          </Animated.View>
        </View>

        {/* Timer row placeholder */}
        <Animated.View
          style={[
            { flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 },
            shimmerStyle,
          ]}
        >
          <Block width={92} height={24} radius={12} color={blockColor} />
        </Animated.View>
      </View>

      {/* ── Question banner placeholder ── */}
      <View
        style={{
          backgroundColor: isDark ? "#15231f" : "#f0f9ff",
          borderBottomWidth: 1,
          borderBottomColor: isDark ? "rgba(255,255,255,0.08)" : "#bae6fd",
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          paddingVertical: 10,
          gap: 8,
        }}
      >
        <Ionicons name="help-circle" size={15} color={primaryColor} />
        <Animated.View style={[{ flex: 1 }, shimmerStyle]}>
          <Block width="70%" height={9} color={blockColor} />
        </Animated.View>
      </View>

      {/* ── Message bubbles ── */}
      <Animated.View style={[{ flex: 1, paddingVertical: 10 }, shimmerStyle]}>
        {BUBBLE_ROWS.map((row, i) => (
          <SkeletonBubble
            key={i}
            own={row.own}
            width={row.width}
            lines={row.lines}
            bubbleColor={bubbleColor}
            lineColor={bubbleLineColor}
            maxWidth={screenWidth}
          />
        ))}
      </Animated.View>

      {/* ── Composer placeholder ── */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingTop: 10,
          paddingBottom: COMPOSER_BOTTOM_GAP + insets.bottom,
          backgroundColor: chatHeaderColor,
          borderTopWidth: 0.5,
          borderTopColor: borderColor,
        }}
      >
        <Animated.View
          style={[
            {
              flex: 1,
              height: 42,
              borderRadius: 21,
              backgroundColor: chatInputColor,
            },
            shimmerStyle,
          ]}
        />
        <Animated.View style={shimmerStyle}>
          <Block width={42} height={42} radius={21} color={chatPanelColor} />
        </Animated.View>
      </View>
    </View>
  );
}

export const ChatSkeleton = memo(ChatSkeletonBase);
export default ChatSkeleton;
