import { Tabs, usePathname, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View, Text, TouchableOpacity } from "react-native";
import { useCallback, useEffect } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { AskFab } from "@/components/ui/ask-fab";
import { maybeOpenCallSetup } from "@/lib/call-setup";
import {
  BottomChromeProvider,
  CENTER_BUTTON_RAISE,
  TAB_BAR_HEIGHT,
  useBottomChrome,
  useTabBarMetrics,
} from "@/components/ui/bottom-chrome";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import type { ComponentProps } from "react";

const TABS = ["feed", "channels", "courses", "menu"] as const;
type TabName = (typeof TABS)[number];
const SWIPE_DIST = 50;
const SWIPE_VEL = 400;

type IoniconName = ComponentProps<typeof Ionicons>["name"];

// ─── Center floating button ────────────────────────────────────
// Shrinks and fades as the bar leaves, rather than just riding it down: the
// floating pill is aimed at this button's resting spot, and the handoff only
// reads as one control moving if this end of it collapses as the other grows.
function CenterTabButton({
  children,
  onPress,
  backgroundColor,
  borderColor,
  progress,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  backgroundColor: string;
  borderColor: string;
  progress?: SharedValue<number>;
}) {
  const handoffStyle = useAnimatedStyle(() => {
    const value = progress?.value ?? 0;

    return {
      opacity: 1 - value,
      transform: [{ scale: 1 - value * 0.55 }],
    };
  });

  return (
    <Animated.View style={handoffStyle}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        style={{
          top: -CENTER_BUTTON_RAISE,
          alignItems: "center",
          justifyContent: "center",
          width: 64,
          height: 64,
          borderRadius: 32,
          borderWidth: 1,
          borderColor,
          backgroundColor,
          shadowColor: backgroundColor,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.32,
          shadowRadius: 8,
          elevation: 8,
        }}
      >
        {children}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Tab icon with optional badge ─────────────────────────────
function TabIcon({
  name,
  label,
  focused,
  activeColor,
  inactiveColor,
  badge,
}: {
  name: IoniconName;
  label: string;
  focused: boolean;
  activeColor: string;
  inactiveColor: string;
  badge?: number;
}) {
  const color = focused ? activeColor : inactiveColor;
  return (
    <View style={{ alignItems: "center", justifyContent: "center", width: 64, gap: 2 }}>
      <View>
        <Ionicons name={name} size={21} color={color} />
        {badge && badge > 0 ? (
          <View
            style={{
              position: "absolute",
              top: -4,
              right: -6,
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: "#EF4444",
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 3,
            }}
          >
            <Text
              style={{ fontSize: 9, fontWeight: "700", color: "#FFF", lineHeight: 11 }}
            >
              {badge > 99 ? "99+" : badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{
          fontSize: 10,
          lineHeight: 12,
          color,
          fontWeight: focused ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// ─── Custom tab bar ────────────────────────────────────────────
// Rendered via the `tabBar` prop so we can apply a counter-transform
// that keeps it perfectly still while the screen content slides.
const TAB_META: Record<
  string,
  { icon: IoniconName; iconFocused: IoniconName; label: string }
> = {
  feed: { icon: "list-outline", iconFocused: "list", label: "Feed" },
  channels: {
    icon: "chatbubbles-outline",
    iconFocused: "chatbubbles",
    label: "Channels",
  },
  courses: { icon: "book-outline", iconFocused: "book", label: "Courses" },
  menu: { icon: "menu-outline", iconFocused: "menu", label: "Menu" },
};

function CustomTabBar({
  state,
  navigation,
  primaryColor,
  cardColor,
  borderColor,
  mutedIconColor,
  isDark,
  bottomPadding,
  totalUnread,
  centerLabel,
  progress,
}: BottomTabBarProps & {
  primaryColor: string;
  cardColor: string;
  borderColor: string;
  mutedIconColor: string;
  isDark: boolean;
  bottomPadding: number;
  totalUnread: number;
  centerLabel: string;
  progress?: SharedValue<number>;
}) {
  const inactiveColor = isDark ? "#A8A29E" : mutedIconColor;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: cardColor,
        borderTopColor: borderColor,
        borderTopWidth: 1,
        height: TAB_BAR_HEIGHT + bottomPadding,
        paddingBottom: bottomPadding,
        paddingTop: 8,
      }}
    >
      {(() => {
        const renderTab = (route: (typeof state.routes)[number], index: number) => {
          const focused = state.index === index;
          const meta = TAB_META[route.name];
          if (!meta) return null;

          const onPress = () => {
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          return (
            <TouchableOpacity
              key={route.key}
              onPress={onPress}
              activeOpacity={0.7}
              style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
            >
              <TabIcon
                name={focused ? meta.iconFocused : meta.icon}
                label={meta.label}
                focused={focused}
                activeColor={primaryColor}
                inactiveColor={inactiveColor}
                badge={route.name === "channels" ? totalUnread : undefined}
              />
            </TouchableOpacity>
          );
        };

        // feed + channels | center FAB (pushes the Ask modal) | courses + menu
        return (
          <>
            {state.routes.slice(0, 2).map((route, i) => renderTab(route, i))}
            <View style={{ flex: 1, alignItems: "center" }}>
              <CenterTabButton
                onPress={() => router.push("/ask")}
                backgroundColor={primaryColor}
                borderColor={borderColor}
                progress={progress}
              >
                <View style={{ alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name="add" size={27} color="#FFFFFF" />
                  <Text style={{ fontSize: 9, fontWeight: "600", color: "#FFFFFF" }}>
                    {centerLabel}
                  </Text>
                </View>
              </CenterTabButton>
            </View>
            {state.routes.slice(2).map((route, i) => renderTab(route, i + 2))}
          </>
        );
      })()}
    </View>
  );
}

// ─── Tabs layout ───────────────────────────────────────────────
export default function TabsLayout() {
  // The provider has to sit above `<Tabs>` so every tab screen can feed it
  // scroll offsets, which is why the shell below is a separate component: a
  // component cannot consume the context it renders.
  return (
    <BottomChromeProvider>
      <TabsShell />
    </BottomChromeProvider>
  );
}

function TabsShell() {
  const userRole = useAppSelector((s) => s.user.data?.role);
  const totalUnread = useAppSelector((s) =>
    s.channels.list.reduce((count, ch) => count + (ch.unreadCount > 0 ? 1 : 0), 0),
  );
  const { cardColor, borderColor, primaryColor, mutedIconColor, isDark } = useAppTheme();
  const isTeacher = userRole === "TEACHER";
  const centerLabel = isTeacher ? "Actions" : "Ask";
  const { bottomPadding, height: tabBarHeight } = useTabBarMetrics();

  // ─── Hide on scroll ────────────────────────────────────────
  const chrome = useBottomChrome();
  const progress = chrome?.progress;

  const hideStyle = useAnimatedStyle(() => {
    const value = progress?.value ?? 0;

    return {
      // Fades slightly ahead of the slide, so the bar reads as leaving rather
      // than as being clipped by the screen edge.
      opacity: 1 - value * 0.6,
      // Slid by its full height, inset included, so nothing peeks out.
      transform: [{ translateY: value * tabBarHeight }],
    };
  });

  // ─── Swipe gesture ─────────────────────────────────────────
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const currentTab = segments[segments.length - 1] as TabName;
  const tabIdx = TABS.indexOf(currentTab);

  const currentIdx = useSharedValue(tabIdx);
  useEffect(() => {
    currentIdx.value = tabIdx;
  }, [currentIdx, tabIdx]);

  // First time into the app (cold start or a fresh sign-in), open Call setup if
  // anything would stop calls ringing. Here rather than the root layout so it
  // never races the sign-in navigation; the delay lets the notification prompt
  // from push registration go first.
  useEffect(() => {
    const timer = setTimeout(() => {
      void maybeOpenCallSetup(() => router.push("/settings/call-setup" as any));
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  const translateX = useSharedValue(0);
  // Captures translationX at the moment the gesture activates so the
  // visual starts from 0 (no jump after the activeOffsetX dead zone).
  const startOffset = useSharedValue(0);

  const goToTab = useCallback((index: number) => {
    router.navigate(`/(tabs)/${TABS[index]}` as any);
  }, []);

  const swipeGesture = Gesture.Pan()
    // Wide enough to ignore diagonal scroll jitter, tight enough to feel instant.
    .activeOffsetX([-12, 12])
    // Fail fast on vertical so FlatList scrolls never get hijacked.
    .failOffsetY([-10, 10])
    .onStart((e) => {
      // Capture the translation at activation so the visual starts from exactly 0
      // (eliminates the snap-jump caused by the activeOffsetX dead zone).
      startOffset.value = e.translationX;
    })
    .onUpdate((e) => {
      translateX.value = (e.translationX - startOffset.value) * 0.15;
    })
    .onEnd((e) => {
      "worklet";
      const ci = currentIdx.value;
      const triggered =
        ci >= 0 &&
        (Math.abs(e.translationX) > SWIPE_DIST || Math.abs(e.velocityX) > SWIPE_VEL);
      const goingNext = e.translationX < 0 && ci < TABS.length - 1;
      const goingPrev = e.translationX > 0 && ci > 0;

      if (triggered && (goingNext || goingPrev)) {
        // Snap to 0 instantly before navigation so the incoming screen
        // never inherits a non-zero translateX (prevents post-swipe shake).
        translateX.value = 0;
        runOnJS(goToTab)(goingNext ? ci + 1 : ci - 1);
      } else {
        translateX.value = withSpring(0, { damping: 20, stiffness: 300 });
      }
    });

  // Screen content slides; counter-transform keeps the tab bar locked in place.
  const swipeStyle = useAnimatedStyle(() => ({
    flex: 1,
    transform: [{ translateX: translateX.value }],
  }));

  const counterStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -translateX.value }],
  }));

  return (
    <GestureDetector gesture={swipeGesture}>
      <Animated.View style={swipeStyle}>
        <Tabs
          tabBar={(props) => (
            /*
             * Absolutely positioned, so the bar floats over the screens instead
             * of occupying a row of the navigator's column. Sliding it away must
             * not reflow the list underneath — otherwise every hide and show
             * would shift the text the reader is looking at. Screens reserve the
             * height themselves, via `tabBarClearance`.
             *
             * `box-none` so the strip the bar vacates hands its touches back to
             * the content behind it.
             */
            <Animated.View
              pointerEvents="box-none"
              style={[
                {
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  /*
                   * Tall enough to contain the center button's raise. Android
                   * does not deliver touches to a child drawn outside its
                   * parent's bounds, so a slot sized to the bar alone would
                   * make the top of the raised Ask button untappable.
                   */
                  height: TAB_BAR_HEIGHT + bottomPadding + CENTER_BUTTON_RAISE,
                },
                counterStyle,
              ]}
            >
              <Animated.View
                style={[
                  { position: "absolute", left: 0, right: 0, bottom: 0 },
                  hideStyle,
                ]}
              >
                <CustomTabBar
                  {...props}
                  primaryColor={primaryColor}
                  cardColor={cardColor}
                  borderColor={borderColor}
                  mutedIconColor={mutedIconColor}
                  isDark={isDark}
                  bottomPadding={bottomPadding}
                  totalUnread={totalUnread}
                  centerLabel={centerLabel}
                  progress={progress}
                />
              </Animated.View>

              {/*
                Grows out of the center button as the bar leaves, and shrinks
                back into it as the bar returns. A sibling of the sliding bar
                rather than a child, so it can hold still while the bar moves.
              */}
              <AskFab label={centerLabel} />
            </Animated.View>
          )}
          screenOptions={{
            headerShown: false,
            tabBarShowLabel: false,
            tabBarHideOnKeyboard: true,
          }}
        >
          <Tabs.Screen name="feed" />
          <Tabs.Screen name="channels" />
          <Tabs.Screen name="courses" />
          <Tabs.Screen name="menu" />
        </Tabs>
      </Animated.View>
    </GestureDetector>
  );
}
