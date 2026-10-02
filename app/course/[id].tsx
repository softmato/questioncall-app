import { formatDuration } from "@/lib/duration";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Image,
  ImageBackground,
  RefreshControl,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Toast from "react-native-toast-message";

import { AuthNotice } from "@/components/auth/auth-notice";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api } from "@/lib/api";
import { store } from "@/store";
import { openWebCheckout } from "@/lib/web-checkout";
import type { Course } from "@/store/slices/coursesSlice";
import {
  patchCourseDetailFavourite,
  patchCourseDetailFollow,
  selectIsCourseDetailStale,
  setCourseDetail,
} from "@/store/slices/coursesSlice";
import { updateUser } from "@/store/slices/userSlice";

type CourseVideo = {
  _id: string;
  title: string;
  durationMinutes?: number | null;
  thumbnailUrl?: string | null;
  order?: number;
};

type CourseSection = {
  _id: string;
  title: string;
  description?: string | null;
  order?: number;
  durationMinutes?: number | null;
  videos: CourseVideo[];
};

type CourseDetail = Course & {
  sections: CourseSection[];
  overallProgressPercent?: number;
  totalDurationMinutes?: number | null;
  enrollmentCount?: number;
  freePreviewCount?: number;
  instructorId?: string;
  instructorRole?: string;
  tags?: string[];
  averageRating?: number;
  rating?: number;
  reviewCount?: number;
  reviews?: number;
  isFavourite?: boolean;
  isFollowingInstructor?: boolean;
  instructorFollowerCount?: number;
  [key: string]: unknown;
};

function formatCompactCount(value?: number | null) {
  if (!value || value <= 0) return "0";
  if (value >= 1000) {
    const compact = value / 1000;
    return `${compact % 1 === 0 ? compact.toFixed(0) : compact.toFixed(1)}k`;
  }
  return value.toLocaleString();
}

function getInitials(name?: string | null) {
  const parts = (name || "QuestionCall").trim().split(/\s+/).filter(Boolean).slice(0, 2);

  return parts.map((part) => part[0]?.toUpperCase()).join("") || "QC";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCourseDetail(
  data: CourseDetail | Course | null | undefined,
): CourseDetail | null {
  if (!isRecord(data)) return null;

  const rawSections: unknown[] = Array.isArray(data.sections) ? data.sections : [];
  const sections = rawSections.map((rawSection, index) => {
    const section: Record<string, unknown> = isRecord(rawSection) ? rawSection : {};
    const rawVideos: unknown[] = Array.isArray(section.videos) ? section.videos : [];
    const videos = rawVideos.map((rawVideo, videoIndex) => {
      const video: Record<string, unknown> = isRecord(rawVideo) ? rawVideo : {};

      return {
        ...(video as object),
        _id: String(video._id ?? `video-${index}-${videoIndex}`),
        title: String(video.title ?? "Untitled lesson"),
      } as CourseVideo;
    });

    return {
      ...(section as object),
      _id: String(section._id ?? `section-${index}`),
      title: String(section.title ?? "Untitled section"),
      videos,
    } as CourseSection;
  });

  return { ...data, sections } as CourseDetail;
}

class CourseDetailErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || "Unable to open this course." };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[CourseDetail] render crash", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#ffffff",
            padding: 24,
          }}
        >
          <Ionicons name="alert-circle-outline" size={42} color="#ef4444" />
          <Text
            style={{
              marginTop: 12,
              color: "#111827",
              fontSize: 16,
              fontWeight: "800",
              textAlign: "center",
            }}
          >
            Unable to open this course
          </Text>
          <Text
            style={{
              marginTop: 8,
              color: "#6b7280",
              fontSize: 13,
              lineHeight: 19,
              textAlign: "center",
            }}
          >
            Please go back and try again after refreshing the course list.
          </Text>
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              marginTop: 18,
              borderRadius: 999,
              backgroundColor: "#12936A",
              paddingHorizontal: 18,
              paddingVertical: 11,
            }}
          >
            <Text style={{ color: "#ffffff", fontSize: 14, fontWeight: "800" }}>
              Go back
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

