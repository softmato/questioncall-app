import { useFocusEffect } from "expo-router";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Easing,
  type SharedValue,
  useAnimatedScrollHandler,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

/**
 * Shared hide-on-scroll state for everything that lives at the bottom of a tab
 * screen — the tab bar itself and the floating Ask button that takes its place.
 *
 * One shared value drives both, so the bar leaving and the button arriving are
 * two halves of the same 220ms move rather than two animations that happen to
 * run at the same time.
 *
 * ## Thresholds
 *
 * Asymmetric on purpose. Hiding takes a deliberate downward push so a jittery
 * thumb, or the rubber-band at the end of a list, cannot make the bar flicker.
 * Showing takes barely a nudge — the moment someone scrolls back up they are
 * looking for a way off the screen, and making them scroll further to get
 * navigation back feels broken.
 */

const HIDE_AFTER = 16;
const SHOW_AFTER = 6;

/** Below this offset the bar always shows; near the top there is nothing to reclaim. */
const ALWAYS_SHOWN_BELOW = 48;

export const CHROME_TIMING = { duration: 220, easing: Easing.out(Easing.cubic) };

/** Bar height excluding the system inset. Screens reserve this plus the inset. */
export const TAB_BAR_HEIGHT = 56;

/**
 * How far the center Ask button is lifted above the bar's row.
 *
 * Exported because the floating pill aims its exit at that button, and a merge
 * that lands 16px off reads as two controls rather than as one moving.
 */
export const CENTER_BUTTON_RAISE = 16;

/**
 * The tab bar's geometry, in one place.
 *
 * `bottomPadding` keeps a floor under devices that report a `0` bottom inset,
 * and matches what the bar itself pads with — a screen reserving less than the
 * bar occupies puts its last row under the labels.
 */
export function useTabBarMetrics() {
  const insets = useSafeAreaInsets();
  const bottomPadding = Math.max(insets.bottom, Platform.OS === "ios" ? 20 : 10);

  return { bottomPadding, height: TAB_BAR_HEIGHT + bottomPadding };
}

type BottomChrome = {
  /**
   * Feed it the scroll offset. A worklet, so it runs on the UI thread when it
   * comes from a Reanimated scroll handler — a JS-thread handler drops frames
   * exactly when a list is rendering rows, which is exactly when someone is
   * scrolling. It is still callable from JS for screens driving their own
   * `Animated.event`.
   */
  onScroll: (offsetY: number) => void;
  /** 0 = bar fully shown, 1 = bar fully tucked away. Animated on the UI thread. */
  progress: SharedValue<number>;
  /** Bring the bar back and forget any accumulated intent. */
  reset: () => void;
};

const BottomChromeContext = createContext<BottomChrome | null>(null);

