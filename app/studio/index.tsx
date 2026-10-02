import { formatDuration } from "@/lib/duration";
import { useCallback, useEffect, useState } from "react";
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
import { router } from "expo-router";
import Toast from "react-native-toast-message";

import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";

type CourseStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
type PricingModel = "FREE" | "SUBSCRIPTION_INCLUDED" | "PAID";

export type Course = {
  _id: string;
  title: string;
  subject: string;
  level: string;
  status: CourseStatus;
  pricingModel: PricingModel;
  price: number | null;
  enrollmentCount: number;
  totalDurationMinutes: number;
  thumbnailUrl: string | null;
  instructorId: string;
  slug: string;
  description: string;
  startDate?: string | null;
  expectedEndDate?: string | null;
};

type Chapter = {
  _id: string;
  title: string;
  subject: string;
  level: string;
  status: CourseStatus;
  pricingModel: PricingModel;
  price: number | null;
  enrollmentCount: number;
  totalDurationMinutes: number;
  slug: string;
  description: string;
};

function StatusPill({ status }: { status: CourseStatus }) {
  const colors: Record<CourseStatus, { bg: string; text: string }> = {
    DRAFT: { bg: "rgba(148,163,184,0.15)", text: "#94a3b8" },
    ACTIVE: { bg: "rgba(34,197,94,0.12)", text: "#22c55e" },
    COMPLETED: { bg: "rgba(59,130,246,0.12)", text: "#3b82f6" },
    ARCHIVED: { bg: "rgba(239,68,68,0.12)", text: "#ef4444" },
  };
  const c = colors[status] ?? colors.DRAFT;
  return (
    <View
      style={{
        backgroundColor: c.bg,
        borderRadius: 20,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "700", color: c.text }}>{status}</Text>
    </View>
  );
}

function PricingBadge({ model, price }: { model: PricingModel; price: number | null }) {
  const label =
    model === "FREE"
      ? "Free"
      : model === "SUBSCRIPTION_INCLUDED"
        ? "Subscription"
        : `NPR ${price ?? "—"}`;
  const color =
    model === "FREE"
      ? "#10b981"
      : model === "SUBSCRIPTION_INCLUDED"
        ? "#8b5cf6"
        : "#f59e0b";
  return (
    <View
      style={{
        backgroundColor: `${color}18`,
        borderRadius: 20,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "700", color }}>{label}</Text>
    </View>
  );
}

