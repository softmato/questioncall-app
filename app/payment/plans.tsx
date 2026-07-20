import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import Toast from "react-native-toast-message";

import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { usePlatformConfig } from "@/hooks/use-platform-config";
import { api } from "@/lib/api";
import { getRequestErrorMessage } from "@/lib/server-response";
import { openWebCheckout } from "@/lib/web-checkout";
import { PlanBadge } from "@/components/PlanBadge";

type ValidatedPromo = {
  code: string;
  kind: "FREE_ACCESS" | "PERCENTAGE";
  planSlug: string | null;
  durationDays: number | null;
  discountPercentage: number | null;
};

/**
 * What an applied coupon does to one plan card. Prices are deliberately absent
 * — paid amounts are only ever shown on the web checkout (Play Store rule), so
 * in-app we communicate the offer, not the number.
 */
type PlanCouponEffect =
  | { type: "none" }
  | { type: "free"; durationDays: number | null }
  | { type: "discount"; percentage: number }
  | { type: "not-applicable" };

interface SubscriptionInfo {
  subscriptionStatus: string;
  subscriptionEnd: string | null;
  pendingManualPayment: boolean;
  pendingPlanSlug: string | null;
  questionsAsked: number;
  questionsRemaining: number | null;
  maxQuestions: number;
  baseMaxQuestions: number;
  bonusQuestions: number;
  planSlug: string;
  referralCode: string | null;
}

