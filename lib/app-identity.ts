import Constants from "expo-constants";
import { Platform } from "react-native";

const expoConfig = Constants.expoConfig;

const FALLBACK_PACKAGE = "com.softmato.questioncall";

export const APP_PACKAGE =
  (Platform.OS === "ios"
    ? expoConfig?.ios?.bundleIdentifier
    : expoConfig?.android?.package) ?? FALLBACK_PACKAGE;

/**
 * Google Sign-In is native now (`lib/google-signin.ts`), so there is no custom
 * URI scheme redirect any more — Google rejects those on Android OAuth clients
 * created after mid-2022 ("Custom URI scheme is not enabled for your Android
 * client"). The native SDK sends only the WEB client id as `serverClientId`;
 * the Android clients still have to exist in that same Cloud project so Google
 * can match the caller's package + signing SHA-1, but the app never names them.
 *
 * `APP_PACKAGE` stays exported for the call/deep-link plumbing.
 */

export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim();

// ── Install-scoped device id ───────────────────────────────────────────────
// Tags call accept/reject requests so the server's CALL_HANDLED_EVENT fan-out
// (dismiss incoming-call UI on the same account's other devices) can be
// ignored by the device that performed the action. Not a security identifier.
let cachedDeviceId: string | null = null;

export function getDeviceId(): string {
  if (!cachedDeviceId) {
    // Random per app launch is enough for the self-echo filter — accept and
    // the resulting Pusher event happen within the same session.
    cachedDeviceId = `app-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }
  return cachedDeviceId;
}
