import { useEffect } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";

import { openCall } from "@/lib/call-ui-store";

/**
 * Deep-link shim. The actual call UI lives in <PersistentCallHost/> at the
 * root layout so it survives navigation (see call-ui-store.ts). This route
 * exists only because external entry points target `/call/<id>`:
 *
 * - the Android full-screen incoming-call notification
 *   (questioncall://call/<uuid>, see the patched native module),
 * - push-notification hrefs,
 * - any legacy router.push("/call/...") call sites.
 *
 * It opens (or re-focuses) the call overlay and immediately leaves the route.
 */
export default function CallRouteShim() {
  const params = useLocalSearchParams<{
    roomId: string;
    channelId?: string;
    mode?: string;
  }>();
  const roomId = params.roomId;
  const channelId = params.channelId ?? undefined;
  const mode = params.mode === "VIDEO" ? "VIDEO" : "AUDIO";

  useEffect(() => {
    if (roomId) {
      openCall({ roomId, channelId, mode });
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/(tabs)/channels" as any);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <View style={{ flex: 1, backgroundColor: "#000" }} />;
}