export default function StudioScreen() {
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

  const [courses, setCourses] = useState<Course[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchCourses = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [coursesRes, chaptersRes] = await Promise.all([
        api.get("/courses", {
          params: { limit: 50, page: 1, instructor: "me" },
        }),
        api.get("/chapters", {
          params: { limit: 50, page: 1, instructor: "me" },
        }),
      ]);
      setCourses(coursesRes.data?.courses ?? []);
      setChapters(chaptersRes.data?.chapters ?? []);
    } catch {
      Toast.show({ type: "error", text1: "Failed to load studio items" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchCourses();
  }, [fetchCourses]);

  const handleRefresh = () => {
    setRefreshing(true);
    void fetchCourses(true);
  };

  // Stats
  const totalStudents = courses.reduce((s, c) => s + (c.enrollmentCount ?? 0), 0);
  const activeCourses = courses.filter((c) => c.status === "ACTIVE").length;

  const renderCourse = ({ item }: { item: Course }) => (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={() =>
        router.push({
          pathname: "/studio/[courseId]" as any,
          params: { courseId: item._id },
        })
      }
      style={{
        backgroundColor: cardColor,
        borderRadius: 16,
        borderWidth: 1,
        borderColor,
        marginBottom: 12,
        padding: 16,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: "700",
            color: isDark ? "#f1f5f9" : "#0f172a",
          }}
          numberOfLines={2}
        >
          {item.title}
        </Text>
        <StatusPill status={item.status} />
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 8,
          flexWrap: "wrap",
        }}
      >
        <PricingBadge model={item.pricingModel} price={item.price} />
        <Text style={{ fontSize: 12, color: mutedIconColor }}>{item.subject}</Text>
        {item.level ? (
          <>
            <Text style={{ fontSize: 12, color: mutedIconColor }}>·</Text>
            <Text style={{ fontSize: 12, color: mutedIconColor }}>{item.level}</Text>
          </>
        ) : null}
      </View>

      <View
        style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop: 10 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Ionicons name="people-outline" size={14} color={mutedIconColor} />
          <Text style={{ fontSize: 12, color: mutedIconColor }}>
            {item.enrollmentCount} enrolled
          </Text>
        </View>
        {item.totalDurationMinutes > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Ionicons name="time-outline" size={14} color={mutedIconColor} />
            <Text style={{ fontSize: 12, color: mutedIconColor }}>
              {formatDuration(item.totalDurationMinutes)}
            </Text>
          </View>
        ) : null}
        <View style={{ flex: 1, alignItems: "flex-end" }}>
          <Ionicons name="chevron-forward" size={16} color={mutedIconColor} />
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderChapter = (item: Chapter) => (
    <TouchableOpacity
      key={item._id}
      activeOpacity={0.75}
      onPress={() =>
        router.push({
          pathname: "/studio/chapter/[chapterId]" as any,
          params: { chapterId: item._id },
        })
      }
      style={{
        backgroundColor: cardColor,
        borderRadius: 16,
        borderWidth: 1,
        borderColor,
        marginBottom: 12,
        padding: 16,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            backgroundColor: primarySoftColor,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="albums-outline" size={20} color={primaryColor} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <Text
              style={{
                flex: 1,
                fontSize: 15,
                fontWeight: "700",
                color: isDark ? "#f1f5f9" : "#0f172a",
              }}
              numberOfLines={2}
            >
              {item.title}
            </Text>
            <StatusPill status={item.status} />
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            <PricingBadge model={item.pricingModel} price={item.price} />
            <Text style={{ fontSize: 12, color: mutedIconColor }}>Chapter</Text>
            <Text style={{ fontSize: 12, color: mutedIconColor }}>·</Text>
            <Text style={{ fontSize: 12, color: mutedIconColor }}>{item.subject}</Text>
          </View>
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop: 10 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Ionicons name="people-outline" size={14} color={mutedIconColor} />
              <Text style={{ fontSize: 12, color: mutedIconColor }}>
                {item.enrollmentCount} enrolled
              </Text>
            </View>
            <View style={{ flex: 1, alignItems: "flex-end" }}>
              <Ionicons name="chevron-forward" size={16} color={mutedIconColor} />
            </View>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingTop: 56,
          paddingBottom: 12,
        }}
      >
        <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="chevron-back" size={24} color={primaryColor} />
        </TouchableOpacity>
        <Text
          style={{
            flex: 1,
            fontSize: 24,
            fontWeight: "700",
            color: isDark ? "#f1f5f9" : "#0f172a",
          }}
        >
          Studio
        </Text>
        <TouchableOpacity onPress={handleRefresh} style={{ marginRight: 8 }}>
          <Ionicons name="refresh-outline" size={22} color={mutedIconColor} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/studio/create" as any)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: primaryColor,
            borderRadius: 20,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>New</Text>
        </TouchableOpacity>
      </View>

      <View
        style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, marginBottom: 8 }}
      >
        <TouchableOpacity
          onPress={() => router.push("/studio/create" as any)}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            borderWidth: 1,
            borderColor,
            borderRadius: 14,
            paddingVertical: 10,
          }}
        >
          <Ionicons name="book-outline" size={17} color={primaryColor} />
          <Text style={{ color: primaryColor, fontWeight: "700" }}>Course</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push("/studio/create-chapter" as any)}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            borderWidth: 1,
            borderColor,
            borderRadius: 14,
            paddingVertical: 10,
          }}
        >
          <Ionicons name="albums-outline" size={17} color={primaryColor} />
          <Text style={{ color: primaryColor, fontWeight: "700" }}>Chapter</Text>
        </TouchableOpacity>
      </View>

      {/* Stats strip */}
      {courses.length + chapters.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            gap: 12,
            paddingHorizontal: 16,
            marginBottom: 8,
          }}
        >
          {[
            {
              label: "Total",
              value: courses.length + chapters.length,
              icon: "book-outline" as const,
            },
            {
              label: "Active",
              value: activeCourses + chapters.filter((c) => c.status === "ACTIVE").length,
              icon: "checkmark-circle-outline" as const,
            },
            {
              label: "Students",
              value:
                totalStudents +
                chapters.reduce((s, c) => s + (c.enrollmentCount ?? 0), 0),
              icon: "people-outline" as const,
            },
          ].map((stat) => (
            <View
              key={stat.label}
              style={{
                flex: 1,
                backgroundColor: primarySoftColor,
                borderRadius: 12,
                padding: 10,
                alignItems: "center",
              }}
            >
              <Ionicons name={stat.icon} size={16} color={primaryColor} />
              <Text
                style={{
                  fontSize: 18,
                  fontWeight: "800",
                  color: primaryColor,
                  marginTop: 2,
                }}
              >
                {stat.value}
              </Text>
              <Text style={{ fontSize: 11, color: mutedIconColor }}>{stat.label}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" color={primaryColor} />
        </View>
      ) : (
        <FlatList
          data={courses}
          keyExtractor={(item) => item._id}
          renderItem={renderCourse}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={primaryColor}
            />
          }
          ListHeaderComponent={
            chapters.length > 0 ? (
              <View style={{ marginBottom: courses.length > 0 ? 12 : 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "800",
                    color: mutedIconColor,
                    marginBottom: 10,
                    textTransform: "uppercase",
                  }}
                >
                  Chapters
                </Text>
                {chapters.map(renderChapter)}
                {courses.length > 0 ? (
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: "800",
                      color: mutedIconColor,
                      marginTop: 8,
                      marginBottom: 10,
                      textTransform: "uppercase",
                    }}
                  >
                    Courses
                  </Text>
                ) : null}
              </View>
            ) : null
          }
          ListEmptyComponent={
            chapters.length > 0 ? null : (
              <View style={{ alignItems: "center", paddingTop: 80 }}>
                <View
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: 40,
                    backgroundColor: primarySoftColor,
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: 16,
                  }}
                >
                  <Ionicons name="videocam-outline" size={36} color={primaryColor} />
                </View>
                <Text
                  style={{
                    fontSize: 18,
                    fontWeight: "700",
                    color: isDark ? "#f1f5f9" : "#0f172a",
                    marginBottom: 8,
                  }}
                >
                  No courses yet
                </Text>
                <Text
                  style={{
                    fontSize: 14,
                    color: mutedIconColor,
                    textAlign: "center",
                    marginBottom: 24,
                    paddingHorizontal: 32,
                  }}
                >
                  Create your first course or chapter to start sharing your knowledge.
                </Text>
              </View>
            )
          }
        />
      )}
    </View>
  );
}
