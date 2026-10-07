// ── Hermes polyfills ────────────────────────────────────────────────────────
// livekit-client uses the `Event` constructor (via abort-controller / event-target-shim)
// which is not available in React Native's Hermes engine. Polyfill it here
// before any LiveKit code runs to prevent "Property 'Event' doesn't exist".
import { useCallback, useEffect } from "react";
import { Appearance, AppState, AppStateStatus, Linking } from "react-native";
import { Stack, router } from "expo-router";
import { Provider } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Sentry from "@sentry/react-native";
import * as SecureStore from "expo-secure-store";
import * as SplashScreen from "expo-splash-screen";
import Toast from "react-native-toast-message";
import { ThemeProvider } from "@react-navigation/native";
import "../global.css";
import { useAppTheme } from "@/hooks/use-app-theme";
import { store, persistor } from "@/store";
import { setTokens, setAuthLoading, clearAuth } from "@/store/slices/authSlice";
import { setUser } from "@/store/slices/userSlice";
import { setConfig } from "@/store/slices/configSlice";
import { setChannels, selectIsChannelsStale } from "@/store/slices/channelsSlice";
import { setNotes, selectIsNotesStale } from "@/store/slices/notesSlice";
import {
  selectIsNotificationsStale,
  setNotifications,
  type AppNotification,
} from "@/store/slices/notificationsSlice";
import { api, SECURE_STORE_KEYS } from "@/lib/api";
import { getLaunchUrl, signInFromHostelPalika } from "@/lib/hostelpalika-sign-in";
import { Sprint2Bootstrap } from "@/components/sprint2/sprint2-bootstrap";
import { GlobalNoticeModal } from "@/components/notices/global-notice-modal";
import { GlobalOnboardingModal } from "@/components/onboarding/global-onboarding-modal";
import { RealtimeBridge } from "@/components/realtime/realtime-bridge";
import { ImageViewerProvider } from "@/components/image-viewer/image-viewer-context";
import {
  registerForPushNotifications,
  subscribePushToken,
  addNotificationResponseListener,
  addNotificationReceivedListener,
  getInitialNotificationResponse,
  CALL_ACTION_ACCEPT,
  CALL_ACTION_DECLINE,
} from "@/lib/push-notifications";
import type { NotificationResponse } from "expo-notifications";

import { ensureLiveKitRegistered } from "@/lib/livekit-setup";
import { setupCallKeep } from "@/lib/callkeep-setup";
import {
  setupFullScreenCallListeners,
  acceptCall,
  rejectCall,
} from "@/lib/full-screen-call-notification";
import { stopOngoingCallService } from "@/lib/ongoing-call-service";
import { resolveNotificationRoute } from "@/lib/notification-route";

import { BrandSplash, releaseBootSplash } from "@/components/branding/brand-splash";
import { GlobalUploadOverlay } from "@/components/sprint2/global-upload-overlay";
import { PersistentCallHost } from "@/components/calls/persistent-call-host";
import { CouponInviteHost } from "@/components/subscription/coupon-invite-host";

if (typeof globalThis.Event === "undefined") {
  (globalThis as any).Event = class Event {
    constructor(
      public type: string,
      options?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean },
    ) {
      this.bubbles = options?.bubbles ?? false;
      this.cancelable = options?.cancelable ?? false;
      this.composed = options?.composed ?? false;
    }
    bubbles = false;
    cancelable = false;
    composed = false;
  } as unknown as typeof globalThis.Event;
}

ensureLiveKitRegistered();
setupCallKeep();
setupFullScreenCallListeners();
// Theme, applied at module scope so it is in effect before the first frame.
// `userInterfaceStyle` is "automatic" in app.json — that is what lets
// Appearance.setColorScheme() take at all, but it also means a device set to
// dark boots dark. Restoring from an effect would paint that dark frame first
// and flash to light. SecureStore.getItem is the synchronous read, so the
// stored choice wins before anything renders.
// Light is the product default: only an explicit "dark" or "system" leaves it.
try {
  const themePreference = SecureStore.getItem("theme_preference");
  if (themePreference === "dark") Appearance.setColorScheme("dark");
  else if (themePreference === "system") Appearance.setColorScheme(null);
  else Appearance.setColorScheme("light");
} catch {
  Appearance.setColorScheme("light");
}
// Reaching module scope means JS is starting fresh, so no call can be in
// progress yet. Any ongoing-call service still alive is a leftover from a
// previous process that died mid-call — its notification is ongoing, so the
// user cannot swipe it away themselves. Sweep it before the UI comes up.
stopOngoingCallService();

