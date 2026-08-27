import { useCallback, useEffect, type ComponentProps } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";

import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import {
  markAllRead,
  markNotificationRead,
  selectIsNotificationsStale,
  setNotifications,
  setNotificationsError,
  setNotificationsLoading,
  setNotificationsRefreshing,
  type AppNotification,
} from "@/store/slices/notificationsSlice";

type IconName = ComponentProps<typeof Ionicons>["name"];

function iconForType(type: string): IconName {
  switch (type) {
    case "QUESTION_ACCEPTED":
    case "QUESTION_RESET":
    case "ANSWER_SUBMITTED":
    case "DEADLINE_WARNING":
    case "NEW_QUESTION_INTEREST":
      return "help-circle-outline";
    case "NEW_QUESTION_POSTED":
      return "add-circle-outline";
    case "REACTION_RECEIVED":
      return "heart-outline";
    case "COMMENT_RECEIVED":
    case "CHAT_MESSAGE":
      return "chatbubble-ellipses-outline";
    case "PROFILE_VIEWED":
      return "eye-outline";
    case "NEW_FOLLOWER":
      return "person-add-outline";
    case "CHANNEL_CLOSED":
    case "CHANNEL_EXPIRED":
      return "chatbubble-outline";
    case "PAYMENT":
    case "DAILY_TARGET_BONUS":
      return "cash-outline";
    case "RATING_RECEIVED":
      return "star-outline";
    case "COURSE_VIDEO_READY":
      return "videocam-outline";
    case "SYSTEM":
      return "megaphone-outline";
    default:
      return "notifications-outline";
  }
}

function formatTimeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const minutes = Math.max(1, Math.floor((Date.now() - t) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export default function NotificationsCenterScreen() {
  const dispatch = useAppDispatch();
  const {
    statusBarStyle,
    backgroundColor,
    cardColor,
    borderColor,
    primaryColor,
    primarySoftColor,
    mutedIconColor,
    isDark,
  } = useAppTheme();
  const userId = useAppSelector((s) => s.user.data?._id ?? null);
  const list = useAppSelector((s) => s.notifications.list);
  const unreadCount = useAppSelector((s) => s.notifications.unreadCount);
  const isLoading = useAppSelector((s) => s.notifications.isLoading);
  const isRefreshing = useAppSelector((s) => s.notifications.isRefreshing);
  const error = useAppSelector((s) => s.notifications.error);
  const lastFetchedAt = useAppSelector((s) => s.notifications.lastFetchedAt);
  const loadedForUserId = useAppSelector((s) => s.notifications.loadedForUserId);

  const loadNotifications = useCallback(
    async (force = false) => {
      if (!userId) return;
      const cacheMatchesUser = loadedForUserId === userId;
      const useCache =
        !force && cacheMatchesUser && !selectIsNotificationsStale(lastFetchedAt);
      if (useCache) return;

      if (force) {
        dispatch(setNotificationsRefreshing(true));
      } else if (!cacheMatchesUser || list.length === 0) {
        dispatch(setNotificationsLoading(true));
      }

      try {
        const res = await api.get("/notifications");
        const raw = Array.isArray(res.data) ? res.data : [];
        const normalized: AppNotification[] = raw.map((n: any) => ({
          id: String(n.id ?? n._id),
          type: String(n.type ?? "SYSTEM"),
          message: String(n.message ?? ""),
          href: n.href ?? null,
          isRead: Boolean(n.isRead),
          createdAt: n.createdAt ?? new Date().toISOString(),
        }));
        dispatch(setNotifications({ list: normalized, userId }));
      } catch (err: any) {
        const msg =
          err?.response?.data?.error ?? err?.message ?? "Couldn't load notifications.";
        dispatch(setNotificationsError(msg));
      } finally {
        dispatch(setNotificationsLoading(false));
        dispatch(setNotificationsRefreshing(false));
      }
    },
    [dispatch, userId, loadedForUserId, lastFetchedAt, list.length],
  );

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  const handleTap = useCallback(
    async (item: AppNotification) => {
      // Optimistic: mark read locally first. PATCH in the background.
      if (!item.isRead) {
        dispatch(markNotificationRead(item.id));
        api.patch(`/notifications/${item.id}`).catch((err: any) => {
          // Non-fatal — we'll re-sync on the next pull-to-refresh.
          console.warn("[notifications] mark-read failed:", err?.message);
        });
      }
      if (item.href) {
        router.push(item.href as any);
      }
    },
    [dispatch],
  );

  const handleMarkAllRead = useCallback(async () => {
    if (unreadCount === 0) return;
    dispatch(markAllRead());
    try {
      // The server uses POST /notifications/all (the [id] route catches "all").
      await api.post("/notifications/all");
    } catch (err: any) {
      console.warn("[notifications] mark-all failed:", err?.message);
      // Re-fetch to get the truth. The user already sees them as read locally
      // so the worst case is they refresh and a few flip back.
      void loadNotifications(true);
    }
  }, [dispatch, unreadCount, loadNotifications]);

  // Auto-mark all read after 2s of viewing the screen
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => {
        if (unreadCount > 0) {
          void handleMarkAllRead();
        }
      }, 2000);
      return () => clearTimeout(timer);
    }, [unreadCount, handleMarkAllRead]),
  );

  const renderItem = useCallback(
    ({ item }: { item: AppNotification }) => {
      const icon = iconForType(item.type);
      const time = formatTimeAgo(item.createdAt);
      return (
        <TouchableOpacity
          onPress={() => handleTap(item)}
          activeOpacity={0.7}
          style={{
            backgroundColor: cardColor,
            flexDirection: "row",
            alignItems: "flex-start",
            paddingHorizontal: 16,
            paddingVertical: 14,
            gap: 12,
          }}
        >
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              backgroundColor: item.isRead ? `${mutedIconColor}15` : primarySoftColor,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons
              name={icon}
              size={18}
              color={item.isRead ? mutedIconColor : primaryColor}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text
              numberOfLines={3}
              style={{
                fontSize: 14,
                lineHeight: 20,
                color: item.isRead ? mutedIconColor : isDark ? "#f1f5f9" : "#0f172a",
                fontWeight: item.isRead ? "400" : "600",
              }}
            >
              {item.message}
            </Text>
            <Text
              style={{
                fontSize: 11,
                color: mutedIconColor,
                marginTop: 4,
              }}
            >
              {time}
            </Text>
          </View>
          {!item.isRead ? (
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: primaryColor,
                marginTop: 6,
              }}
            />
          ) : null}
        </TouchableOpacity>
      );
    },
    [cardColor, mutedIconColor, primaryColor, primarySoftColor, isDark, handleTap],
  );

  const renderEmpty = useCallback(() => {
    if (isLoading) return null;
    return (
      <View
        style={{
          paddingVertical: 60,
          alignItems: "center",
          paddingHorizontal: 32,
        }}
      >
        <View
          style={{
            width: 60,
            height: 60,
            borderRadius: 16,
            backgroundColor: primarySoftColor,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 14,
          }}
        >
          <Ionicons name="notifications-outline" size={28} color={primaryColor} />
        </View>
        <Text className="text-center text-base font-semibold text-foreground">
          No notifications yet
        </Text>
        <Text className="mt-1.5 text-center text-sm text-muted-foreground">
          {error
            ? error
            : "Updates about your questions, payments, and platform notices will appear here."}
        </Text>
      </View>
    );
  }, [isLoading, error, primaryColor, primarySoftColor]);

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      {/* Header */}
      <View
        className="flex-row items-center justify-between border-b px-4 pb-3 pt-14"
        style={{ borderBottomColor: borderColor }}
      >
        <View className="flex-row items-center gap-3">
          <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color={primaryColor} />
          </TouchableOpacity>
          <View>
            <Text className="text-xl font-bold text-foreground">Notifications</Text>
            {unreadCount > 0 ? (
              <Text className="text-xs text-muted-foreground">{unreadCount} unread</Text>
            ) : null}
          </View>
        </View>

        <View className="flex-row items-center gap-2">
          {unreadCount > 0 ? (
            <TouchableOpacity
              onPress={handleMarkAllRead}
              className="rounded-full px-3 py-1.5"
              style={{ backgroundColor: primarySoftColor }}
            >
              <Text className="text-xs font-semibold" style={{ color: primaryColor }}>
                Mark all read
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => router.push("/settings/notifications" as any)}
            hitSlop={8}
          >
            <Ionicons name="settings-outline" size={20} color={primaryColor} />
          </TouchableOpacity>
        </View>
      </View>

      {isLoading && list.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={primaryColor} />
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: borderColor }} />
          )}
          ListEmptyComponent={renderEmpty}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => loadNotifications(true)}
              tintColor={primaryColor}
            />
          }
          contentContainerStyle={{ flexGrow: 1 }}
        />
      )}
    </View>
  );
}