function CourseDetailScreenContent() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const courseId = Array.isArray(id) ? id[0] : id;
  const cachedCourse = useAppSelector((state) =>
    state.courses.list.find((course) => course._id === courseId),
  );
  const cachedDetail = useAppSelector((state) =>
    courseId ? state.courses.details[courseId] : undefined,
  );
  const dispatch = useAppDispatch();
  const user = useAppSelector((state) => state.user.data);
  const userRole = user?.role;
  const currentUserId = user?._id;
  const { statusBarStyle, mutedIconColor, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();

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
            star: "#F0B83A",
            coverGradient: ["#1f6f57", "#0f5f6e", "#123b5e"] as const,
            footerFade: "rgba(14,20,17,0)",
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
            star: "#E0A100",
            coverGradient: ["#1f6f57", "#0f5f6e", "#123b5e"] as const,
            footerFade: "rgba(255,255,255,0)",
          },
    [isDark],
  );

  // Seed from the prefetched full detail (instant render with sections) when
  // available, otherwise from the list summary, otherwise nothing.
  const initialDetail = normalizeCourseDetail(
    (cachedDetail?.data as CourseDetail | undefined) ?? cachedCourse,
  );
  const [course, setCourse] = useState<CourseDetail | null>(initialDetail);
  // Whether we already have the full detail (with sections) on screen — used to
  // suppress the full-screen loader during background revalidation.
  const hasDetailRef = useRef<boolean>(Boolean(initialDetail));
  const [isLoading, setIsLoading] = useState(!initialDetail);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [showCoupon, setShowCoupon] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [isFavourite, setIsFavourite] = useState(false);
  const [isTogglingFav, setIsTogglingFav] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const [isTogglingFollow, setIsTogglingFollow] = useState(false);

  const loadCourse = useCallback(
    async (force = false) => {
      if (!courseId) {
        setError("Course id is missing.");
        setIsLoading(false);
        return;
      }

      if (force) {
        setIsRefreshing(true);
      } else if (!hasDetailRef.current) {
        // Only block with the full-screen loader when there's nothing to show.
        setIsLoading(true);
      }

      setError(null);

      try {
        const res = await api.get(`/courses/${courseId}`);
        const nextCourse = normalizeCourseDetail(res.data as CourseDetail);
        setCourse(nextCourse);
        hasDetailRef.current = true;
        if (nextCourse?._id) {
          dispatch(setCourseDetail({ id: courseId, data: nextCourse }));
        }
      } catch (err: any) {
        setError(
          err?.response?.data?.error ??
            err?.response?.data?.message ??
            "Unable to load this course right now.",
        );
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [courseId, dispatch],
  );

  useEffect(() => {
    // Render instantly from the prefetched cache; only hit the network when the
    // cached copy is missing or stale (stale-while-revalidate, no blocking spinner).
    const entry = courseId ? store.getState().courses.details[courseId] : undefined;
    if (entry && !selectIsCourseDetailStale(entry.fetchedAt)) return;
    void loadCourse();
  }, [courseId, loadCourse]);

  useEffect(() => {
    if (course?.overallProgressPercent != null) setIsEnrolled(true);
  }, [course?.overallProgressPercent]);

  const handleEnroll = useCallback(
    async (code?: string) => {
      if (!courseId) return;
      setIsEnrolling(true);
      try {
        const body: any = {};
        if (code?.trim()) body.couponCode = code.trim();
        await api.post(`/courses/${courseId}/enroll`, body);
        setIsEnrolled(true);
        Toast.show({ type: "success", text1: "Enrolled!", text2: "Happy learning." });
        void loadCourse(true);
      } catch (err: any) {
        const msg = err?.response?.data?.error ?? "";
        const reason = err?.response?.data?.reason ?? "";
        if (msg.includes("PAID_COURSE_USE_PURCHASE_FLOW")) {
          await openWebCheckout("course", courseId, () => loadCourse(true));
        } else if (reason === "SUBSCRIPTION_REQUIRED") {
          await openWebCheckout("subscription", undefined, () => loadCourse(true));
        } else {
          Toast.show({
            type: "error",
            text1: "Enrollment Failed",
            text2: msg || "Try again.",
          });
        }
      } finally {
        setIsEnrolling(false);
      }
    },
    [courseId, loadCourse],
  );

  const handlePurchase = useCallback(() => {
    if (!courseId || !course) return;
    if (course.pricingModel === "PAID") {
      void openWebCheckout("course", courseId, () => loadCourse(true));
    }
  }, [courseId, course, loadCourse]);

  // Sync favourite / follow state whenever the course payload refreshes.
  const loadedCourseId = course?._id;
  const favouriteFlag = course?.isFavourite;
  const followingFlag = course?.isFollowingInstructor;
  const followerCountValue = course?.instructorFollowerCount;
  useEffect(() => {
    if (!loadedCourseId) return;
    setIsFavourite(Boolean(favouriteFlag));
    setIsFollowing(Boolean(followingFlag));
    setFollowerCount(followerCountValue ?? 0);
  }, [loadedCourseId, favouriteFlag, followingFlag, followerCountValue]);

  const toggleFavourite = useCallback(async () => {
    if (!courseId || isTogglingFav) return;
    if (!currentUserId) {
      Toast.show({ type: "info", text1: "Sign in to save favourites." });
      return;
    }

    const next = !isFavourite;
    setIsFavourite(next); // optimistic
    setIsTogglingFav(true);
    try {
      if (next) {
        await api.post(`/courses/${courseId}/favourite`);
      } else {
        await api.delete(`/courses/${courseId}/favourite`);
      }
      const existing = user?.favouriteCourses ?? [];
      const favouriteCourses = Array.isArray(existing) ? existing : [];
      dispatch(
        updateUser({
          favouriteCourses: next
            ? Array.from(new Set(favouriteCourses.concat(courseId)))
            : favouriteCourses.filter((favId) => favId !== courseId),
        }),
      );
      dispatch(patchCourseDetailFavourite({ id: courseId, isFavourite: next }));
    } catch (err: any) {
      setIsFavourite(!next); // revert
      Toast.show({
        type: "error",
        text1: next ? "Couldn't save favourite" : "Couldn't remove favourite",
        text2: err?.response?.data?.error ?? "Please try again.",
      });
    } finally {
      setIsTogglingFav(false);
    }
  }, [
    courseId,
    currentUserId,
    isFavourite,
    isTogglingFav,
    user?.favouriteCourses,
    dispatch,
  ]);

  const toggleFollow = useCallback(async () => {
    const instructorId = course?.instructorId;
    if (!instructorId || isTogglingFollow) return;
    if (!currentUserId) {
      Toast.show({ type: "info", text1: "Sign in to follow teachers." });
      return;
    }

    const next = !isFollowing;
    setIsFollowing(next); // optimistic
    setFollowerCount((count) => Math.max(0, count + (next ? 1 : -1)));
    setIsTogglingFollow(true);
    try {
      const res = next
        ? await api.post(`/teachers/${instructorId}/follow`)
        : await api.delete(`/teachers/${instructorId}/follow`);
      const resolvedCount =
        typeof res.data?.followerCount === "number"
          ? res.data.followerCount
          : Math.max(0, followerCount + (next ? 1 : -1));
      setFollowerCount(resolvedCount);
      const existing = user?.following ?? [];
      const following = Array.isArray(existing) ? existing : [];
      dispatch(
        updateUser({
          following: next
            ? Array.from(new Set(following.concat(instructorId)))
            : following.filter((teacherId) => teacherId !== instructorId),
        }),
      );
      dispatch(
        patchCourseDetailFollow({
          instructorId,
          isFollowing: next,
          followerCount: resolvedCount,
        }),
      );
    } catch (err: any) {
      setIsFollowing(!next); // revert
      setFollowerCount((count) => Math.max(0, count + (next ? -1 : 1)));
      Toast.show({
        type: "error",
        text1: "Action failed",
        text2: err?.response?.data?.error ?? "Please try again.",
      });
    } finally {
      setIsTogglingFollow(false);
    }
  }, [
    course?.instructorId,
    currentUserId,
    isFollowing,
    isTogglingFollow,
    followerCount,
    user?.following,
    dispatch,
  ]);

  const totalVideos = useMemo(
    () =>
      course?.sections?.reduce(
        (count, section) =>
          count + (Array.isArray(section.videos) ? section.videos.length : 0),
        0,
      ) ?? 0,
    [course],
  );

  const freePreviewVideoIds = useMemo(() => {
    const previewCount = course?.freePreviewCount ?? 0;
    if (!course || previewCount <= 0) return new Set<string>();

    const sections = Array.isArray(course.sections) ? course.sections.slice() : [];
    const orderedVideos = sections
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .flatMap((section) => {
        const videos = Array.isArray(section.videos) ? section.videos.slice() : [];
        return videos.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      });

    return new Set(orderedVideos.slice(0, previewCount).map((video) => video._id));
  }, [course]);

  if (isLoading && !course) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: palette.bg,
        }}
      >
        <StatusBar barStyle={statusBarStyle} backgroundColor={palette.bg} />
        <ActivityIndicator color={palette.accent} size="large" />
      </View>
    );
  }

  if (!course && error) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.bg, padding: 18 }}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={palette.bg} />
        <View style={{ paddingTop: insets.top + 18 }}>
          <AuthNotice tone="error" message={error} />
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              alignSelf: "flex-start",
              marginTop: 16,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: palette.hair,
              backgroundColor: palette.sheet,
              paddingHorizontal: 16,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: palette.text, fontSize: 14, fontWeight: "700" }}>
              Go back
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const activeCourse = course;
  if (!activeCourse) return null;

  const rating = activeCourse.averageRating ?? activeCourse.rating ?? 4.8;
  const reviews = activeCourse.reviewCount ?? activeCourse.reviews ?? 0;
  const instructorName = activeCourse.instructorName || "QuestionCall";
  const instructorRole = activeCourse.instructorRole || "Course instructor";
  const courseSections = Array.isArray(activeCourse.sections)
    ? activeCourse.sections
    : [];
  const totalSections = courseSections.length;
  const firstVideo = courseSections[0]?.videos?.[0];
  // Only teachers can be followed, and never yourself.
  const canFollowInstructor =
    Boolean(activeCourse.instructorId) &&
    activeCourse.instructorRole === "TEACHER" &&
    activeCourse.instructorId !== currentUserId;
  const footerHeight = userRole === "STUDENT" || isEnrolled ? 102 + insets.bottom : 0;

  const startFirstVideo = () => {
    if (!firstVideo || !courseId) return;
    router.push({
      pathname: "/course/video" as any,
      params: {
        courseId,
        videoId: firstVideo._id,
        title: firstVideo.title,
      },
    });
  };

  const ctaLabel = isEnrolled
    ? (activeCourse.overallProgressPercent ?? 0) > 0
      ? "Continue learning"
      : "Start learning"
    : activeCourse.pricingModel === "PAID"
      ? "Unlock in your browser"
      : activeCourse.pricingModel === "FREE"
        ? "Enroll for free"
        : "Enroll with subscription";

  const handlePrimaryAction = () => {
    if (isEnrolled) {
      startFirstVideo();
      return;
    }
    if (activeCourse.pricingModel === "PAID") {
      handlePurchase();
      return;
    }
    void handleEnroll(couponCode);
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={palette.bg} />

      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => void loadCourse(true)}
            tintColor={palette.accent}
          />
        }
        contentContainerStyle={{
          paddingBottom: Math.max(28, footerHeight + 22),
        }}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: insets.top + 8,
            paddingHorizontal: 16,
            paddingBottom: 10,
          }}
        >
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: palette.subtle,
            }}
          >
            <Ionicons name="arrow-back-outline" size={20} color={palette.text} />
          </TouchableOpacity>

          <View style={{ flexDirection: "row", gap: 8 }}>
            <View
              style={{
                height: 40,
                borderRadius: 20,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: palette.subtle,
                paddingHorizontal: 14,
              }}
            >
              <Text style={{ color: palette.muted, fontSize: 12, fontWeight: "700" }}>
                {totalSections} section{totalSections === 1 ? "" : "s"}
              </Text>
            </View>
            <TouchableOpacity
              onPress={toggleFavourite}
              disabled={isTogglingFav}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={
                isFavourite ? "Remove from favourites" : "Add to favourites"
              }
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: isFavourite ? palette.accentSoft : palette.subtle,
              }}
            >
              {isTogglingFav ? (
                <ActivityIndicator size="small" color={palette.accent} />
              ) : (
                <Ionicons
                  name={isFavourite ? "bookmark" : "bookmark-outline"}
                  size={18}
                  color={isFavourite ? palette.accent : palette.text}
                />
              )}
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ paddingHorizontal: 18 }}>
          <View
            style={{
              position: "relative",
              overflow: "hidden",
              borderRadius: 24,
              backgroundColor: palette.subtle2,
            }}
          >
            {activeCourse.thumbnailUrl ? (
              <ImageBackground
                source={{ uri: activeCourse.thumbnailUrl }}
                resizeMode="cover"
                style={{ aspectRatio: 16 / 10 }}
              >
                <LinearGradient
                  colors={["rgba(7,18,14,0)", "rgba(7,18,14,0.58)"]}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: "58%",
                  }}
                />
              </ImageBackground>
            ) : (
              <LinearGradient
                colors={palette.coverGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ aspectRatio: 16 / 10 }}
              >
                <View
                  style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons
                    name="book-outline"
                    size={44}
                    color="rgba(255,255,255,0.86)"
                  />
                </View>
              </LinearGradient>
            )}

            <View
              style={{
                position: "absolute",
                left: 14,
                bottom: 13,
                flexDirection: "row",
                gap: 8,
              }}
            >
              <View
                style={{
                  borderRadius: 999,
                  backgroundColor: "rgba(255,255,255,0.92)",
                  paddingHorizontal: 11,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ color: "#0F1A16", fontSize: 12, fontWeight: "800" }}>
                  {activeCourse.subject || "Course"}
                </Text>
              </View>
              <View
                style={{
                  borderRadius: 999,
                  backgroundColor: "rgba(0,0,0,0.34)",
                  paddingHorizontal: 11,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "800" }}>
                  {activeCourse.level || "All levels"}
                </Text>
              </View>
            </View>

            {activeCourse.pricingModel === "PAID" ? (
              <View
                style={{
                  position: "absolute",
                  top: 12,
                  right: 12,
                  borderRadius: 999,
                  backgroundColor: "#F4B23E",
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                }}
              >
                <Text
                  style={{
                    color: "#0F1A16",
                    fontSize: 11,
                    fontWeight: "900",
                    letterSpacing: 0.4,
                  }}
                >
                  PREMIUM
                </Text>
              </View>
            ) : null}
          </View>

          <Text
            style={{
              marginTop: 20,
              marginHorizontal: 2,
              color: palette.text,
              fontSize: 27,
              lineHeight: 32,
              fontWeight: "900",
            }}
          >
            {activeCourse.title}
          </Text>
          <Text
            style={{
              marginTop: 6,
              marginHorizontal: 2,
              color: palette.muted,
              fontSize: 15,
              lineHeight: 22,
              fontWeight: "500",
            }}
          >
            {activeCourse.description || "Course details and lessons"}
          </Text>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 16,
              marginTop: 15,
              marginHorizontal: 2,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="star" size={16} color={palette.star} />
              <Text style={{ color: palette.text, fontSize: 14, fontWeight: "800" }}>
                {rating.toFixed(1)}
              </Text>
              {reviews > 0 ? (
                <Text style={{ color: palette.faint, fontSize: 14, fontWeight: "700" }}>
                  ({reviews})
                </Text>
              ) : null}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="people-outline" size={16} color={palette.muted} />
              <Text style={{ color: palette.muted, fontSize: 14, fontWeight: "700" }}>
                {formatCompactCount(activeCourse.enrollmentCount)} learners
              </Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="time-outline" size={16} color={palette.muted} />
              <Text style={{ color: palette.muted, fontSize: 14, fontWeight: "700" }}>
                {formatDuration(activeCourse.totalDurationMinutes)}
              </Text>
            </View>
          </View>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              marginTop: 18,
              borderRadius: 16,
              backgroundColor: palette.subtle,
              paddingHorizontal: 14,
              paddingVertical: 12,
            }}
          >
            <View
              style={{
                width: 42,
                height: 42,
                borderRadius: 21,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: palette.accent,
              }}
            >
              <Text style={{ color: palette.onAccent, fontSize: 15, fontWeight: "900" }}>
                {getInitials(instructorName)}
              </Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{ color: palette.text, fontSize: 14.5, fontWeight: "800" }}
              >
                {instructorName}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  marginTop: 2,
                  color: palette.muted,
                  fontSize: 12.5,
                  fontWeight: "600",
                }}
              >
                {instructorRole}
                {followerCount > 0
                  ? ` · ${formatCompactCount(followerCount)} ${followerCount === 1 ? "follower" : "followers"}`
                  : ""}
              </Text>
            </View>
            {canFollowInstructor ? (
              <TouchableOpacity
                onPress={toggleFollow}
                disabled={isTogglingFollow}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={isFollowing ? "Unfollow teacher" : "Follow teacher"}
                style={{
                  minWidth: 96,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1.5,
                  borderColor: palette.accent,
                  backgroundColor: isFollowing ? palette.accent : "transparent",
                  borderRadius: 999,
                  paddingHorizontal: 15,
                  paddingVertical: 7,
                }}
              >
                {isTogglingFollow ? (
                  <ActivityIndicator
                    size="small"
                    color={isFollowing ? palette.onAccent : palette.accent}
                  />
                ) : (
                  <Text
                    style={{
                      color: isFollowing ? palette.onAccent : palette.accent,
                      fontSize: 13,
                      fontWeight: "800",
                    }}
                  >
                    {isFollowing ? "Following" : "Follow"}
                  </Text>
                )}
              </TouchableOpacity>
            ) : null}
          </View>

          {typeof activeCourse.overallProgressPercent === "number" ? (
            <View style={{ marginTop: 16 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: palette.muted, fontSize: 12, fontWeight: "800" }}>
                  Your progress
                </Text>
                <Text style={{ color: palette.text, fontSize: 12, fontWeight: "900" }}>
                  {Math.min(100, Math.round(activeCourse.overallProgressPercent))}%
                </Text>
              </View>
              <View
                style={{
                  marginTop: 8,
                  height: 7,
                  borderRadius: 999,
                  backgroundColor: palette.subtle2,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: `${Math.min(100, Math.max(0, activeCourse.overallProgressPercent))}%`,
                    height: "100%",
                    borderRadius: 999,
                    backgroundColor: palette.accent,
                  }}
                />
              </View>
            </View>
          ) : null}

          {error ? (
            <View style={{ marginTop: 16 }}>
              <AuthNotice tone="error" message={error} />
            </View>
          ) : null}

          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 26,
              marginHorizontal: 2,
              marginBottom: 12,
            }}
          >
            <Text style={{ color: palette.text, fontSize: 18, fontWeight: "900" }}>
              Course content
            </Text>
            <Text style={{ color: palette.muted, fontSize: 13, fontWeight: "700" }}>
              {totalVideos} lesson{totalVideos === 1 ? "" : "s"} -{" "}
              {formatDuration(activeCourse.totalDurationMinutes)}
            </Text>
          </View>

          <View style={{ gap: 10 }}>
            {courseSections.length > 0 ? (
              courseSections.map((section, sectionIndex) => {
                const isLocked = !isEnrolled && activeCourse.pricingModel !== "FREE";
                const isOpen = openSections[section._id] ?? sectionIndex === 0;

                return (
                  <View
                    key={section._id}
                    style={{
                      overflow: "hidden",
                      borderRadius: 18,
                      borderWidth: 1,
                      borderColor: palette.hair,
                      backgroundColor: palette.sheet,
                    }}
                  >
                    <TouchableOpacity
                      activeOpacity={0.72}
                      onPress={() =>
                        setOpenSections((current) => ({
                          ...(isRecord(current) ? current : {}),
                          [section._id]: !isOpen,
                        }))
                      }
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 13,
                        padding: 14,
                      }}
                    >
                      <View
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 11,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: palette.accentSoft,
                        }}
                      >
                        <Text
                          style={{
                            color: palette.accent,
                            fontSize: 14,
                            fontWeight: "900",
                          }}
                        >
                          {String(sectionIndex + 1).padStart(2, "0")}
                        </Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          numberOfLines={1}
                          style={{ color: palette.text, fontSize: 15, fontWeight: "800" }}
                        >
                          {section.title}
                        </Text>
                        <Text
                          style={{
                            marginTop: 2,
                            color: palette.muted,
                            fontSize: 12.5,
                            fontWeight: "600",
                          }}
                        >
                          {section.videos.length} lessons
                        </Text>
                      </View>
                      {isLocked && sectionIndex > 0 ? (
                        <Ionicons
                          name="lock-closed-outline"
                          size={15}
                          color={palette.faint}
                        />
                      ) : null}
                      <Ionicons
                        name={isOpen ? "chevron-down" : "chevron-forward"}
                        size={20}
                        color={palette.faint}
                      />
                    </TouchableOpacity>

                    {isOpen ? (
                      <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
                        {section.description ? (
                          <Text
                            style={{
                              paddingHorizontal: 8,
                              paddingBottom: 8,
                              color: palette.muted,
                              fontSize: 12.5,
                              lineHeight: 18,
                              fontWeight: "500",
                            }}
                          >
                            {section.description}
                          </Text>
                        ) : null}

                        {section.videos.length > 0 ? (
                          section.videos.map((video, videoIndex) => {
                            const isPreviewVideo = freePreviewVideoIds.has(video._id);
                            const videoLocked = isLocked && !isPreviewVideo;
                            const canPlay = !videoLocked;

                            const row = (
                              <View
                                style={{
                                  flexDirection: "row",
                                  alignItems: "center",
                                  gap: 12,
                                  borderTopWidth: videoIndex === 0 ? 0 : 1,
                                  borderTopColor: palette.hair,
                                  paddingHorizontal: 8,
                                  paddingVertical: 11,
                                  opacity: videoLocked ? 0.56 : 1,
                                }}
                              >
                                <View
                                  style={{
                                    width: 34,
                                    height: 34,
                                    borderRadius: 17,
                                    alignItems: "center",
                                    justifyContent: "center",
                                    overflow: "hidden",
                                    backgroundColor: palette.subtle,
                                  }}
                                >
                                  {video.thumbnailUrl && !videoLocked ? (
                                    <Image
                                      source={{ uri: video.thumbnailUrl }}
                                      style={{ width: "100%", height: "100%" }}
                                      resizeMode="cover"
                                    />
                                  ) : (
                                    <Ionicons
                                      name={videoLocked ? "lock-closed-outline" : "play"}
                                      size={videoLocked ? 16 : 15}
                                      color={videoLocked ? palette.faint : palette.accent}
                                    />
                                  )}
                                </View>
                                <View style={{ flex: 1, minWidth: 0 }}>
                                  <Text
                                    numberOfLines={2}
                                    style={{
                                      color: palette.text,
                                      fontSize: 14,
                                      lineHeight: 19,
                                      fontWeight: "700",
                                    }}
                                  >
                                    {video.title}
                                  </Text>
                                  <Text
                                    style={{
                                      marginTop: 1,
                                      color: palette.faint,
                                      fontSize: 12,
                                      fontWeight: "600",
                                    }}
                                  >
                                    {formatDuration(video.durationMinutes)}
                                  </Text>
                                </View>
                                {isPreviewVideo && !isEnrolled ? (
                                  <Text
                                    style={{
                                      color: palette.accent,
                                      fontSize: 11,
                                      fontWeight: "900",
                                      letterSpacing: 0.3,
                                    }}
                                  >
                                    FREE
                                  </Text>
                                ) : videoLocked ? (
                                  <Ionicons
                                    name="lock-closed-outline"
                                    size={15}
                                    color={palette.faint}
                                  />
                                ) : (
                                  <Ionicons
                                    name="play-circle"
                                    size={20}
                                    color={palette.accent}
                                  />
                                )}
                              </View>
                            );

                            return canPlay ? (
                              <TouchableOpacity
                                key={video._id}
                                activeOpacity={0.72}
                                onPress={() =>
                                  router.push({
                                    pathname: "/course/video" as any,
                                    params: {
                                      courseId: courseId!,
                                      videoId: video._id,
                                      title: video.title,
                                      isPreview: isPreviewVideo ? "1" : "0",
                                    },
                                  })
                                }
                              >
                                {row}
                              </TouchableOpacity>
                            ) : (
                              <View key={video._id}>{row}</View>
                            );
                          })
                        ) : (
                          <View style={{ paddingHorizontal: 8, paddingVertical: 12 }}>
                            <Text style={{ color: palette.muted, fontSize: 13 }}>
                              No videos in this section yet.
                            </Text>
                          </View>
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })
            ) : (
              <View
                style={{
                  borderRadius: 18,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: palette.hair,
                  backgroundColor: palette.sheet,
                  padding: 18,
                }}
              >
                <Text style={{ color: palette.text, fontSize: 15, fontWeight: "800" }}>
                  No sections yet
                </Text>
                <Text
                  style={{
                    marginTop: 8,
                    color: palette.muted,
                    fontSize: 14,
                    lineHeight: 21,
                  }}
                >
                  This course is published, but the section breakdown has not been added
                  yet.
                </Text>
              </View>
            )}
          </View>

          {userRole === "STUDENT" && !isEnrolled ? (
            <View style={{ marginTop: 18 }}>
              {!showCoupon ? (
                <TouchableOpacity onPress={() => setShowCoupon(true)}>
                  <Text
                    style={{ textAlign: "center", color: palette.muted, fontSize: 14 }}
                  >
                    Have a coupon code?
                  </Text>
                </TouchableOpacity>
              ) : (
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    value={couponCode}
                    onChangeText={setCouponCode}
                    placeholder="Enter coupon code"
                    placeholderTextColor={mutedIconColor}
                    autoCapitalize="characters"
                    style={{
                      flex: 1,
                      borderWidth: 1,
                      borderColor: palette.hair,
                      borderRadius: 14,
                      color: palette.text,
                      backgroundColor: palette.sheet,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      fontSize: 14,
                    }}
                  />
                  <TouchableOpacity
                    onPress={() => handleEnroll(couponCode)}
                    disabled={!couponCode.trim() || isEnrolling}
                    style={{
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 14,
                      backgroundColor: couponCode.trim()
                        ? palette.accent
                        : palette.subtle2,
                      paddingHorizontal: 16,
                    }}
                  >
                    <Text
                      style={{
                        color: couponCode.trim() ? palette.onAccent : palette.faint,
                        fontWeight: "800",
                      }}
                    >
                      Apply
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ) : null}
        </View>
      </ScrollView>

      {userRole === "STUDENT" || isEnrolled ? (
        <LinearGradient
          colors={[palette.footerFade, palette.bg, palette.bg]}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 18,
            paddingTop: 22,
            paddingBottom: insets.bottom + 18,
          }}
        >
          <TouchableOpacity
            activeOpacity={0.86}
            onPress={handlePrimaryAction}
            disabled={isEnrolling}
            style={{
              minHeight: 56,
              borderRadius: 16,
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
              gap: 9,
              backgroundColor: palette.accent,
              shadowColor: palette.accent,
              shadowOffset: { width: 0, height: 12 },
              shadowOpacity: isDark ? 0 : 0.22,
              shadowRadius: 20,
              elevation: 3,
            }}
          >
            {isEnrolling ? (
              <ActivityIndicator color={palette.onAccent} />
            ) : (
              <>
                <Text
                  style={{
                    color: palette.onAccent,
                    fontSize: 16,
                    fontWeight: "900",
                  }}
                >
                  {ctaLabel}
                </Text>
                {activeCourse.pricingModel === "PAID" && !isEnrolled ? (
                  <Ionicons name="open-outline" size={18} color={palette.onAccent} />
                ) : (
                  <Ionicons name="arrow-forward" size={19} color={palette.onAccent} />
                )}
              </>
            )}
          </TouchableOpacity>
        </LinearGradient>
      ) : null}
    </View>
  );
}

export default function CourseDetailScreen() {
  return (
    <CourseDetailErrorBoundary>
      <CourseDetailScreenContent />
    </CourseDetailErrorBoundary>
  );
}
