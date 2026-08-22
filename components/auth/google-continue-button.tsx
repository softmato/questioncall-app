import { useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { RolePickerModal, type SignupRole } from "@/components/auth/role-picker-modal";
import { useAppDispatch } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { signInWithGoogle, isGoogleSignInConfigured } from "@/lib/google-signin";
import { persistMobileAuthSession } from "@/lib/mobile-auth-session";
import {
  assertOkResponse,
  getRequestErrorMessage,
  readServerStatus,
} from "@/lib/server-response";

const SLOW_AUTH_TIMEOUT_MS = 45000;

/**
 * The whole Google path in one component: native sheet → session → app.
 *
 * `/mobile/login` answers 404 for an email it has never seen, and that 404 is
 * the only signal we need — an account that exists already has a role, so it
 * goes straight to the feed. Only the 404 opens the role modal, and the same
 * id_token is then replayed against `/mobile/register`. Nothing on the server
 * changed to support this.
 *
 * Pass `presetRole` from a screen that has already asked (the register form),
 * and the modal is skipped entirely.
 */
export function GoogleContinueButton({
  label = "Continue with Google",
  variant = "primary",
  presetRole,
  referralCode,
  onError,
  disabled,
}: {
  label?: string;
  variant?: "primary" | "secondary";
  presetRole?: SignupRole;
  referralCode?: string;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { iconColor } = useAppTheme();

  const [busy, setBusy] = useState(false);
  const [pendingIdToken, setPendingIdToken] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);

  function enterApp(data: any) {
    return persistMobileAuthSession(dispatch, data).then((session) => {
      if (session.isSuspended) {
        router.replace("/suspended");
      } else if (data?.user?.role === "ADMIN") {
        router.replace("/admin");
      } else {
        router.replace("/(tabs)/feed");
      }
    });
  }

  async function register(idToken: string, role: SignupRole) {
    const res = await api.post(
      "/mobile/register",
      { googleIdToken: idToken, role, referralCode: referralCode?.trim() || undefined },
      // Account creation also settles referrals and the welcome mail, so it can
      // outrun the default timeout on a cold serverless start.
      { ...readServerStatus, timeout: SLOW_AUTH_TIMEOUT_MS },
    );
    assertOkResponse(res, "Google sign-up failed. Please try again.");
    await enterApp(res.data);
  }

  async function handlePress() {
    if (busy) return;

    setBusy(true);
    onError("");

    try {
      const result = await signInWithGoogle();

      if (result.status === "cancelled") return;
      if (result.status === "error") {
        onError(result.message);
        return;
      }

      const res = await api.post(
        "/mobile/login",
        { googleIdToken: result.idToken },
        readServerStatus,
      );

      if (res.status === 404) {
        // New account. Either the caller already knows the role, or ask.
        if (presetRole) {
          await register(result.idToken, presetRole);
          return;
        }

        setSheetError(null);
        setPendingIdToken(result.idToken);
        return;
      }

      assertOkResponse(res, "Google sign-in failed. Please try again.");
      await enterApp(res.data);
    } catch (err) {
      onError(getRequestErrorMessage(err, "Google sign-in failed. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function handleRoleSelected(role: SignupRole) {
    if (!pendingIdToken) return;

    setBusy(true);
    setSheetError(null);

    try {
      await register(pendingIdToken, role);
      setPendingIdToken(null);
    } catch (err) {
      setSheetError(
        getRequestErrorMessage(err, "Could not finish signing up. Please try again."),
      );
    } finally {
      setBusy(false);
    }
  }

  const isPrimary = variant === "primary";
  // The modal drives its own spinner, so the button must not also look busy
  // while it is open.
  const buttonBusy = busy && !pendingIdToken;

  return (
    <View>
      <TouchableOpacity
        className={
          isPrimary
            ? "h-14 flex-row items-center justify-center gap-2 rounded-full bg-primary shadow-lg"
            : "h-14 flex-row items-center justify-center gap-2 rounded-full border border-border bg-card shadow-sm"
        }
        activeOpacity={0.85}
        disabled={disabled || buttonBusy || !isGoogleSignInConfigured}
        onPress={handlePress}
      >
        {buttonBusy ? (
          <ActivityIndicator color={isPrimary ? "#FFFFFF" : iconColor} />
        ) : (
          <Ionicons
            name="logo-google"
            size={19}
            color={isPrimary ? "#FFFFFF" : iconColor}
          />
        )}
        <Text
          className={
            isPrimary
              ? "text-[16px] font-semibold text-primary-foreground"
              : "text-[16px] font-semibold text-card-foreground"
          }
        >
          {label}
        </Text>
      </TouchableOpacity>

      <RolePickerModal
        visible={pendingIdToken !== null}
        busy={busy}
        error={sheetError}
        onSelect={handleRoleSelected}
        onDismiss={() => {
          setPendingIdToken(null);
          setSheetError(null);
        }}
      />
    </View>
  );
}
