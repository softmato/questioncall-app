import { formatDuration } from "@/lib/duration";
import {
  View,
  Text,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  StatusBar,
  Image,
  ImageBackground,
  TextInput,
  Platform,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useTabBarScroll } from "@/components/ui/bottom-chrome";
import Animated from "react-native-reanimated";
import { api } from "@/lib/api";
import { store } from "@/store";
import {
  selectIsCourseDetailStale,
  selectIsCoursesStale,
  setCourseDetail,
  setCourses,
  setCoursesError,
  setCoursesLoading,
  setCoursesRefreshing,
} from "@/store/slices/coursesSlice";
import type { Course } from "@/store/slices/coursesSlice";

// How many top courses to warm into the detail cache so tapping them is instant.
const PREFETCH_COUNT = 5;

function getCourseKey(item: Course | null, index: number) {
  if (!item) return `filler-${index}`;
  return `${item._id || item.slug || item.title || "course"}-${index}`;
}

function pricingLabel(model: Course["pricingModel"]) {
  if (model === "FREE") return { text: "Free", color: "#10b981" };
  if (model === "SUBSCRIPTION_INCLUDED")
    return { text: "Subscription", color: "#0ea5e9" };
  // Play Store compliance: neutral badge instead of a price for paid digital goods.
  return { text: "Premium", color: "#f59e0b" };
}

function formatCompactCount(value?: number | null) {
  if (!value || value <= 0) return "0";
  if (value >= 1000) {
    const compact = value / 1000;
    return `${compact % 1 === 0 ? compact.toFixed(0) : compact.toFixed(1)}k`;
  }
  return value.toLocaleString();
}

type ViewMode = "list" | "grid";

const ENROLLED_GREEN = "#10b981";

type Chapter = Course & {
  type?: "chapter";
};

