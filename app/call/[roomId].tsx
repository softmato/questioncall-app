import { useEffect } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";

import { openCall } from "@/lib/call-ui-store";
import { acceptCall } from "@/lib/full-screen-call-notification";

/**
 * Deep-link shim. The actual call UI lives in <PersistentCallHost/> at the
 * root layout so it survives navigation (see call-ui-store.ts). This route
 * exists only because external entry points target `/call/<id>`:
 *
 * - the Android full-screen incoming-call notification
 *   (questioncall://call/<uuid>, see the patched native module),
 * - the Accept button on the CallStyle notification, which adds `answered=1`,
 * - push-notification hrefs,
 * - any legacy router.push("/call/...") call sites.
 *
 * `answered=1` is the whole difference between "show me this call" and "I have
 * picked this call up". The notification body and the full-screen intent use
 * the plain form on purpose — a full-screen intent fires by itself on a locked
 * phone, and it must never answer for the user.
 */
export default function CallRouteShim() {
  const params = useLocalSearchParams<{
    roomId: string;
    channelId?: string;
    mode?: string;
    answered?: string;
  }>();
  const roomId = params.roomId;
  const channelId = params.channelId ?? undefined;
  const mode = params.mode === "VIDEO" ? "VIDEO" : "AUDIO";
  const answered = params.answered === "1" || params.answered === "true";

  useEffect(() => {
    if (roomId) {
      if (answered) {
        // Runs POST /accept and opens the call UI. Safe to reach twice: the
        // native pending-accept drain in the root layout races this on a cold
        // start by design, and acceptCall() collapses the loser.
        void acceptCall(roomId, mode);
      } else {
        // No answered=1: this is the notification body or the full-screen
        // intent, and the latter fires without anyone touching the phone. Show
        // the call, let the user press Accept.
        openCall({ roomId, channelId, mode, autoAccept: false });
      }
    }

    // Leave the shim behind. router.back() is only safe when there is somewhere
    // to go back TO — on a cold start launched by this very link the shim is the
    // whole history, and popping it takes the app off screen, which is what the
    // "I pressed Accept and it went to the home screen" reports look like.
    // Replacing is always safe, so it is what an empty history falls back to.
    // Either way the call overlay is already drawn on top, so this only decides
    // what the user finds underneath when the call ends.
    try {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace("/(tabs)/channels" as any);
      }
    } catch {
      // A router that is not ready yet must not take the call down with it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <View style={{ flex: 1, backgroundColor: "#000" }} />;
}
