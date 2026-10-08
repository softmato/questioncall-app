import { Platform, Alert, Linking } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { api } from "@/lib/api";
import { surfaceIncomingCall } from "@/lib/call-dispatch";

const EAS_PROJECT_ID = "86d256ec-943f-49e8-adaf-659400e4edac";

let currentPushToken: string | null = null;

/**
 * Returns the last registered push token so callers (e.g. logout flows)
 * can unsubscribe it from the server without re-registering.
 */
export function getCurrentPushToken(): string | null {
  return currentPushToken;
}

/**
 * Single, unified notification handler.
 *
 * • Incoming-call pushes (identified by `callSessionId` in data) are routed
 *   to the native call UI via CallKeep and suppressed from the banner.
 * • Every other notification is shown normally as a banner/alert.
 *
 * IMPORTANT: Do NOT call `setNotificationHandler` anywhere else — doing so
 * would overwrite this handler and lose the call-specific routing.
 */
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as Record<string, string> | undefined;

    // Incoming call → show native call screen instead of a push banner
    if (data?.callSessionId) {
      const mode: "AUDIO" | "VIDEO" = data.mode === "VIDEO" ? "VIDEO" : "AUDIO";
      const callerName = data.callerName ?? "Incoming call";
      // Go through the shared funnel rather than ringing directly. Pusher
      // usually beats the push by around a second, and this handler used to
      // ring a second time on top of it — including on top of a call the user
      // had already accepted. The funnel also caches the metadata the native
      // answer event needs (it only delivers a callUUID).
      //
      // On Android calls are sent data-only and CallNotificationService claims
      // them before Expo ever gets here, so this branch is now a fallback for
      // anything that reaches JS by another route. It shares the same dedupe
      // store as the native service, so it cannot double-ring.
      await surfaceIncomingCall({
        callSessionId: data.callSessionId,
        callerName,
        mode,
        callerId: String(data.callerId ?? ""),
        channelId: String(data.channelId ?? ""),
      });
      // Call pushes now carry real title/body so they still ring when the app
      // has been killed (see web/lib/push/web-push.ts). The cost is that a
      // tray copy can be presented while the app is alive — which would sit
      // behind the full-screen call UI we just launched. Reaching this handler
      // at all means JS is running and has taken over, so clear it. When the
      // app is killed this never runs and the system notification correctly
      // survives as the only way to answer.
      void Notifications.dismissNotificationAsync(notification.request.identifier).catch(
        () => {},
      );
      return {
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      };
    }

    // All other notifications — show alert, sound, badge
    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    };
  },
});

/**
 * Android channel id for incoming calls. Must match CALL_CHANNEL_ID in
 * web/lib/notifications/metadata.ts — the server puts this on the push, and
 * Android drops the notification's sound/importance on the floor if the id
 * doesn't resolve to a channel the app created.
 */
export const CALL_CHANNEL_ID = "calls_v2";

