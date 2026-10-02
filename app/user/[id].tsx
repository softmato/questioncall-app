import { formatDuration } from "@/lib/duration";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Modal,
  ScrollView,
  Share,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";

import { useImageViewer } from "@/components/image-viewer/image-viewer-context";
import { InlineVideo } from "@/components/media/inline-video";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api, API_BASE_URL } from "@/lib/api";
import { updateUser } from "@/store/slices/userSlice";

type PublicProfile = {
  id: string;
  name: string;
  username: string;
  role: string;
  userImage: string | null;
  bio: string | null;
  skills: string[];
  interests: string[];
  points: number;
  totalAnswered: number;
  totalAsked: number;
  averageRating: number;
  ratingCount: number;
  teacherModeVerified: boolean;
  joinedAt: string | null;
  lastActiveAt: string | null;
  isOnline: boolean;
  followerCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  favouriteCount?: number;
  uploadedAssetCount?: number;
};

type FavouriteCourse = {
  id: string;
  title: string;
  description?: string | null;
  subject?: string;
  level?: string;
  pricingModel: "FREE" | "SUBSCRIPTION_INCLUDED" | "PAID";
  thumbnailUrl?: string | null;
  instructorName?: string;
  totalDurationMinutes?: number | null;
  enrollmentCount?: number;
};

type ProfileMediaAsset = {
  url: string;
  type: "video" | "image";
  questionId?: string;
  questionTitle?: string;
};

type ProfilePost = {
  id: string;
  title: string;
  body: string;
  images: string[];
  status: "OPEN" | "ACCEPTED" | "SOLVED" | "RESET";
  subject?: string;
  level?: string;
  createdAt: string;
  answer: { content?: string; mediaUrls?: string[]; rating?: number | null } | null;
};

type ProfileTab = "overview" | "posts" | "media";

const PAGE_SIZE = 15;

