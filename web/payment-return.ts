import { maybeCompleteAuthSession } from "expo-web-browser";

/**
 * Checkout (lib/web-checkout.ts) runs in a popup that finishes on
 * /app/payment/return. There, hand the URL back to the app that opened it and
 * close, before a second copy of the app boots. Reached any other way (the
 * popup was blocked, so the app itself went to checkout), the app boots on into
 * app/payment/return.tsx.
 */
if (
  location.pathname === "/app/payment/return" &&
  maybeCompleteAuthSession().type === "success"
) {
  window.close();
}
