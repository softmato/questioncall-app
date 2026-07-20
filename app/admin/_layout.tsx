import { useEffect } from "react";
import { Stack, router } from "expo-router";

import { useAppSelector } from "@/hooks/redux";
import { prefetchAdmin } from "@/lib/admin-cache";

/**
 * Admin route-group guard — the mobile mirror of the web admin gate
 * (`web/app/(admin)/admin/layout.tsx`), which redirects anyone whose
 * `session.user.role !== "ADMIN"`.
 *
 * Role comes from the persisted Redux user, so a returning admin is gated
 * correctly on cold boot before any network call. `role` can be briefly
 * undefined while `/mobile/me` revalidates — we only bounce once we positively
 * know the user is a non-admin, never on the unknown state.
 */
export default function AdminLayout() {
  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);
  const isLoading = useAppSelector((s) => s.auth.isLoading);
  const role = useAppSelector((s) => s.user.data?.role);

  const isNonAdmin = role !== undefined && role !== "ADMIN";
  const isAdmin = role === "ADMIN";

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace("/(auth)/login");
      return;
    }
    if (isNonAdmin) {
      router.replace("/(tabs)/feed");
    }
  }, [isAuthenticated, isLoading, isNonAdmin]);

  // Warm every admin section the moment a confirmed admin enters the console,
  // so each screen opens with data already in hand. `prefetchAdmin` dedupes
  // concurrent runs and swallows per-section failures.
  useEffect(() => {
    if (isAuthenticated && isAdmin) {
      void prefetchAdmin();
    }
  }, [isAuthenticated, isAdmin]);

  if (!isAuthenticated || isNonAdmin) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="users" />
      <Stack.Screen name="transactions" />
      <Stack.Screen name="withdrawals" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="notices" />
      <Stack.Screen name="questions" />
      <Stack.Screen name="notes" />
      <Stack.Screen name="courses" />
      <Stack.Screen name="chapters" />
      <Stack.Screen name="coupons" />
      <Stack.Screen name="subscription-coupons" />
      <Stack.Screen name="services" />
      <Stack.Screen name="payment-config" />
      <Stack.Screen name="receipts" />
      <Stack.Screen name="account-deletions" />
      <Stack.Screen name="quiz-management" />
      <Stack.Screen name="live-sessions" />
      <Stack.Screen name="onboarding-videos" />
      <Stack.Screen name="developer" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="social" />
      <Stack.Screen name="pricing" />
      <Stack.Screen name="format-config" />
      <Stack.Screen name="ai-keys" />
      <Stack.Screen name="legal" />
      <Stack.Screen name="security" />
    </Stack>
  );
}