export default function CoursesScreen() {
  const dispatch = useAppDispatch();
  const { onScroll, scrollEventThrottle, tabBarClearance } = useTabBarScroll();
  const insets = useSafeAreaInsets();
  const { list, isLoading, isRefreshing } = useAppSelector((s) => s.courses);
  const isLoggedIn = !!useAppSelector((s) => s.auth.accessToken);
  const { statusBarStyle, isDark } = useAppTheme();

  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [chapters, setChapters] = useState<Chapter[]>([]);

  const loadCourses = useCallback(
    async (force = false) => {
      const currentCoursesState = store.getState().courses;
      const shouldUseCache = !selectIsCoursesStale(currentCoursesState.lastFetchedAt);
      if (!force && (currentCoursesState.isLoading || shouldUseCache)) return;
      dispatch(setCoursesLoading(true));
      try {
        const [coursesRes, chaptersRes] = await Promise.all([
          api.get("/courses"),
          api.get("/chapters"),
        ]);
        const courses = Array.isArray(coursesRes.data?.courses)
          ? coursesRes.data.courses
          : Array.isArray(coursesRes.data)
            ? coursesRes.data
            : [];
        const chapterItems = Array.isArray(chaptersRes.data?.chapters)
          ? chaptersRes.data.chapters
          : [];
        setChapters(chapterItems);
        dispatch(setCourses(courses));
      } catch (error) {
        console.error("[Courses] Load failed:", error);
        dispatch(setCoursesError("Unable to load courses right now."));
      }
    },
    [dispatch],
  );

  useEffect(() => {
    void loadCourses();
  }, [loadCourses]);

  // Warm the detail cache for the top courses so opening one feels instant.
  // Fire-and-forget; each id is skipped if a fresh copy is already cached.
  const prefetchTopCourseDetails = useCallback(
    async (courses: Course[]) => {
      const targets = courses.slice(0, PREFETCH_COUNT).filter((course) => course?._id);
      if (targets.length === 0) return;

      const cache = store.getState().courses.details;

      await Promise.allSettled(
        targets.map(async (course) => {
          const cached = cache[course._id];
          if (cached && !selectIsCourseDetailStale(cached.fetchedAt)) return;

          try {
            const res = await api.get(`/courses/${course._id}`);
            if (res.data?._id) {
              dispatch(setCourseDetail({ id: course._id, data: res.data }));
            }
          } catch {
            // Best-effort prefetch — ignore failures, the detail screen will
            // load on demand.
          }
        }),
      );
    },
    [dispatch],
  );

  useEffect(() => {
    if (list.length === 0) return;
    void prefetchTopCourseDetails(list);
  }, [list, prefetchTopCourseDetails]);

  const enrolledCourses = useMemo(
    () => list.filter((c) => typeof c.overallProgressPercent === "number"),
    [list],
  );

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.instructorName ?? "").toLowerCase().includes(q) ||
        (c.subject ?? "").toLowerCase().includes(q),
    );
  }, [list, searchQuery]);

  const filteredChapters = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return chapters;
    return chapters.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.instructorName ?? "").toLowerCase().includes(q) ||
        (c.subject ?? "").toLowerCase().includes(q),
    );
  }, [chapters, searchQuery]);

  const gridData = useMemo(() => {
    if (filtered.length % 2 !== 0) return [...filtered, null];
    return filtered;
  }, [filtered]);

  const palette = useMemo(
    () =>
      isDark
        ? {
            bg: "#0E1411",
            sheet: "#141C18",
            subtle: "#19211D",
            subtle2: "#1F2A24",
            text: "#ECF3EF",
            muted: "#93A29B",
            faint: "#6E7E77",
            hair: "#23302A",
            accent: "#2EC592",
            accentSoft: "rgba(46,197,146,0.14)",
            onAccent: "#06231A",
            coverGradient: ["#1f6f57", "#0f5f6e", "#123b5e"] as const,
          }
        : {
            bg: "#FFFFFF",
            sheet: "#FFFFFF",
            subtle: "#F4F7F5",
            subtle2: "#EAF0EC",
            text: "#0F1A16",
            muted: "#6A7B73",
            faint: "#97A8A0",
            hair: "#E9EDEA",
            accent: "#12936A",
            accentSoft: "rgba(18,147,106,0.10)",
            onAccent: "#FFFFFF",
            coverGradient: ["#1f6f57", "#0f5f6e", "#123b5e"] as const,
          },
    [isDark],
  );
  const backgroundColor = palette.bg;
  const borderColor = palette.hair;
  const primaryColor = palette.accent;
  const primarySoftColor = palette.accentSoft;
  const mutedIconColor = palette.muted;
  const textColor = palette.text;
  const subtleCardBg = palette.sheet;
  const subtleShadow = useMemo(
    () =>
      isDark
        ? {}
        : {
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.06,
            shadowRadius: 4,
            elevation: 2,
          },
    [isDark],
  );

  const isEnrolled = useCallback(
    (item: Course) => typeof item.overallProgressPercent === "number",
    [],
  );

  const refreshControl = (
    <RefreshControl
      refreshing={isRefreshing}
      onRefresh={() => {
        dispatch(setCoursesRefreshing(true));
        void loadCourses(true);
      }}
      tintColor={primaryColor}
    />
  );

  /* ── Enrolled Courses horizontal section (rendered as list header) ─── */
  const enrolledHeader = useMemo(() => {
    if (!isLoggedIn || enrolledCourses.length === 0 || searchQuery.trim().length > 0)
      return null;

    return (
      <View style={{ marginBottom: 14 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            marginBottom: 10,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name="play-circle" size={18} color={ENROLLED_GREEN} />
            <Text style={{ fontSize: 15, fontWeight: "700", color: textColor }}>
              My Courses
            </Text>
          </View>
          <Text style={{ fontSize: 12, color: mutedIconColor }}>
            {enrolledCourses.length} enrolled
          </Text>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
        >
          {enrolledCourses.map((item) => {
            const progress = item.overallProgressPercent ?? 0;
            return (
              <Pressable
                key={item._id}
                onPress={() => router.push(`/course/${item._id}` as any)}
                android_ripple={{ color: "rgba(0,0,0,0.06)", borderless: false }}
                style={({ pressed }) => ({
                  width: 200,
                  borderRadius: 14,
                  overflow: "hidden",
                  backgroundColor: subtleCardBg,
                  borderWidth: 1,
                  borderColor: `${ENROLLED_GREEN}40`,
                  opacity: pressed && Platform.OS === "ios" ? 0.85 : 1,
                  transform: [{ scale: pressed && Platform.OS === "ios" ? 0.97 : 1 }],
                  ...subtleShadow,
                })}
              >
                {item.thumbnailUrl ? (
                  <Image
                    source={{ uri: item.thumbnailUrl }}
                    style={{ width: 200, height: 90 }}
                    resizeMode="cover"
                  />
                ) : (
                  <View
                    style={{
                      width: 200,
                      height: 90,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: `${ENROLLED_GREEN}12`,
                    }}
                  >
                    <Ionicons name="book-outline" size={28} color={ENROLLED_GREEN} />
                  </View>
                )}

                <View style={{ padding: 10 }}>
                  <Text
                    numberOfLines={1}
                    style={{ fontSize: 13, fontWeight: "600", color: textColor }}
                  >
                    {item.title}
                  </Text>
                  {item.instructorName ? (
                    <Text
                      numberOfLines={1}
                      style={{ fontSize: 10, color: mutedIconColor, marginTop: 2 }}
                    >
                      {item.instructorName}
                    </Text>
                  ) : null}

                  {/* Progress bar */}
                  <View style={{ marginTop: 8 }}>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 4,
                      }}
                    >
                      <Text
                        style={{ fontSize: 10, fontWeight: "600", color: ENROLLED_GREEN }}
                      >
                        {progress > 0
                          ? `${Math.min(100, Math.round(progress))}% complete`
                          : "Not started"}
                      </Text>
                    </View>
                    <View
                      style={{
                        height: 4,
                        borderRadius: 2,
                        backgroundColor: isDark ? "#334155" : "#e2e8f0",
                      }}
                    >
                      <View
                        style={{
                          height: 4,
                          borderRadius: 2,
                          width: `${Math.min(100, Math.max(0, progress))}%`,
                          backgroundColor: ENROLLED_GREEN,
                        }}
                      />
                    </View>
                  </View>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Separator */}
        <View
          style={{
            height: 1,
            backgroundColor: borderColor,
            marginTop: 14,
            marginHorizontal: 16,
          }}
        />
      </View>
    );
  }, [
    isLoggedIn,
    enrolledCourses,
    searchQuery,
    textColor,
    mutedIconColor,
    subtleCardBg,
    borderColor,
    isDark,
    subtleShadow,
  ]);

  /* ── List item ─── */
  const renderListItem = useCallback(
    ({ item }: { item: Course }) => {
      const label = pricingLabel(item.pricingModel);
      const enrolled = isEnrolled(item);
      return (
        <Pressable
          onPress={() => router.push(`/course/${item._id}` as any)}
          android_ripple={{ color: "rgba(0,0,0,0.06)", borderless: false }}
          style={({ pressed }) => ({
            borderRadius: 16,
            overflow: "hidden",
            backgroundColor: subtleCardBg,
            borderWidth: 1,
            borderColor: enrolled ? `${ENROLLED_GREEN}40` : borderColor,
            opacity: pressed && Platform.OS === "ios" ? 0.85 : 1,
            transform: [{ scale: pressed && Platform.OS === "ios" ? 0.98 : 1 }],
            ...subtleShadow,
          })}
        >
          <View style={{ position: "relative", backgroundColor: palette.subtle2 }}>
            {item.thumbnailUrl ? (
              <ImageBackground
                source={{ uri: item.thumbnailUrl }}
                resizeMode="cover"
                style={{ height: 148 }}
              >
                <LinearGradient
                  colors={["rgba(7,18,14,0)", "rgba(7,18,14,0.58)"]}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: "60%",
                  }}
                />
              </ImageBackground>
            ) : (
              <LinearGradient
                colors={palette.coverGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ height: 148, alignItems: "center", justifyContent: "center" }}
              >
                <Ionicons name="book-outline" size={36} color="rgba(255,255,255,0.86)" />
              </LinearGradient>
            )}

            <View
              style={{
                position: "absolute",
                left: 12,
                bottom: 11,
                flexDirection: "row",
                gap: 8,
                alignItems: "center",
              }}
            >
              <View
                style={{
                  borderRadius: 999,
                  backgroundColor: "rgba(255,255,255,0.92)",
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                }}
              >
                <Text style={{ color: "#0F1A16", fontSize: 11, fontWeight: "800" }}>
                  {item.subject || "Course"}
                </Text>
              </View>
              <View
                style={{
                  borderRadius: 999,
                  backgroundColor: "rgba(0,0,0,0.34)",
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                }}
              >
                <Text style={{ color: "#FFFFFF", fontSize: 11, fontWeight: "800" }}>
                  {item.level || "All levels"}
                </Text>
              </View>
            </View>

            {item.pricingModel === "PAID" ? (
              <View
                style={{
                  position: "absolute",
                  top: 10,
                  right: 10,
                  borderRadius: 999,
                  backgroundColor: "#F4B23E",
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                }}
              >
                <Text
                  style={{
                    color: "#0F1A16",
                    fontSize: 10,
                    fontWeight: "900",
                    letterSpacing: 0.4,
                  }}
                >
                  PREMIUM
                </Text>
              </View>
            ) : null}

            {enrolled ? (
              <View
                style={{
                  position: "absolute",
                  top: 10,
                  left: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  borderRadius: 999,
                  backgroundColor: "rgba(16,185,129,0.92)",
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                }}
              >
                <Ionicons name="checkmark-circle" size={11} color="#fff" />
                <Text style={{ color: "#fff", fontSize: 10, fontWeight: "900" }}>
                  Enrolled
                </Text>
              </View>
            ) : null}
          </View>

          <View style={{ padding: 12 }}>
            <Text
              numberOfLines={2}
              style={{
                color: textColor,
                fontSize: 18,
                lineHeight: 23,
                fontWeight: "900",
              }}
            >
              {item.title}
            </Text>

            {item.description ? (
              <Text
                numberOfLines={2}
                style={{
                  marginTop: 5,
                  color: mutedIconColor,
                  fontSize: 13,
                  lineHeight: 18,
                  fontWeight: "500",
                }}
              >
                {item.description}
              </Text>
            ) : null}

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
                marginTop: 10,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Ionicons name="star" size={14} color="#E0A100" />
                <Text style={{ color: textColor, fontSize: 12, fontWeight: "800" }}>
                  4.8
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Ionicons name="people-outline" size={14} color={mutedIconColor} />
                <Text style={{ color: mutedIconColor, fontSize: 12, fontWeight: "700" }}>
                  {formatCompactCount(item.enrollmentCount)} learners
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Ionicons name="time-outline" size={14} color={mutedIconColor} />
                <Text style={{ color: mutedIconColor, fontSize: 12, fontWeight: "700" }}>
                  {formatDuration(item.totalDurationMinutes)}
                </Text>
              </View>
            </View>

            <View
              style={{
                marginTop: 12,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}
              >
                <View
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: primaryColor,
                  }}
                >
                  <Text
                    style={{ color: palette.onAccent, fontSize: 11, fontWeight: "900" }}
                  >
                    {(item.instructorName || "QC")
                      .trim()
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((part) => part[0]?.toUpperCase())
                      .join("") || "QC"}
                  </Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    numberOfLines={1}
                    style={{ color: textColor, fontSize: 12.5, fontWeight: "800" }}
                  >
                    {item.instructorName || "QuestionCall"}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{ marginTop: 1, color: mutedIconColor, fontSize: 11 }}
                  >
                    {label.text}
                  </Text>
                </View>
              </View>
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: primarySoftColor,
                }}
              >
                <Ionicons name="arrow-forward" size={16} color={primaryColor} />
              </View>
            </View>
          </View>
        </Pressable>
      );
    },
    [
      textColor,
      borderColor,
      primaryColor,
      primarySoftColor,
      mutedIconColor,
      subtleCardBg,
      isEnrolled,
      palette,
      subtleShadow,
    ],
  );

  /* ── Grid item ─── */
  const renderGridItem = useCallback(
    ({ item }: { item: Course | null }) => {
      if (!item) return <View style={{ flex: 1, maxWidth: "50%" }} />;
      const label = pricingLabel(item.pricingModel);
      const enrolled = isEnrolled(item);
      return (
        <Pressable
          onPress={() => router.push(`/course/${item._id}` as any)}
          android_ripple={{ color: "rgba(0,0,0,0.06)", borderless: false }}
          style={({ pressed }) => ({
            flex: 1,
            maxWidth: "50%",
            borderRadius: 14,
            overflow: "hidden",
            backgroundColor: subtleCardBg,
            borderWidth: 1,
            borderColor: enrolled ? `${ENROLLED_GREEN}40` : borderColor,
            opacity: pressed && Platform.OS === "ios" ? 0.85 : 1,
            transform: [{ scale: pressed && Platform.OS === "ios" ? 0.97 : 1 }],
            ...subtleShadow,
          })}
        >
          <View>
            {item.thumbnailUrl ? (
              <Image
                source={{ uri: item.thumbnailUrl }}
                style={{ width: "100%", height: 100 }}
                resizeMode="cover"
              />
            ) : (
              <View
                style={{
                  height: 100,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: primarySoftColor,
                }}
              >
                <Ionicons name="book-outline" size={28} color={primaryColor} />
              </View>
            )}

            {/* Enrolled overlay badge on thumbnail */}
            {enrolled ? (
              <View
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 3,
                  backgroundColor: "rgba(16,185,129,0.9)",
                  borderRadius: 6,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                }}
              >
                <Ionicons name="checkmark-circle" size={10} color="#fff" />
                <Text style={{ fontSize: 9, fontWeight: "700", color: "#fff" }}>
                  Enrolled
                </Text>
              </View>
            ) : null}
          </View>

          <View style={{ padding: 10 }}>
            <Text
              numberOfLines={2}
              style={{
                fontSize: 12,
                fontWeight: "600",
                color: textColor,
                lineHeight: 16,
                marginBottom: 4,
              }}
            >
              {item.title}
            </Text>
            {item.instructorName ? (
              <Text
                numberOfLines={1}
                style={{ fontSize: 10, color: mutedIconColor, marginBottom: 6 }}
              >
                {item.instructorName}
              </Text>
            ) : null}
            <View
              style={{
                alignSelf: "flex-start",
                backgroundColor: `${label.color}15`,
                borderRadius: 5,
                paddingHorizontal: 6,
                paddingVertical: 2,
              }}
            >
              <Text style={{ fontSize: 10, fontWeight: "700", color: label.color }}>
                {label.text}
              </Text>
            </View>
          </View>
        </Pressable>
      );
    },
    [
      textColor,
      borderColor,
      primaryColor,
      primarySoftColor,
      mutedIconColor,
      subtleCardBg,
      isEnrolled,
      subtleShadow,
    ],
  );

  const listSeparator = useCallback(
    () => (
      <View
        style={{
          height: 18,
          justifyContent: "center",
          paddingHorizontal: 18,
        }}
      >
        <View
          style={{
            height: 1,
            borderRadius: 1,
            backgroundColor: palette.hair,
            opacity: isDark ? 0.7 : 0.9,
          }}
        />
      </View>
    ),
    [isDark, palette.hair],
  );

  const chaptersHeader = useMemo(() => {
    if (filteredChapters.length === 0) return enrolledHeader;

    return (
      <View>
        {enrolledHeader}
        <View style={{ marginBottom: 14 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 16,
              marginBottom: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="albums-outline" size={18} color={primaryColor} />
              <Text style={{ fontSize: 15, fontWeight: "700", color: textColor }}>
                Chapters
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: mutedIconColor }}>
              {filteredChapters.length}
            </Text>
          </View>
          <View style={{ paddingHorizontal: 16, gap: 10 }}>
            {filteredChapters.map((item) => {
              const label = pricingLabel(item.pricingModel);
              const enrolled = isEnrolled(item);
              return (
                <Pressable
                  key={item._id}
                  onPress={() => router.push(`/chapter/${item._id}` as any)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    borderWidth: 1,
                    borderColor: enrolled ? `${ENROLLED_GREEN}40` : borderColor,
                    borderRadius: 14,
                    backgroundColor: subtleCardBg,
                    padding: 12,
                    opacity: pressed && Platform.OS === "ios" ? 0.85 : 1,
                    ...subtleShadow,
                  })}
                >
                  <View
                    style={{
                      width: 54,
                      height: 54,
                      borderRadius: 14,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: primarySoftColor,
                    }}
                  >
                    <Ionicons name="albums-outline" size={24} color={primaryColor} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      numberOfLines={2}
                      style={{ color: textColor, fontWeight: "700" }}
                    >
                      {item.title}
                    </Text>
                    <Text style={{ marginTop: 3, color: mutedIconColor, fontSize: 11 }}>
                      {item.instructorName ?? "Teacher"} · {item.subject ?? "Chapter"}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
                      <View
                        style={{
                          backgroundColor: `${label.color}15`,
                          borderRadius: 6,
                          paddingHorizontal: 7,
                          paddingVertical: 2,
                        }}
                      >
                        <Text
                          style={{ color: label.color, fontSize: 10, fontWeight: "800" }}
                        >
                          {label.text}
                        </Text>
                      </View>
                      <View
                        style={{
                          backgroundColor: primarySoftColor,
                          borderRadius: 6,
                          paddingHorizontal: 7,
                          paddingVertical: 2,
                        }}
                      >
                        <Text
                          style={{ color: primaryColor, fontSize: 10, fontWeight: "800" }}
                        >
                          Chapter
                        </Text>
                      </View>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={mutedIconColor} />
                </Pressable>
              );
            })}
          </View>
          {filtered.length > 0 ? (
            <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: textColor }}>
                Courses
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    );
  }, [
    borderColor,
    enrolledHeader,
    filtered.length,
    filteredChapters,
    isEnrolled,
    mutedIconColor,
    primaryColor,
    primarySoftColor,
    subtleCardBg,
    subtleShadow,
    textColor,
  ]);

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + 10,
          paddingBottom: 8,
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
            marginBottom: 10,
          }}
        >
          <View>
            <Text style={{ fontSize: 26, fontWeight: "700", color: textColor }}>
              Courses
            </Text>
            <Text style={{ fontSize: 12, color: mutedIconColor, marginTop: 1 }}>
              Learn from expert teachers
            </Text>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {/* Notes icon button */}
            <Pressable
              onPress={() => router.push("/notes" as any)}
              android_ripple={{ color: `${primaryColor}30`, borderless: true }}
              style={({ pressed }) => ({
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: pressed ? `${primaryColor}25` : primarySoftColor,
              })}
            >
              <Ionicons name="document-text-outline" size={18} color={primaryColor} />
            </Pressable>

            {/* View toggle */}
            <View
              style={{
                flexDirection: "row",
                borderRadius: 10,
                overflow: "hidden",
                borderWidth: 1,
                borderColor,
              }}
            >
              <Pressable
                onPress={() => setViewMode("list")}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                  backgroundColor: viewMode === "list" ? primaryColor : "transparent",
                }}
              >
                <Ionicons
                  name="list-outline"
                  size={15}
                  color={viewMode === "list" ? "#fff" : mutedIconColor}
                />
              </Pressable>
              <Pressable
                onPress={() => setViewMode("grid")}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                  backgroundColor: viewMode === "grid" ? primaryColor : "transparent",
                }}
              >
                <Ionicons
                  name="grid-outline"
                  size={15}
                  color={viewMode === "grid" ? "#fff" : mutedIconColor}
                />
              </Pressable>
            </View>
          </View>
        </View>

        {/* Search bar */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: isDark ? "#1e293b" : "#f1f5f9",
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: Platform.OS === "ios" ? 10 : 6,
            gap: 8,
          }}
        >
          <Ionicons name="search-outline" size={16} color={mutedIconColor} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search courses, teachers..."
            placeholderTextColor={mutedIconColor}
            style={{ flex: 1, fontSize: 14, color: textColor, padding: 0 }}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 && Platform.OS !== "ios" && (
            <Pressable onPress={() => setSearchQuery("")} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={mutedIconColor} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Body */}
      {isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={primaryColor} size="large" />
        </View>
      ) : filtered.length === 0 && filteredChapters.length === 0 ? (
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
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: primarySoftColor,
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 16,
            }}
          >
            <Ionicons
              name={searchQuery ? "search-outline" : "book-outline"}
              size={28}
              color={primaryColor}
            />
          </View>
          <Text
            style={{
              fontSize: 17,
              fontWeight: "600",
              color: textColor,
              textAlign: "center",
              marginBottom: 6,
            }}
          >
            {searchQuery ? `No results for "${searchQuery}"` : "No courses yet"}
          </Text>
          {searchQuery ? (
            <Pressable onPress={() => setSearchQuery("")}>
              <Text style={{ fontSize: 14, color: primaryColor, fontWeight: "500" }}>
                Clear search
              </Text>
            </Pressable>
          ) : (
            <Text style={{ fontSize: 14, color: mutedIconColor, textAlign: "center" }}>
              Courses will appear here once teachers publish them.
            </Text>
          )}
        </View>
      ) : viewMode === "list" ? (
        <Animated.FlatList
          key="course-list"
          data={filtered}
          keyExtractor={(item, index) => getCourseKey(item, index)}
          refreshControl={refreshControl}
          // The tab bar floats over the list, so the list reserves its height.
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 24 + tabBarClearance,
          }}
          ListHeaderComponent={chaptersHeader}
          ItemSeparatorComponent={listSeparator}
          onScroll={onScroll}
          scrollEventThrottle={scrollEventThrottle}
          showsVerticalScrollIndicator={false}
          renderItem={renderListItem}
        />
      ) : (
        <Animated.FlatList
          key="course-grid"
          data={gridData}
          keyExtractor={(item, index) =>
            item ? getCourseKey(item, index) : `filler-${index}`
          }
          refreshControl={refreshControl}
          numColumns={2}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 24 + tabBarClearance,
          }}
          ListHeaderComponent={chaptersHeader}
          columnWrapperStyle={{ gap: 10, marginBottom: 10 }}
          onScroll={onScroll}
          scrollEventThrottle={scrollEventThrottle}
          showsVerticalScrollIndicator={false}
          renderItem={renderGridItem}
        />
      )}
    </View>
  );
}
