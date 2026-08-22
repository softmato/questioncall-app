import {
  GoogleSignin,
  statusCodes,
  isErrorWithCode,
} from "@react-native-google-signin/google-signin";

import { GOOGLE_WEB_CLIENT_ID } from "@/lib/app-identity";

/**
 * Native Google Sign-In (Credential Manager), replacing the old
 * expo-auth-session browser flow.
 *
 * The browser flow redirected to `com.softmato.questioncall:/oauthredirect`,
 * and Google now rejects custom URI schemes on newly created Android OAuth
 * clients — "Error 400: invalid_request, Custom URI scheme is not enabled for
 * your Android client". There is no way around that for new clients, so the
 * native SDK is the path forward regardless.
 *
 * What changes as a result:
 *
 *   - The only client id the app needs is the **web** one (`webClientId`, which
 *     the SDK sends as `serverClientId`). The Android OAuth clients still have
 *     to exist — Google matches the caller's package name + signing SHA-1
 *     against them — but their ids never appear in the app or in a request.
 *   - Those Android clients MUST live in the same Google Cloud project as the
 *     web client, or Google cannot find them and sign-in fails.
 *   - The id_token's `aud` is now always the web client, on every build. That
 *     is why Play App Signing stops being a problem: a new signing certificate
 *     needs a new Android client registered, but the audience the server
 *     verifies never changes.
 */

let configured = false;

function ensureConfigured() {
  if (configured) return;

  GoogleSignin.configure({
    // Sent as `serverClientId`; becomes the `aud` of the id_token the backend
    // verifies in `getGoogleAudiences()`.
    webClientId: GOOGLE_WEB_CLIENT_ID,
    offlineAccess: false,
    scopes: ["openid", "profile", "email"],
  });

  configured = true;
}

export const isGoogleSignInConfigured = Boolean(GOOGLE_WEB_CLIENT_ID);

export type GoogleSignInResult =
  | { status: "success"; idToken: string; email: string | null }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/**
 * Runs the native sheet and returns an id_token for `/mobile/login`.
 *
 * Always signs out first so the account chooser appears every time — otherwise
 * the SDK silently reuses the last account and a user who picked the wrong one
 * can never switch.
 */
export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  if (!isGoogleSignInConfigured) {
    return {
      status: "error",
      message: "Google sign-in is not configured yet.",
    };
  }

  try {
    ensureConfigured();
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

    // Ignored if nobody is signed in; only clears this app's local session.
    await GoogleSignin.signOut().catch(() => {});

    const response = await GoogleSignin.signIn();

    if (response.type === "cancelled") return { status: "cancelled" };

    const idToken = response.data?.idToken;
    if (!idToken) {
      return {
        status: "error",
        message: "Google sign-in did not return an ID token.",
      };
    }

    return { status: "success", idToken, email: response.data?.user?.email ?? null };
  } catch (error) {
    if (isErrorWithCode(error)) {
      switch (error.code) {
        case statusCodes.SIGN_IN_CANCELLED:
          return { status: "cancelled" };
        case statusCodes.IN_PROGRESS:
          return { status: "cancelled" };
        case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
          return {
            status: "error",
            message: "Google Play Services is unavailable on this device.",
          };
      }
    }

    return {
      status: "error",
      message:
        error instanceof Error && error.message
          ? error.message
          : "Google sign-in failed. Please try again.",
    };
  }
}
