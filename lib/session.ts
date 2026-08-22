import * as SecureStore from "expo-secure-store";

import { store, persistor, resetStore } from "@/store";
import { SECURE_STORE_KEYS } from "@/lib/api";
import { clearAuth } from "@/store/slices/authSlice";
import { resetPusherClient } from "@/lib/realtime";
import { clearAdminCache } from "@/lib/admin-cache";
import { clearAskDraft } from "@/lib/ask-draft";
import { getCurrentPushToken, unsubscribePushToken } from "@/lib/push-notifications";

/**
 * Tear down all local session state — the single source of truth for sign-out
 * and account deletion (previously duplicated across menu / admin / delete
 * screens, which had already drifted).
 *
 * Designed to return fast so the UI navigates to the landing screen
 * immediately:
 * - The push-unsubscribe is best-effort and fired WITHOUT await, so a slow or
 *   failing network never blocks sign-out.
 * - Auth tokens are cleared up front so any in-flight authed request fails fast
 *   instead of triggering a token refresh (which could misroute to /suspended).
 *
 * @param opts.unsubscribePush  Pass `false` after the account is already
 *   deleted server-side — the authed unsubscribe call would just 401, and the
 *   server drops the subscription with the account anyway.
 */
export async function purgeLocalSession(opts?: {
  unsubscribePush?: boolean;
}): Promise<void> {
  const shouldUnsubscribe = opts?.unsubscribePush ?? true;

  // Best-effort, non-blocking. Fire before clearing tokens so it has a valid
  // token to use; failures are swallowed inside unsubscribePushToken.
  if (shouldUnsubscribe) {
    const pushToken = getCurrentPushToken();
    if (pushToken) void unsubscribePushToken(pushToken);
  }

  // Clear auth first — a stray 401 now fails fast (no refresh token → no
  // refresh round-trip, no /suspended bounce).
  await SecureStore.deleteItemAsync(SECURE_STORE_KEYS.ACCESS_TOKEN);
  await SecureStore.deleteItemAsync(SECURE_STORE_KEYS.REFRESH_TOKEN);

  // Wipe in-memory + persisted state and disconnect realtime.
  store.dispatch(resetStore());
  store.dispatch(clearAuth());
  clearAdminCache();
  clearAskDraft();
  resetPusherClient();
  await persistor.purge();
}
