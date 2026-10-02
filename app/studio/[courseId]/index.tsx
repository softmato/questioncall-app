import { formatDuration } from "@/lib/duration";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { router, useLocalSearchParams } from "expo-router";
import Toast from "react-native-toast-message";

import { AcademicSuggestionInput } from "@/components/ui/academic-suggestion-input";
import { LEVEL_OPTIONS, SUBJECT_OPTIONS } from "@/constants/academic-options";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { startCourseVideoUpload } from "@/lib/upload-manager";
import { BottomSheetSurface } from "@/components/ui/bottom-sheet-surface";

// ── Types ───────────────────────────────────────────────────────────────────

type CourseStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
type PricingModel = "FREE" | "SUBSCRIPTION_INCLUDED" | "PAID";

type CourseVideo = {
  _id: string;
  title: string;
  status: "PROCESSING" | "READY" | "ERRORED";
  durationMinutes: number;
  viewCount: number;
  source?: string;
};

type CourseSection = {
  _id: string;
  title: string;
  order: number;
  videos: CourseVideo[];
};

type CourseDetail = {
  _id: string;
  title: string;
  description: string;
  subject: string;
  level: string;
  status: CourseStatus;
  pricingModel: PricingModel;
  price: number | null;
  freePreviewCount: number;
  enrollmentCount: number;
  totalDurationMinutes: number;
  slug: string;
};

type VideoMethod = "ZOOM_LINK" | "FILE_UPLOAD";
type Tab = "curriculum" | "settings" | "analytics";

const STATUSES: CourseStatus[] = ["DRAFT", "ACTIVE", "COMPLETED", "ARCHIVED"];

