import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Platform,
  Image,
  Alert,
  StatusBar,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAppSelector } from "@/hooks/redux";
import { purgeLocalSession } from "@/lib/session";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useTabBarScroll } from "@/components/ui/bottom-chrome";
import { useCallSetup } from "@/lib/call-setup";
import Animated from "react-native-reanimated";
import { PlanBadge } from "@/components/PlanBadge";
import type { ComponentProps } from "react";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

const GREEN = "#10b981";

interface MenuItemProps {
  icon: IoniconName;
  label: string;
  subtitle?: string;
  onPress: () => void;
  danger?: boolean;
  badge?: string;
}

function MenuItem({ icon, label, subtitle, onPress, danger, badge }: MenuItemProps) {
  const { primaryColor, primarySoftColor, mutedIconColor } = useAppTheme();
  const itemColor = danger ? "#EF4444" : primaryColor;
  const rippleColor = danger ? "rgba(239,68,68,0.15)" : `${primaryColor}25`;

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: rippleColor, borderless: false }}
      style={({ pressed }) =>
        Platform.OS === "ios" && pressed ? { backgroundColor: "rgba(0,0,0,0.05)" } : {}
      }
    >
      {/* Inner view owns all layout — never mix className on Pressable itself */}
      <View className="flex-row items-center px-4 py-3.5">
        <View
          className="mr-3 h-9 w-9 items-center justify-center rounded-xl"
          style={{ backgroundColor: danger ? "rgba(239,68,68,0.12)" : primarySoftColor }}
        >
          <Ionicons name={icon} size={18} color={itemColor} />
        </View>
        <View className="flex-1">
          <Text
            className={`text-base font-medium ${
              danger ? "text-red-500 dark:text-red-300" : "text-foreground"
            }`}
          >
            {label}
          </Text>
          {subtitle ? (
            <Text className="mt-0.5 text-xs text-muted-foreground">{subtitle}</Text>
          ) : null}
        </View>
        {badge ? (
          <View
            className="mr-2 rounded-full px-2 py-0.5"
            style={{ backgroundColor: primaryColor }}
          >
            <Text className="text-xs font-semibold text-white">{badge}</Text>
          </View>
        ) : null}
        <Ionicons
          name="chevron-forward"
          size={16}
          color={danger ? "#EF4444" : mutedIconColor}
        />
      </View>
    </Pressable>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <View className="px-4 pb-2 pt-5">
      <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </Text>
    </View>
  );
}

function Divider() {
  return <View className="mx-4 h-px bg-border" />;
}

