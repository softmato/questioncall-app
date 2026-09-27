import type { NotificationResponse } from "expo-notifications";

import { api, SECURE_STORE_KEYS } from "@/lib/api";

/**
 * `lib/push-notifications.ts` for the PWA: Web Push through the site's own
 * service worker (`/sw.js`, registered at `/app`) and VAPID key, sent to the
 * same `/push/subscribe` the phone uses as a "web" subscription, which the
 * server already delivers through Web Push.
 *
 * A tapped notification either opens `/app?push=<href>` or, when the app is
 * already open, is posted to it by the worker. Either way it reaches
 * `app/_layout.tsx` as the same response a phone tap produces, so the layout's
 * own route mapping decides where it lands. iPhone offers push only to the app
 * once it is on the Home Screen.
 */
export const CALL_CHANNEL_ID = "calls_v2";
export const CALL_ACTION_ACCEPT = "accept";
export const CALL_ACTION_DECLINE = "decline";
export const CALL_CATEGORY_ID = "incoming_call";

const SCOPE = "/app";

let subscription: PushSubscription | null = null;

export const getCurrentPushToken = () => subscription?.endpoint ?? null;

export async function configureNotificationHandler() {}

function keyBytes(base64: string) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function sameKey(current: PushSubscription, key: Uint8Array) {
  const bytes = current.options.applicationServerKey;
  if (!bytes) return true;
  const view = new Uint8Array(bytes);
  return view.length === key.length && view.every((byte, index) => byte === key[index]);
}

function activated(registration: ServiceWorkerRegistration) {
  const worker = registration.installing ?? registration.waiting;
  if (registration.active || !worker) return Promise.resolve();

  return new Promise<void>((resolve) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
    });
  });
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (
    !("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)
  ) {
    return null;
  }

  // Browsers show their permission prompt only for a tap, so a first ask is the
  // shell's one-time sheet (public/index.html); a grant comes back below.
  if (Notification.permission === "default") {
    window.dispatchEvent(new Event("pwa-ask-notifications"));
    return null;
  }
  if (Notification.permission !== "granted") return null;

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: SCOPE,
    });
    await activated(registration);

    const { data } = await api.get<{ publicKey: string }>("/push/public-key");
    const key = keyBytes(data.publicKey);
    let current = await registration.pushManager.getSubscription();

    // A rotated VAPID pair leaves a subscription the server can no longer sign for.
    if (current && !sameKey(current, key)) {
      await current.unsubscribe();
      current = null;
    }

    subscription =
      current ??
      (await registration.pushManager.subscribe({
        applicationServerKey: key,
        userVisibleOnly: true,
      }));

    return subscription.endpoint;
  } catch (error) {
    console.warn("[push] Web Push registration failed:", error);
    return null;
  }
}

export async function subscribePushToken(token: string): Promise<boolean> {
  if (!subscription || subscription.endpoint !== token) return false;

  try {
    await api.post("/push/subscribe", {
      subscription: { ...subscription.toJSON(), platform: "web" },
    });
    return true;
  } catch {
    return false;
  }
}

export async function unsubscribePushToken(token: string): Promise<boolean> {
  try {
    await api.post("/push/unsubscribe", { endpoint: token });
    return true;
  } catch {
    return false;
  }
}

// The shell's one-time ask reports a grant here, so a signed-in session
// subscribes now; a signed-out one subscribes at sign-in, as on the phone.
window.addEventListener("pwa-notifications-granted", () => {
  if (!localStorage.getItem(SECURE_STORE_KEYS.ACCESS_TOKEN)) return;
  void registerForPushNotifications().then((endpoint) => {
    if (endpoint) void subscribePushToken(endpoint);
  });
});

function opened(url: string) {
  return {
    actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
    notification: {
      date: Date.now(),
      request: {
        content: { body: null, data: { url }, title: null },
        identifier: `web-${Date.now()}`,
        trigger: null,
      },
    },
  } as unknown as NotificationResponse;
}

// A cold start from a tapped notification: `/app?push=<href>` (public/sw.js).
const launchUrl = new URLSearchParams(location.search).get("push");
if (launchUrl !== null) history.replaceState(history.state, "", location.pathname);

export async function getInitialNotificationResponse(): Promise<NotificationResponse | null> {
  return launchUrl ? opened(launchUrl) : null;
}

export function addNotificationResponseListener(
  handler: (response: NotificationResponse) => void,
) {
  const listen = (event: MessageEvent) => {
    if (event.data?.type === "pwa-push-open" && typeof event.data.url === "string") {
      handler(opened(event.data.url));
    }
  };

  navigator.serviceWorker?.addEventListener("message", listen);
  return {
    remove: () => navigator.serviceWorker?.removeEventListener("message", listen),
  };
}

export function addNotificationReceivedListener(
  _handler: (notification: unknown) => void,
) {
  return { remove() {} };
}
