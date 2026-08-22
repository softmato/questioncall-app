import { useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AuthSegmented, type AuthTab } from "@/components/auth/auth-segmented";
import { LoginForm } from "@/components/auth/login-form";
import { RegisterForm } from "@/components/auth/register-form";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * Both email auth paths on one screen.
 *
 * Login and Register used to be separate routes that replaced each other, which
 * meant a stack animation and a cleared form every time someone realised they
 * were on the wrong one. Here the switch is local state, so the two are one
 * destination with two modes and `router.back()` always returns to the landing
 * screen rather than to the other tab.
 */
export function AuthScreen({
  initialTab,
  initialRole,
  initialReferralCode,
}: {
  initialTab: AuthTab;
  initialRole?: "STUDENT" | "TEACHER";
  initialReferralCode?: string;
}) {
  const insets = useSafeAreaInsets();
  const { statusBarStyle, backgroundColor, iconColor } = useAppTheme();
  const [tab, setTab] = useState<AuthTab>(initialTab);

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 24,
            paddingTop: Math.max(insets.top + 12, 40),
            paddingBottom: Math.max(insets.bottom + 24, 36),
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* A referral link can open `/register` as the very first route, and
              there is no history to pop in that case — fall back to the
              landing screen so the arrow is never a dead control. */}
          <TouchableOpacity
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
            className="h-11 w-11 items-center justify-center rounded-full border border-border bg-card"
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={20} color={iconColor} />
          </TouchableOpacity>

          <View className="items-center pb-7 pt-4">
            <Image
              source={require("../../assets/images/logo.png")}
              style={{ width: 44, height: 44 }}
              resizeMode="contain"
            />
            <Text className="mt-3 text-[26px] font-bold tracking-tight text-foreground">
              {tab === "login" ? "Login" : "Register"}
            </Text>
            <Text className="mt-1 text-[14px] text-muted-foreground">
              {tab === "login"
                ? "Welcome back to QuestionCall."
                : "Create your QuestionCall account."}
            </Text>
          </View>

          <View className="pb-6">
            <AuthSegmented value={tab} onChange={setTab} />
          </View>

          {tab === "login" ? (
            <LoginForm />
          ) : (
            <RegisterForm
              initialRole={initialRole}
              initialReferralCode={initialReferralCode}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
