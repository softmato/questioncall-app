import { formatDuration } from "@/lib/duration";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
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
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { startChapterVideoUpload, startMobileUpload } from "@/lib/upload-manager";
import { BottomSheetSurface } from "@/components/ui/bottom-sheet-surface";

type PricingModel = "FREE" | "SUBSCRIPTION_INCLUDED" | "PAID";
type ChapterStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
type ContentType = "VIDEO" | "DOC";

type ChapterContent = {
  _id: string;
  type: ContentType;
  title: string;
  description?: string | null;
  order: number;
  status: "PROCESSING" | "READY" | "ERRORED";
  durationMinutes?: number;
  viewCount?: number;
  fileUrl?: string | null;
  fileName?: string | null;
  fileType?: string | null;
  fileSizeBytes?: number;
};

type ChapterDetail = {
  _id: string;
  title: string;
  description: string;
  subject: string;
  level: string;
  status: ChapterStatus;
  pricingModel: PricingModel;
  price: number | null;
  freePreviewCount: number;
  enrollmentCount: number;
  totalDurationMinutes: number;
  slug: string;
  contents: ChapterContent[];
};

type Tab = "content" | "settings";
type AddKind = "VIDEO_LINK" | "VIDEO_FILE" | "DOC";

const STATUSES: ChapterStatus[] = ["DRAFT", "ACTIVE", "COMPLETED", "ARCHIVED"];