SplashScreen.preventAutoHideAsync();

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    enableAutoSessionTracking: true,
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,
  });
}

function AppInitializer({ children }: { children: React.ReactNode }) {
  const fetchPlatformConfig = useCallback(async () => {
    try {
      const res = await api.get("/platform/config");
      store.dispatch(setConfig(res.data));
    } catch {
      // Non-fatal — app can still work with stale config
    }
  }, []);

  const backgroundPrefetch = useCallback(async () => {
    const s = store.getState() as any;
    const userId = s.user?.data?._id ?? null;
    // Channels
    if (selectIsChannelsStale(s.channels?.lastFetchedAt ?? null)) {
      api
        .get("/channels")
        .then((res) => {
          store.dispatch(
            setChannels({ channels: Array.isArray(res.data) ? res.data : [], userId }),
          );
        })
        .catch(() => {});
    }
    // Notes
    if (selectIsNotesStale(s.notes?.lastFetchedAt ?? null)) {
      api
        .get("/notes?limit=30")
        .then((res) => {
          store.dispatch(setNotes(Array.isArray(res.data) ? res.data : []));
        })
        .catch(() => {});
    }
    // Notifications — drives the menu badge. Cheap (server caps at 50) and
    // critical for the unread count to be accurate on cold start.
    if (userId && selectIsNotificationsStale(s.notifications?.lastFetchedAt ?? null)) {
      api
        .get("/notifications")
        .then((res) => {
          const raw = Array.isArray(res.data) ? res.data : [];
          const normalized: AppNotification[] = raw.map((n: any) => ({
            id: String(n.id ?? n._id),
            type: String(n.type ?? "SYSTEM"),
            message: String(n.message ?? ""),
            href: n.href ?? null,
            isRead: Boolean(n.isRead),
            createdAt: n.createdAt ?? new Date().toISOString(),
          }));
          store.dispatch(setNotifications({ list: normalized, userId }));
        })
        .catch(() => {});
    }
  }, []);

  const fetchCurrentUser = useCallback(async () => {
    try {
      const res = await api.get("/mobile/me");
      store.dispatch(setUser(res.data));
      return res.data;
    } catch (err: any) {
      if (err?.response?.status === 403) {
        router.replace("/suspended");
      }
      return null;
    }
  }, []);

  const initializeApp = useCallback(async () => {
    let isAuthed = false;
    try {
      // Read both tokens in parallel — this is all we need to decide routing.
      const [accessToken, refreshToken] = await Promise.all([
        SecureStore.getItemAsync(SECURE_STORE_KEYS.ACCESS_TOKEN),
        SecureStore.getItemAsync(SECURE_STORE_KEYS.REFRESH_TOKEN),
      ]);

      if (accessToken && refreshToken) {
        store.dispatch(setTokens({ accessToken, refreshToken }));
        isAuthed = true;
      } else if (await signInFromHostelPalika(store.dispatch, await getLaunchUrl())) {
        // Opened from HostelPalika: signed in under the splash, no landing flash.
        isAuthed = true;
      } else {
        store.dispatch(clearAuth());
      }
    } catch {
      store.dispatch(clearAuth());
    } finally {
      // Open the app NOW. Routing only needs the tokens above, and the screens
      // hydrate from the persisted Redux cache — so we hide the splash here and
      // load everything else (user, config, push, channels…) in the background
      // while the UI is already visible and interactive.
      store.dispatch(setAuthLoading(false));
      SplashScreen.hideAsync();
      releaseBootSplash();
    }

    void fetchPlatformConfig();

    if (!isAuthed) return;

    // ── Background warm-up: runs after first paint, never blocks the splash ──
    registerForPushNotifications()
      .then((token) => {
        if (token) subscribePushToken(token).catch(() => {});
      })
      .catch(() => {});

    void fetchCurrentUser(); // revalidates cached user + handles suspension
    void backgroundPrefetch(); // channels + notes + notifications
    // Record DAU — server deduplicates via upsert
    api.post("/daily-active", { platform: "app" }).catch(() => {});
  }, [fetchCurrentUser, fetchPlatformConfig, backgroundPrefetch]);

  const handleAppStateChange = useCallback(
    (state: AppStateStatus) => {
      if (state !== "active") {
        return;
      }

      const { auth, config } = store.getState();
      if (!auth.isAuthenticated) return;

      // Refresh config if stale (older than 1 hour)
      const stale =
        !config.lastFetchedAt || Date.now() - config.lastFetchedAt > 60 * 60 * 1000;
      if (stale) {
        void fetchPlatformConfig();
      }

      // Always check suspension on foreground
      void fetchCurrentUser();

      // Record DAU on every foreground — server deduplicates via upsert
      api.post("/daily-active", { platform: "app" }).catch(() => {});

      // Background refresh channels + notes if stale
      void backgroundPrefetch();
    },
    [fetchCurrentUser, fetchPlatformConfig, backgroundPrefetch],
  );

  useEffect(() => {
    void initializeApp();

    // Presence heartbeat: keep `lastActiveAt` fresh while the user is actively
    // using the app so their online green dot doesn't go stale within a single
    // session. Cold-start + foreground already ping daily-active; this covers
    // the gap during continuous foreground use. Online threshold is 5 min, so a
    // 2-min beat leaves comfortable headroom. Skipped while backgrounded.
    const HEARTBEAT_MS = 2 * 60 * 1000;
    const heartbeat = setInterval(() => {
      if (AppState.currentState !== "active") return;
      if (!store.getState().auth.isAuthenticated) return;
      api.post("/daily-active", { platform: "app" }).catch(() => {});
    }, HEARTBEAT_MS);

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    // Already running, signed out, when HostelPalika opens us again.
    const linkSub = Linking.addEventListener("url", ({ url }) => {
      if (store.getState().auth.isAuthenticated) return;
      void signInFromHostelPalika(store.dispatch, url);
    });
    const receivedSub = addNotificationReceivedListener((notification) => {
      console.log(
        "[push] ★ Notification RECEIVED:",
        JSON.stringify({
          title: notification.request.content.title,
          body: notification.request.content.body,
          data: notification.request.content.data,
        }),
      );
    });
    // A cold-start tap can arrive twice — once from getInitialNotificationResponse
    // below and once from the listener — and handling a call response twice
    // would fire acceptCall against an already-accepted session.
    const handledResponseIds = new Set<string>();

    const handleNotificationResponse = (response: NotificationResponse) => {
      const responseId = response.notification.request.identifier;
      if (handledResponseIds.has(responseId)) return;
      handledResponseIds.add(responseId);

      const data = response.notification.request.content.data;

      // Accept / Decline tapped on the incoming-call notification. This is the
      // path a call takes when the app was killed: no JS was alive to draw the
      // native ringing UI, so Android rendered the plain notification and these
      // buttons are the only way to answer.
      const callSessionId =
        typeof data?.callSessionId === "string" ? data.callSessionId : null;
      if (callSessionId) {
        if (response.actionIdentifier === CALL_ACTION_ACCEPT) {
          void acceptCall(callSessionId);
          return;
        }
        if (response.actionIdentifier === CALL_ACTION_DECLINE) {
          void rejectCall(callSessionId);
          return;
        }
      }

      const raw = data?.url ?? data?.href;
      if (!raw || typeof raw !== "string") return;
      const url = resolveNotificationRoute(raw);
      if (url.startsWith("/call/")) {
        router.replace(url as any);
      } else {
        router.push(url as any);
      }
    };

    const notificationSub = addNotificationResponseListener(handleNotificationResponse);

    // Cold start: the app was launched by tapping a notification. That response
    // was delivered before this effect ran (it waits on auth rehydration), so
    // the listener above never sees it and the tap does nothing. Replaying it
    // here is what lets a killed-app fallback call notification actually answer.
    void getInitialNotificationResponse().then((response) => {
      if (response) handleNotificationResponse(response);
    });

    return () => {
      clearInterval(heartbeat);
      subscription.remove();
      linkSub.remove();
      receivedSub.remove();
      notificationSub.remove();
    };
  }, [handleAppStateChange, initializeApp]);

  return <>{children}</>;
}

