import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Modal,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";

import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { getRequestErrorMessage } from "@/lib/server-response";
import { openWebCheckout } from "@/lib/web-checkout";
import { store } from "@/store";
import { setUser } from "@/store/slices/userSlice";

type EligibleCoupon = {
  code: string;
  kind: "FREE_ACCESS" | "PERCENTAGE";
  planSlug: string | null;
  planName: string | null;
  durationDays: number | null;
  discountPercentage: number | null;
  campaign: string | null;
  expiryDate: string | null;
};

const DISMISSED_KEY = "qc:coupon-invite-dismissed";
/** Hold the activation overlay long enough to be readable; never pad past this
 *  once the server has answered. */
const MIN_OVERLAY_MS = 1200;
const MAX_PADDING_MS = 3000;

async function readDismissed(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

async function rememberDismissed(code: string) {
  try {
    const next = [...new Set([...(await readDismissed()), code])].slice(-50);
    await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    /* storage failure just means the banner returns next session */
  }
}

/**
 * Root-mounted announcement for coupons the student was personally invited to
 * (their email is on the coupon's allow-list). Shows an absolute-top snackbar
 * over whatever screen they're on; activating a free-access coupon runs the
 * redemption behind a dimmed "we're setting this up" overlay instead of pushing
 * a separate route.
 */
export function CouponInviteHost() {
  const insets = useSafeAreaInsets();
  const { primaryColor, cardColor, borderColor } = useAppTheme();

  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);
  const user = useAppSelector((s) => s.user.data);
  const role = user?.role;
  const firstName = user?.name?.split(" ")[0] ?? null;

  const [coupon, setCoupon] = useState<EligibleCoupon | null>(null);
  const [isActivating, setIsActivating] = useState(false);
  const checkedForUserRef = useRef<string | null>(null);

  const check = useCallback(async () => {
    if (!isAuthenticated || role !== "STUDENT") return;
    try {
      const res = await api.get("/mobile/subscription/coupons/eligible");
      const list = (res.data?.coupons ?? []) as EligibleCoupon[];
      if (list.length === 0) return;

      const dismissed = await readDismissed();
      const next = list.find((entry) => !dismissed.includes(entry.code));
      if (next) setCoupon(next);
    } catch {
      // Non-critical surface — stay silent.
    }
  }, [isAuthenticated, role]);

  // Runs on login/register (the user id appearing) and again on each foreground
  // so a coupon created while the app was open still finds the user.
  useEffect(() => {
    const userId = user?._id ?? null;
    if (!isAuthenticated || role !== "STUDENT" || !userId) {
      checkedForUserRef.current = null;
      setCoupon(null);
      return;
    }

    if (checkedForUserRef.current !== userId) {
      checkedForUserRef.current = userId;
      void check();
    }

    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") void check();
    });
    return () => sub.remove();
  }, [isAuthenticated, role, user?._id, check]);

  const dismiss = useCallback(() => {
    if (coupon) void rememberDismissed(coupon.code);
    setCoupon(null);
  }, [coupon]);

  const activate = useCallback(async () => {
    if (!coupon) return;

    // Discounts still have to be paid for — hand off to the compliant web
    // checkout with the code attached (never an in-app purchase).
    if (coupon.kind === "PERCENTAGE") {
      const code = coupon.code;
      const planSlug = coupon.planSlug ?? undefined;
      void rememberDismissed(code);
      setCoupon(null);
      void openWebCheckout(
        "subscription",
        planSlug,
        async () => {
          try {
            const me = await api.get("/mobile/me");
            store.dispatch(setUser(me.data));
          } catch {}
        },
        { coupon: code },
      );
      return;
    }

    setIsActivating(true);
    const startedAt = Date.now();

    try {
      const res = await api.post("/mobile/subscription/coupons/redeem", {
        code: coupon.code,
      });

      try {
        const me = await api.get("/mobile/me");
        store.dispatch(setUser(me.data));
      } catch {}

      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_OVERLAY_MS) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(MIN_OVERLAY_MS - elapsed, MAX_PADDING_MS)),
        );
      }

      void rememberDismissed(coupon.code);
      setCoupon(null);
      Toast.show({
        type: "success",
        text1: `${res.data?.planName ?? "Your plan"} is active 🎉`,
        text2: res.data?.subscriptionEnd
          ? `Active until ${new Date(res.data.subscriptionEnd).toLocaleDateString()}`
          : undefined,
        position: "bottom",
      });
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Couldn't activate your plan",
        text2: getRequestErrorMessage(err, "Please try again."),
        position: "bottom",
      });
    } finally {
      setIsActivating(false);
    }
  }, [coupon]);

  if (!coupon) return null;

  const planLabel = coupon.planName ?? coupon.planSlug?.toUpperCase() ?? "premium";
  const headline =
    coupon.kind === "FREE_ACCESS"
      ? `Congrats! You've been selected for ${planLabel}${
          coupon.durationDays ? ` (${coupon.durationDays} days)` : ""
        } — completely free.`
      : `Congrats! You've been selected for ${coupon.discountPercentage}% off${
          coupon.planName ? ` ${coupon.planName}` : ""
        }.`;

  return (
    <>
      <View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          top: insets.top + 8,
          left: 12,
          right: 12,
          zIndex: 999,
        }}
      >
        <View
          className="overflow-hidden rounded-2xl"
          style={{
            backgroundColor: primaryColor,
            shadowColor: "#000",
            shadowOpacity: 0.22,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: 5 },
            elevation: 10,
          }}
        >
          {/* Gift ribbon header */}
          <View className="flex-row items-center gap-2 px-4 pt-3">
            <Ionicons name="gift" size={16} color="#fff" />
            <Text className="flex-1 text-[11px] font-black uppercase tracking-[2px] text-white/90">
              {coupon.kind === "FREE_ACCESS" ? "A gift for you" : "Special offer"}
            </Text>
            <TouchableOpacity onPress={dismiss} disabled={isActivating} hitSlop={10}>
              <Ionicons name="close" size={16} color="rgba(255,255,255,0.75)" />
            </TouchableOpacity>
          </View>

          <View
            className="m-2 mt-2.5 flex-row items-center gap-3 rounded-xl p-3"
            style={{ backgroundColor: cardColor, borderColor, borderWidth: 1 }}
          >
            <View className="flex-1">
              <Text className="text-[13px] font-bold text-foreground" numberOfLines={2}>
                {headline}
              </Text>
              <Text
                className="mt-0.5 text-[11px] text-muted-foreground"
                numberOfLines={1}
              >
                {coupon.campaign ? `${coupon.campaign} · ` : ""}Code {coupon.code}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => void activate()}
              disabled={isActivating}
              activeOpacity={0.85}
              className="rounded-xl px-3.5 py-2"
              style={{ backgroundColor: primaryColor, opacity: isActivating ? 0.6 : 1 }}
            >
              <Text className="text-[13px] font-semibold text-white">
                {coupon.kind === "FREE_ACCESS" ? "Activate" : "Claim"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <Modal visible={isActivating} transparent animationType="fade">
        <View className="flex-1 items-center justify-center bg-black/70 px-8">
          <View
            className="w-full items-center gap-4 rounded-3xl px-6 py-9"
            style={{ backgroundColor: cardColor }}
          >
            <ActivityIndicator size="large" color={primaryColor} />
            <Text className="text-lg font-bold text-foreground">
              Hold on{firstName ? `, ${firstName}` : ""}…
            </Text>
            <Text className="text-center text-sm text-muted-foreground">
              We&apos;re activating your {planLabel} subscription and setting up your
              benefits.
            </Text>
          </View>
        </View>
      </Modal>
    </>
  );
}