async function setupAndroidChannels() {
  await Notifications.setNotificationChannelAsync("chat", {
    name: "Chat Messages",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#3B82F6",
    // Show the message on the lock screen instead of "1 new notification", so
    // it's readable without unlocking. (Android only wakes the screen for
    // full-screen intents, which are reserved for calls — a normal message
    // notification lights the screen at most, and only on some OEMs.)
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    sound: "notification_sound",
  });
  await Notifications.setNotificationChannelAsync("questions", {
    name: "Question Updates",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#3B82F6",
    sound: "notification_sound",
  });
  // The only channel a *killed* app can ring through: with no JS alive, the
  // native call UI never runs and Android renders this notification itself,
  // using nothing but the channel's own settings. So this channel has to carry
  // the ring on its own — the actual ringtone (not the short message chime),
  // a call-length vibration, DND bypass, and lock-screen visibility so the
  // Accept/Decline actions are reachable without unlocking.
  //
  // NOTE the "_v2" id. Android freezes a channel's sound/importance/vibration
  // the moment it is first created; later setNotificationChannelAsync calls
  // with the same id only rename it. The old "calls" channel was created with
  // the short message chime, so upgrading in place would have been a silent
  // no-op for every existing install. A new id is the only way to ship changed
  // channel settings — and it must stay in step with CALL_CHANNEL_ID in
  // web/lib/notifications/metadata.ts, which is what the server sends.
  await Notifications.setNotificationChannelAsync(CALL_CHANNEL_ID, {
    name: "Incoming Calls",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 1000, 800, 1000, 800, 1000],
    lightColor: "#22c55e",
    enableLights: true,
    enableVibrate: true,
    // Best effort: silently ignored unless the user grants Do Not Disturb
    // access. Worth setting — a missed call is worse than a missed chime.
    bypassDnd: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    sound: "incoming_ringtone",
  });
  // The superseded channel is deliberately kept alive, not deleted.
  //
  // A server that has not yet deployed the matching CALL_CHANNEL_ID still sends
  // calls tagged "calls". Deleting the channel makes those pushes render
  // unpredictably or not at all, which turns a routine deploy-order skew into
  // silently dropped calls. Keeping it costs one extra row in system settings
  // and means a mismatch degrades to "rings with the old sound" instead.
  await Notifications.setNotificationChannelAsync("calls", {
    name: "Incoming Calls (legacy)",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 1000, 800, 1000],
    lightColor: "#22c55e",
    enableLights: true,
    enableVibrate: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    sound: "notification_sound",
  });
  await Notifications.setNotificationChannelAsync("wallet", {
    name: "Wallet & Payments",
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: "#F59E0B",
    sound: "notification_sound",
  });
  await Notifications.setNotificationChannelAsync("default", {
    name: "General",
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: "#3B82F6",
    sound: "notification_sound",
  });
}

/** Action identifiers on the incoming-call notification, shared with `_layout`. */
export const CALL_ACTION_ACCEPT = "accept";
export const CALL_ACTION_DECLINE = "decline";
export const CALL_CATEGORY_ID = "incoming_call";

/**
 * Give the incoming-call notification Accept / Decline buttons.
 *
 * The server has always tagged call pushes with `categoryId: "incoming_call"`
 * (see web/lib/push/web-push.ts) but nothing ever registered that category, so
 * the tag was inert and a call arriving at a killed app rendered as a plain
 * line of text with no way to answer from the shade.
 *
 * This is NOT the WhatsApp-style full-screen ringing UI, and it deliberately
 * stops short of it. Waking the screen from a killed app needs a notification
 * posted with setFullScreenIntent, which only native code can do — i.e. our own
 * FirebaseMessagingService receiving the call message before Firebase renders
 * it. That was attempted once and ANR'd the app badly enough to be reverted;
 * `plugins/withCallNotificationService.js` and `withCallNotificationDeps.js`
 * are the orphaned remains and are intentionally NOT in app.json's plugin list.
 * Do not re-enable them without redoing that work properly.
 *
 * What this does give a killed app: the real ringtone (via the calls channel),
 * a lock-screen-visible notification, and Accept/Decline without unlocking.
 */