function RootLayout() {
  const { navigationTheme, backgroundColor } = useAppTheme();

  return (
    <ThemeProvider value={navigationTheme}>
      <Provider store={store}>
        <PersistGate persistor={persistor}>
          <SafeAreaProvider>
            <GestureHandlerRootView style={{ flex: 1, backgroundColor }}>
              <AppInitializer>
                <Sprint2Bootstrap />
                <RealtimeBridge />
                <GlobalNoticeModal />
                <GlobalOnboardingModal />
                <ImageViewerProvider>
                  <Stack
                    screenOptions={{
                      headerShown: false,
                      contentStyle: { backgroundColor },
                    }}
                  >
                    <Stack.Screen name="index" />
                    <Stack.Screen name="(auth)" />
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen name="admin" />
                    <Stack.Screen
                      name="ask"
                      options={{
                        animation: "fade_from_bottom",
                        animationDuration: 160,
                        gestureEnabled: true,
                        gestureDirection: "vertical",
                      }}
                    />
                    <Stack.Screen
                      name="workspace/[channelId]"
                      options={{
                        // Cross-fade into the chat: the list and the chat share
                        // the same header geometry, so a slide reads as a jolt
                        // where a fade reads as the row expanding in place.
                        animation: "fade",
                        animationDuration: 180,
                        gestureEnabled: true,
                      }}
                    />
                    <Stack.Screen
                      name="call/[roomId]"
                      options={{
                        gestureEnabled: false,
                      }}
                    />
                    <Stack.Screen name="course/[id]" />
                    <Stack.Screen name="course/video" />
                    <Stack.Screen name="chapter/[id]" />
                    <Stack.Screen name="chapter/content" />
                    <Stack.Screen name="quiz/index" />
                    <Stack.Screen name="quiz/[topicId]" />
                    <Stack.Screen name="quiz/results" />
                    <Stack.Screen name="wallet/index" />
                    <Stack.Screen name="wallet/withdraw" />
                    <Stack.Screen name="payment/plans" />
                    <Stack.Screen name="payment/return" />
                    <Stack.Screen name="notes" />
                    <Stack.Screen name="notifications" />
                    <Stack.Screen name="user/[id]" />
                    <Stack.Screen name="profile/index" />
                    <Stack.Screen name="profile/edit" />
                    <Stack.Screen name="profile/activity" />
                    <Stack.Screen name="profile/change-password" />
                    <Stack.Screen name="settings/call-settings" />
                    <Stack.Screen name="settings/notifications" />
                    <Stack.Screen name="settings/theme" />
                    <Stack.Screen name="legal/index" />
                    <Stack.Screen name="legal/terms" />
                    <Stack.Screen name="legal/privacy" />
                    <Stack.Screen name="referral" />
                    <Stack.Screen name="leaderboard" />
                    <Stack.Screen name="notices" />
                    <Stack.Screen name="onboarding" />
                    <Stack.Screen name="suspended" options={{ gestureEnabled: false }} />
                  </Stack>
                </ImageViewerProvider>
                {/* Active call overlay/bubble — mounted at root so navigation
                    never unmounts the LiveKit room. Sits above the Stack;
                    Toast stays above it. */}
                <PersistentCallHost />
                {/* Absolute-top "you've been selected" coupon announcement.
                    Below the call host so an active call always wins the
                    screen, above the Stack so it rides over any route. */}
                <CouponInviteHost />
                <GlobalUploadOverlay />
                <Toast />
                {/* The launch screen where the native one is missing (the PWA,
                    older builds); renders nothing on Android. Last child, so it
                    covers everything until it fades itself out. */}
                <BrandSplash />
              </AppInitializer>
            </GestureHandlerRootView>
          </SafeAreaProvider>
        </PersistGate>
      </Provider>
    </ThemeProvider>
  );
}

const AppRoot = sentryDsn ? Sentry.wrap(RootLayout) : RootLayout;

export default AppRoot;
