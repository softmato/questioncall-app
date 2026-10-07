import { lazy, Suspense, useEffect, useState } from "react";

import { useAppSelector } from "@/hooks/redux";
import { useCallUi } from "@/lib/call-ui-store";

/**
 * `components/calls/persistent-call-host` for the PWA. The real host pulls in
 * livekit-client (half a megabyte), so the browser fetches it when the first
 * call opens rather than before the first screen. Call state lives in
 * lib/call-ui-store, so the host picks up the call it was loaded for, and stays
 * mounted from then on: remounting mid-call is what the real host guards against.
 */
const loadHost = () => import("./call-chunk");
const Host = lazy(() => loadHost().then((m) => ({ default: m.PersistentCallHost })));

export function PersistentCallHost() {
  const { params } = useCallUi();
  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);
  const [needed, setNeeded] = useState(false);

  // Signed in, a call can arrive any moment: fetch the host once the first
  // screen has settled, so answering does not wait on the download.
  useEffect(() => {
    if (!isAuthenticated) return;
    const timer = setTimeout(() => void loadHost(), 5000);
    return () => clearTimeout(timer);
  }, [isAuthenticated]);

  useEffect(() => {
    if (params) setNeeded(true);
  }, [params]);

  if (!needed && !params) return null;
  return (
    <Suspense fallback={null}>
      <Host />
    </Suspense>
  );
}
