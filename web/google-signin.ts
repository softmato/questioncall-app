import { GOOGLE_WEB_CLIENT_ID } from "@/lib/app-identity";

/**
 * `lib/google-signin.ts` for the PWA, where the native Google SDK does not
 * exist. Google Identity Services with the same web client id the phone asks
 * for its id token with, so `/mobile/login` verifies it unchanged. `prompt()`
 * over FedCM is the browser's own account chooser, so the app keeps its own
 * "Continue with Google" button.
 *
 * questioncall.com must be listed under the web client's Authorized JavaScript
 * origins in Google Cloud.
 */
export type GoogleSignInResult =
  | { status: "success"; idToken: string; email: string | null }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export const isGoogleSignInConfigured = Boolean(GOOGLE_WEB_CLIENT_ID);

type Moment = {
  getDismissedReason?(): string;
  isDismissedMoment?(): boolean;
  isNotDisplayed?(): boolean;
  isSkippedMoment?(): boolean;
};

type GoogleIdentity = {
  accounts: {
    id: {
      initialize(options: Record<string, unknown>): void;
      prompt(listener: (moment: Moment) => void): void;
    };
  };
};

let loading: Promise<GoogleIdentity> | null = null;

function loadGoogle() {
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = () =>
      resolve((window as unknown as { google: GoogleIdentity }).google);
    script.onerror = () => {
      loading = null;
      reject(new Error("Google sign-in did not load."));
    };
    document.head.appendChild(script);
  });

  return loading;
}

function emailOf(idToken: string) {
  try {
    const payload = JSON.parse(
      atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export async function signInWithGoogle(): Promise<GoogleSignInResult> {
  if (!isGoogleSignInConfigured) {
    return { status: "error", message: "Google sign-in is not configured yet." };
  }

  let google: GoogleIdentity;
  try {
    google = await loadGoogle();
  } catch {
    return {
      status: "error",
      message: "Google sign-in could not load. Check your connection and try again.",
    };
  }

  return new Promise((resolve) => {
    google.accounts.id.initialize({
      callback: ({ credential }: { credential?: string }) =>
        resolve(
          credential
            ? { status: "success", idToken: credential, email: emailOf(credential) }
            : { status: "error", message: "Google sign-in did not return an ID token." },
        ),
      cancel_on_tap_outside: true,
      client_id: GOOGLE_WEB_CLIENT_ID,
      use_fedcm_for_prompt: true,
    });

    // A closed chooser, or one the browser holds back after earlier
    // dismissals, is a quiet cancel — the same as backing out of the phone's sheet.
    google.accounts.id.prompt((moment) => {
      if (
        moment.isSkippedMoment?.() ||
        moment.isNotDisplayed?.() ||
        (moment.isDismissedMoment?.() &&
          moment.getDismissedReason?.() !== "credential_returned")
      ) {
        resolve({ status: "cancelled" });
      }
    });
  });
}