export default function MenuScreen() {
  const user = useAppSelector((s) => s.user.data);
  const { onScroll, scrollEventThrottle, tabBarClearance } = useTabBarScroll();
  const config = useAppSelector((s) => s.config.data);
  const unreadNotificationCount = useAppSelector((s) => s.notifications.unreadCount);
  const { issues: callSetupIssues } = useCallSetup();
  const { statusBarStyle, backgroundColor, cardColor, primaryColor, primarySoftColor } =
    useAppTheme();
  const isTeacher = user?.role === "TEACHER";

  async function handleSignOut() {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          // Fast, non-blocking teardown — navigates immediately; the push
          // unsubscribe runs best-effort in the background.
          await purgeLocalSession();
          router.replace("/");
        },
      },
    ]);
  }

  const pointBalance = isTeacher ? (user?.pointBalance ?? 0) : (user?.points ?? 0);
  const nprRate = config?.pointToNprRate ?? 1;
  const nprEquivalent = (pointBalance * nprRate).toFixed(2);

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      <View className="px-6 pb-2 pt-14">
        <Text className="text-[28px] font-bold tracking-tight text-foreground">Menu</Text>
      </View>

      <Animated.ScrollView
        showsVerticalScrollIndicator={false}
        className="flex-1"
        // The tab bar floats over the content, so the page reserves its height.
        contentContainerStyle={{ paddingBottom: 28 + tabBarClearance }}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
      >
        {/* ── Combined Profile + Points card (cut-corner style) ─── */}
        <View className="mx-4 my-3">
          <View
            style={{
              borderRadius: 18,
              borderBottomRightRadius: 0,
              borderWidth: 1.5,
              borderColor: `${GREEN}45`,
              backgroundColor: cardColor,
              overflow: "hidden",
            }}
          >
            {/* Green left accent strip */}
            <View
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: 3,
                backgroundColor: GREEN,
              }}
            />

            {/* Profile row */}
            <View className="flex-row items-center px-4 pb-3 pt-4">
              {user?.image ? (
                <Image
                  source={{ uri: user.image }}
                  className="mr-3 h-14 w-14 rounded-full"
                />
              ) : (
                <View
                  className="mr-3 h-14 w-14 items-center justify-center rounded-full"
                  style={{ backgroundColor: primaryColor }}
                >
                  <Text className="text-2xl font-bold text-white">
                    {(user?.name ?? "U")[0].toUpperCase()}
                  </Text>
                </View>
              )}
              <View className="flex-1">
                <Text className="text-lg font-bold text-foreground" numberOfLines={1}>
                  {user?.name ?? "Loading..."}
                </Text>
                <View className="mt-1 flex-row items-center gap-2">
                  <View
                    className="rounded-full px-2 py-0.5"
                    style={{ backgroundColor: primarySoftColor }}
                  >
                    <Text
                      className="text-xs font-semibold"
                      style={{ color: primaryColor }}
                    >
                      {user?.role ?? "—"}
                    </Text>
                  </View>
                  <PlanBadge slug={user?.planSlug ?? "free"} />
                </View>
              </View>
              <TouchableOpacity
                onPress={() => router.push("/profile" as any)}
                className="rounded-xl px-3 py-1.5"
                style={{ backgroundColor: `${primaryColor}18` }}
                activeOpacity={0.7}
              >
                <Text className="text-xs font-semibold" style={{ color: primaryColor }}>
                  View
                </Text>
              </TouchableOpacity>
            </View>

            {/* Separator with green tint */}
            <View
              style={{ height: 1, marginHorizontal: 14, backgroundColor: `${GREEN}25` }}
            />

            {/* Points row */}
            <View className="px-4 pb-4 pt-3">
              <Text className="mb-1 text-xs text-muted-foreground">
                {isTeacher ? "Point Balance" : "Quiz Points"}
              </Text>
              <View className="flex-row items-baseline gap-1">
                <Text className="text-[30px] font-black" style={{ color: GREEN }}>
                  {pointBalance.toLocaleString()}
                </Text>
                <Text className="text-sm text-muted-foreground">pts</Text>
              </View>
              <Text className="mt-0.5 text-sm text-muted-foreground">
                ≈ NPR {nprEquivalent}
              </Text>
            </View>

            {/* Cut corner — green triangle at bottom-right */}
            <View
              style={{
                position: "absolute",
                bottom: 0,
                right: 0,
                width: 0,
                height: 0,
                borderStyle: "solid",
                borderBottomWidth: 36,
                borderLeftWidth: 36,
                borderBottomColor: GREEN,
                borderLeftColor: "transparent",
              }}
            />
          </View>
        </View>

        {/* Profile section */}
        <SectionHeader title="Profile" />
        <View className="mx-4 overflow-hidden rounded-2xl border border-border bg-card">
          <MenuItem
            icon="person-outline"
            label="My Profile"
            onPress={() => router.push("/profile" as any)}
          />
          <Divider />
          <MenuItem
            icon="stats-chart-outline"
            label="My Activity"
            onPress={() => router.push("/profile/activity" as any)}
          />
        </View>

        {/* Wallet & Transactions */}
        <SectionHeader title="Wallet & Transactions" />
        <View className="mx-4 overflow-hidden rounded-2xl border border-border bg-card">
          <MenuItem
            icon="wallet-outline"
            label="Wallet"
            subtitle={`${pointBalance} pts · NPR ${nprEquivalent}`}
            onPress={() => router.push("/wallet" as any)}
          />
          {isTeacher ? (
            <>
              <Divider />
              <MenuItem
                icon="cash-outline"
                label="Withdraw"
                subtitle="Transfer to eSewa"
                onPress={() => router.push("/wallet/withdraw" as any)}
              />
            </>
          ) : null}
          <Divider />
          <MenuItem
            icon="receipt-outline"
            label="Transaction History"
            onPress={() => router.push("/wallet" as any)}
          />
          {isTeacher ? (
            <>
              <Divider />
              <MenuItem
                icon="flag-outline"
                label="Daily Target"
                subtitle={`${user?.dailyAnswersCount ?? 0} answers today`}
                onPress={() => router.push("/daily-target" as any)}
              />
            </>
          ) : null}
        </View>

        {/* Services */}
        <SectionHeader title="Services" />
        <View className="mx-4 overflow-hidden rounded-2xl border border-border bg-card">
          {isTeacher ? (
            <>
              <MenuItem
                icon="videocam-outline"
                label="Course Studio"
                subtitle="Manage your courses"
                onPress={() => router.push("/studio" as any)}
              />
              <Divider />
            </>
          ) : null}
          <MenuItem
            icon="document-text-outline"
            label="Notes"
            subtitle="Study notes shared by students"
            onPress={() => router.push("/notes" as any)}
          />
          <Divider />
          <MenuItem
            icon="bulb-outline"
            label="AI Quizzes"
            subtitle="Test your knowledge"
            onPress={() => router.push("/quiz" as any)}
          />
          <Divider />
          <MenuItem
            icon="trophy-outline"
            label="Leaderboard"
            onPress={() => router.push("/leaderboard" as any)}
          />
          <Divider />
          <MenuItem
            icon="gift-outline"
            label="Referrals"
            subtitle="Invite friends, earn bonus questions"
            onPress={() => router.push("/referral" as any)}
          />
          <Divider />
          <MenuItem
            icon="megaphone-outline"
            label="Notices"
            onPress={() => router.push("/notices" as any)}
          />
        </View>

        {/* Account */}
        <SectionHeader title="Account" />
        <View className="mx-4 overflow-hidden rounded-2xl border border-border bg-card">
          {!isTeacher ? (
            <>
              <MenuItem
                icon="diamond-outline"
                label="Subscription Plans"
                subtitle={`Current: ${(user?.planSlug ?? "free").toUpperCase()}`}
                onPress={() => router.push("/payment/plans" as any)}
              />
              <Divider />
            </>
          ) : null}
          <MenuItem
            icon="notifications-outline"
            label="Notification Center"
            subtitle={
              unreadNotificationCount > 0
                ? `${unreadNotificationCount} unread`
                : "Recent updates and alerts"
            }
            badge={
              unreadNotificationCount > 0
                ? unreadNotificationCount > 99
                  ? "99+"
                  : String(unreadNotificationCount)
                : undefined
            }
            onPress={() => router.push("/notifications" as any)}
          />
          <Divider />
          <MenuItem
            icon="options-outline"
            label="Notification Settings"
            subtitle="Mute categories of push notifications"
            onPress={() => router.push("/settings/notifications" as any)}
          />
          <Divider />
          <MenuItem
            icon="call-outline"
            label="Call Settings"
            onPress={() => router.push("/settings/call-settings" as any)}
          />
          <Divider />
          {Platform.OS === "android" ? (
            <>
              <MenuItem
                icon="shield-checkmark-outline"
                label="Call Setup"
                subtitle={
                  callSetupIssues > 0
                    ? "Calls may not ring when the app is closed"
                    : "Calls ring even when the app is closed"
                }
                badge={callSetupIssues > 0 ? String(callSetupIssues) : undefined}
                onPress={() => router.push("/settings/call-setup" as any)}
              />
              <Divider />
            </>
          ) : null}
          <MenuItem
            icon="play-circle-outline"
            label="Onboarding Videos"
            onPress={() => router.push("/onboarding" as any)}
          />
          <Divider />
          <MenuItem
            icon="document-text-outline"
            label="Terms of Use"
            onPress={() => router.push("/legal/terms" as any)}
          />
          <Divider />
          <MenuItem
            icon="shield-checkmark-outline"
            label="Privacy Policy"
            onPress={() => router.push("/legal/privacy" as any)}
          />
          <Divider />
          <MenuItem
            icon="key-outline"
            label="Change Password"
            onPress={() => router.push("/profile/change-password" as any)}
          />
          <Divider />
          <MenuItem
            icon="contrast-outline"
            label="Theme"
            onPress={() => router.push("/settings/theme" as any)}
          />
        </View>

        {/* Danger Zone */}
        <SectionHeader title="Danger Zone" />
        <View className="mx-4 mb-8 overflow-hidden rounded-2xl border border-border bg-card">
          <MenuItem
            icon="log-out-outline"
            label="Sign Out"
            onPress={handleSignOut}
            danger
          />
          <Divider />
          <MenuItem
            icon="trash-outline"
            label="Delete Account"
            subtitle="Recoverable within 30 days"
            onPress={() => router.push("/settings/delete-account" as any)}
            danger
          />
        </View>
      </Animated.ScrollView>
    </View>
  );
}
