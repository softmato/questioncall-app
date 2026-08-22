import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";

import { AuthScreen } from "@/components/auth/auth-screen";

WebBrowser.maybeCompleteAuthSession();

/**
 * Same screen as `/login`, opened on the Register tab.
 *
 * Referral links point here with `?ref=`, and role-specific invites with
 * `?role=`, so both params still have to be honoured even though the screen
 * itself is now shared.
 */
export default function RegisterScreen() {
  const params = useLocalSearchParams<{ ref?: string; role?: string }>();

  return (
    <AuthScreen
      initialTab="register"
      initialRole={params.role === "TEACHER" ? "TEACHER" : "STUDENT"}
      initialReferralCode={params.ref ?? ""}
    />
  );
}
