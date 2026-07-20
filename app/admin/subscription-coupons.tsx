import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Modal,
  ScrollView,
  Alert,
  StatusBar,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Toast from "react-native-toast-message";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { getRequestErrorMessage } from "@/lib/server-response";
import { readCache, writeCache } from "@/lib/admin-cache";

type SubscriptionCoupon = {
  _id: string;
  code: string;
  kind: "FREE_ACCESS" | "PERCENTAGE";
  planSlug?: string | null;
  durationDays?: number | null;
  discountPercentage?: number | null;
  allowedEmails?: string[];
  usageLimit?: number | null;
  usedCount?: number;
  redemptionCount?: number;
  startsAt?: string | null;
  expiryDate?: string | null;
  campaign?: string | null;
  isActive: boolean;
  createdAt?: string;
};

// Paid plan slugs mirror web `SUBSCRIPTION_PLANS` (lib/config.ts).
const PLAN_OPTIONS = ["go", "plus", "pro", "max"] as const;

function formatDate(value?: string | null) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

export default function AdminSubscriptionCouponsScreen() {
  const insets = useSafeAreaInsets();
  const { statusBarStyle, backgroundColor, iconColor, primaryColor } = useAppTheme();

  const [items, setItems] = useState<SubscriptionCoupon[]>(
    () => readCache<SubscriptionCoupon[]>("subscription-coupons") ?? [],
  );
  const [loading, setLoading] = useState(
    () => readCache("subscription-coupons") === undefined,
  );
  const [refreshing, setRefreshing] = useState(false);

  // create state
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"FREE_ACCESS" | "PERCENTAGE">("FREE_ACCESS");
  const [planSlug, setPlanSlug] = useState<string>("go");
  const [durationDays, setDurationDays] = useState("");
  const [discount, setDiscount] = useState("20");
  const [emails, setEmails] = useState("");
  const [usageLimit, setUsageLimit] = useState("");
  const [expiry, setExpiry] = useState("");
  const [campaign, setCampaign] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.get("/mobile/admin/subscription-coupons");
      const data = Array.isArray(res.data?.coupons) ? res.data.coupons : [];
      setItems(data);
      writeCache("subscription-coupons", data);
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Failed to load subscription coupons",
        text2: getRequestErrorMessage(err, "Please try again."),
        position: "bottom",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = useCallback(() => {
    setCode("");
    setKind("FREE_ACCESS");
    setPlanSlug("go");
    setDurationDays("");
    setDiscount("20");
    setEmails("");
    setUsageLimit("");
    setExpiry("");
    setCampaign("");
    setCreating(true);
  }, []);

  const submitCreate = useCallback(async () => {
    if (!code.trim()) {
      Toast.show({ type: "error", text1: "Code is required", position: "bottom" });
      return;
    }
    if (kind === "PERCENTAGE" && !Number(discount)) {
      Toast.show({
        type: "error",
        text1: "Discount % is required",
        position: "bottom",
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post("/mobile/admin/subscription-coupons", {
        code: code.trim().toUpperCase(),
        kind,
        planSlug: kind === "FREE_ACCESS" ? planSlug : planSlug || null,
        durationDays: durationDays.trim() ? Number(durationDays) : null,
        discountPercentage: kind === "PERCENTAGE" ? Number(discount) : null,
        allowedEmails: emails,
        usageLimit: usageLimit.trim() ? Number(usageLimit) : null,
        expiryDate: expiry.trim() || null,
        campaign: campaign.trim() || null,
      });
      setItems((prev) => [{ ...res.data, redemptionCount: 0 }, ...prev]);
      Toast.show({ type: "success", text1: "Coupon created", position: "bottom" });
      setCreating(false);
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Failed to create coupon",
        text2: getRequestErrorMessage(err, "Please try again."),
        position: "bottom",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    code,
    kind,
    planSlug,
    durationDays,
    discount,
    emails,
    usageLimit,
    expiry,
    campaign,
  ]);

  const toggleActive = useCallback(async (coupon: SubscriptionCoupon) => {
    const next = !coupon.isActive;
    setItems((prev) =>
      prev.map((c) => (c._id === coupon._id ? { ...c, isActive: next } : c)),
    );
    try {
      await api.patch(`/mobile/admin/subscription-coupons/${coupon._id}`, {
        isActive: next,
      });
    } catch (err) {
      setItems((prev) =>
        prev.map((c) => (c._id === coupon._id ? { ...c, isActive: !next } : c)),
      );
      Toast.show({
        type: "error",
        text1: "Failed to update",
        text2: getRequestErrorMessage(err, "Please try again."),
        position: "bottom",
      });
    }
  }, []);

  const deleteCoupon = useCallback((coupon: SubscriptionCoupon) => {
    Alert.alert("Delete coupon?", `"${coupon.code}" will be permanently removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.delete(`/mobile/admin/subscription-coupons/${coupon._id}`);
            setItems((prev) => prev.filter((c) => c._id !== coupon._id));
            Toast.show({
              type: "success",
              text1: "Coupon deleted",
              position: "bottom",
            });
          } catch (err) {
            Toast.show({
              type: "error",
              text1: "Failed to delete",
              text2: getRequestErrorMessage(err, "Please try again."),
              position: "bottom",
            });
          }
        },
      },
    ]);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: SubscriptionCoupon }) => {
      const expiryLabel = formatDate(item.expiryDate);
      const used = item.redemptionCount ?? item.usedCount ?? 0;
      const emailCount = item.allowedEmails?.length ?? 0;
      const benefit =
        item.kind === "FREE_ACCESS"
          ? `Free ${item.planSlug?.toUpperCase() ?? ""}${item.durationDays ? ` · ${item.durationDays}d` : ""}`
          : `${item.discountPercentage}% off ${item.planSlug ? item.planSlug.toUpperCase() : "any plan"}`;
      return (
        <View className="mb-3 rounded-2xl border border-border bg-card p-4">
          <View className="flex-row items-start justify-between">
            <View className="flex-1 pr-3">
              <Text className="text-[16px] font-bold tracking-wide text-foreground">
                {item.code}
              </Text>
              <Text className="mt-0.5 text-[12px] text-muted-foreground">{benefit}</Text>
              {item.campaign ? (
                <Text className="mt-0.5 text-[11px] text-muted-foreground">
                  {item.campaign}
                </Text>
              ) : null}
            </View>
            <View
              className="rounded-full px-2 py-0.5"
              style={{
                backgroundColor: item.isActive
                  ? "rgba(16,185,129,0.12)"
                  : "rgba(120,120,120,0.12)",
              }}
            >
              <Text
                className="text-[11px] font-bold"
                style={{ color: item.isActive ? "#10B981" : "#888" }}
              >
                {item.isActive ? "ACTIVE" : "OFF"}
              </Text>
            </View>
          </View>

          <View className="mt-2 flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text className="text-[12px] text-muted-foreground">
              Used {used}
              {item.usageLimit ? ` / ${item.usageLimit}` : ""}
            </Text>
            <Text className="text-[12px] text-muted-foreground">
              {emailCount > 0
                ? `${emailCount} email${emailCount > 1 ? "s" : ""} only`
                : "Anyone"}
            </Text>
            {expiryLabel ? (
              <Text className="text-[12px] text-muted-foreground">
                Expires {expiryLabel}
              </Text>
            ) : (
              <Text className="text-[12px] text-muted-foreground">No expiry</Text>
            )}
          </View>

          <View className="mt-3 flex-row gap-2">
            <TouchableOpacity
              onPress={() => toggleActive(item)}
              activeOpacity={0.85}
              className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full border border-border py-2.5"
            >
              <Ionicons
                name={item.isActive ? "pause-outline" : "play-outline"}
                size={16}
                color={iconColor}
              />
              <Text className="text-[13px] font-semibold text-foreground">
                {item.isActive ? "Disable" : "Enable"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => deleteCoupon(item)}
              activeOpacity={0.85}
              className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full py-2.5"
              style={{ backgroundColor: "rgba(239,68,68,0.12)" }}
            >
              <Ionicons name="trash-outline" size={16} color="#EF4444" />
              <Text className="text-[13px] font-semibold" style={{ color: "#EF4444" }}>
                Delete
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    },
    [iconColor, toggleActive, deleteCoupon],
  );

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      <View
        className="border-b border-border px-5 pb-3"
        style={{ paddingTop: Math.max(insets.top + 8, 36) }}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-3">
            <TouchableOpacity
              onPress={() => router.back()}
              className="h-10 w-10 items-center justify-center rounded-full border border-border bg-card"
              activeOpacity={0.85}
            >
              <Ionicons name="arrow-back" size={20} color={iconColor} />
            </TouchableOpacity>
            <View>
              <Text className="text-[18px] font-bold tracking-tight text-foreground">
                Subscription Coupons
              </Text>
              <Text className="text-[12px] text-muted-foreground">
                {items.length} total
              </Text>
            </View>
          </View>

          <TouchableOpacity
            onPress={openCreate}
            activeOpacity={0.85}
            className="flex-row items-center gap-1 rounded-full px-3 py-1.5"
            style={{ backgroundColor: primaryColor }}
          >
            <Ionicons name="add" size={16} color="#fff" />
            <Text className="text-[12px] font-semibold text-white">New</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={primaryColor} size="large" />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item._id}
          renderItem={renderItem}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: Math.max(insets.bottom + 24, 32),
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
              tintColor={primaryColor}
              colors={[primaryColor]}
            />
          }
          ListEmptyComponent={
            <View className="items-center justify-center py-20">
              <Ionicons name="ticket-outline" size={40} color="#9CA3AF" />
              <Text className="mt-3 text-[14px] text-muted-foreground">
                No subscription coupons yet.
              </Text>
            </View>
          }
        />
      )}

      {/* Create modal */}
      <Modal
        visible={creating}
        transparent
        animationType="slide"
        onRequestClose={() => !submitting && setCreating(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View
            className="rounded-t-3xl border border-border bg-card"
            style={{ maxHeight: "90%", paddingBottom: Math.max(insets.bottom, 16) }}
          >
            <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
              <Text className="text-[17px] font-bold text-foreground">
                New subscription coupon
              </Text>
              <TouchableOpacity onPress={() => !submitting && setCreating(false)}>
                <Ionicons name="close" size={22} color={iconColor} />
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={{ padding: 20 }}
              keyboardShouldPersistTaps="handled"
            >
              <Text className="mb-1 ml-1 text-[12px] font-medium text-foreground">
                Code
              </Text>
              <TextInput
                value={code}
                onChangeText={setCode}
                placeholder="CREATOR2026"
                placeholderTextColor="#6B7280"
                autoCapitalize="characters"
                className="rounded-2xl border border-border bg-background px-4 py-3 text-[14px] text-foreground"
              />

              <Text className="mb-2 ml-1 mt-4 text-[12px] font-medium text-foreground">
                Type
              </Text>
              <View className="flex-row gap-2">
                {(
                  [
                    ["FREE_ACCESS", "Free access"],
                    ["PERCENTAGE", "Discount %"],
                  ] as const
                ).map(([value, label]) => {
                  const active = kind === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      onPress={() => setKind(value)}
                      activeOpacity={0.85}
                      className="rounded-full border px-3 py-1.5"
                      style={{
                        borderColor: active ? primaryColor : "transparent",
                        backgroundColor: active
                          ? `${primaryColor}1A`
                          : "rgba(120,120,120,0.1)",
                      }}
                    >
                      <Text
                        className="text-[12px] font-semibold"
                        style={{ color: active ? primaryColor : iconColor }}
                      >
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text className="mb-2 ml-1 mt-4 text-[12px] font-medium text-foreground">
                Plan {kind === "PERCENTAGE" ? "(optional — empty = any)" : ""}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {kind === "PERCENTAGE" ? (
                  <TouchableOpacity
                    onPress={() => setPlanSlug("")}
                    activeOpacity={0.85}
                    className="rounded-full border px-3 py-1.5"
                    style={{
                      borderColor: planSlug === "" ? primaryColor : "transparent",
                      backgroundColor:
                        planSlug === "" ? `${primaryColor}1A` : "rgba(120,120,120,0.1)",
                    }}
                  >
                    <Text
                      className="text-[12px] font-semibold"
                      style={{ color: planSlug === "" ? primaryColor : iconColor }}
                    >
                      Any plan
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {PLAN_OPTIONS.map((slug) => {
                  const active = planSlug === slug;
                  return (
                    <TouchableOpacity
                      key={slug}
                      onPress={() => setPlanSlug(slug)}
                      activeOpacity={0.85}
                      className="rounded-full border px-3 py-1.5"
                      style={{
                        borderColor: active ? primaryColor : "transparent",
                        backgroundColor: active
                          ? `${primaryColor}1A`
                          : "rgba(120,120,120,0.1)",
                      }}
                    >
                      <Text
                        className="text-[12px] font-semibold uppercase"
                        style={{ color: active ? primaryColor : iconColor }}
                      >
                        {slug}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {kind === "FREE_ACCESS" ? (
                <>
                  <Text className="mb-1 ml-1 mt-4 text-[12px] font-medium text-foreground">
                    Access duration in days (empty = plan default)
                  </Text>
                  <TextInput
                    value={durationDays}
                    onChangeText={setDurationDays}
                    placeholder="e.g. 30"
                    placeholderTextColor="#6B7280"
                    keyboardType="numeric"
                    className="rounded-2xl border border-border bg-background px-4 py-3 text-[14px] text-foreground"
                  />
                </>
              ) : (
                <>
                  <Text className="mb-1 ml-1 mt-4 text-[12px] font-medium text-foreground">
                    Discount %
                  </Text>
                  <TextInput
                    value={discount}
                    onChangeText={setDiscount}
                    placeholder="1 - 100"
                    placeholderTextColor="#6B7280"
                    keyboardType="numeric"
                    className="rounded-2xl border border-border bg-background px-4 py-3 text-[14px] text-foreground"
                  />
                </>
              )}

              <Text className="mb-1 ml-1 mt-4 text-[12px] font-medium text-foreground">
                Restrict to emails (optional, comma separated)
              </Text>
              <TextInput
                value={emails}
                onChangeText={setEmails}
                placeholder="one@x.com, two@x.com — empty = anyone"
                placeholderTextColor="#6B7280"
                autoCapitalize="none"
                multiline
                className="min-h-[72px] rounded-2xl border border-border bg-background px-4 py-3 text-[14px] text-foreground"
              />

              <Text className="mb-1 ml-1 mt-4 text-[12px] font-medium text-foreground">
                First N redeemers (optional)
              </Text>
              <TextInput
                value={usageLimit}
                onChangeText={setUsageLimit}
                placeholder="e.g. 100 — empty = unlimited"
                placeholderTextColor="#6B7280"
                keyboardType="numeric"
                className="rounded-2xl border border-border bg-background px-4 py-3 text-[14px] text-foreground"
              />

              <Text className="mb-1 ml-1 mt-4 text-[12px] font-medium text-foreground">
                Expiry date (optional, YYYY-MM-DD)
              </Text>
              <TextInput
                value={expiry}
                onChangeText={setExpiry}
                placeholder="2026-12-31"
                placeholderTextColor="#6B7280"
                autoCapitalize="none"
                className="rounded-2xl border border-border bg-background px-4 py-3 text-[14px] text-foreground"
              />

              <Text className="mb-1 ml-1 mt-4 text-[12px] font-medium text-foreground">
                Campaign label (optional)
              </Text>
              <TextInput
                value={campaign}
                onChangeText={setCampaign}
                placeholder='e.g. "YT promo — CreatorName"'
                placeholderTextColor="#6B7280"
                className="rounded-2xl border border-border bg-background px-4 py-3 text-[14px] text-foreground"
              />

              <TouchableOpacity
                onPress={submitCreate}
                disabled={submitting}
                activeOpacity={0.85}
                className="mt-6 items-center rounded-full py-4"
                style={{ backgroundColor: primaryColor }}
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text className="text-[15px] font-semibold text-white">
                    Create coupon
                  </Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