async function setupCallNotificationCategory() {
  await Notifications.setNotificationCategoryAsync(CALL_CATEGORY_ID, [
    {
      identifier: CALL_ACTION_ACCEPT,
      buttonTitle: "Accept",
      options: { opensAppToForeground: true },
    },
    {
      identifier: CALL_ACTION_DECLINE,
      buttonTitle: "Decline",
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]);
}

/** Show an alert directing the user to system settings to enable notifications manually. */
async function showSettingsAlert(): Promise<void> {
  await new Promise<void>((resolve) => {
    Alert.alert(
      "Enable Notifications",
      "To receive question updates, chat messages, and call alerts, please enable notifications in your device settings.\n\nSettings → Apps → QuestionCall → Notifications",
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve() },
        {
          text: "Open Settings",
          onPress: () => {
            Linking.openSettings();
            resolve();
          },
        },
      ],
    );
  });
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log("[push] Not a physical device — skipping push registration");
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    console.warn("[push] Notification permission not granted:", finalStatus);

    // Check if we can ask again (Android 13+ may block re-prompting)
    const perm = await Notifications.getPermissionsAsync();
    const canAskAgain = perm.canAskAgain ?? true;

    if (!canAskAgain) {
      // Permanently denied — guide user to system settings
      await showSettingsAlert();
      return null;
    }

    // Denied but we can still re-prompt — explain why notifications matter
    let shouldRetry = false;
    await new Promise<void>((resolve) => {
      Alert.alert(
        "Notifications Needed",
        "QuestionCall needs notification permission to alert you when you receive answers, chat messages, and incoming calls.",
        [
          {
            text: "Not Now",
            style: "cancel",
            onPress: () => resolve(),
          },
          {
            text: "Try Again",
            onPress: () => {
              shouldRetry = true;
              resolve();
            },
          },
        ],
      );
    });

    if (shouldRetry) {
      const { status: retryStatus } = await Notifications.requestPermissionsAsync();
      if (retryStatus !== "granted") {
        console.warn("[push] Permission still denied after re-prompt:", retryStatus);
        // Still denied after retry — guide user to settings
        await showSettingsAlert();
        return null;
      }
    } else {
      // User chose "Not Now" — stop
      return null;
    }
  }

  if (Platform.OS === "android") {
    await setupAndroidChannels();
  }

  await setupCallNotificationCategory().catch((err) => {
    console.warn(
      "[push] Failed to register the incoming-call category:",
      err?.message ?? err,
    );
  });

  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId: EAS_PROJECT_ID,
  }).catch((err) => {
    console.warn("[push] getExpoPushTokenAsync failed:", err?.message ?? err);
    return null;
  });

  if (!tokenData) {
    console.warn("[push] No Expo push token, trying device token fallback");
    const deviceToken = await Notifications.getDevicePushTokenAsync().catch((err) => {
      console.warn("[push] getDevicePushTokenAsync failed:", err?.message ?? err);
      return null;
    });
    if (deviceToken?.data) {
      console.log("[push] Using device push token (FCM)");
      currentPushToken = String(deviceToken.data);
      return currentPushToken;
    }
    console.warn("[push] No push token obtained at all");
    return null;
  }

  console.log("[push] Expo push token obtained:", tokenData.data.slice(0, 30) + "…");
  currentPushToken = tokenData.data;
  return tokenData.data;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function subscribePushToken(token: string): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await api.post("/push/subscribe", {
        subscription: {
          endpoint: token,
          expirationTime: null,
          keys: {},
          platform: Platform.OS === "ios" ? "ios" : "android",
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[push] Failed to subscribe push token (attempt ${attempt}/${MAX_RETRIES}):`,
        message,
      );
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[push] Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  return false;
}

export async function unsubscribePushToken(token: string): Promise<boolean> {
  try {
    await api.post("/push/unsubscribe", { endpoint: token });
    return true;
  } catch (error) {
    // Best-effort cleanup — never surface this. In dev, console.error is
    // elevated to a red error overlay, and an unsubscribe failure during
    // sign-out / account deletion (token already gone → 401) is harmless.
    console.warn(
      "[push] Failed to unsubscribe push token:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void,
) {
  return Notifications.addNotificationResponseReceivedListener(handler);
}

/**
 * The notification tap that cold-started the app, if there was one.
 *
 * `addNotificationResponseReceivedListener` only sees responses delivered
 * after it subscribes, and `_layout` registers it behind auth rehydration. A
 * tap that launches the app from killed is therefore already delivered by the
 * time anything is listening, and is silently dropped — the user answers a
 * call and lands on the home screen.
 *
 * That matters most for calls: when an OEM blocks the data-only push from
 * starting our process, the server's fallback tier (see
 * web/app/api/calls/create/route.ts) sends a system-rendered notification, and
 * tapping it is the only way to answer. Checking this explicitly at boot is
 * what makes that route work.
 *
 * Callers must dedupe against the listener — both can surface the same
 * response.
 */
export async function getInitialNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  try {
    return await Notifications.getLastNotificationResponseAsync();
  } catch {
    return null;
  }
}

export function addNotificationReceivedListener(
  handler: (notification: Notifications.Notification) => void,
) {
  return Notifications.addNotificationReceivedListener(handler);
}

/**
 * No-op — the unified handler is now set at module scope and must not be
 * overwritten. Kept as an export so existing call-sites don't break.
 *
 * @deprecated The module-level handler already shows alerts for all
 * non-call notifications. Do not call `setNotificationHandler` again.
 */
export async function configureNotificationHandler() {
  // Intentionally empty — handler is already configured at module load.
}
