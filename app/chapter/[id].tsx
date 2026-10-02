import { formatDuration } from "@/lib/duration";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  RefreshControl,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import Toast from "react-native-toast-message";

import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { openWebCheckout } from "@/lib/web-checkout";

type PricingModel = "FREE" | "SUBSCRIPTION_INCLUDED" | "PAID";
type ChapterContent = {
  _id: string;
  type: "VIDEO" | "DOC";
  title: string;
  description?: string | null;
  order: number;
  status: "PROCESSING" | "READY" | "ERRORED";
  durationMinutes?: number;
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
  pricingModel: PricingModel;
  price: number | null;
  thumbnailUrl?: string | null;
  totalDurationMinutes?: number;
  enrollmentCount?: number;
  instructorName?: string;
  freePreviewCount?: number;
  overallProgressPercent?: number;
  contents: ChapterContent[];
};

function priceLabel(chapter: ChapterDetail) {
  if (chapter.pricingModel === "FREE") return "Free";
  if (chapter.pricingModel === "SUBSCRIPTION_INCLUDED") return "Subscription";
  // Play Store compliance: show a neutral badge, not a price, in-app.
  return "Premium";
}

export default function ChapterDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const chapterId = Array.isArray(id) ? id[0] : id;
  const userRole = useAppSelector((state) => state.user.data?.role);
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

  const [chapter, setChapter] = useState<ChapterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textColor = isDark ? "#f1f5f9" : "#0f172a";

  const loadChapter = useCallback(
    async (force = false) => {
      if (!chapterId) return;
      if (force) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await api.get(`/chapters/${chapterId}`);
        setChapter(res.data as ChapterDetail);
      } catch (err: any) {
        setError(err?.response?.data?.error ?? "Unable to load chapter.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [chapterId],
  );

  useEffect(() => {
    void loadChapter();
  }, [loadChapter]);

  const previewIds = useMemo(() => {
    if (!chapter) return new Set<string>();
    return new Set(
      [...chapter.contents]
        .sort((a, b) => a.order - b.order)
        .slice(0, chapter.freePreviewCount ?? 0)
        .map((item) => item._id),
    );
  }, [chapter]);

  const hasAccess =
    chapter?.pricingModel === "FREE" ||
    typeof chapter?.overallProgressPercent === "number" ||
    userRole === "ADMIN" ||
    userRole === "TEACHER";

  const enroll = async () => {
    if (!chapterId || !chapter) return;
    if (chapter.pricingModel === "PAID") {
      await openWebCheckout("chapter", chapterId, () => loadChapter(true));
      return;
    }

    setEnrolling(true);
    try {
      await api.post(`/chapters/${chapterId}/enroll`);
      Toast.show({ type: "success", text1: "Chapter unlocked" });
      void loadChapter(true);
    } catch (err: any) {
      const reason = err?.response?.data?.reason;
      if (reason === "SUBSCRIPTION_REQUIRED") {
        await openWebCheckout("subscription", undefined, () => loadChapter(true));
      } else {
        Toast.show({ type: "error", text1: err?.response?.data?.error ?? "Failed" });
      }
    } finally {
      setEnrolling(false);
    }
  };

  if (loading && !chapter) {
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
        <ActivityIndicator color={primaryColor} size="large" />
      </View>
    );
  }

  if (!chapter) {
    return (
      <View style={{ flex: 1, backgroundColor, padding: 20, paddingTop: 60 }}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />
        <Text style={{ color: textColor, fontSize: 18, fontWeight: "700" }}>
          {error ?? "Chapter not found"}
        </Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: primaryColor, fontWeight: "700" }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadChapter(true)}
            tintColor={primaryColor}
          />
        }
        contentContainerStyle={{ padding: 16, paddingTop: 56, paddingBottom: 36 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 14 }}>
          <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
            <Ionicons name="chevron-back" size={24} color={primaryColor} />
          </TouchableOpacity>
          <Text style={{ flex: 1, fontSize: 22, fontWeight: "800", color: textColor }}>
            Chapter
          </Text>
        </View>

        <View
          style={{
            overflow: "hidden",
            borderRadius: 24,
            borderWidth: 1,
            borderColor,
            backgroundColor: cardColor,
          }}
        >
          {chapter.thumbnailUrl ? (
            <Image
              source={{ uri: chapter.thumbnailUrl }}
              style={{ width: "100%", height: 210 }}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                height: 210,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: primarySoftColor,
              }}
            >
              <Ionicons name="albums-outline" size={50} color={primaryColor} />
            </View>
          )}
          <View style={{ padding: 16 }}>
            <View
              style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}
            >
              {[chapter.subject, chapter.level, priceLabel(chapter)].map((label) => (
                <View
                  key={label}
                  style={{
                    borderRadius: 20,
                    backgroundColor: primarySoftColor,
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                  }}
                >
                  <Text style={{ color: primaryColor, fontSize: 12, fontWeight: "700" }}>
                    {label}
                  </Text>
                </View>
              ))}
            </View>
            <Text style={{ fontSize: 24, fontWeight: "800", color: textColor }}>
              {chapter.title}
            </Text>
            <Text
              style={{
                marginTop: 8,
                fontSize: 14,
                lineHeight: 22,
                color: mutedIconColor,
              }}
            >
              {chapter.description}
            </Text>
            <Text style={{ marginTop: 10, fontSize: 12, color: mutedIconColor }}>
              {chapter.instructorName ?? "QuestionCall"} · {chapter.contents.length} items
              · {chapter.enrollmentCount ?? 0} learners
            </Text>
          </View>
        </View>

        <View style={{ marginTop: 18 }}>
          <Text
            style={{
              marginBottom: 10,
              fontSize: 15,
              fontWeight: "800",
              color: textColor,
            }}
          >
            Content
          </Text>
          {chapter.contents.length === 0 ? (
            <View
              style={{
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor,
                borderRadius: 16,
                padding: 18,
              }}
            >
              <Text style={{ color: mutedIconColor }}>
                No content has been added yet.
              </Text>
            </View>
          ) : (
            chapter.contents.map((item) => {
              const preview = previewIds.has(item._id);
              const locked = !hasAccess && !preview;
              return (
                <TouchableOpacity
                  key={item._id}
                  disabled={locked || item.status !== "READY"}
                  onPress={() => {
                    if (item.type === "DOC") {
                      router.push({
                        pathname: "/chapter/content" as any,
                        params: { chapterId, contentId: item._id, title: item.title },
                      });
                    } else {
                      router.push({
                        pathname: "/chapter/content" as any,
                        params: { chapterId, contentId: item._id, title: item.title },
                      });
                    }
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    marginBottom: 10,
                    opacity: locked ? 0.55 : 1,
                    borderWidth: 1,
                    borderColor,
                    backgroundColor: cardColor,
                    borderRadius: 16,
                    padding: 14,
                  }}
                >
                  <Ionicons
                    name={
                      locked
                        ? "lock-closed-outline"
                        : item.type === "VIDEO"
                          ? "play-circle-outline"
                          : "document-text-outline"
                    }
                    size={24}
                    color={locked ? mutedIconColor : primaryColor}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ color: textColor, fontWeight: "700" }}
                      numberOfLines={2}
                    >
                      {item.order}. {item.title}
                    </Text>
                    <Text style={{ marginTop: 3, color: mutedIconColor, fontSize: 12 }}>
                      {item.status !== "READY"
                        ? item.status
                        : item.type === "VIDEO"
                          ? `${formatDuration(item.durationMinutes)}`
                          : item.fileName || item.fileType || "Document"}
                    </Text>
                    {preview && !hasAccess ? (
                      <Text
                        style={{
                          marginTop: 4,
                          color: primaryColor,
                          fontSize: 11,
                          fontWeight: "800",
                        }}
                      >
                        Free preview
                      </Text>
                    ) : null}
                  </View>
                  {locked ? null : (
                    <Ionicons name="chevron-forward" size={18} color={mutedIconColor} />
                  )}
                </TouchableOpacity>
              );
            })
          )}
        </View>

        {userRole === "STUDENT" && !hasAccess ? (
          <View style={{ marginTop: 8, gap: 8 }}>
            <TouchableOpacity
              onPress={() => void enroll()}
              disabled={enrolling}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                borderRadius: 16,
                paddingVertical: 15,
                backgroundColor: primaryColor,
              }}
            >
              {enrolling ? (
                <ActivityIndicator color="#fff" />
              ) : chapter.pricingModel === "PAID" ? (
                <>
                  <Ionicons name="lock-open-outline" size={17} color="#fff" />
                  <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800" }}>
                    Unlock in your browser
                  </Text>
                  <Ionicons name="open-outline" size={14} color="#ffffffcc" />
                </>
              ) : (
                <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800" }}>
                  Unlock Chapter
                </Text>
              )}
            </TouchableOpacity>
            {chapter.pricingModel === "PAID" && !enrolling ? (
              <Text
                style={{
                  textAlign: "center",
                  fontSize: 12,
                  color: mutedIconColor,
                }}
              >
                Opens our secure website to finish unlocking, then brings you right back
                to the app.
              </Text>
            ) : null}
          </View>
        ) : null}

        <TouchableOpacity
          onPress={() =>
            Linking.openURL(`https://questioncall.com/chapters/${chapter._id}`).catch(
              () => {},
            )
          }
          style={{ marginTop: 14, alignSelf: "flex-start" }}
        >
          <Text style={{ color: mutedIconColor, fontSize: 12 }}>Share link</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