export default function PlansScreen() {
  const user = useAppSelector((s) => s.user.data);
  const { config, isLoading: configLoading } = usePlatformConfig();
  const {
    statusBarStyle,
    backgroundColor,
    primaryColor,
    primarySoftColor,
    cardColor,
    borderColor,
    mutedIconColor,
  } = useAppTheme();

  const [subInfo, setSubInfo] = useState<SubscriptionInfo | null>(null);
  const [loadingSub, setLoadingSub] = useState(false);

  // Coupon entry lives inline at the top of the screen. FREE_ACCESS codes
  // activate in-app (no payment involved → Play-Store-safe); PERCENTAGE codes
  // travel with the hand-off to the compliant web checkout.
  const [promoCode, setPromoCode] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [promo, setPromo] = useState<ValidatedPromo | null>(null);

  const currentPlan = subInfo?.planSlug ?? user?.planSlug ?? "free";
  const plans = config?.plans ?? [];

  const fetchSubscription = useCallback(async () => {
    setLoadingSub(true);
    try {
      const res = await api.get("/user/subscription");
      setSubInfo(res.data);
    } catch {}
    setLoadingSub(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (user?.role === "STUDENT") void fetchSubscription();
    }, [user?.role, fetchSubscription]),
  );

  const isLoading = configLoading || loadingSub;

  const clearPromo = useCallback(() => {
    setPromo(null);
    setPromoCode("");
  }, []);

  const applyPromo = useCallback(async () => {
    if (!promoCode.trim()) return;
    setPromoBusy(true);
    try {
      const res = await api.post("/mobile/subscription/coupons/validate", {
        code: promoCode.trim(),
      });
      if (!res.data?.valid) {
        Toast.show({
          type: "error",
          text1: res.data?.message ?? "That code isn't valid",
          position: "bottom",
        });
        setPromo(null);
        return;
      }
      setPromo(res.data.coupon as ValidatedPromo);
      Toast.show({
        type: "success",
        text1: "Coupon applied",
        text2: "Your packages below have been updated.",
        position: "bottom",
      });
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Couldn't check that code",
        text2: getRequestErrorMessage(err, "Please try again."),
        position: "bottom",
      });
    } finally {
      setPromoBusy(false);
    }
  }, [promoCode]);

  const redeemPromo = useCallback(async () => {
    if (!promo) return;
    setPromoBusy(true);
    try {
      const res = await api.post("/mobile/subscription/coupons/redeem", {
        code: promo.code,
      });
      Toast.show({
        type: "success",
        text1: `${res.data?.planName ?? "Plan"} activated 🎉`,
        text2: res.data?.subscriptionEnd
          ? `Active until ${new Date(res.data.subscriptionEnd).toLocaleDateString()}`
          : undefined,
        position: "bottom",
      });
      clearPromo();
      void fetchSubscription();
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Couldn't redeem the code",
        text2: getRequestErrorMessage(err, "Please try again."),
        position: "bottom",
      });
    } finally {
      setPromoBusy(false);
    }
  }, [promo, clearPromo, fetchSubscription]);

  const effectForPlan = useCallback(
    (slug: string): PlanCouponEffect => {
      if (!promo || slug === "free") return { type: "none" };

      if (promo.kind === "FREE_ACCESS") {
        return promo.planSlug === slug
          ? { type: "free", durationDays: promo.durationDays }
          : { type: "not-applicable" };
      }

      if (promo.planSlug && promo.planSlug !== slug) {
        return { type: "not-applicable" };
      }

      return typeof promo.discountPercentage === "number"
        ? { type: "discount", percentage: promo.discountPercentage }
        : { type: "not-applicable" };
    },
    [promo],
  );

  const getPlanIcon = (slug: string): any => {
    if (slug === "go") return "flash-outline";
    if (slug === "plus") return "star-outline";
    if (slug === "pro") return "rocket-outline";
    if (slug === "max") return "diamond-outline";
    return "document-outline";
  };

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      {/* Header */}
      <View className="flex-row items-center px-4 pb-2 pt-14">
        <TouchableOpacity onPress={() => router.back()} className="mr-3">
          <Ionicons name="chevron-back" size={24} color={primaryColor} />
        </TouchableOpacity>
        <Text className="flex-1 text-2xl font-bold text-foreground">
          Subscription Plans
        </Text>
      </View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={primaryColor} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Apply coupon — first thing on the screen, so a code is in place
              before the user compares packages. */}
          {user?.role === "STUDENT" ? (
            promo ? (
              <View
                className="rounded-2xl border p-4"
                style={{ borderColor: primaryColor, backgroundColor: primarySoftColor }}
              >
                <View className="flex-row items-center gap-2">
                  <Ionicons name="pricetag" size={18} color={primaryColor} />
                  <Text className="flex-1 text-sm font-bold text-foreground">
                    {promo.code} applied
                  </Text>
                  <TouchableOpacity onPress={clearPromo} disabled={promoBusy}>
                    <Text className="text-xs font-semibold text-muted-foreground">
                      Remove
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text className="mt-1.5 text-xs text-muted-foreground">
                  {promo.kind === "FREE_ACCESS"
                    ? `Unlocks the ${promo.planSlug?.toUpperCase()} plan${
                        promo.durationDays ? ` for ${promo.durationDays} days` : ""
                      } — completely free.`
                    : `${promo.discountPercentage}% off ${
                        promo.planSlug
                          ? `the ${promo.planSlug.toUpperCase()} plan`
                          : "any paid plan"
                      }. Your packages below are updated.`}
                </Text>
              </View>
            ) : (
              <View
                className="rounded-2xl border border-dashed p-4"
                style={{ borderColor: primaryColor, backgroundColor: primarySoftColor }}
              >
                <View className="flex-row items-center gap-2">
                  <Ionicons name="ticket-outline" size={18} color={primaryColor} />
                  <Text className="text-sm font-bold text-foreground">
                    Apply a coupon
                  </Text>
                </View>
                <View className="mt-3 flex-row gap-2">
                  <TextInput
                    value={promoCode}
                    onChangeText={(v) => setPromoCode(v.toUpperCase())}
                    onSubmitEditing={() => void applyPromo()}
                    placeholder="ENTER CODE"
                    placeholderTextColor="#6B7280"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    className="flex-1 rounded-xl border border-border bg-background px-4 py-3 text-[15px] font-semibold tracking-widest text-foreground"
                  />
                  <TouchableOpacity
                    onPress={() => void applyPromo()}
                    disabled={promoBusy || !promoCode.trim()}
                    activeOpacity={0.85}
                    className="items-center justify-center rounded-xl px-5"
                    style={{
                      backgroundColor: primaryColor,
                      opacity: promoBusy || !promoCode.trim() ? 0.6 : 1,
                    }}
                  >
                    {promoBusy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text className="text-[15px] font-semibold text-white">Apply</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            )
          ) : null}

          {/* Current plan info */}
          {subInfo ? (
            <View
              className="rounded-2xl border p-4"
              style={{ backgroundColor: primarySoftColor, borderColor }}
            >
              <View className="flex-row items-center justify-between">
                <Text className="text-sm font-semibold text-foreground">
                  Current Plan
                </Text>
                <PlanBadge slug={currentPlan} size="md" />
              </View>
              <Text className="mt-2 text-xs text-muted-foreground">
                Questions: {subInfo.questionsAsked}/{subInfo.maxQuestions}
                {subInfo.bonusQuestions > 0 ? ` (+${subInfo.bonusQuestions} bonus)` : ""}
                {subInfo.subscriptionEnd
                  ? ` · Expires: ${new Date(subInfo.subscriptionEnd).toLocaleDateString()}`
                  : ""}
              </Text>
              {subInfo.subscriptionStatus === "TRIAL" ? (
                <Text className="mt-1 text-xs text-amber-500">
                  You&apos;re on a free trial. Upgrade to unlock more questions!
                </Text>
              ) : null}
              {subInfo.pendingManualPayment ? (
                <View className="mt-3 flex-row items-center gap-2 rounded-lg bg-amber-500/10 p-2.5">
                  <Ionicons name="time-outline" size={16} color="#f59e0b" />
                  <Text className="flex-1 text-xs text-amber-600">
                    {subInfo.pendingPlanSlug
                      ? `Pending upgrade to ${subInfo.pendingPlanSlug.toUpperCase()} — awaiting admin verification.`
                      : "You have a pending payment. Please wait for admin verification."}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Plan cards */}
          {plans.map((plan) => {
            const isCurrent = currentPlan === plan.slug;
            const isPending = subInfo?.pendingManualPayment ?? false;
            const isPendingPlan = isPending && subInfo?.pendingPlanSlug === plan.slug;
            const effect = effectForPlan(plan.slug);
            const isCouponPlan = effect.type === "free" || effect.type === "discount";

            return (
              <View
                key={plan.slug}
                className="overflow-hidden rounded-2xl border"
                style={{
                  backgroundColor: isCurrent ? primarySoftColor : cardColor,
                  borderColor: isPendingPlan
                    ? "#f59e0b"
                    : isCouponPlan || isCurrent
                      ? primaryColor
                      : borderColor,
                  borderWidth: isPendingPlan || isCouponPlan ? 2 : 1,
                  opacity: effect.type === "not-applicable" ? 0.55 : 1,
                }}
              >
                <View className="p-5">
                  <View className="flex-row items-center gap-3">
                    <View
                      className="h-10 w-10 items-center justify-center rounded-xl"
                      style={{
                        backgroundColor: isCurrent ? primaryColor : primarySoftColor,
                      }}
                    >
                      <Ionicons
                        name={getPlanIcon(plan.slug)}
                        size={20}
                        color={isCurrent ? "#fff" : primaryColor}
                      />
                    </View>
                    <View className="flex-1">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-lg font-bold text-foreground">
                          {plan.name.toUpperCase()}
                        </Text>
                        {isCurrent ? (
                          <View
                            className="rounded-full px-2 py-0.5"
                            style={{ backgroundColor: primaryColor }}
                          >
                            <Text className="text-[10px] font-bold text-white">
                              CURRENT
                            </Text>
                          </View>
                        ) : null}
                        {isPendingPlan ? (
                          <View className="rounded-full bg-amber-500/20 px-2 py-0.5">
                            <Text className="text-[10px] font-bold text-amber-500">
                              PENDING
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <Text className="text-sm text-muted-foreground">
                        {plan.maxQuestions} questions
                      </Text>
                    </View>
                  </View>

                  {/* Coupon effect on this specific plan */}
                  {effect.type === "free" ? (
                    <View
                      className="mt-4 flex-row items-center gap-2 rounded-xl px-3 py-2.5"
                      style={{ backgroundColor: primarySoftColor }}
                    >
                      <Ionicons name="gift" size={16} color={primaryColor} />
                      <Text
                        className="flex-1 text-xs font-bold"
                        style={{ color: primaryColor }}
                      >
                        FREE with {promo?.code}
                        {effect.durationDays ? ` · ${effect.durationDays} days` : ""}
                      </Text>
                    </View>
                  ) : effect.type === "discount" ? (
                    <View
                      className="mt-4 flex-row items-center gap-2 rounded-xl px-3 py-2.5"
                      style={{ backgroundColor: primarySoftColor }}
                    >
                      <Ionicons name="pricetag" size={16} color={primaryColor} />
                      <Text
                        className="flex-1 text-xs font-bold"
                        style={{ color: primaryColor }}
                      >
                        {effect.percentage}% off applied with {promo?.code}
                      </Text>
                    </View>
                  ) : effect.type === "not-applicable" ? (
                    <Text className="mt-4 text-xs text-muted-foreground">
                      {promo?.code} doesn&apos;t apply to this plan.
                    </Text>
                  ) : null}

                  {/* Features */}
                  {plan.features?.length > 0 ? (
                    <View className="mt-4 gap-2">
                      {plan.features.map((feature, i) => (
                        <View key={i} className="flex-row items-center gap-2">
                          <Ionicons name="checkmark-circle" size={16} color="#22c55e" />
                          <Text className="flex-1 text-sm text-foreground">
                            {feature}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  {/* CTA. A free-access coupon activates in-app (no payment);
                      everything else is a neutral "view on web" hand-off. */}
                  {!isCurrent && effect.type === "free" ? (
                    <TouchableOpacity
                      onPress={() => void redeemPromo()}
                      disabled={promoBusy}
                      activeOpacity={0.85}
                      className="mt-4 flex-row items-center justify-center gap-1.5 rounded-xl py-3"
                      style={{
                        backgroundColor: primaryColor,
                        opacity: promoBusy ? 0.6 : 1,
                      }}
                    >
                      {promoBusy ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <>
                          <Ionicons name="gift-outline" size={15} color="#fff" />
                          <Text className="text-sm font-semibold text-white">
                            Activate free
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  ) : !isCurrent ? (
                    <TouchableOpacity
                      onPress={() =>
                        void openWebCheckout(
                          "subscription",
                          plan.slug,
                          fetchSubscription,
                          effect.type === "discount" && promo
                            ? { coupon: promo.code }
                            : undefined,
                        )
                      }
                      disabled={isPendingPlan}
                      activeOpacity={0.85}
                      className="mt-4 flex-row items-center justify-center gap-1.5 rounded-xl py-3"
                      style={{
                        backgroundColor: isPendingPlan ? primarySoftColor : primaryColor,
                      }}
                    >
                      <Ionicons
                        name={isPendingPlan ? "time-outline" : "open-outline"}
                        size={15}
                        color={isPendingPlan ? primaryColor : "#fff"}
                      />
                      <Text
                        className="text-sm font-semibold"
                        style={{ color: isPendingPlan ? primaryColor : "#fff" }}
                      >
                        {isPendingPlan
                          ? "Awaiting verification"
                          : effect.type === "discount"
                            ? "Continue in your browser"
                            : "Choose in your browser"}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            );
          })}

          {plans.length === 0 ? (
            <View className="items-center py-20">
              <Ionicons name="pricetags-outline" size={48} color={mutedIconColor} />
              <Text className="mt-3 text-base text-muted-foreground">
                No plans available
              </Text>
            </View>
          ) : (
            <View className="mt-2 gap-3">
              <Text className="text-center text-xs text-muted-foreground">
                Compare plans and manage your membership on the QuestionCall website.
              </Text>
              <TouchableOpacity
                className="flex-row items-center justify-center gap-2 rounded-xl py-3.5"
                style={{ backgroundColor: primaryColor }}
                onPress={() =>
                  void openWebCheckout(
                    "subscription",
                    undefined,
                    fetchSubscription,
                    promo?.kind === "PERCENTAGE" ? { coupon: promo.code } : undefined,
                  )
                }
              >
                <Ionicons name="open-outline" size={16} color="#fff" />
                <Text className="font-semibold text-white">
                  Manage membership in your browser
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}
