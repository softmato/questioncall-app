import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Linking,
  Modal,
  RefreshControl,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { questionSummary } from "@/lib/question-summary";

import { useImageViewer } from "@/components/image-viewer/image-viewer-context";
import Toast from "react-native-toast-message";

import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import {
  normalizeFeedQuestions,
  removeQuestion,
  setMyQuestions,
} from "@/store/slices/feedSlice";
import type { Note } from "@/store/slices/notesSlice";
import type { FeedQuestion } from "@/types/question";

type Tab = "questions" | "uploads";

// ─── helpers ──────────────────────────────────────────────────────────────

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ─── Delete confirmation modal ─────────────────────────────────────────────

function DeleteModal({
  visible,
  onCancel,
  onConfirm,
  isDeleting,
}: {
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
}) {
  const { primaryColor, cardColor, borderColor } = useAppTheme();
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          useNativeDriver: true,
          tension: 120,
          friction: 8,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      scaleAnim.setValue(0.9);
      opacityAnim.setValue(0);
    }
  }, [visible]);

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onCancel}>
      <TouchableWithoutFeedback onPress={onCancel}>
        <View
          className="flex-1 items-center justify-center"
          style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
        >
          <TouchableWithoutFeedback>
            <Animated.View
              style={{
                transform: [{ scale: scaleAnim }],
                opacity: opacityAnim,
                backgroundColor: cardColor,
                borderColor,
                borderWidth: 1,
                borderRadius: 20,
                width: 300,
                padding: 24,
              }}
            >
              {/* Icon */}
              <View
                className="mb-4 h-14 w-14 items-center justify-center self-center rounded-full"
                style={{ backgroundColor: "rgba(239,68,68,0.1)" }}
              >
                <Ionicons name="trash-outline" size={28} color="#EF4444" />
              </View>

              <Text className="mb-1.5 text-center text-[17px] font-bold text-foreground">
                Delete Question?
              </Text>
              <Text className="mb-6 text-center text-sm leading-5 text-muted-foreground">
                This will permanently remove your question and cannot be undone.
              </Text>

              {/* Buttons */}
              <TouchableOpacity
                onPress={onConfirm}
                disabled={isDeleting}
                activeOpacity={0.8}
                className="mb-2.5 items-center rounded-xl py-3"
                style={{ backgroundColor: "#EF4444" }}
              >
                {isDeleting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text className="text-sm font-bold text-white">Yes, Delete</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={onCancel}
                disabled={isDeleting}
                activeOpacity={0.8}
                className="items-center rounded-xl py-3"
                style={{ backgroundColor: borderColor }}
              >
                <Text className="text-sm font-semibold text-foreground">Cancel</Text>
              </TouchableOpacity>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// ─── Question card ─────────────────────────────────────────────────────────

const NOTE_TYPE_CONFIG: Record<string, { color: string; icon: string }> = {
  PDF: { color: "#EF4444", icon: "document-text" },
  DOCX: { color: "#3B82F6", icon: "document" },
  PPT: { color: "#F59E0B", icon: "easel" },
  Image: { color: "#8B5CF6", icon: "image" },
};

function StatusBadge({ status }: { status: string }) {
  const answered = status === "ACCEPTED" || status === "SOLVED";
  return (
    <View
      className="rounded-full px-2.5 py-0.5"
      style={{
        backgroundColor: answered ? "rgba(34,197,94,0.12)" : "rgba(234,179,8,0.12)",
      }}
    >
      <Text
        className="text-[10px] font-semibold"
        style={{ color: answered ? "#22c55e" : "#ca8a04" }}
      >
        {answered ? "Answered" : "Waiting"}
      </Text>
    </View>
  );
}

function QuestionCard({
  item,
  onImagePress,
  onDelete,
}: {
  item: FeedQuestion;
  onImagePress: (uri: string) => void;
  onDelete: () => void;
}) {
  const { cardColor, borderColor, primaryColor, mutedIconColor } = useAppTheme();
  const answered = item.status === "ACCEPTED" || item.status === "SOLVED";

  return (
    <View
      className="mb-3 overflow-hidden rounded-2xl border"
      style={{ backgroundColor: cardColor, borderColor }}
    >
      {/* Status accent bar */}
      <View
        style={{
          height: 3,
          backgroundColor: answered ? "rgba(34,197,94,0.4)" : "rgba(234,179,8,0.4)",
        }}
      />

      <View className="px-4 pb-4 pt-3">
        {/* Title + badge */}
        <View className="mb-2.5 flex-row items-start justify-between gap-2">
          <Text className="flex-1 text-[15px] font-semibold leading-snug text-foreground">
            {questionSummary(item)}
          </Text>
          <StatusBadge status={item.status} />
        </View>

        {/* Question body */}
        {item.body ? (
          <Text className="mb-3 text-sm leading-5 text-muted-foreground">
            {item.body}
          </Text>
        ) : null}

        {/* Attached images — tap opens global viewer */}
        {item.images && item.images.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, marginBottom: 12 }}
          >
            {item.images.map((uri, idx) => (
              <TouchableOpacity
                key={`${uri}-${idx}`}
                activeOpacity={0.85}
                onPress={() => onImagePress(uri)}
              >
                <Image
                  source={{ uri }}
                  style={{ width: 80, height: 80, borderRadius: 10 }}
                  resizeMode="cover"
                />
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}

        {/* Full answer block */}
        {item.answer?.content ? (
          <View
            className="mb-3 rounded-xl px-3 py-3"
            style={{ backgroundColor: `${primaryColor}0D` }}
          >
            <View className="mb-1.5 flex-row items-center gap-1.5">
              <Ionicons name="checkmark-circle" size={13} color={primaryColor} />
              <Text
                className="text-[10px] font-bold uppercase tracking-wider"
                style={{ color: primaryColor }}
              >
                Answer
              </Text>
              {item.answer.acceptorName ? (
                <Text className="ml-auto text-[10px] text-muted-foreground">
                  by {item.answer.acceptorName}
                </Text>
              ) : null}
            </View>
            {/* Full answer text — no line clamp */}
            <Text className="text-[13px] leading-5 text-foreground">
              {item.answer.content}
            </Text>
            {/* Answer media — tap opens global viewer */}
            {item.answer.mediaUrls && item.answer.mediaUrls.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, marginTop: 8 }}
              >
                {item.answer.mediaUrls.map((uri, idx) => (
                  <TouchableOpacity
                    key={`ans-${uri}-${idx}`}
                    activeOpacity={0.85}
                    onPress={() => onImagePress(uri)}
                  >
                    <Image
                      source={{ uri }}
                      style={{ width: 80, height: 80, borderRadius: 10 }}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            ) : null}
          </View>
        ) : !answered ? (
          <View
            className="mb-3 flex-row items-center gap-2 rounded-xl px-3 py-2.5"
            style={{ backgroundColor: "rgba(234,179,8,0.08)" }}
          >
            <Ionicons name="time-outline" size={14} color="#ca8a04" />
            <Text className="text-xs text-muted-foreground">
              Waiting for a teacher to answer…
            </Text>
          </View>
        ) : null}

        {/* Footer row */}
        <View className="flex-row items-center gap-2.5 border-t border-border pt-2.5">
          {item.subject ? (
            <View
              className="rounded-full px-2 py-0.5"
              style={{ backgroundColor: `${primaryColor}18` }}
            >
              <Text className="text-[10px] font-semibold" style={{ color: primaryColor }}>
                {item.subject}
              </Text>
            </View>
          ) : null}
          <View className="flex-row items-center gap-1">
            <Ionicons name="chatbubble-outline" size={12} color={mutedIconColor} />
            <Text className="text-[11px] text-muted-foreground">{item.answerCount}</Text>
          </View>
          <View className="flex-row items-center gap-1">
            <Ionicons name="heart-outline" size={12} color={mutedIconColor} />
            <Text className="text-[11px] text-muted-foreground">
              {item.reactionCount}
            </Text>
          </View>
          <Text className="text-[11px] text-muted-foreground">
            {formatDate(item.createdAt)}
          </Text>
          <TouchableOpacity
            onPress={onDelete}
            activeOpacity={0.7}
            hitSlop={8}
            className="ml-auto h-7 w-7 items-center justify-center rounded-full"
            style={{ backgroundColor: "rgba(239,68,68,0.1)" }}
          >
            <Ionicons name="trash-outline" size={14} color="#EF4444" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── Note card ─────────────────────────────────────────────────────────────

function NoteCard({ note }: { note: Note }) {
  const { cardColor, borderColor, primaryColor, mutedIconColor } = useAppTheme();
  const cfg = NOTE_TYPE_CONFIG[note.fileType] ?? NOTE_TYPE_CONFIG.PDF;

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={() => {
        if (note.fileUrl) Linking.openURL(note.fileUrl);
      }}
      disabled={!note.fileUrl}
      className="mb-3 overflow-hidden rounded-2xl border"
      style={{ backgroundColor: cardColor, borderColor }}
    >
      <View style={{ height: 3, backgroundColor: `${cfg.color}30` }} />
      <View className="p-4">
        <View className="flex-row items-start">
          <View
            className="mr-3 h-11 w-11 items-center justify-center rounded-xl"
            style={{ backgroundColor: `${cfg.color}18` }}
          >
            <Ionicons name={cfg.icon as any} size={22} color={cfg.color} />
          </View>
          <View className="flex-1">
            <Text
              className="text-[15px] font-semibold leading-tight text-foreground"
              numberOfLines={2}
            >
              {note.title}
            </Text>
            <View className="mt-1 flex-row flex-wrap items-center gap-1.5">
              <View
                className="rounded-full px-2 py-0.5"
                style={{ backgroundColor: `${primaryColor}18` }}
              >
                <Text
                  className="text-[10px] font-semibold"
                  style={{ color: primaryColor }}
                >
                  {note.subject}
                </Text>
              </View>
              <View className="rounded-full bg-secondary px-2 py-0.5">
                <Text className="text-[10px] text-muted-foreground">{note.grade}</Text>
              </View>
              <View
                className="rounded-full px-2 py-0.5"
                style={{ backgroundColor: `${cfg.color}18` }}
              >
                <Text className="text-[10px] font-semibold" style={{ color: cfg.color }}>
                  {note.fileType}
                </Text>
              </View>
            </View>
          </View>
          <View className="ml-2 h-9 w-9 items-center justify-center rounded-xl bg-secondary">
            <Ionicons
              name={note.fileUrl ? "open-outline" : "document-outline"}
              size={17}
              color={note.fileUrl ? primaryColor : mutedIconColor}
            />
          </View>
        </View>

        {note.description ? (
          <Text
            className="mt-2 text-xs leading-4 text-muted-foreground"
            numberOfLines={2}
          >
            {note.description}
          </Text>
        ) : null}

        <Text className="mt-3 border-t border-border pt-2.5 text-[10px] text-muted-foreground">
          Uploaded {formatDate(note.createdAt)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────

export default function MyQuestionsScreen() {
  const dispatch = useAppDispatch();
  const user = useAppSelector((s) => s.user.data);
  const myQuestions = useAppSelector((s) => s.feed.myQuestions);
  const { openImageViewer } = useImageViewer();
  const {
    statusBarStyle,
    backgroundColor,
    primaryColor,
    primarySoftColor,
    borderColor,
    mutedIconColor,
    cardColor,
  } = useAppTheme();

  const [activeTab, setActiveTab] = useState<Tab>("questions");
  const [search, setSearch] = useState("");

  // Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Questions state
  const [isLoadingQ, setIsLoadingQ] = useState(false);
  const [isRefreshingQ, setIsRefreshingQ] = useState(false);

  // Uploads (notes) state
  const [notes, setNotes] = useState<Note[]>([]);
  const [isLoadingN, setIsLoadingN] = useState(false);
  const [isRefreshingN, setIsRefreshingN] = useState(false);

  // ── Fetch questions ──────────────────────────────────────────────────────

  const fetchMyQuestions = useCallback(
    async (force = false) => {
      if (!force && myQuestions.length > 0) return;
      if (myQuestions.length === 0) setIsLoadingQ(true);
      try {
        const res = await api.get("/questions/feed?limit=50");
        const raw = res.data?.questions ?? res.data ?? [];
        const normalized = normalizeFeedQuestions(raw) as FeedQuestion[];
        const mine = normalized.filter((q) => q.askerId === user?._id);
        dispatch(setMyQuestions(mine));
      } catch (err) {
        console.error("[MyQuestions] fetch failed:", err);
      } finally {
        setIsLoadingQ(false);
        setIsRefreshingQ(false);
      }
    },
    [dispatch, myQuestions.length, user?._id],
  );

  // ── Fetch notes ──────────────────────────────────────────────────────────

  const fetchMyNotes = useCallback(
    async (force = false) => {
      if (!force && notes.length > 0) return;
      if (notes.length === 0) setIsLoadingN(true);
      try {
        const res = await api.get("/notes?uploaderOnly=true&limit=50");
        setNotes(Array.isArray(res.data) ? res.data : []);
      } catch (err) {
        console.error("[MyNotes] fetch failed:", err);
      } finally {
        setIsLoadingN(false);
        setIsRefreshingN(false);
      }
    },
    [notes.length],
  );

  useEffect(() => {
    void fetchMyQuestions();
    void fetchMyNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Filtered data ────────────────────────────────────────────────────────

  const q = search.trim().toLowerCase();
  const filteredQuestions = q
    ? myQuestions.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          (item.body ?? "").toLowerCase().includes(q) ||
          (item.subject ?? "").toLowerCase().includes(q),
      )
    : myQuestions;

  const filteredNotes = q
    ? notes.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.subject.toLowerCase().includes(q) ||
          n.grade.toLowerCase().includes(q),
      )
    : notes;

  // ── Delete question ──────────────────────────────────────────────────────

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await api.delete(`/questions/${deleteTarget}`);
      dispatch(removeQuestion(deleteTarget));
    } catch (err) {
      console.error("[MyQuestions] delete failed:", err);
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, dispatch]);

  // ── Render ───────────────────────────────────────────────────────────────

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "questions", label: "Questions", count: myQuestions.length },
    { key: "uploads", label: "Uploads", count: notes.length },
  ];

  return (
    <View className="flex-1 bg-background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      <DeleteModal
        visible={deleteTarget !== null}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        isDeleting={isDeleting}
      />

      {/* Header */}
      <View
        style={{ borderBottomWidth: 1, borderBottomColor: borderColor, backgroundColor }}
      >
        <View className="flex-row items-center gap-3 px-4 pb-3 pt-14">
          <TouchableOpacity
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-full bg-secondary"
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-back" size={20} color={primaryColor} />
          </TouchableOpacity>
          <Text className="text-[18px] font-bold text-foreground">My Activity</Text>
        </View>

        {/* Search bar */}
        <View className="px-4 pb-3">
          <View
            className="flex-row items-center rounded-xl border px-3 py-2.5"
            style={{ borderColor, backgroundColor: cardColor }}
          >
            <Ionicons name="search-outline" size={16} color={mutedIconColor} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={
                activeTab === "questions" ? "Search questions…" : "Search uploads…"
              }
              placeholderTextColor={mutedIconColor}
              className="ml-2 flex-1 text-sm text-foreground"
              returnKeyType="search"
              autoCorrect={false}
            />
            {search.length > 0 ? (
              <TouchableOpacity onPress={() => setSearch("")} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={mutedIconColor} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {/* Tabs */}
        <View className="flex-row px-4 pb-0">
          {tabs.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                activeOpacity={0.8}
                className="mr-5 pb-3"
                style={{
                  borderBottomWidth: 2,
                  borderBottomColor: active ? primaryColor : "transparent",
                }}
              >
                <View className="flex-row items-center gap-1.5">
                  <Text
                    className="text-[14px] font-semibold"
                    style={{ color: active ? primaryColor : mutedIconColor }}
                  >
                    {tab.label}
                  </Text>
                  {tab.count > 0 ? (
                    <View
                      className="rounded-full px-1.5 py-0.5"
                      style={{
                        backgroundColor: active
                          ? primarySoftColor
                          : `${mutedIconColor}22`,
                      }}
                    >
                      <Text
                        className="text-[10px] font-bold"
                        style={{ color: active ? primaryColor : mutedIconColor }}
                      >
                        {tab.count}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Questions tab */}
      {activeTab === "questions" ? (
        isLoadingQ ? (
          <View className="mt-24 items-center">
            <ActivityIndicator size="large" color={primaryColor} />
            <Text className="mt-3 text-sm text-muted-foreground">
              Loading your questions…
            </Text>
          </View>
        ) : (
          <FlatList
            data={filteredQuestions}
            keyExtractor={(item) => item.id ?? item.createdAt}
            renderItem={({ item }) => (
              <QuestionCard
                item={item}
                onImagePress={openImageViewer}
                onDelete={() => setDeleteTarget(item.id ?? (item as any)._id ?? "")}
              />
            )}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 48,
            }}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshingQ}
                onRefresh={() => {
                  setIsRefreshingQ(true);
                  void fetchMyQuestions(true);
                }}
                tintColor={primaryColor}
                colors={[primaryColor]}
              />
            }
            ListEmptyComponent={
              <View className="mt-28 items-center px-8">
                <Ionicons name="help-circle-outline" size={56} color={mutedIconColor} />
                <Text className="mt-4 text-[17px] font-semibold text-muted-foreground">
                  No questions yet
                </Text>
                <Text className="mt-1 text-center text-sm leading-5 text-muted-foreground">
                  Questions you post will appear here along with the full answers you
                  received.
                </Text>
                <TouchableOpacity
                  onPress={() => router.push("/ask" as any)}
                  className="mt-6 rounded-full px-8 py-3"
                  style={{ backgroundColor: primaryColor }}
                  activeOpacity={0.85}
                >
                  <Text className="text-sm font-bold text-white">Ask a Question</Text>
                </TouchableOpacity>
              </View>
            }
          />
        )
      ) : null}

      {/* Uploads tab */}
      {activeTab === "uploads" ? (
        isLoadingN ? (
          <View className="mt-24 items-center">
            <ActivityIndicator size="large" color={primaryColor} />
            <Text className="mt-3 text-sm text-muted-foreground">
              Loading your uploads…
            </Text>
          </View>
        ) : (
          <FlatList
            data={filteredNotes}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <NoteCard note={item} />}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 48,
            }}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshingN}
                onRefresh={() => {
                  setIsRefreshingN(true);
                  void fetchMyNotes(true);
                }}
                tintColor={primaryColor}
                colors={[primaryColor]}
              />
            }
            ListEmptyComponent={
              <View className="mt-28 items-center px-8">
                <Ionicons name="cloud-upload-outline" size={56} color={mutedIconColor} />
                <Text className="mt-4 text-[17px] font-semibold text-muted-foreground">
                  No uploads yet
                </Text>
                <Text className="mt-1 text-center text-sm leading-5 text-muted-foreground">
                  Notes and files you upload will appear here.
                </Text>
                <TouchableOpacity
                  onPress={() => router.push("/notes" as any)}
                  className="mt-6 rounded-full px-8 py-3"
                  style={{ backgroundColor: primaryColor }}
                  activeOpacity={0.85}
                >
                  <Text className="text-sm font-bold text-white">Upload a Note</Text>
                </TouchableOpacity>
              </View>
            }
          />
        )
      ) : null}
    </View>
  );
}
