import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import {
  type LayoutChangeEvent,
  Text,
  TouchableOpacity,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";

import {
  CENTER_BUTTON_RAISE,
  TAB_BAR_HEIGHT,
  useBottomChrome,
  useTabBarMetrics,
} from "@/components/ui/bottom-chrome";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * The Ask action as a floating pill, for while the tab bar is hidden.
 *
 * Asking a question is the one thing this app exists for, so it is the one
 * control that survives a scroll. It is not a second button: it is the *same*
 * button, in its other position. Both ends carry the same icon and the same
 * label, and the pill's exit is aimed at the center button's exact resting
 * spot — it shrinks and slides into it as the bar arrives, so the two read as
 * one control moving rather than as one appearing while another vanishes.
 *
 * Geometry is derived, not guessed, so the merge stays aimed at the center
 * button if the bar's height or the inset ever changes.
 */

/** Matches the extended-FAB proportions in the reference. */
const PILL_HEIGHT = 52;
const RIGHT_MARGIN = 18;
/** Clearance above the system inset, so the pill clears a 3-button nav bar. */
const BOTTOM_GAP = 4;

/** Width to aim at before the pill has been measured. Replaced on first layout. */
const ASSUMED_PILL_WIDTH = 108;

export function AskFab({ label }: { label: string }) {
  const { width: screenWidth } = useWindowDimensions();
  const { bottomPadding } = useTabBarMetrics();
  const { primaryColor } = useAppTheme();
  const chrome = useBottomChrome();
  const progress = chrome?.progress;

  const [pillWidth, setPillWidth] = useState(ASSUMED_PILL_WIDTH);

  /*
   * Touchability is React state rather than an animated `pointerEvents`,
   * because it has to be off for the whole time the pill is invisible — an
   * unreachable 52px target parked over the Courses tab would otherwise
   * swallow the tap meant for it.
   */
  const [reachable, setReachable] = useState(false);

  useAnimatedReaction(
    () => (progress?.value ?? 0) > 0.5,
    (isHidden, wasHidden) => {
      if (isHidden !== wasHidden) {
        runOnJS(setReachable)(isHidden);
      }
    },
  );

  /*
   * Where the center button sits, measured from the same origin as the pill.
   * The bar is `TAB_BAR_HEIGHT + bottomPadding` tall and the center button is
   * lifted `CENTER_BUTTON_RAISE` above its row's midpoint, which puts its
   * center `TAB_BAR_HEIGHT - CENTER_BUTTON_RAISE` above the inset.
   */
  const centerButtonY = bottomPadding + TAB_BAR_HEIGHT - CENTER_BUTTON_RAISE;
  const pillY = bottomPadding + BOTTOM_GAP + PILL_HEIGHT / 2;

  // Negative: the pill travels left, from the right margin to the screen's mid.
  const mergeX = pillWidth / 2 + RIGHT_MARGIN - screenWidth / 2;
  const mergeY = -(centerButtonY - pillY);

  const pillStyle = useAnimatedStyle(() => {
    const value = progress?.value ?? 0;

    return {
      /*
       * Gone well before it lands. The pill is opaque by the time the bar has
       * finished leaving and transparent well before it reaches the center, so
       * the two controls overlap for only a few frames — long enough to read as
       * a handoff, short enough that there are never plainly two Ask buttons.
       */
      opacity: interpolate(value, [0.18, 0.72], [0, 1], Extrapolation.CLAMP),
      transform: [
        { translateX: interpolate(value, [0, 1], [mergeX, 0]) },
        { translateY: interpolate(value, [0, 1], [mergeY, 0]) },
        { scale: interpolate(value, [0, 1], [0.4, 1]) },
      ],
    };
  });

  function onLayout(event: LayoutChangeEvent) {
    const measured = Math.round(event.nativeEvent.layout.width);

    if (measured > 0 && measured !== pillWidth) {
      setPillWidth(measured);
    }
  }

  return (
    <Animated.View
      onLayout={onLayout}
      pointerEvents={reachable ? "auto" : "none"}
      style={[
        {
          position: "absolute",
          right: RIGHT_MARGIN,
          bottom: bottomPadding + BOTTOM_GAP,
        },
        pillStyle,
      ]}
    >
      <TouchableOpacity
        accessibilityElementsHidden={!reachable}
        accessibilityLabel={label}
        accessibilityRole="button"
        activeOpacity={0.85}
        importantForAccessibility={reachable ? "yes" : "no-hide-descendants"}
        onPress={() => {
          void Haptics.selectionAsync();
          router.push("/ask");
        }}
        style={{
          alignItems: "center",
          backgroundColor: primaryColor,
          borderRadius: PILL_HEIGHT / 2,
          elevation: 8,
          flexDirection: "row",
          gap: 8,
          height: PILL_HEIGHT,
          paddingLeft: 16,
          paddingRight: 20,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3,
          shadowRadius: 10,
        }}
      >
        <Ionicons name="add" size={22} color="#FFFFFF" />
        <Text style={{ fontSize: 15, fontWeight: "700", color: "#FFFFFF" }}>{label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}