function StatusPill({ status }: { status: CourseStatus }) {
  const c: Record<CourseStatus, { bg: string; text: string }> = {
    DRAFT: { bg: "rgba(148,163,184,0.15)", text: "#94a3b8" },
    ACTIVE: { bg: "rgba(34,197,94,0.12)", text: "#22c55e" },
    COMPLETED: { bg: "rgba(59,130,246,0.12)", text: "#3b82f6" },
    ARCHIVED: { bg: "rgba(239,68,68,0.12)", text: "#ef4444" },
  };
  return (
    <View
      style={{
        backgroundColor: c[status].bg,
        borderRadius: 20,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "700", color: c[status].text }}>
        {status}
      </Text>
    </View>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function ManageCourseScreen() {
  const { courseId } = useLocalSearchParams<{ courseId: string }>();
  const {
    statusBarStyle,
    backgroundColor,
    primaryColor,
    primarySoftColor,
    cardColor,
    borderColor,
    mutedIconColor,
    isDark,
  } = useAppTheme();

  const [tab, setTab] = useState<Tab>("curriculum");
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [sections, setSections] = useState<CourseSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Curriculum state ──
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [showAddSection, setShowAddSection] = useState(false);
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [addingSectionLoading, setAddingSectionLoading] = useState(false);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editSectionTitle, setEditSectionTitle] = useState("");

  // ── Add video modal state ──
  const [showAddVideo, setShowAddVideo] = useState(false);
  const [addVideoSectionId, setAddVideoSectionId] = useState<string | null>(null);
  const [videoMethod, setVideoMethod] = useState<VideoMethod>("ZOOM_LINK");
  const [videoTitle, setVideoTitle] = useState("");
  const [zoomLink, setZoomLink] = useState("");
  const [pickedFileName, setPickedFileName] = useState("");
  const pickedFileUriRef = useRef<string | null>(null);
  const pickedFileSizeRef = useRef<number>(0);
  const [isAddingVideo, setIsAddingVideo] = useState(false);

  // File-upload videos run in the background via the global upload manager,
  // which keeps polling even after this screen unmounts. We only want to
  // auto-refresh the curriculum if the teacher is still here.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Live background uploads for THIS course, so the matching curriculum row can
  // show "Uploading… X%" / "Processing…" instead of a bare "Processing…".
  const allUploads = useAppSelector((s) => s.upload.uploads);
  const activeCourseUploads = useMemo(
    () =>
      allUploads.filter(
        (u) =>
          u.courseId === courseId && (u.status === "pending" || u.status === "uploading"),
      ),
    [allUploads, courseId],
  );
  const findActiveUpload = useCallback(
    (sectionId: string, title: string) =>
      activeCourseUploads.find(
        (u) => u.sectionId === sectionId && (u.videoTitle ?? "").trim() === title.trim(),
      ),
    [activeCourseUploads],
  );

  // ── Settings form state ──
  const [settingsForm, setSettingsForm] = useState({
    title: "",
    description: "",
    subject: "",
    level: "",
    status: "DRAFT" as CourseStatus,
    pricingModel: "FREE" as PricingModel,
    price: "",
    freePreviewCount: "0",
  });
  const [isSaving, setIsSaving] = useState(false);

  // ─── Fetch data ─────────────────────────────────────────────────────────

  const fetchData = useCallback(
    async (silent = false) => {
      if (!courseId) return;
      if (!silent) setLoading(true);
      try {
        const [courseRes, sectionsRes] = await Promise.all([
          api.get(`/courses/${courseId}`),
          api.get(`/courses/${courseId}/sections`),
        ]);

        const found: CourseDetail | null = courseRes.data ?? null;
        setCourse(found);
        if (found) {
          setSettingsForm({
            title: found.title,
            description: found.description,
            subject: found.subject,
            level: found.level,
            status: found.status,
            pricingModel: found.pricingModel,
            price: found.price != null ? String(found.price) : "",
            freePreviewCount: String(found.freePreviewCount ?? 0),
          });
        }

        const fetchedSections: CourseSection[] = sectionsRes.data?.sections ?? [];
        setSections(fetchedSections.sort((a, b) => a.order - b.order));
      } catch {
        Toast.show({ type: "error", text1: "Failed to load course data" });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [courseId],
  );

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const totalVideos = sections.reduce((s, sec) => s + (sec.videos?.length ?? 0), 0);

  // ─── Section actions ────────────────────────────────────────────────────

  const handleAddSection = async () => {
    if (!newSectionTitle.trim()) return;
    setAddingSectionLoading(true);
    try {
      const res = await api.post(`/courses/${courseId}/sections`, {
        title: newSectionTitle.trim(),
      });
      setSections((prev) => [...prev, { ...res.data, videos: [] }]);
      setNewSectionTitle("");
      setShowAddSection(false);
      Toast.show({ type: "success", text1: "Section added" });
    } catch {
      Toast.show({ type: "error", text1: "Failed to add section" });
    } finally {
      setAddingSectionLoading(false);
    }
  };

  const handleRenameSection = async (sectionId: string) => {
    if (!editSectionTitle.trim()) return;
    try {
      await api.patch(`/courses/${courseId}/sections/${sectionId}`, {
        title: editSectionTitle.trim(),
      });
      setSections((prev) =>
        prev.map((s) =>
          s._id === sectionId ? { ...s, title: editSectionTitle.trim() } : s,
        ),
      );
      setEditingSectionId(null);
      Toast.show({ type: "success", text1: "Section renamed" });
    } catch {
      Toast.show({ type: "error", text1: "Failed to rename section" });
    }
  };

  const handleDeleteSection = (sectionId: string, sectionTitle: string) => {
    Alert.alert(
      "Delete section?",
      `"${sectionTitle}" and all its videos will be permanently deleted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await api.delete(`/courses/${courseId}/sections/${sectionId}`);
              setSections((prev) => prev.filter((s) => s._id !== sectionId));
              Toast.show({ type: "success", text1: "Section deleted" });
            } catch {
              Toast.show({ type: "error", text1: "Failed to delete section" });
            }
          },
        },
      ],
    );
  };

  const handleDeleteVideo = (videoId: string, videoTitle: string) => {
    Alert.alert("Delete video?", `"${videoTitle}" will be permanently deleted.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.delete(`/courses/${courseId}/videos/${videoId}`);
            setSections((prev) =>
              prev.map((s) => ({
                ...s,
                videos: s.videos.filter((v) => v._id !== videoId),
              })),
            );
            Toast.show({ type: "success", text1: "Video deleted" });
          } catch {
            Toast.show({ type: "error", text1: "Failed to delete video" });
          }
        },
      },
    ]);
  };

  const toggleSection = (id: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // ─── Add video ──────────────────────────────────────────────────────────

  const openAddVideo = (sectionId: string) => {
    setAddVideoSectionId(sectionId);
    setVideoMethod("ZOOM_LINK");
    setVideoTitle("");
    setZoomLink("");
    setPickedFileName("");
    pickedFileUriRef.current = null;
    setShowAddVideo(true);
  };

  const handlePickVideo = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "video/*",
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    pickedFileUriRef.current = asset.uri;
    pickedFileSizeRef.current = asset.size ?? 0;
    const autoTitle = asset.name.replace(/\.[^.]+$/, "");
    if (!videoTitle.trim()) setVideoTitle(autoTitle);
    setPickedFileName(asset.name);
  };

  const handleAddVideoSubmit = async () => {
    if (!videoTitle.trim()) {
      Toast.show({ type: "error", text1: "Enter a video title" });
      return;
    }
    if (!addVideoSectionId) {
      Toast.show({ type: "error", text1: "No section selected" });
      return;
    }

    if (videoMethod === "FILE_UPLOAD") {
      if (!pickedFileUriRef.current) {
        Toast.show({ type: "error", text1: "Pick a video file first" });
        return;
      }
      // Hand off to the background upload manager and close the sheet right
      // away — the teacher can navigate anywhere and gets a push + in-app
      // notification once Mux finishes processing.
      startCourseVideoUpload({
        courseId: courseId!,
        sectionId: addVideoSectionId,
        title: videoTitle.trim(),
        file: {
          uri: pickedFileUriRef.current,
          name: pickedFileName || `${videoTitle.trim()}.mp4`,
          mimeType: "video/mp4",
          size: pickedFileSizeRef.current,
        },
        // Refresh so the PROCESSING placeholder row appears immediately.
        onCreated: () => {
          if (isMountedRef.current) void fetchData(true);
        },
        // Refresh once it's READY so the curriculum shows it as playable.
        onReady: () => {
          if (isMountedRef.current) void fetchData(true);
        },
      });
      Toast.show({
        type: "info",
        text1: "Uploading in background",
        text2: "Keep using the app — we'll notify you when it's ready.",
      });
      setShowAddVideo(false);
      return;
    }

    // Zoom link
    if (!zoomLink.trim()) {
      Toast.show({ type: "error", text1: "Enter a Zoom recording URL" });
      return;
    }
    setIsAddingVideo(true);
    try {
      await api.post(`/courses/${courseId}/videos`, {
        title: videoTitle.trim(),
        sectionId: addVideoSectionId,
        zoomRecordingUrl: zoomLink.trim(),
        source: "ZOOM_LINK",
      });
      Toast.show({ type: "success", text1: "Zoom link saved!" });
      setShowAddVideo(false);
      void fetchData(true);
    } catch (err: any) {
      Toast.show({
        type: "error",
        text1: err?.response?.data?.error ?? "Failed to save link",
      });
    } finally {
      setIsAddingVideo(false);
    }
  };

  // ─── Settings save ──────────────────────────────────────────────────────

  const handleSaveSettings = async () => {
    setIsSaving(true);
    try {
      const res = await api.patch(`/courses/${courseId}`, {
        title: settingsForm.title.trim(),
        description: settingsForm.description.trim(),
        subject: settingsForm.subject.trim(),
        level: settingsForm.level.trim(),
        status: settingsForm.status,
        pricingModel: settingsForm.pricingModel,
        price: settingsForm.pricingModel === "PAID" ? Number(settingsForm.price) : null,
        freePreviewCount:
          settingsForm.pricingModel === "FREE"
            ? 0
            : Number(settingsForm.freePreviewCount) || 0,
      });
      setCourse((prev) => (prev ? { ...prev, ...res.data } : prev));
      Toast.show({ type: "success", text1: "Course settings saved!" });
    } catch (err: any) {
      Toast.show({
        type: "error",
        text1: err?.response?.data?.error ?? "Failed to save",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Render tabs ────────────────────────────────────────────────────────

  const renderCurriculumTab = () => (
    <View style={{ flex: 1 }}>
      {/* Add section inline form */}
      {showAddSection ? (
        <View
          style={{
            margin: 16,
            backgroundColor: `${primaryColor}10`,
            borderRadius: 14,
            padding: 14,
            borderWidth: 1,
            borderColor: `${primaryColor}30`,
          }}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: isDark ? "#cbd5e1" : "#475569",
              marginBottom: 8,
            }}
          >
            Section Title
          </Text>
          <TextInput
            value={newSectionTitle}
            onChangeText={setNewSectionTitle}
            placeholder="e.g. Introduction to the Course"
            placeholderTextColor={mutedIconColor}
            autoFocus
            style={{
              borderWidth: 1,
              borderColor,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              fontSize: 14,
              color: isDark ? "#f1f5f9" : "#0f172a",
              backgroundColor: cardColor,
            }}
          />
          <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
            <TouchableOpacity
              onPress={() => void handleAddSection()}
              disabled={!newSectionTitle.trim() || addingSectionLoading}
              style={{
                flex: 1,
                alignItems: "center",
                paddingVertical: 10,
                borderRadius: 10,
                backgroundColor: newSectionTitle.trim()
                  ? primaryColor
                  : `${primaryColor}40`,
              }}
            >
              {addingSectionLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                  Add Section
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setShowAddSection(false);
                setNewSectionTitle("");
              }}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor,
              }}
            >
              <Text style={{ color: mutedIconColor, fontSize: 14 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void fetchData(true);
            }}
            tintColor={primaryColor}
          />
        }
      >
        {sections.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 60 }}>
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: 36,
                backgroundColor: primarySoftColor,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 14,
              }}
            >
              <Ionicons name="book-outline" size={32} color={primaryColor} />
            </View>
            <Text
              style={{
                fontSize: 16,
                fontWeight: "700",
                color: isDark ? "#f1f5f9" : "#0f172a",
                marginBottom: 6,
              }}
            >
              No sections yet
            </Text>
            <Text
              style={{
                fontSize: 13,
                color: mutedIconColor,
                textAlign: "center",
                paddingHorizontal: 32,
              }}
            >
              Start building your curriculum by adding a section.
            </Text>
            <TouchableOpacity
              onPress={() => setShowAddSection(true)}
              style={{
                marginTop: 20,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                backgroundColor: primaryColor,
                borderRadius: 20,
                paddingHorizontal: 20,
                paddingVertical: 10,
              }}
            >
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                Add First Section
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          sections.map((section, sIdx) => {
            const isCollapsed = collapsedSections.has(section._id);
            const isEditing = editingSectionId === section._id;
            return (
              <View
                key={section._id}
                style={{
                  backgroundColor: cardColor,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor,
                  overflow: "hidden",
                }}
              >
                {/* Section header */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    backgroundColor: isDark ? "#1e293b" : "#f8fafc",
                    gap: 10,
                  }}
                >
                  <TouchableOpacity onPress={() => toggleSection(section._id)}>
                    <Ionicons
                      name={isCollapsed ? "chevron-forward" : "chevron-down"}
                      size={16}
                      color={mutedIconColor}
                    />
                  </TouchableOpacity>

                  {isEditing ? (
                    <TextInput
                      value={editSectionTitle}
                      onChangeText={setEditSectionTitle}
                      autoFocus
                      style={{
                        flex: 1,
                        fontSize: 14,
                        fontWeight: "600",
                        color: isDark ? "#f1f5f9" : "#0f172a",
                        borderBottomWidth: 1,
                        borderBottomColor: primaryColor,
                        paddingBottom: 2,
                      }}
                    />
                  ) : (
                    <TouchableOpacity
                      style={{ flex: 1 }}
                      onPress={() => toggleSection(section._id)}
                    >
                      <View
                        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                      >
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: "700",
                            color: mutedIconColor,
                          }}
                        >
                          {String(sIdx + 1).padStart(2, "0")}
                        </Text>
                        <Text
                          style={{
                            flex: 1,
                            fontSize: 14,
                            fontWeight: "600",
                            color: isDark ? "#f1f5f9" : "#0f172a",
                          }}
                          numberOfLines={1}
                        >
                          {section.title}
                        </Text>
                        <Text style={{ fontSize: 12, color: mutedIconColor }}>
                          {section.videos?.length ?? 0} video
                          {(section.videos?.length ?? 0) !== 1 ? "s" : ""}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )}

                  {isEditing ? (
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <TouchableOpacity
                        onPress={() => void handleRenameSection(section._id)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 4,
                          backgroundColor: primaryColor,
                          borderRadius: 8,
                        }}
                      >
                        <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>
                          Save
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => setEditingSectionId(null)}>
                        <Ionicons name="close" size={18} color={mutedIconColor} />
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={{ flexDirection: "row", gap: 2 }}>
                      <TouchableOpacity
                        onPress={() => {
                          setEditingSectionId(section._id);
                          setEditSectionTitle(section.title);
                        }}
                        style={{ padding: 6 }}
                      >
                        <Ionicons
                          name="pencil-outline"
                          size={15}
                          color={mutedIconColor}
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handleDeleteSection(section._id, section.title)}
                        style={{ padding: 6 }}
                      >
                        <Ionicons name="trash-outline" size={15} color="#ef4444" />
                      </TouchableOpacity>
                    </View>
                  )}
                </View>

                {/* Section videos */}
                {!isCollapsed ? (
                  <View>
                    {(section.videos?.length ?? 0) === 0 ? (
                      <View style={{ paddingVertical: 18, alignItems: "center" }}>
                        <Text style={{ fontSize: 13, color: mutedIconColor }}>
                          No videos yet in this section.
                        </Text>
                      </View>
                    ) : (
                      <View>
                        {section.videos.map((video, vIdx) => {
                          // While a background upload for this video is still in
                          // flight, surface its real phase on the row.
                          const activeUp = findActiveUpload(section._id, video.title);
                          const statusLabel = activeUp
                            ? activeUp.progress >= 95
                              ? "Processing…"
                              : `Uploading… ${activeUp.progress}%`
                            : video.status === "PROCESSING"
                              ? "Processing…"
                              : video.status === "ERRORED"
                                ? "Processing failed"
                                : `${formatDuration(video.durationMinutes)} · ${video.viewCount} view${video.viewCount !== 1 ? "s" : ""}`;
                          const isBusyVideo = !!activeUp || video.status === "PROCESSING";
                          return (
                            <TouchableOpacity
                              key={video._id}
                              // Teachers can preview their own READY videos straight
                              // from the curriculum, same player students use.
                              disabled={video.status !== "READY"}
                              activeOpacity={0.6}
                              onPress={() =>
                                router.push({
                                  pathname: "/course/video" as any,
                                  params: {
                                    courseId: courseId!,
                                    videoId: video._id,
                                    title: video.title,
                                  },
                                })
                              }
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                paddingHorizontal: 14,
                                paddingVertical: 11,
                                borderTopWidth: 1,
                                borderTopColor: borderColor,
                                gap: 10,
                              }}
                            >
                              <View
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: 8,
                                  backgroundColor: isDark ? "#1e293b" : "#f1f5f9",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                <Text
                                  style={{
                                    fontSize: 11,
                                    fontWeight: "700",
                                    color: mutedIconColor,
                                  }}
                                >
                                  {vIdx + 1}
                                </Text>
                              </View>
                              <Ionicons
                                name="play-circle-outline"
                                size={18}
                                color={
                                  isBusyVideo
                                    ? "#f59e0b"
                                    : video.status === "ERRORED"
                                      ? "#ef4444"
                                      : "#22c55e"
                                }
                              />
                              <View style={{ flex: 1 }}>
                                <Text
                                  style={{
                                    fontSize: 13,
                                    fontWeight: "600",
                                    color: isDark ? "#f1f5f9" : "#0f172a",
                                  }}
                                  numberOfLines={1}
                                >
                                  {video.title}
                                </Text>
                                <Text
                                  style={{
                                    fontSize: 11,
                                    color: activeUp ? "#f59e0b" : mutedIconColor,
                                    marginTop: 1,
                                    fontWeight: activeUp ? "600" : "400",
                                  }}
                                >
                                  {statusLabel}
                                </Text>
                              </View>
                              {isBusyVideo ? (
                                <ActivityIndicator size="small" color="#f59e0b" />
                              ) : (
                                <View
                                  style={{
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: 2,
                                  }}
                                >
                                  {video.status === "READY" ? (
                                    <Ionicons
                                      name="chevron-forward"
                                      size={15}
                                      color={mutedIconColor}
                                    />
                                  ) : null}
                                  <TouchableOpacity
                                    onPress={() =>
                                      handleDeleteVideo(video._id, video.title)
                                    }
                                    style={{ padding: 6 }}
                                  >
                                    <Ionicons
                                      name="trash-outline"
                                      size={15}
                                      color="#ef4444"
                                    />
                                  </TouchableOpacity>
                                </View>
                              )}
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}

                    {/* Add video button */}
                    <TouchableOpacity
                      onPress={() => openAddVideo(section._id)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        paddingHorizontal: 14,
                        paddingVertical: 12,
                        borderTopWidth: 1,
                        borderTopColor: borderColor,
                        backgroundColor: `${primaryColor}06`,
                      }}
                    >
                      <Ionicons
                        name="add-circle-outline"
                        size={18}
                        color={primaryColor}
                      />
                      <Text
                        style={{ fontSize: 13, fontWeight: "600", color: primaryColor }}
                      >
                        Add Video
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );

  const renderSettingsTab = () => (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Title */}
        <View>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: isDark ? "#cbd5e1" : "#475569",
              marginBottom: 6,
            }}
          >
            Title
          </Text>
          <TextInput
            value={settingsForm.title}
            onChangeText={(v) => setSettingsForm((f) => ({ ...f, title: v }))}
            style={{
              borderWidth: 1,
              borderColor,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              fontSize: 15,
              color: isDark ? "#f1f5f9" : "#0f172a",
              backgroundColor: cardColor,
            }}
          />
        </View>

        {/* Description */}
        <View>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: isDark ? "#cbd5e1" : "#475569",
              marginBottom: 6,
            }}
          >
            Description
          </Text>
          <TextInput
            value={settingsForm.description}
            onChangeText={(v) => setSettingsForm((f) => ({ ...f, description: v }))}
            multiline
            numberOfLines={5}
            textAlignVertical="top"
            style={{
              borderWidth: 1,
              borderColor,
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              fontSize: 14,
              color: isDark ? "#f1f5f9" : "#0f172a",
              minHeight: 110,
              backgroundColor: cardColor,
            }}
          />
        </View>

        {/* Subject */}
        <View>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: isDark ? "#cbd5e1" : "#475569",
              marginBottom: 8,
            }}
          >
            Subject
          </Text>
          <AcademicSuggestionInput
            value={settingsForm.subject}
            onChangeText={(value) => setSettingsForm((f) => ({ ...f, subject: value }))}
            options={SUBJECT_OPTIONS}
            placeholder="Type or choose subject"
          />
        </View>

        {/* Level */}
        <View>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: isDark ? "#cbd5e1" : "#475569",
              marginBottom: 8,
            }}
          >
            Level
          </Text>
          <AcademicSuggestionInput
            value={settingsForm.level}
            onChangeText={(value) => setSettingsForm((f) => ({ ...f, level: value }))}
            options={LEVEL_OPTIONS}
            placeholder="Type or choose level"
          />
        </View>

        {/* Status */}
        <View>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: isDark ? "#cbd5e1" : "#475569",
              marginBottom: 8,
            }}
          >
            Status
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {STATUSES.map((st) => {
              const colors: Record<CourseStatus, string> = {
                DRAFT: "#94a3b8",
                ACTIVE: "#22c55e",
                COMPLETED: "#3b82f6",
                ARCHIVED: "#ef4444",
              };
              const selected = settingsForm.status === st;
              return (
                <TouchableOpacity
                  key={st}
                  onPress={() => setSettingsForm((f) => ({ ...f, status: st }))}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                    borderRadius: 20,
                    borderWidth: 1.5,
                    borderColor: selected ? colors[st] : borderColor,
                    backgroundColor: selected ? `${colors[st]}15` : "transparent",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: "700",
                      color: selected ? colors[st] : mutedIconColor,
                    }}
                  >
                    {st}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Pricing */}
        <View>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: isDark ? "#cbd5e1" : "#475569",
              marginBottom: 8,
            }}
          >
            Pricing
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {(["FREE", "SUBSCRIPTION_INCLUDED", "PAID"] as PricingModel[]).map((pm) => {
              const labels = {
                FREE: "Free",
                SUBSCRIPTION_INCLUDED: "Subscription",
                PAID: "Paid",
              };
              const selected = settingsForm.pricingModel === pm;
              return (
                <TouchableOpacity
                  key={pm}
                  onPress={() => setSettingsForm((f) => ({ ...f, pricingModel: pm }))}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    paddingVertical: 10,
                    borderRadius: 12,
                    borderWidth: 1.5,
                    borderColor: selected ? primaryColor : borderColor,
                    backgroundColor: selected ? primarySoftColor : "transparent",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: "700",
                      color: selected ? primaryColor : mutedIconColor,
                    }}
                  >
                    {labels[pm]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {settingsForm.pricingModel === "PAID" ? (
            <View style={{ marginTop: 10 }}>
              <Text style={{ fontSize: 12, color: mutedIconColor, marginBottom: 6 }}>
                Price (NPR)
              </Text>
              <TextInput
                value={settingsForm.price}
                onChangeText={(v) => setSettingsForm((f) => ({ ...f, price: v }))}
                keyboardType="numeric"
                placeholder="e.g. 999"
                placeholderTextColor={mutedIconColor}
                style={{
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  fontSize: 15,
                  color: isDark ? "#f1f5f9" : "#0f172a",
                  backgroundColor: cardColor,
                }}
              />
              {Number(settingsForm.price) > 0 ? (
                <View
                  style={{
                    marginTop: 8,
                    backgroundColor: isDark ? "#1e293b" : "#f8fafc",
                    borderRadius: 10,
                    padding: 12,
                    gap: 6,
                  }}
                >
                  {[
                    {
                      label: "Course price",
                      val: `NPR ${Number(settingsForm.price).toLocaleString()}`,
                      red: false,
                    },
                    {
                      label: "Platform (20%)",
                      val: `- NPR ${Math.round(Number(settingsForm.price) * 0.2).toLocaleString()}`,
                      red: true,
                    },
                    {
                      label: "You receive",
                      val: `NPR ${Math.round(Number(settingsForm.price) * 0.8).toLocaleString()}`,
                      red: false,
                    },
                  ].map((row, i) => (
                    <View
                      key={row.label}
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        ...(i === 2
                          ? {
                              paddingTop: 6,
                              borderTopWidth: 1,
                              borderTopColor: borderColor,
                            }
                          : {}),
                      }}
                    >
                      <Text style={{ fontSize: 12, color: mutedIconColor }}>
                        {row.label}
                      </Text>
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: i === 2 ? "700" : "400",
                          color: row.red
                            ? "#ef4444"
                            : i === 2
                              ? "#22c55e"
                              : isDark
                                ? "#f1f5f9"
                                : "#0f172a",
                        }}
                      >
                        {row.val}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* Free preview */}
        <View>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "600",
              color: isDark ? "#cbd5e1" : "#475569",
              marginBottom: 8,
            }}
          >
            Free preview videos
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {[
              { label: "No", value: false },
              { label: "Yes", value: true },
            ].map((option) => {
              const disabled = settingsForm.pricingModel === "FREE";
              const selected = Number(settingsForm.freePreviewCount) > 0 === option.value;
              return (
                <TouchableOpacity
                  key={option.label}
                  disabled={disabled}
                  onPress={() =>
                    setSettingsForm((f) => ({
                      ...f,
                      freePreviewCount: option.value
                        ? Number(f.freePreviewCount) > 0
                          ? f.freePreviewCount
                          : "1"
                        : "0",
                    }))
                  }
                  style={{
                    flex: 1,
                    alignItems: "center",
                    paddingVertical: 10,
                    borderRadius: 12,
                    borderWidth: 1.5,
                    borderColor: selected ? primaryColor : borderColor,
                    backgroundColor: selected ? primarySoftColor : "transparent",
                    opacity: disabled ? 0.45 : 1,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: "700",
                      color: selected ? primaryColor : mutedIconColor,
                    }}
                  >
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {settingsForm.pricingModel === "FREE" ? (
            <Text style={{ marginTop: 8, fontSize: 12, color: mutedIconColor }}>
              Free courses are already fully open.
            </Text>
          ) : Number(settingsForm.freePreviewCount) > 0 ? (
            <View style={{ marginTop: 10 }}>
              <Text style={{ fontSize: 12, color: mutedIconColor, marginBottom: 6 }}>
                Number of first videos students can preview
              </Text>
              <TextInput
                value={settingsForm.freePreviewCount}
                onChangeText={(v) =>
                  setSettingsForm((f) => ({
                    ...f,
                    freePreviewCount: v.replace(/[^0-9]/g, ""),
                  }))
                }
                keyboardType="numeric"
                placeholder="e.g. 2"
                placeholderTextColor={mutedIconColor}
                style={{
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  fontSize: 15,
                  color: isDark ? "#f1f5f9" : "#0f172a",
                  backgroundColor: cardColor,
                }}
              />
            </View>
          ) : null}
        </View>

        {/* Save button */}
        <TouchableOpacity
          onPress={() => void handleSaveSettings()}
          disabled={isSaving}
          style={{
            alignItems: "center",
            paddingVertical: 14,
            borderRadius: 14,
            backgroundColor: isSaving ? `${primaryColor}60` : primaryColor,
          }}
        >
          {isSaving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>
              Save Changes
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );

  const renderAnalyticsTab = () => (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      {/* Stats grid */}
      <View style={{ flexDirection: "row", gap: 12 }}>
        {[
          {
            label: "Students",
            value: course?.enrollmentCount ?? 0,
            icon: "people-outline" as const,
            color: "#22c55e",
          },
          {
            label: "Videos",
            value: totalVideos,
            icon: "play-circle-outline" as const,
            color: "#3b82f6",
          },
          {
            label: "Duration",
            value: `${course?.totalDurationMinutes ?? 0}m`,
            icon: "time-outline" as const,
            color: "#f59e0b",
          },
        ].map((stat) => (
          <View
            key={stat.label}
            style={{
              flex: 1,
              backgroundColor: cardColor,
              borderRadius: 14,
              borderWidth: 1,
              borderColor,
              padding: 14,
              alignItems: "center",
              gap: 6,
            }}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: `${stat.color}15`,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name={stat.icon} size={20} color={stat.color} />
            </View>
            <Text
              style={{
                fontSize: 20,
                fontWeight: "800",
                color: isDark ? "#f1f5f9" : "#0f172a",
              }}
            >
              {stat.value}
            </Text>
            <Text style={{ fontSize: 11, color: mutedIconColor }}>{stat.label}</Text>
          </View>
        ))}
      </View>

      {/* Section breakdown */}
      {sections.length > 0 ? (
        <View
          style={{
            backgroundColor: cardColor,
            borderRadius: 16,
            borderWidth: 1,
            borderColor,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: borderColor,
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: "700",
                color: isDark ? "#f1f5f9" : "#0f172a",
              }}
            >
              Curriculum Overview
            </Text>
          </View>
          {sections.map((section, i) => (
            <View key={section._id}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  gap: 12,
                }}
              >
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    backgroundColor: primarySoftColor,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "700", color: primaryColor }}>
                    {i + 1}
                  </Text>
                </View>
                <Text
                  style={{ flex: 1, fontSize: 13, color: isDark ? "#f1f5f9" : "#0f172a" }}
                  numberOfLines={1}
                >
                  {section.title}
                </Text>
                <Text style={{ fontSize: 12, color: mutedIconColor }}>
                  {section.videos?.length ?? 0} video
                  {(section.videos?.length ?? 0) !== 1 ? "s" : ""}
                </Text>
              </View>
              {i < sections.length - 1 ? (
                <View
                  style={{
                    height: 1,
                    marginHorizontal: 16,
                    backgroundColor: borderColor,
                  }}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {/* Pricing info */}
      {course ? (
        <View
          style={{
            backgroundColor: cardColor,
            borderRadius: 16,
            borderWidth: 1,
            borderColor,
            padding: 16,
          }}
        >
          <Text
            style={{
              fontSize: 14,
              fontWeight: "700",
              color: isDark ? "#f1f5f9" : "#0f172a",
              marginBottom: 12,
            }}
          >
            Course Info
          </Text>
          {[
            {
              label: "Pricing",
              value:
                course.pricingModel === "FREE"
                  ? "Free"
                  : course.pricingModel === "SUBSCRIPTION_INCLUDED"
                    ? "Subscription"
                    : `NPR ${course.price?.toLocaleString() ?? "—"}`,
            },
            { label: "Status", value: course.status },
            { label: "Subject", value: course.subject || "—" },
            { label: "Level", value: course.level || "—" },
          ].map((row, i) => (
            <View
              key={row.label}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                marginBottom: i < 3 ? 8 : 0,
              }}
            >
              <Text style={{ fontSize: 13, color: mutedIconColor }}>{row.label}</Text>
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: "600",
                  color: isDark ? "#f1f5f9" : "#0f172a",
                }}
              >
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );

  // ── Add Video Modal ─────────────────────────────────────────────────────

  // File uploads hand off to the background manager and close the sheet
  // instantly, so the only in-modal "busy" state left is saving a Zoom link.
  const isBusy = isAddingVideo;

  const renderAddVideoModal = () => (
    <Modal
      visible={showAddVideo}
      animationType="slide"
      transparent
      onRequestClose={() => {
        if (!isBusy) setShowAddVideo(false);
      }}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          backgroundColor: "rgba(0,0,0,0.5)",
        }}
      >
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <BottomSheetSurface
            basePadding={20}
            style={{
              backgroundColor: cardColor,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              padding: 20,
              gap: 16,
            }}
          >
            {/* Handle */}
            <View
              style={{
                alignSelf: "center",
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: borderColor,
                marginBottom: 4,
              }}
            />

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: "700",
                  color: isDark ? "#f1f5f9" : "#0f172a",
                }}
              >
                Add Video
              </Text>
              <TouchableOpacity
                onPress={() => {
                  if (!isBusy) setShowAddVideo(false);
                }}
                disabled={isBusy}
              >
                <Ionicons name="close" size={22} color={mutedIconColor} />
              </TouchableOpacity>
            </View>

            {/* Method picker */}
            <View style={{ flexDirection: "row", gap: 10 }}>
              {[
                {
                  key: "ZOOM_LINK" as const,
                  label: "Zoom Link",
                  icon: "link-outline" as const,
                  color: "#8b5cf6",
                },
                {
                  key: "FILE_UPLOAD" as const,
                  label: "File Upload",
                  icon: "cloud-upload-outline" as const,
                  color: "#3b82f6",
                },
              ].map((m) => {
                const selected = videoMethod === m.key;
                return (
                  <TouchableOpacity
                    key={m.key}
                    onPress={() => setVideoMethod(m.key)}
                    disabled={isBusy}
                    style={{
                      flex: 1,
                      alignItems: "center",
                      gap: 8,
                      paddingVertical: 14,
                      borderRadius: 14,
                      borderWidth: 2,
                      borderColor: selected ? m.color : borderColor,
                      backgroundColor: selected ? `${m.color}10` : "transparent",
                    }}
                  >
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        backgroundColor: `${m.color}18`,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ionicons name={m.icon} size={18} color={m.color} />
                    </View>
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: "700",
                        color: selected ? m.color : mutedIconColor,
                      }}
                    >
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Video title */}
            <View>
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: "600",
                  color: isDark ? "#cbd5e1" : "#475569",
                  marginBottom: 6,
                }}
              >
                Video Title *
              </Text>
              <TextInput
                value={videoTitle}
                onChangeText={setVideoTitle}
                placeholder="e.g. Introduction to the Topic"
                placeholderTextColor={mutedIconColor}
                editable={!isBusy}
                style={{
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  fontSize: 14,
                  color: isDark ? "#f1f5f9" : "#0f172a",
                  backgroundColor: isDark ? "#1e293b" : "#f8fafc",
                }}
              />
            </View>

            {/* Section selector */}
            {sections.length > 1 ? (
              <View>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: "600",
                    color: isDark ? "#cbd5e1" : "#475569",
                    marginBottom: 8,
                  }}
                >
                  Section
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {sections.map((s) => (
                      <TouchableOpacity
                        key={s._id}
                        onPress={() => setAddVideoSectionId(s._id)}
                        disabled={isBusy}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 7,
                          borderRadius: 20,
                          borderWidth: 1,
                          borderColor:
                            addVideoSectionId === s._id ? primaryColor : borderColor,
                          backgroundColor:
                            addVideoSectionId === s._id ? primaryColor : "transparent",
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: "600",
                            color: addVideoSectionId === s._id ? "#fff" : mutedIconColor,
                          }}
                          numberOfLines={1}
                        >
                          {s.title}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              </View>
            ) : null}

            {/* Source-specific */}
            {videoMethod === "ZOOM_LINK" ? (
              <View>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: "600",
                    color: isDark ? "#cbd5e1" : "#475569",
                    marginBottom: 6,
                  }}
                >
                  Zoom Recording URL *
                </Text>
                <TextInput
                  value={zoomLink}
                  onChangeText={setZoomLink}
                  placeholder="https://zoom.us/rec/share/…"
                  placeholderTextColor={mutedIconColor}
                  editable={!isBusy}
                  style={{
                    borderWidth: 1,
                    borderColor,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    fontSize: 14,
                    color: isDark ? "#f1f5f9" : "#0f172a",
                    backgroundColor: isDark ? "#1e293b" : "#f8fafc",
                  }}
                />
              </View>
            ) : (
              <View>
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: "600",
                    color: isDark ? "#cbd5e1" : "#475569",
                    marginBottom: 6,
                  }}
                >
                  Video File *
                </Text>
                <TouchableOpacity
                  onPress={() => void handlePickVideo()}
                  disabled={isBusy}
                  style={{
                    borderWidth: 2,
                    borderStyle: "dashed",
                    borderColor: pickedFileName ? primaryColor : borderColor,
                    borderRadius: 12,
                    padding: 16,
                    alignItems: "center",
                    gap: 8,
                    backgroundColor: pickedFileName ? `${primaryColor}06` : "transparent",
                  }}
                >
                  <Ionicons
                    name={pickedFileName ? "videocam" : "cloud-upload-outline"}
                    size={24}
                    color={pickedFileName ? primaryColor : mutedIconColor}
                  />
                  <Text
                    style={{
                      fontSize: 13,
                      color: pickedFileName ? primaryColor : mutedIconColor,
                      textAlign: "center",
                    }}
                    numberOfLines={2}
                  >
                    {pickedFileName || "Tap to pick a video from device"}
                  </Text>
                  {pickedFileName ? (
                    <Text style={{ fontSize: 11, color: mutedIconColor }}>
                      {(pickedFileSizeRef.current / 1024 / 1024).toFixed(1)} MB · Tap to
                      replace
                    </Text>
                  ) : null}
                </TouchableOpacity>
              </View>
            )}

            {/* File-upload hint: uploads continue in the background */}
            {videoMethod === "FILE_UPLOAD" && pickedFileName ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  backgroundColor: `${primaryColor}10`,
                  borderRadius: 10,
                  padding: 10,
                }}
              >
                <Ionicons name="cloud-upload-outline" size={16} color={primaryColor} />
                <Text style={{ flex: 1, fontSize: 12, color: mutedIconColor }}>
                  Upload runs in the background — you can keep using the app and
                  we&apos;ll notify you when it&apos;s ready.
                </Text>
              </View>
            ) : null}

            {/* Buttons */}
            <View style={{ flexDirection: "row", gap: 10 }}>
              <TouchableOpacity
                onPress={() => {
                  if (!isBusy) setShowAddVideo(false);
                }}
                disabled={isBusy}
                style={{
                  flex: 1,
                  alignItems: "center",
                  paddingVertical: 13,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "600", color: mutedIconColor }}>
                  Cancel
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => void handleAddVideoSubmit()}
                disabled={isBusy}
                style={{
                  flex: 2,
                  alignItems: "center",
                  paddingVertical: 13,
                  borderRadius: 12,
                  backgroundColor: isBusy ? `${primaryColor}60` : primaryColor,
                }}
              >
                {isBusy ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff" }}>
                    {videoMethod === "ZOOM_LINK" ? "Save Link" : "Upload Video"}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </BottomSheetSurface>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );

  // ── Main render ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />
        <ActivityIndicator size="large" color={primaryColor} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      {/* Header */}
      <View
        style={{
          paddingTop: 56,
          paddingBottom: 0,
          borderBottomWidth: 1,
          borderBottomColor: borderColor,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 16,
            paddingBottom: 12,
            gap: 10,
          }}
        >
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={primaryColor} />
          </TouchableOpacity>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              style={{
                fontSize: 17,
                fontWeight: "700",
                color: isDark ? "#f1f5f9" : "#0f172a",
              }}
              numberOfLines={1}
            >
              {course?.title ?? "Course"}
            </Text>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 }}
            >
              {course ? <StatusPill status={course.status} /> : null}
              <Text style={{ fontSize: 12, color: mutedIconColor }}>
                {sections.length} section{sections.length !== 1 ? "s" : ""} ·{" "}
                {totalVideos} video{totalVideos !== 1 ? "s" : ""}
              </Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => void fetchData(true)}>
            <Ionicons name="refresh-outline" size={20} color={mutedIconColor} />
          </TouchableOpacity>
        </View>

        {/* Tab bar */}
        <View style={{ flexDirection: "row", paddingHorizontal: 16 }}>
          {[
            {
              id: "curriculum" as const,
              label: "Curriculum",
              icon: "layers-outline" as const,
            },
            {
              id: "settings" as const,
              label: "Settings",
              icon: "settings-outline" as const,
            },
            {
              id: "analytics" as const,
              label: "Analytics",
              icon: "bar-chart-outline" as const,
            },
          ].map((t) => (
            <TouchableOpacity
              key={t.id}
              onPress={() => setTab(t.id)}
              style={{
                flex: 1,
                alignItems: "center",
                paddingBottom: 12,
                borderBottomWidth: 2,
                borderBottomColor: tab === t.id ? primaryColor : "transparent",
                gap: 3,
              }}
            >
              <Ionicons
                name={t.icon}
                size={18}
                color={tab === t.id ? primaryColor : mutedIconColor}
              />
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: tab === t.id ? "700" : "500",
                  color: tab === t.id ? primaryColor : mutedIconColor,
                }}
              >
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Add Section FAB (Curriculum only) */}
      {tab === "curriculum" && !showAddSection ? (
        <TouchableOpacity
          onPress={() => setShowAddSection(true)}
          style={{
            position: "absolute",
            bottom: 28,
            right: 20,
            zIndex: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: primaryColor,
            borderRadius: 28,
            paddingHorizontal: 18,
            paddingVertical: 13,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.18,
            shadowRadius: 8,
            elevation: 5,
          }}
        >
          <Ionicons name="add" size={20} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
            Add Section
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* Tab content */}
      <View style={{ flex: 1 }}>
        {tab === "curriculum" && renderCurriculumTab()}
        {tab === "settings" && renderSettingsTab()}
        {tab === "analytics" && renderAnalyticsTab()}
      </View>

      {renderAddVideoModal()}
    </View>
  );
}
