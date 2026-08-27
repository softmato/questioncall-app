import {
  View,
  Text,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  Image,
  TextInput,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import {
  setChannels,
  setChannelsLoading,
  setChannelsRefreshing,
  setChannelsError,
  selectIsChannelsStale,
} from "@/store/slices/channelsSlice";
import type { ChannelListItem } from "@/store/slices/channelsSlice";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useTabBarScroll } from "@/components/ui/bottom-chrome";
import Animated from "react-native-reanimated";
import { api } from "@/lib/api";

// ─── Time formatter ───────────────────────────────────────────
function formatChannelTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    const h = date.getHours();
    const m = date.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    return `${h % 12 || 12}:${m.toString().padStart(2, "0")} ${ampm}`;
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return date.toLocaleDateString("en-US", { weekday: "short" });
  return date.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

// ─── Last-active label (presence) ─────────────────────────────
// Returns "Active now" for an online counterpart, otherwise a relative
// "Active 5m ago" / "Active 2h ago" / "Active 3d ago" line.
function formatLastActive(isOnline?: boolean, lastActiveAt?: string): string | null {
  if (isOnline) return "Active now";
  if (!lastActiveAt) return null;
  const ts = new Date(lastActiveAt).getTime();
  if (Number.isNaN(ts)) return null;
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "Active now";
  if (mins < 60) return `Active ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Active ${days}d ago`;
  return null;
}