function formatBytes(bytes?: number) {
  if (!bytes) return "File";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ManageChapterScreen() {
  const { chapterId } = useLocalSearchParams<{ chapterId: string }>();
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

  const [tab, setTab] = useState<Tab>("content");
  const [chapter, setChapter] = useState<ChapterDetail | null>(null);
  const [contents, setContents] = useState<ChapterContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addKind, setAddKind] = useState<AddKind>("VIDEO_LINK");
  const [contentTitle, setContentTitle] = useState("");
  const [contentDescription, setContentDescription] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [pickedFileName, setPickedFileName] = useState("");
  const pickedFileRef = useRef<DocumentPicker.DocumentPickerAsset | null>(null);

  const [settingsForm, setSettingsForm] = useState({
    title: "",
    description: "",
    subject: "",
    level: "",
    status: "DRAFT" as ChapterStatus,
    pricingModel: "FREE" as PricingModel,
    price: "",
    freePreviewCount: "0",
  });

  const textColor = isDark ? "#f1f5f9" : "#0f172a";

  const fetchChapter = useCallback(
    async (silent = false) => {
      if (!chapterId) return;
      if (!silent) setLoading(true);
      try {
        const res = await api.get(`/chapters/${chapterId}`);
        const found = res.data as ChapterDetail;
        setChapter(found);
        setContents((found.contents ?? []).sort((a, b) => a.order - b.order));
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
      } catch {
        Toast.show({ type: "error", text1: "Failed to load chapter" });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [chapterId],
  );

  useEffect(() => {
    void fetchChapter();
  }, [fetchChapter]);

  const saveSettings = async () => {
    setIsSaving(true);
    try {
      const res = await api.patch(`/chapters/${chapterId}`, {
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
      setChapter((prev) => (prev ? { ...prev, ...res.data } : prev));
      Toast.show({ type: "success", text1: "Chapter saved" });
    } catch (err: any) {
      Toast.show({ type: "error", text1: err?.response?.data?.error ?? "Save failed" });
    } finally {
      setIsSaving(false);
    }
  };

  const pickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: addKind === "VIDEO_FILE" ? "video/*" : "*/*",
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets[0]) return;
    pickedFileRef.current = result.assets[0];
    setPickedFileName(result.assets[0].name);
    if (!contentTitle.trim()) {
      setContentTitle(result.assets[0].name.replace(/\.[^.]+$/, ""));
    }
  };

  const resetAddForm = () => {
    setContentTitle("");
    setContentDescription("");
    setVideoUrl("");
    setPickedFileName("");
    pickedFileRef.current = null;
  };

  const submitContent = async () => {
    if (!contentTitle.trim()) {
      Toast.show({ type: "error", text1: "Enter a title" });
      return;
    }

    if (addKind === "VIDEO_LINK") {
      if (!videoUrl.trim()) {
        Toast.show({ type: "error", text1: "Enter a video link" });
        return;
      }
      try {
        await api.post(`/chapters/${chapterId}/contents`, {
          type: "VIDEO",
          title: contentTitle.trim(),
          description: contentDescription.trim() || null,
          videoUrl: videoUrl.trim(),
        });
        Toast.show({ type: "success", text1: "Video added" });
        setShowAdd(false);
        resetAddForm();
        void fetchChapter(true);
      } catch (err: any) {
        Toast.show({
          type: "error",
          text1: err?.response?.data?.error ?? "Failed to add video",
        });
      }
      return;
    }

    const file = pickedFileRef.current;
    if (!file) {
      Toast.show({ type: "error", text1: "Pick a file first" });
      return;
    }

    if (addKind === "VIDEO_FILE") {
      startChapterVideoUpload({
        chapterId: chapterId!,
        title: contentTitle.trim(),
        file: {
          uri: file.uri,
          name: file.name || `${contentTitle.trim()}.mp4`,
          mimeType: file.mimeType || "video/mp4",
          size: file.size,
        },
        onCreated: () => void fetchChapter(true),
        onReady: () => void fetchChapter(true),
      });
      Toast.show({ type: "info", text1: "Uploading in background" });
      setShowAdd(false);
      resetAddForm();
      return;
    }

    startMobileUpload({
      file: {
        uri: file.uri,
        name: file.name || contentTitle.trim(),
        mimeType: file.mimeType || "application/octet-stream",
        size: file.size,
      },
      label: `Chapter doc: ${contentTitle.trim()}`,
      fileType: "file",
      folder: "chapter-docs",
      onComplete: async (url) => {
        try {
          await api.post(`/chapters/${chapterId}/contents`, {
            type: "DOC",
            title: contentTitle.trim(),
            description: contentDescription.trim() || null,
            fileUrl: url,
            fileKey: url.split("/").pop() || null,
            fileName: file.name || contentTitle.trim(),
            fileType: file.mimeType || "application/octet-stream",
            fileSizeBytes: file.size ?? 0,
          });
          Toast.show({ type: "success", text1: "Document added" });
          void fetchChapter(true);
        } catch (err: any) {
          Toast.show({
            type: "error",
            text1: err?.response?.data?.error ?? "Document save failed",
          });
        }
      },
    });
    Toast.show({ type: "info", text1: "Uploading document" });
    setShowAdd(false);
    resetAddForm();
  };

  const deleteContent = (content: ChapterContent) => {
    Alert.alert("Delete content?", `"${content.title}" will be removed.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.delete(`/chapters/${chapterId}/contents/${content._id}`);
            setContents((prev) => prev.filter((item) => item._id !== content._id));
            Toast.show({ type: "success", text1: "Content deleted" });
          } catch {
            Toast.show({ type: "error", text1: "Failed to delete content" });
          }
        },
      },
    ]);
  };

  const moveContent = async (content: ChapterContent, direction: -1 | 1) => {
    const nextOrder = content.order + direction;
    if (nextOrder < 1 || nextOrder > contents.length) return;
    try {
      await api.patch(`/chapters/${chapterId}/contents/${content._id}`, {
        order: nextOrder,
      });
      void fetchChapter(true);
    } catch {
      Toast.show({ type: "error", text1: "Failed to reorder" });
    }
  };

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor,
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
      <View
        style={{ paddingTop: 56, borderBottomWidth: 1, borderBottomColor: borderColor }}
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
          <View style={{ flex: 1 }}>
            <Text
              style={{ fontSize: 17, fontWeight: "700", color: textColor }}
              numberOfLines={1}
            >
              {chapter?.title ?? "Chapter"}
            </Text>
            <Text style={{ fontSize: 12, color: mutedIconColor }}>
              {contents.length} item{contents.length !== 1 ? "s" : ""}
            </Text>
          </View>
          <TouchableOpacity onPress={() => void fetchChapter(true)}>
            <Ionicons name="refresh-outline" size={20} color={mutedIconColor} />
          </TouchableOpacity>
        </View>

        <View style={{ flexDirection: "row", paddingHorizontal: 16 }}>
          {[
            { id: "content" as const, label: "Content", icon: "albums-outline" as const },
            {
              id: "settings" as const,
              label: "Settings",
              icon: "settings-outline" as const,
            },
          ].map((item) => (
            <TouchableOpacity
              key={item.id}
              onPress={() => setTab(item.id)}
              style={{
                flex: 1,
                alignItems: "center",
                paddingBottom: 12,
                borderBottomWidth: 2,
                borderBottomColor: tab === item.id ? primaryColor : "transparent",
                gap: 3,
              }}
            >
              <Ionicons
                name={item.icon}
                size={18}
                color={tab === item.id ? primaryColor : mutedIconColor}
              />
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: "700",
                  color: tab === item.id ? primaryColor : mutedIconColor,
                }}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {tab === "content" ? (
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 96 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void fetchChapter(true);
              }}
              tintColor={primaryColor}
            />
          }
        >
          {contents.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 64 }}>
              <Ionicons name="albums-outline" size={44} color={primaryColor} />
              <Text
                style={{
                  marginTop: 12,
                  fontSize: 17,
                  fontWeight: "700",
                  color: textColor,
                }}
              >
                No content yet
              </Text>
              <Text style={{ marginTop: 6, color: mutedIconColor, textAlign: "center" }}>
                Add videos or documents directly to this chapter.
              </Text>
            </View>
          ) : (
            contents.map((item, index) => (
              <View
                key={item._id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  backgroundColor: cardColor,
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 16,
                  padding: 14,
                }}
              >
                <View
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    backgroundColor: primarySoftColor,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons
                    name={
                      item.type === "VIDEO"
                        ? "play-circle-outline"
                        : "document-text-outline"
                    }
                    size={20}
                    color={primaryColor}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{ fontSize: 14, fontWeight: "700", color: textColor }}
                    numberOfLines={2}
                  >
                    {item.order}. {item.title}
                  </Text>
                  <Text style={{ marginTop: 3, fontSize: 12, color: mutedIconColor }}>
                    {item.type === "VIDEO"
                      ? item.status === "READY"
                        ? `${formatDuration(item.durationMinutes)} · ${item.viewCount ?? 0} views`
                        : item.status
                      : `${item.fileType ?? "Document"} · ${formatBytes(item.fileSizeBytes)}`}
                  </Text>
                  {item.fileUrl ? (
                    <TouchableOpacity onPress={() => Linking.openURL(item.fileUrl!)}>
                      <Text
                        style={{
                          marginTop: 4,
                          fontSize: 12,
                          fontWeight: "700",
                          color: primaryColor,
                        }}
                      >
                        Open file
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                <View style={{ alignItems: "center", gap: 8 }}>
                  <TouchableOpacity
                    disabled={index === 0}
                    onPress={() => void moveContent(item, -1)}
                  >
                    <Ionicons
                      name="chevron-up"
                      size={18}
                      color={index === 0 ? borderColor : mutedIconColor}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={index === contents.length - 1}
                    onPress={() => void moveContent(item, 1)}
                  >
                    <Ionicons
                      name="chevron-down"
                      size={18}
                      color={index === contents.length - 1 ? borderColor : mutedIconColor}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => deleteContent(item)}>
                    <Ionicons name="trash-outline" size={18} color="#ef4444" />
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }}
            keyboardShouldPersistTaps="handled"
          >
            {[
              { label: "Title", key: "title", multiline: false },
              { label: "Description", key: "description", multiline: true },
              { label: "Subject", key: "subject", multiline: false },
              { label: "Level", key: "level", multiline: false },
            ].map((field) => (
              <View key={field.key}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "700",
                    color: textColor,
                    marginBottom: 6,
                  }}
                >
                  {field.label}
                </Text>
                {field.key === "subject" ? (
                  <AcademicSuggestionInput
                    value={settingsForm.subject}
                    onChangeText={(value) =>
                      setSettingsForm((f) => ({ ...f, subject: value }))
                    }
                    options={SUBJECT_OPTIONS}
                    placeholder="Type or choose subject"
                  />
                ) : field.key === "level" ? (
                  <AcademicSuggestionInput
                    value={settingsForm.level}
                    onChangeText={(value) =>
                      setSettingsForm((f) => ({ ...f, level: value }))
                    }
                    options={LEVEL_OPTIONS}
                    placeholder="Type or choose level"
                  />
                ) : (
                  <TextInput
                    value={(settingsForm as any)[field.key]}
                    onChangeText={(value) =>
                      setSettingsForm((f) => ({ ...f, [field.key]: value }))
                    }
                    multiline={field.multiline}
                    textAlignVertical={field.multiline ? "top" : "center"}
                    style={{
                      minHeight: field.multiline ? 110 : undefined,
                      borderWidth: 1,
                      borderColor,
                      borderRadius: 12,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      color: textColor,
                      backgroundColor: cardColor,
                    }}
                  />
                )}
              </View>
            ))}

            <Text style={{ fontSize: 13, fontWeight: "700", color: textColor }}>
              Status
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {STATUSES.map((status) => (
                <TouchableOpacity
                  key={status}
                  onPress={() => setSettingsForm((f) => ({ ...f, status }))}
                  style={{
                    borderWidth: 1,
                    borderColor:
                      settingsForm.status === status ? primaryColor : borderColor,
                    backgroundColor:
                      settingsForm.status === status ? primarySoftColor : "transparent",
                    borderRadius: 20,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  }}
                >
                  <Text
                    style={{
                      color:
                        settingsForm.status === status ? primaryColor : mutedIconColor,
                      fontWeight: "700",
                    }}
                  >
                    {status}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={{ fontSize: 13, fontWeight: "700", color: textColor }}>
              Pricing
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["FREE", "SUBSCRIPTION_INCLUDED", "PAID"] as PricingModel[]).map(
                (model) => (
                  <TouchableOpacity
                    key={model}
                    onPress={() =>
                      setSettingsForm((f) => ({ ...f, pricingModel: model }))
                    }
                    style={{
                      flex: 1,
                      alignItems: "center",
                      borderWidth: 1,
                      borderColor:
                        settingsForm.pricingModel === model ? primaryColor : borderColor,
                      backgroundColor:
                        settingsForm.pricingModel === model
                          ? primarySoftColor
                          : "transparent",
                      borderRadius: 12,
                      paddingVertical: 10,
                    }}
                  >
                    <Text
                      style={{
                        color:
                          settingsForm.pricingModel === model
                            ? primaryColor
                            : mutedIconColor,
                        fontWeight: "700",
                        fontSize: 12,
                      }}
                    >
                      {model === "SUBSCRIPTION_INCLUDED" ? "Sub" : model}
                    </Text>
                  </TouchableOpacity>
                ),
              )}
            </View>
            {settingsForm.pricingModel === "PAID" ? (
              <TextInput
                value={settingsForm.price}
                onChangeText={(value) => setSettingsForm((f) => ({ ...f, price: value }))}
                keyboardType="numeric"
                placeholder="Price in NPR"
                placeholderTextColor={mutedIconColor}
                style={{
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  color: textColor,
                  backgroundColor: cardColor,
                }}
              />
            ) : null}

            <Text style={{ fontSize: 13, fontWeight: "700", color: textColor }}>
              Free preview items
            </Text>
            <TextInput
              value={settingsForm.freePreviewCount}
              onChangeText={(value) =>
                setSettingsForm((f) => ({
                  ...f,
                  freePreviewCount: value.replace(/[^0-9]/g, ""),
                }))
              }
              editable={settingsForm.pricingModel !== "FREE"}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={mutedIconColor}
              style={{
                borderWidth: 1,
                borderColor,
                borderRadius: 12,
                paddingHorizontal: 14,
                paddingVertical: 12,
                color: textColor,
                backgroundColor: cardColor,
                opacity: settingsForm.pricingModel === "FREE" ? 0.5 : 1,
              }}
            />

            <TouchableOpacity
              onPress={() => void saveSettings()}
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
                <Text style={{ color: "#fff", fontWeight: "700" }}>Save Changes</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {tab === "content" ? (
        <TouchableOpacity
          onPress={() => setShowAdd(true)}
          style={{
            position: "absolute",
            right: 20,
            bottom: 28,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: primaryColor,
            borderRadius: 28,
            paddingHorizontal: 18,
            paddingVertical: 13,
          }}
        >
          <Ionicons name="add" size={20} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "700" }}>Add Content</Text>
        </TouchableOpacity>
      ) : null}

      <Modal
        visible={showAdd}
        animationType="slide"
        transparent
        onRequestClose={() => setShowAdd(false)}
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
                gap: 14,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={{ fontSize: 18, fontWeight: "700", color: textColor }}>
                  Add content
                </Text>
                <TouchableOpacity onPress={() => setShowAdd(false)}>
                  <Ionicons name="close" size={22} color={mutedIconColor} />
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: "row", gap: 8 }}>
                {[
                  ["VIDEO_LINK", "Link", "link-outline"],
                  ["VIDEO_FILE", "Video", "cloud-upload-outline"],
                  ["DOC", "Doc", "document-text-outline"],
                ].map(([kind, label, icon]) => (
                  <TouchableOpacity
                    key={kind}
                    onPress={() => {
                      setAddKind(kind as AddKind);
                      setPickedFileName("");
                      pickedFileRef.current = null;
                    }}
                    style={{
                      flex: 1,
                      alignItems: "center",
                      gap: 6,
                      borderWidth: 1.5,
                      borderColor: addKind === kind ? primaryColor : borderColor,
                      backgroundColor:
                        addKind === kind ? primarySoftColor : "transparent",
                      borderRadius: 12,
                      paddingVertical: 12,
                    }}
                  >
                    <Ionicons
                      name={icon as any}
                      size={20}
                      color={addKind === kind ? primaryColor : mutedIconColor}
                    />
                    <Text
                      style={{
                        color: addKind === kind ? primaryColor : mutedIconColor,
                        fontWeight: "700",
                        fontSize: 12,
                      }}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TextInput
                value={contentTitle}
                onChangeText={setContentTitle}
                placeholder="Title"
                placeholderTextColor={mutedIconColor}
                style={{
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 12,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: textColor,
                }}
              />
              <TextInput
                value={contentDescription}
                onChangeText={setContentDescription}
                placeholder="Description (optional)"
                placeholderTextColor={mutedIconColor}
                style={{
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 12,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: textColor,
                }}
              />
              {addKind === "VIDEO_LINK" ? (
                <TextInput
                  value={videoUrl}
                  onChangeText={setVideoUrl}
                  placeholder="Video URL"
                  placeholderTextColor={mutedIconColor}
                  autoCapitalize="none"
                  style={{
                    borderWidth: 1,
                    borderColor,
                    borderRadius: 12,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    color: textColor,
                  }}
                />
              ) : (
                <TouchableOpacity
                  onPress={() => void pickFile()}
                  style={{
                    alignItems: "center",
                    gap: 8,
                    borderWidth: 2,
                    borderStyle: "dashed",
                    borderColor: pickedFileName ? primaryColor : borderColor,
                    borderRadius: 14,
                    padding: 18,
                  }}
                >
                  <Ionicons
                    name="cloud-upload-outline"
                    size={24}
                    color={pickedFileName ? primaryColor : mutedIconColor}
                  />
                  <Text
                    style={{
                      color: pickedFileName ? primaryColor : mutedIconColor,
                      textAlign: "center",
                    }}
                  >
                    {pickedFileName || "Tap to pick a file"}
                  </Text>
                </TouchableOpacity>
              )}

              <View style={{ flexDirection: "row", gap: 10 }}>
                <TouchableOpacity
                  onPress={() => setShowAdd(false)}
                  style={{
                    flex: 1,
                    alignItems: "center",
                    paddingVertical: 13,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor,
                  }}
                >
                  <Text style={{ color: mutedIconColor, fontWeight: "700" }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => void submitContent()}
                  style={{
                    flex: 2,
                    alignItems: "center",
                    paddingVertical: 13,
                    borderRadius: 12,
                    backgroundColor: primaryColor,
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "700" }}>Add</Text>
                </TouchableOpacity>
              </View>
            </BottomSheetSurface>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}
