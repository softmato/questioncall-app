import { useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";

import { AuthField } from "@/components/auth/auth-field";
import { AuthNotice } from "@/components/auth/auth-notice";
import { AuthSocialBlock } from "@/components/auth/auth-social";
import { useAppDispatch } from "@/hooks/redux";
import { api } from "@/lib/api";
import { isGoogleSignInConfigured } from "@/lib/google-signin";
import { persistMobileAuthSession } from "@/lib/mobile-auth-session";
import {
  assertOkResponse,
  getRequestErrorMessage,
  readServerStatus,
} from "@/lib/server-response";

export function LoginForm() {
  const dispatch = useAppDispatch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      setFormError("Please fill in all fields.");
      return;
    }

    setBusy(true);
    setFormError(null);

    try {
      const res = await api.post(
        "/mobile/login",
        { email: email.trim().toLowerCase(), password },
        readServerStatus,
      );
      assertOkResponse(res, "Login failed. Please try again.");

      const session = await persistMobileAuthSession(dispatch, res.data);
      if (session.isSuspended) {
        router.replace("/suspended");
      } else if (res.data?.user?.role === "ADMIN") {
        router.replace("/admin");
      } else {
        router.replace("/(tabs)/feed");
      }
    } catch (err: any) {
      setFormError(getRequestErrorMessage(err, "Login failed. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-3">
      <AuthField
        label="Email Address"
        icon="mail-outline"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        placeholderTextColor="#A8A29E"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
      />

      <AuthField
        label="Password"
        icon="lock-closed-outline"
        secure
        value={password}
        onChangeText={setPassword}
        placeholder="Your password"
        placeholderTextColor="#A8A29E"
        autoComplete="password"
      />

      <TouchableOpacity
        onPress={() => router.push("/(auth)/forgot-password")}
        className="self-end py-1"
        activeOpacity={0.7}
      >
        <Text className="text-[13px] font-semibold text-primary">Forgot password?</Text>
      </TouchableOpacity>

      <AuthNotice tone="error" message={formError} />

      <TouchableOpacity
        onPress={handleLogin}
        disabled={busy}
        className="mt-1 h-14 items-center justify-center rounded-full bg-primary"
        activeOpacity={0.85}
      >
        {busy ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text className="text-[16px] font-semibold text-primary-foreground">Login</Text>
        )}
      </TouchableOpacity>

      <View className="pt-3">
        <AuthSocialBlock
          disabled={busy}
          onError={(message) => setFormError(message || null)}
          configured={isGoogleSignInConfigured}
          unavailableNote="Google sign-in is not configured yet."
        />
      </View>
    </View>
  );
}
