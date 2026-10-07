import { Linking } from "react-native";
import { router } from "expo-router";

import { publicApi } from "@/lib/api";
import { persistMobileAuthSession } from "@/lib/mobile-auth-session";
import type { AppDispatch } from "@/store";

/**
 * Signs in a student who tapped QuestionCall inside HostelPalika, so they never
 * see our landing page. HostelPalika opens us with `?hp_code=` — on
 * `questioncall://` for this app, on questioncall.com/app for the PWA — and the
 * server trades that single-use code with HostelPalika for who they are
 * (`/api/mobile/hostelpalika`).
 *
 * Only ever used when nobody is signed in: an existing session is never swapped
 * for another account by a link. `publicApi`, because a 401 here is a used or
 * expired code, not a session to refresh. Resolves false when there is no code
 * or the trade fails — the landing page then does what it always did.
 */
export async function signInFromHostelPalika(
  dispatch: AppDispatch,
  url: string | null,
): Promise<boolean> {
  const match = url?.match(/[?&]hp_code=([^&#]+)/);

  if (!match) return false;

  try {
    const res = await publicApi.post("/mobile/hostelpalika", {
      code: decodeURIComponent(match[1]),
    });
    const { isSuspended } = await persistMobileAuthSession(dispatch, res.data);

    if (isSuspended) router.replace("/suspended");
    return true;
  } catch {
    return false;
  }
}

/** The URL this launch was opened with — `questioncall://…`, or the page on web. */
export function getLaunchUrl() {
  return Linking.getInitialURL().catch(() => null);
}