// ─── Channel row (messenger style) ───────────────────────────
function ChannelRow({
  item,
  primaryColor,
  primarySoftColor,
  mutedIconColor,
  borderColor,
  isDark,
}: {
  item: ChannelListItem;
  primaryColor: string;
  primarySoftColor: string;
  mutedIconColor: string;
  borderColor: string;
  isDark: boolean;
}) {
  const timeStr = formatChannelTime(item.lastMessageAt ?? item.timerDeadline);
  const hasUnread = item.unreadCount > 0;
  const isActive = item.status === "ACTIVE";
  const isOnline = !!item.counterpartIsOnline;
  const presenceLabel = formatLastActive(
    item.counterpartIsOnline,
    item.counterpartLastActiveAt,
  );

  // Preview line: last message or fallback
  const preview = item.lastMessagePreview
    ? item.lastMessagePreview
    : isActive
      ? "Channel opened"
      : item.status === "CLOSED"
        ? "Channel closed"
        : "Channel expired";

  return (
    <TouchableOpacity
      onPress={() => router.push(`/workspace/${item.id}` as any)}
      activeOpacity={0.55}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      {/* Avatar */}
      <View style={{ width: 54, height: 54, marginRight: 13 }}>
        {item.counterpartImage ? (
          <Image
            source={{ uri: item.counterpartImage }}
            style={{ width: 54, height: 54, borderRadius: 27 }}
            resizeMode="cover"
          />
        ) : (
          <View
            style={{
              width: 54,
              height: 54,
              borderRadius: 27,
              backgroundColor: primarySoftColor,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 20, fontWeight: "700", color: primaryColor }}>
              {(item.counterpartName ?? "?")[0].toUpperCase()}
            </Text>
          </View>
        )}
        {/* Presence: green dot when the counterpart is currently online */}
        {isOnline && (
          <View
            style={{
              position: "absolute",
              bottom: 2,
              right: 2,
              width: 13,
              height: 13,
              borderRadius: 7,
              backgroundColor: "#22c55e",
              borderWidth: 2,
              borderColor: isDark ? "#0f172a" : "#ffffff",
            }}
          />
        )}
      </View>

      {/* Text block */}
      <View style={{ flex: 1 }}>
        {/* Row 1: name + timestamp */}
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 3 }}>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontSize: 15,
              fontWeight: hasUnread ? "700" : "600",
              color: isDark ? "#f1f5f9" : "#0f172a",
              marginRight: 8,
            }}
          >
            {item.counterpartName}
          </Text>
          <Text
            style={{
              fontSize: 12,
              color: hasUnread ? primaryColor : mutedIconColor,
              fontWeight: hasUnread ? "600" : "400",
            }}
          >
            {timeStr}
          </Text>
        </View>

        {/* Row 2: question title + presence */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginBottom: 2,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontSize: 12,
              fontWeight: "500",
              color: "#64748b",
              marginRight: 8,
            }}
          >
            {item.questionTitle}
          </Text>
          {presenceLabel ? (
            <Text
              numberOfLines={1}
              style={{
                fontSize: 11,
                fontWeight: isOnline ? "600" : "400",
                color: isOnline ? "#22c55e" : mutedIconColor,
              }}
            >
              {presenceLabel}
            </Text>
          ) : null}
        </View>

        {/* Row 3: preview + status badges */}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontSize: 13,
              color: hasUnread ? (isDark ? "#e2e8f0" : "#111827") : mutedIconColor,
              fontWeight: hasUnread ? "500" : "400",
              marginRight: 8,
            }}
          >
            {preview}
          </Text>

          {/* Right-side badges */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            {/* Non-active status pill */}
            {!isActive && (
              <View
                style={{
                  borderRadius: 6,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  backgroundColor: item.status === "CLOSED" ? "#10b98118" : "#ef444418",
                }}
              >
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: "600",
                    color: item.status === "CLOSED" ? "#10b981" : "#ef4444",
                  }}
                >
                  {item.status === "CLOSED" ? "Closed" : "Expired"}
                </Text>
              </View>
            )}

            {/* Unread badge */}
            {hasUnread ? (
              <View
                style={{
                  minWidth: 20,
                  height: 20,
                  borderRadius: 10,
                  backgroundColor: primaryColor,
                  alignItems: "center",
                  justifyContent: "center",
                  paddingHorizontal: 5,
                }}
              >
                <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>
                  {item.unreadCount > 99 ? "99+" : item.unreadCount}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── Separator ────────────────────────────────────────────────
function Separator({ borderColor }: { borderColor: string }) {
  return (
    <View
      style={{ height: 0.5, marginLeft: 83, backgroundColor: borderColor, opacity: 0.5 }}
    />
  );
}

// ─── Main screen ──────────────────────────────────────────────
export default function ChannelsScreen() {
  const dispatch = useAppDispatch();
  const { onScroll, scrollEventThrottle, tabBarClearance } = useTabBarScroll();
  const insets = useSafeAreaInsets();
  const userId = useAppSelector((s) => s.user.data?._id ?? null);
  const { list, isLoading, isRefreshing, lastFetchedAt, loadedForUserId } =
    useAppSelector((s) => s.channels);
  const {
    statusBarStyle,
    backgroundColor,
    primaryColor,
    primarySoftColor,
    mutedIconColor,
    borderColor,
    isDark,
  } = useAppTheme();

  const [searchQuery, setSearchQuery] = useState("");

  const cacheMatchesUser = loadedForUserId === userId;
  const channels = cacheMatchesUser ? list : [];
  const shouldUseCache = cacheMatchesUser && !selectIsChannelsStale(lastFetchedAt);
  const showInitialSpinner = isLoading && channels.length === 0;

  const loadChannels = useCallback(
    async (force = false) => {
      if (!force && (isLoading || shouldUseCache)) return;
      if (list.length === 0) dispatch(setChannelsLoading(true));
      try {
        const res = await api.get("/channels");
        dispatch(
          setChannels({ channels: Array.isArray(res.data) ? res.data : [], userId }),
        );
      } catch {
        dispatch(setChannelsLoading(false));
        dispatch(setChannelsRefreshing(false));
      }
    },
    [dispatch, isLoading, shouldUseCache, userId, list.length],
  );

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  const handleRefresh = useCallback(async () => {
    dispatch(setChannelsRefreshing(true));
    await loadChannels(true);
  }, [dispatch, loadChannels]);

  const activeCount = channels.filter((c) => c.status === "ACTIVE").length;

  const filteredChannels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter(
      (c) =>
        c.counterpartName.toLowerCase().includes(q) ||
        c.questionTitle.toLowerCase().includes(q),
    );
  }, [channels, searchQuery]);

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      {/* ── Header ───────────────────────────────────────── */}
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingBottom: 14,
          paddingHorizontal: 16,
          backgroundColor,
          borderBottomWidth: 0.5,
          borderBottomColor: borderColor,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <View>
            <Text
              style={{
                fontSize: 26,
                fontWeight: "700",
                color: isDark ? "#f1f5f9" : "#0f172a",
              }}
            >
              Messages
            </Text>
            {activeCount > 0 && (
              <Text
                style={{
                  fontSize: 12,
                  color: primaryColor,
                  fontWeight: "500",
                  marginTop: 1,
                }}
              >
                {activeCount} active
              </Text>
            )}
          </View>
          <TouchableOpacity
            onPress={() => {
              dispatch(setChannelsRefreshing(true));
              void loadChannels(true);
            }}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: primarySoftColor,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="refresh-outline" size={18} color={primaryColor} />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Search bar ───────────────────────────────────── */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          backgroundColor,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: isDark ? "#1e293b" : "#f1f5f9",
            borderRadius: 12,
            paddingHorizontal: 12,
            height: 40,
          }}
        >
          <Ionicons
            name="search-outline"
            size={16}
            color={mutedIconColor}
            style={{ marginRight: 8 }}
          />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search"
            placeholderTextColor={mutedIconColor}
            style={{
              flex: 1,
              fontSize: 15,
              color: isDark ? "#f1f5f9" : "#0f172a",
              paddingVertical: 0,
            }}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery("")} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={mutedIconColor} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Content ──────────────────────────────────────── */}
      {showInitialSpinner ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={primaryColor} size="large" />
        </View>
      ) : filteredChannels.length === 0 ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 40,
          }}
        >
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              backgroundColor: primarySoftColor,
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 16,
            }}
          >
            <Ionicons name="chatbubbles-outline" size={32} color={primaryColor} />
          </View>
          <Text
            style={{
              fontSize: 18,
              fontWeight: "600",
              color: isDark ? "#f1f5f9" : "#0f172a",
              textAlign: "center",
              marginBottom: 8,
            }}
          >
            No messages yet
          </Text>
          <Text
            style={{
              fontSize: 14,
              color: mutedIconColor,
              textAlign: "center",
              lineHeight: 20,
            }}
          >
            {searchQuery
              ? "No channels match your search."
              : "Channels open when a teacher accepts your question. They appear here instantly."}
          </Text>
        </View>
      ) : (
        <Animated.FlatList
          data={filteredChannels}
          keyExtractor={(item, index) => `${item.id}-${index}`}
          renderItem={({ item }) => (
            <ChannelRow
              item={item}
              primaryColor={primaryColor}
              primarySoftColor={primarySoftColor}
              mutedIconColor={mutedIconColor}
              borderColor={borderColor}
              isDark={isDark}
            />
          )}
          ItemSeparatorComponent={() => <Separator borderColor={borderColor} />}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={primaryColor}
            />
          }
          // The tab bar floats over the list, so the list reserves its height.
          contentContainerStyle={{ paddingBottom: 16 + tabBarClearance }}
          onScroll={onScroll}
          scrollEventThrottle={scrollEventThrottle}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}
