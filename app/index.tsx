import { useEffect, useMemo, useState } from "react";
import { Image, StatusBar, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FormulaBackdrop } from "@/components/auth/formula-backdrop";
import { GoogleContinueButton } from "@/components/auth/google-continue-button";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";

export default function LandingScreen() {
  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);
  const isLoading = useAppSelector((s) => s.auth.isLoading);
  const role = useAppSelector((s) => s.user.data?.role);
  const platformConfig = useAppSelector((s) => s.config.data);
  const insets = useSafeAreaInsets();
  const [authError, setAuthError] = useState("");
  const { statusBarStyle, backgroundColor, iconColor } = useAppTheme();
  const landingDisplayUserCount = useMemo(() => {
    if (typeof platformConfig?.landingDisplayUserCount === "number") {
      return platformConfig.landingDisplayUserCount;
    }

    const realUserCount =
      typeof platformConfig?.landingUserCount === "number"
        ? platformConfig.landingUserCount
        : 0;
    const offset =
      typeof platformConfig?.landingUserCountOffset === "number"
        ? platformConfig.landingUserCountOffset
        : 300;

    return realUserCount + offset;
  }, [platformConfig]);
  const formattedLandingUserCount = useMemo(
    () => Math.max(0, Math.round(landingDisplayUserCount)).toLocaleString("en-US"),
    [landingDisplayUserCount],
  );

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      // Admins go to the admin console; everyone else lands on the feed.
      // Onboarding is shown as a global modal (GlobalOnboardingModal), so new
      // users land on the feed and the video overlays on top.
      router.replace(role === "ADMIN" ? "/admin" : "/(tabs)/feed");
    }
  }, [isAuthenticated, isLoading, role]);

  if (isLoading || isAuthenticated) return null;

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      {/* Painted first so the mark and the buttons always sit on top of it. */}
      <FormulaBackdrop topInset={insets.top} />

      <View
        className="flex-1 px-7"
        style={{
          paddingTop: Math.max(insets.top + 16, 44),
          paddingBottom: Math.max(insets.bottom + 20, 32),
        }}
      >
        {/* The whole top half is deliberately quiet: a mark, a name, one line
            of promise. Everything the old screen explained in paragraphs is
            better learned inside the app than read on the way in. */}
        <View className="flex-1 items-center justify-center">
          <Image
            source={require("../assets/images/logo.png")}
            style={{ width: 64, height: 64 }}
            resizeMode="contain"
          />

          <Text className="mt-7 text-center text-[32px] font-semibold tracking-tight text-foreground">
            QuestionCall
          </Text>

          <Text className="mt-3 max-w-[280px] text-center text-[16px] leading-6 text-muted-foreground">
            Ask a question. Get a teacher on it in minutes.
          </Text>
        </View>

        <View className="gap-3">
          {/* One tap to the feed for anyone with a Google account: existing
              users never see a role screen, new ones get asked once in a
              sheet on top of this screen rather than on a route of their own. */}
          <GoogleContinueButton onError={setAuthError} />

          <TouchableOpacity
            className="h-14 flex-row items-center justify-center gap-2 rounded-full border border-border bg-card"
            activeOpacity={0.85}
            onPress={() => router.push("/(auth)/login")}
          >
            <Ionicons name="mail-outline" size={18} color={iconColor} />
            <Text className="text-[16px] font-semibold text-card-foreground">
              Continue with Email
            </Text>
          </TouchableOpacity>

          {authError ? (
            <Text className="px-2 text-center text-[13px] leading-5 text-destructive">
              {authError}
            </Text>
          ) : null}

          <Text className="pt-2 text-center text-[11px] leading-4 text-muted-foreground">
            Joined by {formattedLandingUserCount} learners and teachers
          </Text>

          <Text className="px-4 text-center text-[11px] leading-4 text-muted-foreground">
            By continuing, you agree to our{" "}
            <Text
              className="font-semibold text-foreground underline"
              onPress={() => router.push("/legal/terms")}
            >
              Terms of Use
            </Text>{" "}
            and{" "}
            <Text
              className="font-semibold text-foreground underline"
              onPress={() => router.push("/legal/privacy")}
            >
              Privacy Policy
            </Text>
            .
          </Text>
        </View>
      </View>
    </View>
  );
}
