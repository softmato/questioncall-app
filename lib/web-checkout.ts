import { Appearance, Linking, Platform } from "react-native";
import Toast from "react-native-toast-message";

import { api } from "@/lib/api";
import { store } from "@/store";
import { setUser } from "@/store/slices/userSlice";
import { setConfig } from "@/store/slices/configSlice";

// The PWA's checkout popup can only hand back a page on its own origin
// (web/payment-return.ts); the server allowlists both (isAppReturnUrl).
const RETURN_URL =
  Platform.OS === "web"
    ? `${window.location.origin}/app/payment/return`
    : "questioncall://payment/return";

export type CheckoutIntent = "subscription" | "course" | "chapter";

/**
 * Open the compliant web checkout in the SYSTEM BROWSER (Chrome Custom Tab) and,
 * on return, refresh entitlements so unlocked content shows without a restart.
 *
 * THE ONE HARD RULE: payments must open in the external browser. NEVER route a
 * purchase through react-native-webview — an in-app WebView checkout is treated
 * as bypassing Play Billing and is a ban-level violation.
 *
 * @param intent      what is being purchased
 * @param ref         courseId / chapterId (Mongo _id) for course/chapter intents;
 *                    optional plan slug for subscription
 * @param onComplete  optional caller refresh (e.g. reload the open course/chapter
 *                    screen) run AFTER global entitlements refresh, so a just-paid
 *                    item flips from locked → unlocked without a manual pull-to-refresh.
 * @param options.coupon  optional subscription promo code to prefill at the web
 *                    checkout (re-validated server-side there).
 */
export async function openWebCheckout(
  intent: CheckoutIntent,
  ref?: string,
  onComplete?: () => void | Promise<void>,
  options?: { coupon?: string | null },
): Promise<void> {
  let url: string;
  try {
    // Ask the backend for an authenticated one-time checkout URL (Bearer auth via
    // the api interceptor). The long-lived token never touches the browser.
    const { data } = await api.post("/mobile/checkout-session", {
      intent,
      ref,
      coupon: options?.coupon ?? undefined,
      returnUrl: RETURN_URL,
    });
    url = data?.url;
    if (!url) throw new Error("No checkout url");

    // Pass the app's current theme so the web checkout matches the app
    // (light/dark) instead of defaulting to the device/browser scheme.
    const theme = Appearance.getColorScheme() === "dark" ? "dark" : "light";
    url += `${url.includes("?") ? "&" : "?"}theme=${theme}`;
  } catch {
    Toast.show({
      type: "error",
      text1: "Couldn't open the membership page",
      text2: "Please check your connection and try again.",
    });
    return;
  }

  // System browser. Keep expo-web-browser lazy so older OTA-compatible APKs do
  // not crash when merely importing screens that can eventually open checkout.
  let result: { type: string; url?: string | null } | null = null;
  try {
    const WebBrowser = await import("expo-web-browser");
    result = await WebBrowser.openAuthSessionAsync(url, RETURN_URL);
  } catch (error) {
    // A browser blocks the popup when the tap is too long ago. Go to checkout
    // in this window instead; it comes back to app/payment/return.tsx.
    if (Platform.OS === "web") {
      window.location.assign(url);
      return;
    }
    console.warn("[checkout] Falling back to Linking.openURL:", error);
    try {
      await Linking.openURL(url);
      return;
    } catch {
      Toast.show({
        type: "error",
        text1: "Couldn't open the membership page",
        text2: "Please check your browser settings and try again.",
      });
      return;
    }
  }

  if (result.type === "success" && result.url) {
    // The web success/cancel surface tells us what actually happened.
    const status = getParam(result.url, "status");
    if (status === "success") {
      Toast.show({ type: "success", text1: "Payment complete" });
    } else if (status === "submitted") {
      // Manual transfer: access unlocks only after admin review — don't imply
      // the user already has it.
      Toast.show({
        type: "info",
        text1: "Payment submitted — pending review",
        text2: "We'll email you once your access is activated.",
      });
    } else if (status === "cancelled") {
      Toast.show({ type: "info", text1: "Checkout cancelled" });
    }
    await refreshEntitlements();
    await onComplete?.();
  } else if (result.type === "dismiss") {
    // User closed the tab manually — refresh in case they completed payment.
    await refreshEntitlements();
    await onComplete?.();
  }
}

/** Read a single query param from a returned deep-link URL (no URL polyfill needed). */
function getParam(url: string, key: string): string | null {
  const query = url.split("?")[1];
  if (!query) return null;
  for (const pair of query.split("&")) {
    const [k, v] = pair.split("=");
    if (decodeURIComponent(k) === key) return decodeURIComponent(v ?? "");
  }
  return null;
}

/** Re-pull the user + platform config so newly unlocked content appears immediately. */
async function refreshEntitlements(): Promise<void> {
  const [me, config] = await Promise.allSettled([
    api.get("/mobile/me"),
    api.get("/platform/config"),
  ]);
  if (me.status === "fulfilled") store.dispatch(setUser(me.value.data));
  if (config.status === "fulfilled") store.dispatch(setConfig(config.value.data));
}