function formatTimeAgo(value: string) {
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return "";
  const mins = Math.max(1, Math.floor((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatJoined(value: string | null) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatJoinedShort(value: string | null) {
  const joined = formatJoined(value);
  return joined ? joined.split(" ")[0] : "--";
}

function formatLastActive(isOnline: boolean, lastActiveAt: string | null) {
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
  return `Active ${days}d ago`;
}

function formatCompactCount(value?: number | null) {
  if (!value || value <= 0) return "0";
  if (value >= 1000) {
    const compact = value / 1000;
    return `${compact % 1 === 0 ? compact.toFixed(0) : compact.toFixed(1)}k`;
  }
  return value.toLocaleString();
}

function pricingLabel(model: FavouriteCourse["pricingModel"]) {
  if (model === "FREE") return "Free";
  if (model === "SUBSCRIPTION_INCLUDED") return "Subscription";
  return "Premium";
}

function getInitials(name?: string | null) {
  const parts = (name || "QC").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase()).join("") || "QC";
}

function buildProfileUrl(username?: string | null) {
  const handle = (username || "").replace(/^@/, "").trim();
  return `${API_BASE_URL}/${encodeURIComponent(handle)}`;
}

export default function PublicUserProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { openImageViewer } = useImageViewer();
  const dispatch = useAppDispatch();
  const user = useAppSelector((state) => state.user.data);
  const currentUserId = user?._id;
  const {
    statusBarStyle,
    backgroundColor,
    cardColor,
    borderColor,
    primaryColor,
    primarySoftColor,
    mutedIconColor,
    iconColor,
    isDark,
  } = useAppTheme();

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [posts, setPosts] = useState<ProfilePost[]>([]);
  const [favouriteCourses, setFavouriteCourses] = useState<FavouriteCourse[]>([]);
  const [mediaAssets, setMediaAssets] = useState<ProfileMediaAsset[]>([]);
  const [activeTab, setActiveTab] = useState<ProfileTab>("overview");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isTogglingFollow, setIsTogglingFollow] = useState(false);
  const [shareSheetOpen, setShareSheetOpen] = useState(false);

  const palette = useMemo(
    () => ({
      bg: backgroundColor,
      surface: isDark ? "#121714" : "#f4f6f7",
      card: cardColor,
      border: borderColor,
      text: isDark ? "#eef3f0" : "#0f1a14",
      text2: mutedIconColor,
      text3: isDark ? "#69736d" : "#9aa39d",
      brand: primaryColor,
      brandSoft: primarySoftColor,
      chipBg: isDark ? "rgba(255,255,255,0.06)" : "#f1f3f4",
      media: isDark ? "#070a08" : "#10151b",
    }),
    [
      backgroundColor,
      borderColor,
      cardColor,
      isDark,
      mutedIconColor,
      primaryColor,
      primarySoftColor,
    ],
  );

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/users/${id}/public?limit=${PAGE_SIZE}`);
      setProfile(res.data.profile);
      setPosts(Array.isArray(res.data.posts) ? res.data.posts : []);
      setFavouriteCourses(
        Array.isArray(res.data.favouriteCourses) ? res.data.favouriteCourses : [],
      );
      setMediaAssets(Array.isArray(res.data.mediaAssets) ? res.data.mediaAssets : []);
      setHasMore(Boolean(res.data.hasMore));
      setActiveTab("overview");
    } catch (err: any) {
      setError(
        err?.response?.status === 404
          ? "This profile isn't available."
          : "Couldn't load this profile. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!id || loadingMore || !hasMore || activeTab !== "posts") return;
    setLoadingMore(true);
    try {
      const res = await api.get(
        `/users/${id}/public?limit=${PAGE_SIZE}&offset=${posts.length}`,
      );
      const next = Array.isArray(res.data.posts) ? res.data.posts : [];
      setPosts((prev) => [...prev, ...next]);
      setHasMore(Boolean(res.data.hasMore));
    } catch {
      // Silent: user can retry by scrolling again.
    } finally {
      setLoadingMore(false);
    }
  }, [activeTab, id, loadingMore, hasMore, posts.length]);

  const isTeacher = profile?.role === "TEACHER";
  const canFollowTeacher = Boolean(
    profile && isTeacher && currentUserId && profile.id !== currentUserId,
  );
  const presenceLabel = profile
    ? formatLastActive(profile.isOnline, profile.lastActiveAt)
    : null;
  const profileUrl = profile ? buildProfileUrl(profile.username) : "";
  const qrCodeUrl = profileUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=16&data=${encodeURIComponent(profileUrl)}`
    : "";
  const videoAssets = mediaAssets.filter((asset) => asset.type === "video");
  const imageAssets = mediaAssets.filter((asset) => asset.type === "image");
  const visiblePosts = activeTab === "posts" ? posts : [];
  const joined = profile ? formatJoined(profile.joinedAt) : null;

  const toggleFollow = useCallback(async () => {
    if (!profile || profile.role !== "TEACHER" || isTogglingFollow) return;
    if (!currentUserId) {
      Toast.show({ type: "info", text1: "Sign in to follow teachers." });
      return;
    }
    if (profile.id === currentUserId) return;

    const next = !Boolean(profile.isFollowing);
    const previousCount = profile.followerCount ?? 0;
    const optimisticCount = Math.max(0, previousCount + (next ? 1 : -1));

    setProfile((prev) =>
      prev?.id === profile.id
        ? { ...prev, isFollowing: next, followerCount: optimisticCount }
        : prev,
    );
    setIsTogglingFollow(true);

    try {
      const res = next
        ? await api.post(`/teachers/${profile.id}/follow`)
        : await api.delete(`/teachers/${profile.id}/follow`);
      const resolvedCount =
        typeof res.data?.followerCount === "number"
          ? res.data.followerCount
          : optimisticCount;

      setProfile((prev) =>
        prev?.id === profile.id
          ? { ...prev, isFollowing: next, followerCount: resolvedCount }
          : prev,
      );

      const existing = user?.following ?? [];
      dispatch(
        updateUser({
          following: next
            ? Array.from(new Set([...existing, profile.id]))
            : existing.filter((teacherId) => teacherId !== profile.id),
        }),
      );
    } catch (err: any) {
      setProfile((prev) =>
        prev?.id === profile.id
          ? { ...prev, isFollowing: !next, followerCount: previousCount }
          : prev,
      );
      Toast.show({
        type: "error",
        text1: "Action failed",
        text2: err?.response?.data?.error ?? "Please try again.",
      });
    } finally {
      setIsTogglingFollow(false);
    }
  }, [currentUserId, dispatch, isTogglingFollow, profile, user?.following]);

  const openShareSheet = useCallback(() => {
    if (!profileUrl) return;
    setShareSheetOpen(true);
  }, [profileUrl]);

  const shareProfile = useCallback(async () => {
    if (!profile || !profileUrl) return;
    try {
      await Share.share({
        title: `${profile.name} on QuestionCall`,
        message: `${profile.name} on QuestionCall\n${profileUrl}`,
        url: profileUrl,
      });
    } catch {
      Toast.show({ type: "error", text1: "Could not open share dialog" });
    }
  }, [profile, profileUrl]);

  const copyProfileUrl = useCallback(async () => {
    if (!profileUrl) return;
    try {
      const Clipboard = await import("expo-clipboard");
      await Clipboard.setStringAsync(profileUrl);
      Toast.show({ type: "success", text1: "Profile URL copied" });
    } catch {
      Toast.show({
        type: "info",
        text1: "Copy needs a rebuilt dev app",
        text2: profileUrl,
      });
    }
  }, [profileUrl]);

  const openProfileUrl = useCallback(() => {
    if (!profileUrl) return;
    Linking.openURL(profileUrl).catch(() => {
      Toast.show({ type: "error", text1: "Could not open profile URL" });
    });
  }, [profileUrl]);

  const renderHeader = () => {
    if (!profile) return null;

    const isFollowingTeacher = Boolean(profile.isFollowing);
    const roleLabel = isTeacher ? "Teacher" : "Student";
    const tags = [...profile.skills, ...profile.interests];
    const mediaTabLabel = isTeacher ? "Media" : "Saved";

    return (
      <View>
        <View style={{ paddingHorizontal: 20, paddingTop: 18 }}>
          <View style={{ alignItems: "center" }}>
            <View style={{ width: 96, height: 96 }}>
              {profile.userImage ? (
                <TouchableOpacity
                  activeOpacity={0.86}
                  onPress={() => openImageViewer(profile.userImage!)}
                >
                  <Image
                    source={{ uri: profile.userImage }}
                    style={{ width: 96, height: 96, borderRadius: 48 }}
                    resizeMode="cover"
                  />
                </TouchableOpacity>
              ) : (
                <View
                  style={{
                    width: 96,
                    height: 96,
                    borderRadius: 48,
                    backgroundColor: primaryColor,
                    alignItems: "center",
                    justifyContent: "center",
                    shadowColor: primaryColor,
                    shadowOpacity: 0.18,
                    shadowRadius: 18,
                    shadowOffset: { width: 0, height: 10 },
                    elevation: 4,
                  }}
                >
                  <Text style={{ fontSize: 36, fontWeight: "800", color: "#fff" }}>
                    {getInitials(profile.name)}
                  </Text>
                </View>
              )}
              {profile.teacherModeVerified ? (
                <View
                  style={{
                    position: "absolute",
                    right: -1,
                    bottom: -1,
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    backgroundColor: primaryColor,
                    borderWidth: 3,
                    borderColor: backgroundColor,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons name="checkmark" size={17} color="#fff" />
                </View>
              ) : null}
              {profile.isOnline ? (
                <View
                  style={{
                    position: "absolute",
                    left: 4,
                    bottom: 6,
                    width: 15,
                    height: 15,
                    borderRadius: 8,
                    backgroundColor: "#22c55e",
                    borderWidth: 3,
                    borderColor: backgroundColor,
                  }}
                />
              ) : null}
            </View>

            <Text
              numberOfLines={1}
              style={{
                marginTop: 16,
                fontSize: 23,
                fontWeight: "800",
                color: palette.text,
                maxWidth: "100%",
              }}
            >
              {profile.name}
            </Text>
            <Text style={{ marginTop: 3, fontSize: 14, color: palette.text2 }}>
              @{profile.username}
            </Text>

            <View
              style={{
                marginTop: 11,
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                borderRadius: 999,
                backgroundColor: primarySoftColor,
                paddingHorizontal: 12,
                paddingVertical: 6,
              }}
            >
              <Ionicons
                name={isTeacher ? "school-outline" : "sparkles-outline"}
                size={14}
                color={primaryColor}
              />
              <Text style={{ fontSize: 12.5, fontWeight: "800", color: primaryColor }}>
                {roleLabel}
              </Text>
            </View>

            {presenceLabel ? (
              <Text
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  fontWeight: profile.isOnline ? "700" : "500",
                  color: profile.isOnline ? "#22c55e" : palette.text2,
                }}
              >
                {presenceLabel}
              </Text>
            ) : null}
          </View>

          <View style={{ flexDirection: "row", gap: 10, marginTop: 20 }}>
            {canFollowTeacher ? (
              <TouchableOpacity
                onPress={toggleFollow}
                disabled={isTogglingFollow}
                activeOpacity={0.86}
                accessibilityRole="button"
                accessibilityLabel={
                  isFollowingTeacher ? "Unfollow teacher" : "Follow teacher"
                }
                style={{
                  flex: 1,
                  height: 50,
                  borderRadius: 15,
                  backgroundColor: isFollowingTeacher ? palette.surface : primaryColor,
                  borderWidth: isFollowingTeacher ? 1.5 : 0,
                  borderColor,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 9,
                  opacity: isTogglingFollow ? 0.72 : 1,
                }}
              >
                {isTogglingFollow ? (
                  <ActivityIndicator
                    size="small"
                    color={isFollowingTeacher ? primaryColor : "#04130c"}
                  />
                ) : (
                  <Ionicons
                    name={isFollowingTeacher ? "checkmark-circle" : "person-add-outline"}
                    size={18}
                    color={isFollowingTeacher ? primaryColor : "#04130c"}
                  />
                )}
                <Text
                  style={{
                    color: isFollowingTeacher ? palette.text : "#04130c",
                    fontSize: 15,
                    fontWeight: "800",
                  }}
                >
                  {isFollowingTeacher ? "Following" : "Follow"}
                </Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity
              onPress={openShareSheet}
              activeOpacity={0.86}
              accessibilityRole="button"
              accessibilityLabel="Share profile"
              style={{
                flex: canFollowTeacher ? 0 : 1,
                width: canFollowTeacher ? 50 : undefined,
                height: 50,
                borderRadius: 15,
                borderWidth: 1.5,
                borderColor,
                backgroundColor: palette.surface,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 9,
                paddingHorizontal: canFollowTeacher ? 0 : 16,
              }}
            >
              <Ionicons name="share-social-outline" size={19} color={palette.text} />
              {!canFollowTeacher ? (
                <Text style={{ color: palette.text, fontSize: 15, fontWeight: "800" }}>
                  Share profile
                </Text>
              ) : null}
            </TouchableOpacity>
          </View>

          <View
            style={{
              marginTop: 22,
              flexDirection: "row",
              borderRadius: 18,
              borderWidth: 1,
              borderColor,
              backgroundColor: cardColor,
              overflow: "hidden",
            }}
          >
            <Stat
              label={isTeacher ? "Solved" : "Asked"}
              value={formatCompactCount(
                isTeacher ? profile.totalAnswered : profile.totalAsked,
              )}
              palette={palette}
              borderColor={borderColor}
            />
            <Stat
              label={isTeacher ? "Followers" : "Points"}
              value={formatCompactCount(
                isTeacher ? (profile.followerCount ?? 0) : profile.points,
              )}
              palette={palette}
              borderColor={borderColor}
            />
            <Stat
              label={isTeacher ? "Assets" : "Saved"}
              value={formatCompactCount(
                isTeacher
                  ? (profile.uploadedAssetCount ?? mediaAssets.length)
                  : (profile.favouriteCount ?? favouriteCourses.length),
              )}
              palette={palette}
              borderColor={borderColor}
            />
            <Stat
              label={isTeacher ? "Rating" : "Joined"}
              value={
                isTeacher
                  ? profile.ratingCount > 0
                    ? profile.averageRating.toFixed(1)
                    : "--"
                  : formatJoinedShort(profile.joinedAt)
              }
              palette={palette}
              borderColor={borderColor}
              last
            />
          </View>
        </View>

        {tags.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 20 }}
            contentContainerStyle={{ gap: 9, paddingHorizontal: 20 }}
          >
            {tags.map((tag, index) => (
              <View
                key={`${tag}-${index}`}
                style={{
                  paddingHorizontal: 15,
                  paddingVertical: 9,
                  borderRadius: 999,
                  backgroundColor: index === 0 ? primarySoftColor : palette.chipBg,
                  borderWidth: 1,
                  borderColor: index === 0 ? `${primaryColor}55` : "transparent",
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "700",
                    color: index === 0 ? primaryColor : palette.text2,
                  }}
                >
                  {tag}
                </Text>
              </View>
            ))}
          </ScrollView>
        ) : null}

        <View
          style={{
            marginHorizontal: 20,
            marginTop: 24,
            flexDirection: "row",
            gap: 4,
            padding: 4,
            borderRadius: 14,
            backgroundColor: palette.surface,
          }}
        >
          <TabButton
            label="Overview"
            active={activeTab === "overview"}
            onPress={() => setActiveTab("overview")}
            palette={palette}
          />
          <TabButton
            label="Posts"
            active={activeTab === "posts"}
            onPress={() => setActiveTab("posts")}
            palette={palette}
          />
          <TabButton
            label={mediaTabLabel}
            active={activeTab === "media"}
            onPress={() => setActiveTab("media")}
            palette={palette}
          />
        </View>

        {activeTab === "overview" ? renderOverview(profile, joined) : null}
        {activeTab === "media"
          ? isTeacher
            ? renderTeacherMedia()
            : renderStudentSavedCourses()
          : null}

        {activeTab === "posts" ? (
          <SectionHeading
            title="Posts"
            count={`${posts.length}${hasMore ? "+" : ""}`}
            palette={palette}
          />
        ) : null}
      </View>
    );
  };

  const renderOverview = (profileData: PublicProfile, joinedLabel: string | null) => (
    <View style={{ paddingHorizontal: 20, paddingTop: 24 }}>
      <View
        style={{
          borderRadius: 18,
          borderWidth: 1,
          borderColor,
          backgroundColor: cardColor,
          padding: 16,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="person-circle-outline" size={18} color={primaryColor} />
          <Text style={{ fontSize: 13, fontWeight: "800", color: primaryColor }}>
            About
          </Text>
        </View>
        <Text
          style={{
            marginTop: 10,
            fontSize: 14,
            lineHeight: 21,
            color: profileData.bio ? palette.text2 : palette.text3,
            fontStyle: profileData.bio ? "normal" : "italic",
          }}
        >
          {profileData.bio ||
            (profileData.role === "TEACHER"
              ? "This teacher has not added a bio yet."
              : "This student has not added a bio yet.")}
        </Text>

        <View style={{ height: 1, backgroundColor: borderColor, marginVertical: 16 }} />

        <InfoPill
          icon="calendar-outline"
          label="Joined"
          value={joinedLabel ?? "--"}
          palette={palette}
        />
        <InfoPill
          icon={profileData.role === "TEACHER" ? "school-outline" : "book-outline"}
          label="Profile type"
          value={profileData.role === "TEACHER" ? "Verified learning helper" : "Learner"}
          palette={palette}
        />
        <InfoPill
          icon="people-outline"
          label={profileData.role === "TEACHER" ? "Following" : "Teachers followed"}
          value={formatCompactCount(profileData.followingCount ?? 0)}
          palette={palette}
          last
        />
      </View>

      <TagBlock
        title={profileData.role === "TEACHER" ? "Teaching skills" : "Skills"}
        items={profileData.skills}
        emptyText={
          profileData.role === "TEACHER"
            ? "No teaching skills added yet."
            : "No skills added yet."
        }
        palette={palette}
      />
      <TagBlock
        title={profileData.role === "TEACHER" ? "Focus areas" : "Interests"}
        items={profileData.interests}
        emptyText="No interests added yet."
        palette={palette}
      />
    </View>
  );

  const renderTeacherMedia = () => (
    <View style={{ paddingHorizontal: 20, paddingTop: 24 }}>
      <SectionHeading
        title="Teaching showcase"
        count={`${mediaAssets.length} assets`}
        palette={palette}
        compact
      />
      <View
        style={{
          borderRadius: 18,
          borderWidth: 1,
          borderColor,
          backgroundColor: cardColor,
          padding: 14,
        }}
      >
        {mediaAssets.length > 0 ? (
          <View style={{ gap: 18 }}>
            {videoAssets.length > 0 ? (
              <View>
                <Text
                  style={{
                    marginBottom: 10,
                    fontSize: 12,
                    fontWeight: "800",
                    letterSpacing: 0.8,
                    textTransform: "uppercase",
                    color: palette.text2,
                  }}
                >
                  Videos
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 12 }}
                >
                  {videoAssets.map((asset, index) => (
                    <View key={`${asset.url}-${index}`} style={{ width: 246 }}>
                      <InlineVideo
                        uri={asset.url}
                        width={246}
                        height={154}
                        borderColor={borderColor}
                        borderRadius={16}
                      />
                      <Text
                        numberOfLines={2}
                        style={{
                          marginTop: 8,
                          fontSize: 13,
                          lineHeight: 17,
                          color: palette.text,
                          fontWeight: "800",
                        }}
                      >
                        {asset.questionTitle || "Answered question"}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {imageAssets.length > 0 ? (
              <View>
                <Text
                  style={{
                    marginBottom: 10,
                    fontSize: 12,
                    fontWeight: "800",
                    letterSpacing: 0.8,
                    textTransform: "uppercase",
                    color: palette.text2,
                  }}
                >
                  Images
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 12 }}
                >
                  {imageAssets.map((asset, index) => (
                    <TouchableOpacity
                      key={`${asset.url}-${index}`}
                      activeOpacity={0.86}
                      onPress={() => openImageViewer(asset.url)}
                      style={{ width: 132 }}
                    >
                      <Image
                        source={{ uri: asset.url }}
                        style={{
                          width: 132,
                          height: 104,
                          borderRadius: 14,
                          borderWidth: 1,
                          borderColor,
                        }}
                        resizeMode="cover"
                      />
                      <Text
                        numberOfLines={2}
                        style={{
                          marginTop: 7,
                          fontSize: 11.5,
                          lineHeight: 15,
                          color: palette.text2,
                          fontWeight: "700",
                        }}
                      >
                        {asset.questionTitle || "Answer image"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </View>
        ) : (
          <EmptyPanel
            icon="images-outline"
            text="No public uploaded answer assets yet."
            palette={palette}
          />
        )}
      </View>
    </View>
  );

  const renderStudentSavedCourses = () => (
    <View style={{ paddingHorizontal: 20, paddingTop: 24 }}>
      <SectionHeading
        title="Saved courses"
        count={`${favouriteCourses.length}`}
        palette={palette}
        compact
      />
      <View
        style={{
          borderRadius: 18,
          borderWidth: 1,
          borderColor,
          backgroundColor: cardColor,
          padding: 14,
        }}
      >
        {favouriteCourses.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12 }}
          >
            {favouriteCourses.map((course) => (
              <TouchableOpacity
                key={course.id}
                activeOpacity={0.86}
                onPress={() => router.push(`/course/${course.id}` as any)}
                style={{
                  width: 174,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor,
                  backgroundColor: palette.surface,
                  overflow: "hidden",
                }}
              >
                {course.thumbnailUrl ? (
                  <Image
                    source={{ uri: course.thumbnailUrl }}
                    style={{ width: "100%", height: 96 }}
                    resizeMode="cover"
                  />
                ) : (
                  <View
                    style={{
                      height: 96,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: primarySoftColor,
                    }}
                  >
                    <Ionicons name="book-outline" size={30} color={primaryColor} />
                  </View>
                )}
                <View style={{ padding: 12 }}>
                  <Text
                    numberOfLines={2}
                    style={{
                      fontSize: 13.5,
                      lineHeight: 18,
                      fontWeight: "800",
                      color: palette.text,
                    }}
                  >
                    {course.title}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{
                      marginTop: 6,
                      fontSize: 11.5,
                      fontWeight: "700",
                      color: palette.text2,
                    }}
                  >
                    {pricingLabel(course.pricingModel)} -{" "}
                    {formatDuration(course.totalDurationMinutes)}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : (
          <EmptyPanel
            icon="bookmark-outline"
            text="No favorite courses yet."
            palette={palette}
          />
        )}
      </View>
    </View>
  );

  const renderPost = ({ item }: { item: ProfilePost }) => {
    const isSolved = item.status === "SOLVED";
    return (
      <View
        style={{
          marginHorizontal: 20,
          marginBottom: 12,
          borderRadius: 18,
          borderWidth: 1,
          borderColor,
          backgroundColor: cardColor,
          padding: 16,
        }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", marginBottom: 10, gap: 8 }}
        >
          <Text style={{ fontSize: 12, fontWeight: "700", color: palette.text2 }}>
            {formatTimeAgo(item.createdAt)}
          </Text>
          {item.subject ? (
            <View
              style={{
                borderRadius: 999,
                backgroundColor: primarySoftColor,
                paddingHorizontal: 9,
                paddingVertical: 3,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "800", color: primaryColor }}>
                {item.subject}
              </Text>
            </View>
          ) : null}
          {isSolved ? (
            <View
              style={{
                marginLeft: "auto",
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
              }}
            >
              <Ionicons name="checkmark-circle" size={14} color={primaryColor} />
              <Text style={{ fontSize: 11.5, fontWeight: "800", color: primaryColor }}>
                Solved
              </Text>
            </View>
          ) : null}
        </View>

        <Text
          style={{
            fontSize: 16,
            fontWeight: "800",
            lineHeight: 22,
            color: palette.text,
          }}
        >
          {item.title}
        </Text>
        {item.body ? (
          <Text
            numberOfLines={3}
            style={{
              fontSize: 13.5,
              lineHeight: 20,
              color: palette.text2,
              marginTop: 4,
            }}
          >
            {item.body}
          </Text>
        ) : null}

        {item.images.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 12 }}
            contentContainerStyle={{ gap: 8 }}
          >
            {item.images.map((url, index) => (
              <TouchableOpacity
                key={`${url}-${index}`}
                activeOpacity={0.85}
                onPress={() => openImageViewer(url)}
                style={{
                  borderRadius: 13,
                  overflow: "hidden",
                  borderWidth: 1,
                  borderColor,
                }}
              >
                <Image source={{ uri: url }} style={{ width: 98, height: 98 }} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}

        {item.answer?.content ? (
          <View
            style={{
              marginTop: 12,
              borderRadius: 13,
              borderWidth: 1,
              borderColor: `${primaryColor}2b`,
              backgroundColor: primarySoftColor,
              padding: 13,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
              }}
            >
              <Ionicons
                name="chatbubble-ellipses-outline"
                size={13}
                color={primaryColor}
              />
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "800",
                  letterSpacing: 0.7,
                  color: primaryColor,
                  textTransform: "uppercase",
                }}
              >
                Accepted answer
              </Text>
            </View>
            <Text
              numberOfLines={3}
              style={{
                fontSize: 13,
                lineHeight: 19,
                color: palette.text2,
              }}
            >
              {item.answer.content}
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={backgroundColor} />

      <View
        style={{
          paddingTop: insets.top + 6,
          paddingBottom: 10,
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor,
          borderBottomWidth: 0.5,
          borderBottomColor: borderColor,
        }}
      >
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={10}
          style={{
            width: 38,
            height: 38,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="arrow-back" size={22} color={iconColor} />
        </TouchableOpacity>
        <Text
          numberOfLines={1}
          style={{
            fontSize: 17,
            fontWeight: "800",
            color: palette.text,
            flex: 1,
          }}
        >
          {profile?.name ?? "Profile"}
        </Text>
        {profile ? (
          <TouchableOpacity
            onPress={openShareSheet}
            hitSlop={10}
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="share-social-outline" size={20} color={iconColor} />
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={primaryColor} size="large" />
        </View>
      ) : error ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 40,
            gap: 12,
          }}
        >
          <Ionicons name="person-outline" size={40} color={mutedIconColor} />
          <Text style={{ fontSize: 15, color: mutedIconColor, textAlign: "center" }}>
            {error}
          </Text>
          <TouchableOpacity
            onPress={load}
            style={{
              marginTop: 4,
              paddingHorizontal: 20,
              paddingVertical: 10,
              borderRadius: 999,
              backgroundColor: primaryColor,
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={visiblePosts}
          keyExtractor={(item) => item.id}
          renderItem={renderPost}
          ListHeaderComponent={renderHeader}
          ListEmptyComponent={
            activeTab === "posts" ? (
              <View
                style={{
                  alignItems: "center",
                  paddingVertical: 40,
                  paddingHorizontal: 40,
                }}
              >
                <Ionicons name="document-text-outline" size={32} color={mutedIconColor} />
                <Text
                  style={{
                    fontSize: 14,
                    color: mutedIconColor,
                    textAlign: "center",
                    marginTop: 10,
                  }}
                >
                  No posts yet.
                </Text>
              </View>
            ) : null
          }
          onEndReachedThreshold={0.4}
          onEndReached={loadMore}
          ListFooterComponent={
            activeTab === "posts" && loadingMore ? (
              <View style={{ paddingVertical: 20 }}>
                <ActivityIndicator color={primaryColor} />
              </View>
            ) : (
              <View style={{ height: 32 }} />
            )
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      <ShareProfileModal
        visible={shareSheetOpen}
        onClose={() => setShareSheetOpen(false)}
        profile={profile}
        profileUrl={profileUrl}
        qrCodeUrl={qrCodeUrl}
        onShare={shareProfile}
        onCopy={copyProfileUrl}
        onOpenUrl={openProfileUrl}
        palette={palette}
      />
    </View>
  );
}

function Stat({
  label,
  value,
  palette,
  borderColor,
  last,
}: {
  label: string;
  value: string;
  palette: {
    text: string;
    text2: string;
  };
  borderColor: string;
  last?: boolean;
}) {
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: 15,
        alignItems: "center",
        borderRightWidth: last ? 0 : 1,
        borderRightColor: borderColor,
      }}
    >
      <Text style={{ fontSize: 20, fontWeight: "800", color: palette.text }}>
        {value}
      </Text>
      <Text
        numberOfLines={1}
        style={{ fontSize: 11.5, fontWeight: "700", color: palette.text2, marginTop: 3 }}
      >
        {label}
      </Text>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
  palette,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  palette: {
    card: string;
    text: string;
    text2: string;
  };
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        flex: 1,
        height: 38,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active ? palette.card : "transparent",
      }}
    >
      <Text
        style={{
          fontSize: 13.5,
          fontWeight: "800",
          color: active ? palette.text : palette.text2,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function SectionHeading({
  title,
  count,
  palette,
  compact,
}: {
  title: string;
  count?: string;
  palette: {
    brand: string;
    text2: string;
  };
  compact?: boolean;
}) {
  return (
    <View
      style={{
        marginHorizontal: compact ? 0 : 20,
        marginTop: compact ? 0 : 24,
        marginBottom: 13,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: "800",
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: palette.text2,
        }}
      >
        {title}
      </Text>
      {count ? (
        <Text style={{ fontSize: 12, fontWeight: "800", color: palette.brand }}>
          {count}
        </Text>
      ) : null}
    </View>
  );
}

function InfoPill({
  icon,
  label,
  value,
  palette,
  last,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  palette: {
    brand: string;
    brandSoft: string;
    text: string;
    text2: string;
    border: string;
  };
  last?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingBottom: last ? 0 : 12,
        marginBottom: last ? 0 : 12,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: palette.border,
      }}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          backgroundColor: palette.brandSoft,
          alignItems: "center",
          justifyContent: "center",
          marginRight: 11,
        }}
      >
        <Ionicons name={icon} size={15} color={palette.brand} />
      </View>
      <Text
        style={{ width: 112, fontSize: 12.5, fontWeight: "700", color: palette.text2 }}
      >
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontSize: 13, fontWeight: "800", color: palette.text }}
      >
        {value}
      </Text>
    </View>
  );
}

function TagBlock({
  title,
  items,
  emptyText,
  palette,
}: {
  title: string;
  items: string[];
  emptyText: string;
  palette: {
    card: string;
    border: string;
    brand: string;
    brandSoft: string;
    text2: string;
    text3: string;
  };
}) {
  return (
    <View
      style={{
        marginTop: 14,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.card,
        padding: 16,
      }}
    >
      <Text
        style={{
          marginBottom: 12,
          fontSize: 13,
          fontWeight: "800",
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: palette.text2,
        }}
      >
        {title}
      </Text>
      {items.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {items.map((item) => (
            <View
              key={item}
              style={{
                borderRadius: 999,
                backgroundColor: palette.brandSoft,
                paddingHorizontal: 12,
                paddingVertical: 7,
              }}
            >
              <Text style={{ fontSize: 12.5, fontWeight: "800", color: palette.brand }}>
                {item}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ fontSize: 13, color: palette.text3 }}>{emptyText}</Text>
      )}
    </View>
  );
}

function EmptyPanel({
  icon,
  text,
  palette,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  palette: {
    surface: string;
    border: string;
    text2: string;
  };
}) {
  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: palette.border,
        backgroundColor: palette.surface,
        padding: 18,
        alignItems: "center",
        gap: 8,
      }}
    >
      <Ionicons name={icon} size={24} color={palette.text2} />
      <Text style={{ color: palette.text2, fontSize: 13, textAlign: "center" }}>
        {text}
      </Text>
    </View>
  );
}

function ShareProfileModal({
  visible,
  onClose,
  profile,
  profileUrl,
  qrCodeUrl,
  onShare,
  onCopy,
  onOpenUrl,
  palette,
}: {
  visible: boolean;
  onClose: () => void;
  profile: PublicProfile | null;
  profileUrl: string;
  qrCodeUrl: string;
  onShare: () => void;
  onCopy: () => void;
  onOpenUrl: () => void;
  palette: {
    bg: string;
    card: string;
    surface: string;
    border: string;
    brand: string;
    brandSoft: string;
    text: string;
    text2: string;
    text3: string;
  };
}) {
  if (!profile) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.46)",
          justifyContent: "flex-end",
        }}
      >
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View
          style={{
            borderTopLeftRadius: 26,
            borderTopRightRadius: 26,
            backgroundColor: palette.bg,
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: 28,
            borderWidth: 1,
            borderColor: palette.border,
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 38,
              height: 4,
              borderRadius: 999,
              backgroundColor: palette.border,
              marginBottom: 18,
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View
              style={{
                width: 46,
                height: 46,
                borderRadius: 15,
                backgroundColor: palette.brandSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="qr-code-outline" size={22} color={palette.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: "900", color: palette.text }}>
                Share profile
              </Text>
              <Text
                numberOfLines={1}
                style={{ marginTop: 2, fontSize: 13, color: palette.text2 }}
              >
                @{profile.username}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={{
                width: 36,
                height: 36,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: palette.surface,
              }}
            >
              <Ionicons name="close" size={20} color={palette.text} />
            </TouchableOpacity>
          </View>

          <View
            style={{
              marginTop: 18,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: palette.border,
              backgroundColor: palette.card,
              padding: 16,
              alignItems: "center",
            }}
          >
            {qrCodeUrl ? (
              <Image
                source={{ uri: qrCodeUrl }}
                style={{ width: 190, height: 190, borderRadius: 16 }}
                resizeMode="contain"
              />
            ) : null}
            <View
              style={{
                marginTop: 14,
                alignSelf: "stretch",
                borderRadius: 14,
                backgroundColor: palette.surface,
                paddingHorizontal: 12,
                paddingVertical: 11,
                borderWidth: 1,
                borderColor: palette.border,
              }}
            >
              <Text
                numberOfLines={1}
                style={{ fontSize: 12.5, fontWeight: "700", color: palette.text2 }}
              >
                {profileUrl}
              </Text>
            </View>
          </View>

          <View style={{ marginTop: 14, gap: 10 }}>
            <ShareAction
              icon="share-social-outline"
              label="Open native share"
              onPress={onShare}
              palette={palette}
              primary
            />
            <ShareAction
              icon="copy-outline"
              label="Copy profile URL"
              onPress={onCopy}
              palette={palette}
            />
            <ShareAction
              icon="open-outline"
              label="Open public profile"
              onPress={onOpenUrl}
              palette={palette}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ShareAction({
  icon,
  label,
  onPress,
  palette,
  primary,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  palette: {
    brand: string;
    surface: string;
    border: string;
    text: string;
  };
  primary?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.86}
      style={{
        height: 48,
        borderRadius: 15,
        borderWidth: primary ? 0 : 1,
        borderColor: palette.border,
        backgroundColor: primary ? palette.brand : palette.surface,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 9,
      }}
    >
      <Ionicons name={icon} size={18} color={primary ? "#04130c" : palette.text} />
      <Text
        style={{
          fontSize: 14,
          fontWeight: "900",
          color: primary ? "#04130c" : palette.text,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}
