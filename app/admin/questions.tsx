import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Alert,
  StatusBar,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Toast from "react-native-toast-message";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppTheme } from "@/hooks/use-app-theme";
import { questionSummary } from "@/lib/question-summary";
import { api } from "@/lib/api";
import { getRequestErrorMessage } from "@/lib/server-response";
import { readCache, writeCache } from "@/lib/admin-cache";

type QuestionRecord = {
  _id: string;
  title: string;
  body: string;
  status: string;
  askerId: { _id: string; name: string; username: string } | null;
  createdAt: string;
};

function timeAgo(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function AdminQuestionsScreen() {
  const insets = useSafeAreaInsets();
  const { statusBarStyle, backgroundColor, iconColor, primaryColor } = useAppTheme();

  const [items, setItems] = useState<QuestionRecord[]>(
    () => readCache<QuestionRecord[]>("questions") ?? [],
  );
  const [loading, setLoading] = useState(() => readCache("questions") === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");
  const [username, setUsername] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async (title: string, user: string) => {
    try {
      const params = new URLSearchParams();
      if (title.trim()) params.set("q", title.trim());
      if (user.trim()) params.set("username", user.trim());
      const res = await api.get(`/mobile/admin/questions?${params.toString()}`);
      const data = Array.isArray(res.data) ? res.data : [];
      setItems(data);
      // Cache only the unfiltered default view that prefetch/seed relies on.
      if (!title.trim() && !user.trim()) writeCache("questions", data);
    } catch (err) {
      Toast.show({
        type: "error",
        text1: "Failed to load questions",
        text2: getRequestErrorMessage(err, "Please try again."),
        position: "bottom",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Debounced search on q / username changes
  useEffect(() => {
    const t = setTimeout(() => {
      if (firstLoad.current) firstLoad.current = false;
      void load(q, username);
    }, 450);
    return () => clearTimeout(t);
  }, [q, username, load]);

  const deleteQuestion = useCallback((question: QuestionRecord) => {
    Alert.alert("Delete question?", "This action cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setDeletingId(question._id);
          try {
            await api.delete(`/mobile/admin/questions/${question._id}`);
            setItems((prev) => prev.filter((x) => x._id !== question._id));
            Toast.show({
              type: "success",
              text1: "Question deleted",
              position: "bottom",
            });
          } catch (err) {
            Toast.show({
              type: "error",
              text1: "Failed to delete",
              text2: getRequestErrorMessage(err, "Please try again."),
              position: "bottom",
            });
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: QuestionRecord }) => {
      const open = item.status === "OPEN";
      return (
        <View className="mb-3 rounded-2xl border border-border bg-card p-4">
          <View className="flex-row items-start justify-between">
            <Text
              className="flex-1 pr-3 text-[15px] font-semibold text-foreground"
              numberOfLines={2}
            >
              {questionSummary(item)}
            </Text>
            <View
              className="rounded-full px-2 py-0.5"
              style={{
                backgroundColor: open ? "rgba(16,185,129,0.12)" : "rgba(59,130,246,0.12)",
              }}
            >
              <Text
                className="text-[11px] font-bold"
                style={{ color: open ? "#10B981" : "#3B82F6" }}
              >
                {item.status}
              </Text>
            </View>
          </View>

          {item.body ? (
            <Text className="mt-1 text-[13px] text-muted-foreground" numberOfLines={2}>
              {item.body}
            </Text>
          ) : null}

          <View className="mt-2 flex-row items-center justify-between">
            <Text className="text-[12px] text-muted-foreground">
              {item.askerId?.name ?? "Unknown"}
              {item.askerId?.username ? ` · @${item.askerId.username}` : ""}
            </Text>
            <Text className="text-[11px] text-muted-foreground">
              {timeAgo(item.createdAt)}
            </Text>
          </View>

          <TouchableOpacity
            onPress={() => deleteQuestion(item)}
            disabled={deletingId === item._id}
            activeOpacity={0.85}
            className="mt-3 flex-row items-center justify-center gap-1.5 rounded-full py-2.5"
            style={{ backgroundColor: "rgba(239,68,68,0.12)" }}
          >
            {deletingId === item._id ? (
              <ActivityIndicator color="#EF4444" />
            ) : (
              <>
                <Ionicons name="trash-outline" size={16} color="#EF4444" />
                <Text className="text-[13px] font-semibold" style={{ color: "#EF4444" }}>
                  Delete
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      );
    },
    [deletingId, deleteQuestion],
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
              Questions
            </Text>
            <Text className="text-[12px] text-muted-foreground">
              {items.length} found
            </Text>
          </View>
        </View>

        <View className="mt-3 flex-row items-center rounded-2xl border border-border bg-card px-3">
          <Ionicons name="search" size={18} color={iconColor} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search by title"
            placeholderTextColor="#6B7280"
            className="flex-1 px-2 py-3 text-[14px] text-foreground"
          />
        </View>
        <View className="mt-2 flex-row items-center rounded-2xl border border-border bg-card px-3">
          <Ionicons name="person-outline" size={18} color={iconColor} />
          <TextInput
            value={username}
            onChangeText={setUsername}
            placeholder="Filter by username"
            placeholderTextColor="#6B7280"
            autoCapitalize="none"
            className="flex-1 px-2 py-3 text-[14px] text-foreground"
          />
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
                void load(q, username);
              }}
              tintColor={primaryColor}
              colors={[primaryColor]}
            />
          }
          ListEmptyComponent={
            <View className="items-center justify-center py-20">
              <Ionicons name="help-circle-outline" size={40} color="#9CA3AF" />
              <Text className="mt-3 text-[14px] text-muted-foreground">
                No questions found.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}
