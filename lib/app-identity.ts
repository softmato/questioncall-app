import Constants from "expo-constants";
import { Platform } from "react-native";

const expoConfig = Constants.expoConfig;

const FALLBACK_PACKAGE = "com.questioncall.app";

export const APP_PACKAGE =
  (Platform.OS === "ios"
    ? expoConfig?.ios?.bundleIdentifier
    : expoConfig?.android?.package) ?? FALLBACK_PACKAGE;

/**
 * Google's OAuth redirect back into the app.
 *
 * The path MUST NOT collide with a real expo-router route. `APP_PACKAGE` is a
 * registered scheme in AndroidManifest, so when Google redirects to
 * `com.questioncall.app:/<path>` Android hands that URL to MainActivity and
 * expo-router's linking handler resolves `<path>` as a navigation target — it
 * races expo-auth-session's listener for the same URL. When the path was
 * `/login`, router won: the screen remounted (wiping the pending auth request
 * and flashing away any error), the id_token was never delivered, and
 * `/mobile/login` was never called. Signing up from the register screen got
 * bounced to the login screen for the same reason.
 *
 * `oauthredirect` is the path Google documents for Android client types and
 * matches no route in `app/`, so only expo-auth-session consumes it. Android
 * OAuth clients authorise by package name + signing SHA-1 rather than by
 * registered redirect URI, so changing this path needs no Google Cloud change.
 */
export const GOOGLE_OAUTH_REDIRECT_URI =
  Platform.OS === "web" ? undefined : `${APP_PACKAGE}:/oauthredirect`;

const isProductionBuild = !__DEV__;

export const GOOGLE_ANDROID_CLIENT_ID = (
  isProductionBuild
    ? process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID_PROD
    : process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
)?.trim();

export const GOOGLE_IOS_CLIENT_ID = (
  isProductionBuild
    ? process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID_PROD
    : process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
)?.trim();

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
