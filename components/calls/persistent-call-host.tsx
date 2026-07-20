import { useEffect } from "react";
import {
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { useAppSelector } from "@/hooks/redux";
import { closeCall, expandCall, minimizeCall, useCallUi } from "@/lib/call-ui-store";
import { setCallShowsOverLockScreen, useIsDeviceLocked } from "@/lib/call-keyguard";
import { CallScreen } from "@/components/calls/call-screen";

const BUBBLE_W = 116;
const BUBBLE_H = 158;
const BUBBLE_MARGIN = 12;

/**
 * Root-level host for the active call — the mobile mirror of the web's
 * `persistent-call-host.tsx`. <CallScreen/> mounts here (not in a routed
 * screen), so navigation never unmounts the LiveKit room:
 *
 * - expanded  → fullscreen overlay above the router content
 * - minimized → draggable floating bubble (WhatsApp-style); tap to expand
 * - no call   → renders nothing
 *
 * CRITICAL — the component tree below must stay IDENTICAL in both states.
 * React reconciles by element type and position, so returning a different
 * shape for minimized vs expanded (as an earlier version did) makes React
 * throw the subtree away and mount a fresh one. That unmounts <CallScreen/>,
 * whose cleanup effect disconnects the LiveKit room and stops the call — and
 * the remount then re-runs the caller bootstrap and places a SECOND call to
 * the same person. Minimize/expand therefore changes ONLY geometry and which
 * gestures are live; never the hierarchy.
 */
export function PersistentCallHost() {
  const { params, minimized, instance } = useCallUi();
  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);
  const { width: screenW, height: screenH } = useWindowDimensions();

  // Bubble position (top-left of bubble), spring-settled after drags.
  const defaultX = screenW - BUBBLE_W - BUBBLE_MARGIN;
  const defaultY = Platform.OS === "ios" ? 110 : 90;
  const posX = useSharedValue(defaultX);
  const posY = useSharedValue(defaultY);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const active = params !== null;

  // Logging out mid-call must end the call — the store reset wipes the user
  // the call session belongs to.
  useEffect(() => {
    if (!isAuthenticated && active) {
      closeCall();
    }
  }, [isAuthenticated, active]);

  // Let the call — and only the call — display over the lock screen, for as
  // long as the call lasts. See lib/call-keyguard.ts for why this is armed
  // per-call rather than declared once in the manifest.
  useEffect(() => {
    if (!active) return;
    setCallShowsOverLockScreen(true);
    return () => setCallShowsOverLockScreen(false);
  }, [active]);

  const deviceLocked = useIsDeviceLocked(active);
  // Minimizing while the keyguard is up would leave the bubble floating over
  // the rest of the app with the phone still locked — i.e. the whole app
  // readable without authentication. While locked the call stays fullscreen.
  const canMinimize = !deviceLocked;

  useEffect(() => {
    if (deviceLocked && minimized) expandCall();
  }, [deviceLocked, minimized]);

  // Android hardware back on the expanded overlay: minimize, don't let the
  // press fall through to the (invisible) screen underneath.
  useEffect(() => {
    if (!active || minimized) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canMinimize) minimizeCall();
      // Consumed either way — back must never reveal the app behind a call,
      // least of all over the lock screen.
      return true;
    });
    return () => sub.remove();
  }, [active, minimized, canMinimize]);

  // Dragging is a bubble-only affordance. Declared unconditionally (the
  // detector must exist in both states, see the note above) and switched off
  // while expanded so it can never swallow touches meant for the call UI —
  // in particular the PiP's own pan gesture inside <CallScreen/>.
  const pan = Gesture.Pan()
    .enabled(minimized)
    .minDistance(6)
    .onStart(() => {
      startX.value = posX.value;
      startY.value = posY.value;
    })
    .onUpdate((e) => {
      const maxX = screenW - BUBBLE_W - BUBBLE_MARGIN;
      const maxY = screenH - BUBBLE_H - BUBBLE_MARGIN - 40;
      posX.value = Math.min(maxX, Math.max(BUBBLE_MARGIN, startX.value + e.translationX));
      posY.value = Math.min(
        maxY,
        Math.max(BUBBLE_MARGIN + 30, startY.value + e.translationY),
      );
    })
    .onEnd(() => {
      // Snap horizontally to the nearest edge, WhatsApp-style.
      const mid = (screenW - BUBBLE_W) / 2;
      const targetX =
        posX.value > mid ? screenW - BUBBLE_W - BUBBLE_MARGIN : BUBBLE_MARGIN;
      posX.value = withSpring(targetX, { damping: 20, stiffness: 180 });
      posY.value = withSpring(posY.value, { damping: 20, stiffness: 200 });
    });

  // The one thing that differs between the two states: the surface's geometry.
  const surfaceStyle = useAnimatedStyle(() => {
    if (!minimized) {
      return {
        width: "100%",
        height: "100%",
        borderRadius: 0,
        borderWidth: 0,
        transform: [{ translateX: 0 }, { translateY: 0 }],
      };
    }
    return {
      width: BUBBLE_W,
      height: BUBBLE_H,
      borderRadius: 16,
      borderWidth: 2,
      transform: [{ translateX: posX.value }, { translateY: posY.value }],
    };
  }, [minimized]);

  if (!active || !params) return null;

  return (
    // box-none while minimized so the app underneath stays interactive and only
    // the bubble itself receives touches.
    <View style={styles.root} pointerEvents={minimized ? "box-none" : "auto"}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.surface, surfaceStyle]}>
          <Pressable
            style={styles.fill}
            disabled={!minimized}
            onPress={expandCall}
            accessibilityRole="button"
            accessibilityLabel={minimized ? "Return to call" : undefined}
          >
            <CallScreen
              key={instance}
              roomId={params.roomId}
              channelId={params.channelId ?? null}
              mode={params.mode ?? null}
              minimized={minimized}
              canMinimize={canMinimize}
            />
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    elevation: 100,
  },
  surface: {
    position: "absolute",
    top: 0,
    left: 0,
    overflow: "hidden",
    borderColor: "#22c55e",
    backgroundColor: "#000",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  fill: {
    flex: 1,
  },
});
