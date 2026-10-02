import { formatDuration } from "@/lib/duration";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Linking,
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

type SessionData = {
  _id: string;
  courseTitle: string;
  courseSlug: string;
  instructorName: string;
  title: string;
  scheduledAt: string;
  durationMinutes: number | null;
  status: string;
  zoomLink: string | null;
  notificationsSent: boolean;
  recordingUrl: string | null;
  notificationStats: { sent: number; failed: number };
};

const STATUSES = ["SCHEDULED", "LIVE", "ENDED", "CANCELLED"] as const;
type StatusFilter = "ALL" | (typeof STATUSES)[number];

const STATUS_META: Record<string, { color: string; bg: string }> = {
  SCHEDULED: { color: "#3B82F6", bg: "rgba(59,130,246,0.12)" },
  LIVE: { color: "#10B981", bg: "rgba(16,185,129,0.12)" },
  ENDED: { color: "#888", bg: "rgba(120,120,120,0.14)" },
  CANCELLED: { color: "#EF4444", bg: "rgba(239,68,68,0.12)" },
};

const formatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kathmandu",
});

function formatScheduled(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : formatter.format(d);
}

export default function AdminLiveSessionsScreen() {
  const insets = useSafeAreaInsets();
  const { statusBarStyle, backgroundColor, iconColor, primaryColor } = useAppTheme();

  const [items, setItems] = useState<SessionData[]>(
    () => readCache<SessionData[]>("live-sessions") ?? [],
  );
  const [loading, setLoading] = useState(() => readCache("live-sessions") === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("ALL");

  const load = useCallback(async () => {
    try {
      const res = await api.get("/mobile/admin/live-sessions");
      const data = Array.isArray(res.data?.sessions) ? res.data.sessions : [];
      setItems(data);
      writeCache("live-sessions", data);
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Failed to load live sessions",
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

  const filtered = useMemo(() => {
    if (filter === "ALL") return items;
    return items.filter((s) => s.status === filter);
  }, [items, filter]);

  const openLink = useCallback(async (url: string | null) => {
    if (!url) return;
    const can = await Linking.canOpenURL(url);
    if (can) void Linking.openURL(url);
    else Toast.show({ type: "error", text1: "Can't open link", position: "bottom" });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: SessionData }) => {
      const meta = STATUS_META[item.status] ?? {
        color: iconColor,
        bg: "rgba(120,120,120,0.12)",
      };
      return (
        <View className="mb-3 rounded-2xl border border-border bg-card p-4">
          <View className="flex-row items-start justify-between">
            <View className="flex-1 pr-3">
              <Text
                className="text-[15px] font-semibold text-foreground"
                numberOfLines={2}
              >
                {item.title}
              </Text>
              <Text className="text-[12px] text-muted-foreground">
                {item.courseTitle}
              </Text>
            </View>
            <View
              className="rounded-full px-2 py-0.5"
              style={{ backgroundColor: meta.bg }}
            >
              <Text className="text-[11px] font-bold" style={{ color: meta.color }}>
                {item.status}
              </Text>
            </View>
          </View>

          <View className="mt-2 flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text className="text-[12px] text-muted-foreground">
              {item.instructorName}
            </Text>
            <Text className="text-[12px] text-muted-foreground">
              {formatScheduled(item.scheduledAt)}
            </Text>
            {item.durationMinutes ? (
              <Text className="text-[12px] text-muted-foreground">
                {formatDuration(item.durationMinutes)}
              </Text>
            ) : null}
          </View>

          <View className="mt-2 flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text className="text-[11px] text-muted-foreground">
              {item.notificationsSent
                ? `Notified +${item.notificationStats.sent}${
                    item.notificationStats.failed > 0
                      ? ` -${item.notificationStats.failed}`
                      : ""
                  }`
                : "Not notified"}
            </Text>
            <Text className="text-[11px] text-muted-foreground">
              {item.recordingUrl
                ? "Recording available"
                : item.status === "ENDED"
                  ? "Recording missing"
                  : ""}
            </Text>
          </View>

          {item.zoomLink || item.recordingUrl ? (
            <View className="mt-3 flex-row gap-2">
              {item.zoomLink ? (
                <TouchableOpacity
                  onPress={() => openLink(item.zoomLink)}
                  activeOpacity={0.85}
                  className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full border border-border py-2.5"
                >
                  <Ionicons name="videocam-outline" size={15} color={iconColor} />
                  <Text className="text-[12px] font-semibold text-foreground">
                    Join link
                  </Text>
                </TouchableOpacity>
              ) : null}
              {item.recordingUrl ? (
                <TouchableOpacity
                  onPress={() => openLink(item.recordingUrl)}
                  activeOpacity={0.85}
                  className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full border border-border py-2.5"
                >
                  <Ionicons name="play-circle-outline" size={15} color={iconColor} />
                  <Text className="text-[12px] font-semibold text-foreground">
                    Recording
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>
      );
    },
    [iconColor, openLink],
  );

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      <View
        className="border-b border-border px-5 pb-3"
        style={{ paddingTop: Math.max(insets.top + 8, 36) }}
      >
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
              Live Sessions
            </Text>
            <Text className="text-[12px] text-muted-foreground">
              {filtered.length} shown
            </Text>
          </View>
        </View>

        <View className="mt-3 flex-row flex-wrap gap-2">
          {(["ALL", ...STATUSES] as StatusFilter[]).map((f) => {
            const active = filter === f;
            return (
              <TouchableOpacity
                key={f}
                onPress={() => setFilter(f)}
                activeOpacity={0.85}
                className="rounded-full border px-3 py-1.5"
                style={{
                  borderColor: active ? primaryColor : "transparent",
                  backgroundColor: active ? `${primaryColor}1A` : "rgba(120,120,120,0.1)",
                }}
              >
                <Text
                  className="text-[12px] font-semibold"
                  style={{ color: active ? primaryColor : iconColor }}
                >
                  {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={primaryColor} size="large" />
        </View>
      ) : (
        <FlatList
          data={filtered}
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
              <Ionicons name="videocam-outline" size={40} color="#9CA3AF" />
              <Text className="mt-3 text-[14px] text-muted-foreground">
                No live sessions found.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}