export function BottomChromeProvider({ children }: { children: ReactNode }) {
  const progress = useSharedValue(0);
  const lastOffset = useSharedValue(-1);
  const accumulated = useSharedValue(0);
  const hidden = useSharedValue(0);

  const onScroll = useCallback(
    (offsetY: number) => {
      "worklet";

      /*
       * The first event after a `reset` establishes where the list *is*; it is
       * not a scroll.
       *
       * `reset` runs when a screen takes focus and cannot know that screen's
       * offset — a tab keeps its scroll position, so returning to one sitting
       * at 800px would otherwise produce `delta = 800 - 0` on the very next
       * event. That is far past `HIDE_AFTER`, so the bar would slide away on
       * the first touch of the list in either direction, which reads as a
       * glitch rather than as hide-on-scroll.
       */
      if (lastOffset.value < 0) {
        lastOffset.value = offsetY;
        return;
      }

      const delta = offsetY - lastOffset.value;
      lastOffset.value = offsetY;

      if (offsetY <= ALWAYS_SHOWN_BELOW) {
        accumulated.value = 0;

        if (hidden.value === 1) {
          hidden.value = 0;
          progress.value = withTiming(0, CHROME_TIMING);
        }

        return;
      }

      // Direction change: start counting again from here, so the thresholds
      // measure intent rather than raw offset.
      if ((delta > 0 && accumulated.value < 0) || (delta < 0 && accumulated.value > 0)) {
        accumulated.value = 0;
      }

      /*
       * Clamped, so a long scroll in one direction cannot build a debt that has
       * to be repaid before the bar will come back. Without this the counter
       * grows with the list: after a 2000px scroll down it sits at +2000, and
       * every reversal has to burn all of it off first — which shows up as a
       * bar that only returns at the top of the list. The reset above normally
       * prevents that, but it only fires on a *clean* reversal, and a list that
       * corrects its own offset (`maintainVisibleContentPosition`, a settling
       * `RefreshControl`) interleaves the two directions. The bound is the
       * recovery cost in the worst case: a few tens of pixels, not a whole list.
       */
      accumulated.value = Math.min(
        Math.max(accumulated.value + delta, -SHOW_AFTER * 4),
        HIDE_AFTER * 4,
      );

      /*
       * `hidden` guards the animation. Without it every scroll frame would
       * restart `withTiming` from wherever it had reached, and the bar would
       * crawl instead of sliding.
       */
      if (accumulated.value > HIDE_AFTER && hidden.value === 0) {
        hidden.value = 1;
        accumulated.value = 0;
        progress.value = withTiming(1, CHROME_TIMING);
      } else if (accumulated.value < -SHOW_AFTER && hidden.value === 1) {
        hidden.value = 0;
        accumulated.value = 0;
        progress.value = withTiming(0, CHROME_TIMING);
      }
    },
    [accumulated, hidden, lastOffset, progress],
  );

  /*
   * Called when a screen takes focus. The state is shared across the tab
   * navigator, so without this you could scroll a list until the bar hid,
   * switch tabs, and arrive on a screen sitting at the top with no navigation
   * showing and no obvious way to get it back.
   */
  const reset = useCallback(() => {
    // `-1`, not `0`: the next scroll event supplies the real offset. See the
    // baseline note in `onScroll`.
    lastOffset.value = -1;
    accumulated.value = 0;
    hidden.value = 0;
    progress.value = withTiming(0, CHROME_TIMING);
  }, [accumulated, hidden, lastOffset, progress]);

  const value = { onScroll, progress, reset };

  return (
    <BottomChromeContext.Provider value={value}>{children}</BottomChromeContext.Provider>
  );
}

export function useBottomChrome() {
  return useContext(BottomChromeContext);
}

/**
 * What a tab screen needs to take part in hide-on-scroll.
 *
 * - `onScroll` for a Reanimated `Animated.ScrollView` / `Animated.FlatList`.
 * - `trackOffset` is the same logic as a bare worklet, for a screen that drives
 *   something else from the same scroll and needs one handler for both.
 * - `tabBarClearance` for the content's bottom padding. The bar is absolutely
 *   positioned so that hiding it does not reflow the list behind it, which
 *   means content has to reserve the height itself.
 *
 * Every tab screen goes through Reanimated. A screen feeding this from a
 * JS-thread scroll handler instead gets the offsets late and coalesced while
 * its list is rendering rows — which is precisely when someone is scrolling.
 */
export function useTabBarScroll() {
  const chrome = useBottomChrome();
  const { height } = useTabBarMetrics();

  // Destructured rather than captured whole: only these two cross into the UI
  // thread, and a worklet closure should carry nothing it does not use.
  const handleScroll = chrome?.onScroll;
  const reset = chrome?.reset;

  useFocusEffect(
    useCallback(() => {
      reset?.();
    }, [reset]),
  );

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      handleScroll?.(event.contentOffset.y);
    },
  });

  return {
    onScroll,
    scrollEventThrottle: 16,
    tabBarClearance: height,
    trackOffset: handleScroll,
  };
}
