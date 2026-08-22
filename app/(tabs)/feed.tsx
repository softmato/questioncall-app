import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated as RNAnimated,
  Easing,
  FlatList,
  Modal,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";

import { FeedFilterModal } from "@/components/feed-ui/FeedFilterModal";
import { FeedHeader, FeedTopBar } from "@/components/feed-ui/FeedHeader";
import {
  FeedQuestionCard,
  type PeerCommentItem,
} from "@/components/feed-ui/FeedQuestionCard";
import { useFeedColors } from "@/components/feed-ui/tokens";
import { useImageViewer } from "@/components/image-viewer/image-viewer-context";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api, publicApi } from "@/lib/api";
import { QUESTIONS_FEED_PAGE_SIZE } from "@/lib/feed-config";
import { questionSummary } from "@/lib/question-summary";
import { scheduleAnswerDeadlineReminder } from "@/lib/local-notifications";
import {
  getPusherClient,
  QUESTION_CREATED_EVENT,
  QUESTION_FEED_CHANNEL,
  QUESTION_UPDATED_EVENT,
} from "@/lib/realtime";
import { store } from "@/store";
import {
  addMyQuestion,
  appendQuestions,
  clearFeedError,
  getFeedQuestionId,
  normalizeFeedQuestion,
  normalizeFeedQuestions,
  prependQuestion,
  removeQuestion,
  selectIsFeedStale,
  setFeedError,
  setFeedLoading,
  setFeedLoadingMore,
  setFeedRefreshing,
  setHasMore,
  setMyQuestions,
  setQuestions,
  updateQuestion,
} from "@/store/slices/feedSlice";
import { updateUser } from "@/store/slices/userSlice";
import {
  selectIsCoursesStale,
  setCourses,
  setCoursesError,
  setCoursesLoading,
  setCoursesRefreshing,
} from "@/store/slices/coursesSlice";
import type { Course } from "@/store/slices/coursesSlice";
import { setChannels, setChannelsLoading } from "@/store/slices/channelsSlice";
import { setChannelData } from "@/store/slices/channelSlice";
import {
  setWalletData,
  setWalletLoading,
  setWalletError,
  selectIsWalletStale,
} from "@/store/slices/walletSlice";
import type { FeedQuestion, ReactionType } from "@/types/question";

type FeedView =
  | "all"
  | "waiting"
  | "solved"
  | "media"
  | "discussion"
  | "physics"
  | "maths";
type FeedSort = "hot" | "new" | "discussed";

function formatTimeAgo(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "just now";
  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getQuestionKey(item: FeedQuestion, index: number) {
  return `${getFeedQuestionId(item) || item.createdAt || item.title || "question"}-${index}`;
}

function dedupeComments(comments: PeerCommentItem[]) {
  const unique = new Map<string, PeerCommentItem>();
  for (const comment of comments) {
    if (comment?._id) unique.set(comment._id, comment);
  }
  return Array.from(unique.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

function getReactionSummary(question: FeedQuestion) {
  const summary = { like: 0, insightful: 0, same_doubt: 0 };
  for (const reaction of question.reactions) {
    if (reaction.type in summary) summary[reaction.type] += 1;
  }
  return { ...summary, total: question.reactions.length };
}

function hasMediaQuestion(question: FeedQuestion) {
  return (
    (question.images?.length ?? 0) > 0 ||
    (question.answer?.mediaUrls?.length ?? 0) > 0 ||
    question.answerFormat.includes("PHOTO") ||
    question.answerFormat.includes("VIDEO") ||
    question.answerFormat.includes("AUDIO")
  );
}

function matchesAllTerms(haystack: string, query: string): boolean {
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}

function matchesQuestionSearch(question: FeedQuestion, query: string) {
  if (!query) return true;
  const haystack = [
    question.title,
    question.body,
    question.subject,
    question.stream,
    question.level,
    question.askerName,
    question.askerUsername,
    question.previewAuthor,
    question.previewText,
    question.acceptedByName,
    question.answer?.content,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return matchesAllTerms(haystack, query);
}

function matchesCourseSearch(course: Course, query: string) {
  if (!query) return true;
  const haystack = [
    course.title,
    course.subject,
    course.level,
    course.instructorName,
    course.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return matchesAllTerms(haystack, query);
}

function normalizeQuestionCards(questions: FeedQuestion[]) {
  return [...questions];
}

// ─── Sticky top-bar geometry ──────────────────────────────────────────────
// The logo + notification bar is pinned just below the status bar. On the
// first few pixels of scroll it slides up by COLLAPSE_DISTANCE and then sticks;
// everything else (search, chips, courses) scrolls underneath it.
const TOP_BAR_HEIGHT = 56; // paddingTop(6) + 42px row + paddingBottom(8)
const COLLAPSE_DISTANCE = 14;

export default function FeedScreen() {
  const dispatch = useAppDispatch();
  const insets = useSafeAreaInsets();
  const { openImageViewer } = useImageViewer();
  const feedColors = useFeedColors();
  const user = useAppSelector((state) => state.user.data);
  const feedState = useAppSelector((state) => state.feed);
  const coursesState = useAppSelector((state) => state.courses);
  const unreadCount = useAppSelector((s) => s.notifications.unreadCount);
  const {
    statusBarStyle,
    cardColor,
    borderColor,
    iconColor,
    mutedIconColor,
    primaryColor,
    primarySoftColor,
  } = useAppTheme();

  const userRole = user?.role;
  const isTeacher = userRole === "TEACHER";
  const roleKey = userRole ?? null;
  const userId = user?._id ?? null;
  const defaultSort: FeedSort = "new";

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");

  const [activeView, setActiveView] = useState<FeedView>("all");
  const [activeSort, setActiveSort] = useState<FeedSort>(defaultSort);
  const [filterModalVisible, setFilterModalVisible] = useState(false);
  const [expandedAnswers, setExpandedAnswers] = useState<Set<string>>(new Set());
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());
  const [commentsMap, setCommentsMap] = useState<Record<string, PeerCommentItem[]>>({});
  const [commentInput, setCommentInput] = useState<Record<string, string>>({});
  const [isSubmittingComment, setIsSubmittingComment] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteModalTarget, setDeleteModalTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);

  // Modal slide-up animation
  const modalSlide = useRef(new RNAnimated.Value(0)).current;

  // ─── Sticky header: track scroll offset (native-driven for smoothness) ───
  const scrollY = useRef(new RNAnimated.Value(0)).current;
  const onScroll = useMemo(
    () =>
      RNAnimated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
      }),
    [scrollY],
  );
  // Bar starts COLLAPSE_DISTANCE px lower, then rises and pins under the status bar.
  const barTranslateY = scrollY.interpolate({
    inputRange: [0, COLLAPSE_DISTANCE],
    outputRange: [COLLAPSE_DISTANCE, 0],
    extrapolate: "clamp",
  });
  // Bottom hairline/shadow fades in once the bar is stuck, for separation.
  const barBorderOpacity = scrollY.interpolate({
    inputRange: [0, COLLAPSE_DISTANCE],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });

  // Debounce search: wait 300ms after user stops typing before filtering
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // FlatList ref — used to auto-scroll to top when a new question is prepended
  // (own post, or other people's posts arriving via Pusher).
  const flatListRef = useRef<FlatList<FeedQuestion>>(null);
  const scrollToTop = useCallback((animated = true) => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated });
  }, []);

  const openFilterModal = useCallback(() => {
    setFilterModalVisible(true);
    RNAnimated.spring(modalSlide, {
      toValue: 1,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start();
  }, []);

  const closeFilterModal = () => {
    RNAnimated.timing(modalSlide, {
      toValue: 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setFilterModalVisible(false));
  };

  const feedQuestions = normalizeQuestionCards(feedState.questions);
  const courseList = coursesState.list;
  const normalizedSearch = debouncedSearchTerm.trim().toLowerCase();
  const hasActiveFilters =
    normalizedSearch.length > 0 || activeView !== "all" || activeSort !== defaultSort;
  const isInitialFeedLoading = feedState.isLoading && feedQuestions.length === 0;
  const isRefreshing = feedState.isRefreshing || coursesState.isRefreshing;

  const activeFilterCount =
    (activeView !== "all" ? 1 : 0) + (activeSort !== defaultSort ? 1 : 0);

  useEffect(() => {
    setActiveSort(defaultSort);
  }, [defaultSort]);

  const loadFeed = useCallback(
    async (force = false) => {
      const currentFeedState = store.getState().feed;
      const currentCacheMatchesUser =
        currentFeedState.loadedForRole === roleKey &&
        currentFeedState.loadedForUserId === userId;
      const currentShouldUseCache =
        currentCacheMatchesUser && !selectIsFeedStale(currentFeedState.lastFetchedAt);
      if (!force && (currentFeedState.isLoading || currentShouldUseCache)) return;

      dispatch(setFeedLoading(true));
      dispatch(clearFeedError());
      try {
        const client = userId ? api : publicApi;
        const res = await client.get(`/questions/feed?limit=${QUESTIONS_FEED_PAGE_SIZE}`);
        const raw = Array.isArray(res.data) ? res.data : [];
        const normalized = normalizeFeedQuestions(raw);
        dispatch(setQuestions({ questions: normalized, role: roleKey, userId }));
        dispatch(setHasMore(raw.length >= QUESTIONS_FEED_PAGE_SIZE));
        dispatch(
          setMyQuestions(userId ? normalized.filter((q) => q.askerId === userId) : []),
        );
        void prefetchBackgroundData();
      } catch (err: unknown) {
        const error = err as {
          code?: string;
          message?: string;
          response?: { status?: number; data?: { error?: string; message?: string } };
        };
        const isNetworkError =
          error?.code === "ECONNABORTED" ||
          error?.code === "ERR_NETWORK" ||
          (typeof error?.message === "string" &&
            error.message.toLowerCase().includes("network"));
        const fallback = isNetworkError
          ? "Can't reach the server. Check your connection and try again."
          : error?.response?.status && error.response.status >= 500
            ? "The server hit an error loading the feed. Please retry shortly."
            : "Unable to load questions right now.";
        dispatch(
          setFeedError(
            error?.response?.data?.error ?? error?.response?.data?.message ?? fallback,
          ),
        );
      } finally {
        dispatch(setFeedLoading(false));
      }
    },
    [dispatch, roleKey, userId],
  );

  // ─── Background prefetch: load channels, courses, and wallet after feed loads ───
  const prefetchBackgroundData = async () => {
    if (!userId) return;

    // 1. Prefetch channels + top 10 channel messages (parallel fetch)
    try {
      const channelsState = store.getState().channels;
      const shouldFetchChannels =
        channelsState.loadedForUserId !== userId ||
        !channelsState.lastFetchedAt ||
        Date.now() - channelsState.lastFetchedAt >= 60 * 1000;

      if (shouldFetchChannels) {
        console.log("[prefetch] Fetching channels...");
        dispatch(setChannelsLoading(true));
        const res = await api.get("/channels");
        const raw = Array.isArray(res.data) ? res.data : [];
        dispatch(setChannels({ channels: raw, userId }));

        // Prefetch top 10 channels' recent messages in parallel
        const topChannels = raw.slice(0, 10);
        if (topChannels.length > 0) {
          console.log(
            `[prefetch] Prefetching messages for ${topChannels.length} channels...`,
          );
          await Promise.all(
            topChannels.map(async (ch: any) => {
              try {
                const msgRes = await api.get(`/channels/${ch.id}?limit=20`);
                const { channel: detail, messages } = msgRes.data;
                if (detail && Array.isArray(messages)) {
                  dispatch(setChannelData({ channelId: ch.id, detail, messages }));
                }
              } catch (err: any) {
                console.warn(
                  `[prefetch] Failed to prefetch messages for channel ${ch.id}:`,
                  err?.message,
                );
              }
            }),
          );
          console.log("[prefetch] Channel messages prefetch complete");
        }
      }
    } catch (err: any) {
      console.warn("[prefetch] Failed to prefetch channels:", err?.message);
      dispatch(setChannelsLoading(false));
    }

    // 2. Prefetch courses (10 min cache, so only refetches occasionally)
    try {
      const coursesState = store.getState().courses;
      if (!coursesState.isLoading && selectIsCoursesStale(coursesState.lastFetchedAt)) {
        console.log("[prefetch] Fetching courses...");
        dispatch(setCoursesLoading(true));
        try {
          const res = await api.get("/courses");
          const courses = Array.isArray(res.data?.courses)
            ? res.data.courses
            : Array.isArray(res.data)
              ? res.data
              : [];
          dispatch(setCourses(courses));
        } catch (err: any) {
          console.warn("[prefetch] Failed to fetch courses:", err?.message);
          dispatch(setCoursesError("Unable to load courses."));
        }
      }
    } catch (err: any) {
      console.warn("[prefetch] Failed to prefetch courses:", err?.message);
    }

    // 3. Prefetch wallet data
    try {
      const walletState = store.getState().wallet;
      if (!walletState.isLoading && selectIsWalletStale(walletState.lastFetchedAt)) {
        console.log("[prefetch] Fetching wallet...");
        dispatch(setWalletLoading(true));
        try {
          const res = await api.get("/wallet", { params: { limit: 50, skip: 0 } });
          dispatch(setWalletData(res.data));
        } catch (err: any) {
          console.warn("[prefetch] Failed to fetch wallet:", err?.message);
          dispatch(setWalletError(err?.response?.data?.error ?? "Failed to load wallet"));
        }
      }
    } catch (err: any) {
      console.warn("[prefetch] Failed to prefetch wallet:", err?.message);
    }
  };

  const loadMore = useCallback(async () => {
    const currentFeedState = store.getState().feed;
    if (currentFeedState.isLoadingMore || !currentFeedState.hasMore) return;
    const questions = currentFeedState.questions;
    if (questions.length === 0) return;

    const lastQuestion = questions[questions.length - 1];
    const cursor = lastQuestion.createdAt;
    if (!cursor) return;

    dispatch(setFeedLoadingMore(true));
    try {
      const client = userId ? api : publicApi;
      const res = await client.get(
        `/questions/feed?cursor=${encodeURIComponent(cursor)}&limit=${QUESTIONS_FEED_PAGE_SIZE}`,
      );
      const raw = Array.isArray(res.data) ? res.data : [];
      const normalized = normalizeFeedQuestions(raw);
      if (normalized.length > 0) {
        dispatch(appendQuestions(normalized));
        if (userId) {
          const myNew = normalized.filter((q) => q.askerId === userId);
          for (const q of myNew) dispatch(addMyQuestion(q));
        }
      }
      dispatch(setHasMore(raw.length >= QUESTIONS_FEED_PAGE_SIZE));
    } catch {
      // silent — user can pull-to-refresh
    } finally {
      dispatch(setFeedLoadingMore(false));
    }
  }, [dispatch, userId]);

  const loadCourses = useCallback(
    async (force = false) => {
      const currentCoursesState = store.getState().courses;
      const currentShouldUseCache = !selectIsCoursesStale(
        currentCoursesState.lastFetchedAt,
      );
      if (!force && (currentCoursesState.isLoading || currentShouldUseCache)) return;

      dispatch(setCoursesLoading(true));
      try {
        const res = await publicApi.get("/courses");
        const courses = Array.isArray(res.data?.courses)
          ? res.data.courses
          : Array.isArray(res.data)
            ? res.data
            : [];
        dispatch(setCourses(courses));
      } catch {
        dispatch(setCoursesError("Unable to load courses right now."));
      }
    },
    [dispatch],
  );

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);
  useEffect(() => {
    void loadCourses();
  }, [loadCourses]);

  useEffect(() => {
    const client = getPusherClient();
    if (!client) return;
    const channel = client.subscribe(QUESTION_FEED_CHANNEL);

    const handleCreated = (payload: { question?: unknown }) => {
      if (!payload.question) return;
      const normalized = normalizeFeedQuestion(payload.question);
      dispatch(prependQuestion(normalized));
      if (normalized.askerId === userId) dispatch(addMyQuestion(normalized));
      // Surface the new question by pulling the list to the top.
      // Same behavior for student and teacher.
      scrollToTop();
    };

    const handleUpdated = (payload: { question?: unknown }) => {
      if (!payload.question) return;
      const normalized = normalizeFeedQuestion(payload.question);
      dispatch(updateQuestion({ id: normalized.id, data: normalized }));
    };

    channel.bind(QUESTION_CREATED_EVENT, handleCreated);
    channel.bind(QUESTION_UPDATED_EVENT, handleUpdated);

    return () => {
      channel.unbind(QUESTION_CREATED_EVENT, handleCreated);
      channel.unbind(QUESTION_UPDATED_EVENT, handleUpdated);
      client.unsubscribe(QUESTION_FEED_CHANNEL);
    };
  }, [dispatch, userId, scrollToTop]);

  // When the Feed tab regains focus, refresh if the cache is older than 30s
  // and snap the list to the top. Covers the post-question → switch-tab path:
  // the user lands on the freshest feed with their new question at the top,
  // works the same for students and teachers, and doesn't depend on Pusher.
  useFocusEffect(
    useCallback(() => {
      const lastFetched = store.getState().feed.lastFetchedAt;
      const thirtySecondsAgo = Date.now() - 30_000;
      if (!lastFetched || lastFetched < thirtySecondsAgo) {
        void loadFeed(true);
      }
      scrollToTop(false);
    }, [loadFeed, scrollToTop]),
  );

  // Step 1: stable sorted ID list — recomputed on fetch/refresh, filter/sort
  // change, or when the SET of questions changes (new post, delete, realtime
  // arrival), but NOT on in-place updates like reaction counts. This stops
  // cards jumping position when the user taps Like / Insightful, while still
  // surfacing a newly posted question at the top immediately.
  //
  // The id-set key is essential: an optimistic prepend (or Pusher insert)
  // does NOT change `lastFetchedAt`, so keying only on that left new questions
  // invisible until the next refetch. Reaction updates keep the same ids, so
  // this string is unchanged and positions stay put.
  const questionOrderKey = feedState.questions.map((q) => getFeedQuestionId(q)).join("|");
  const stableOrderedIds = useMemo(() => {
    const filtered = feedQuestions.filter((q) => {
      if (!matchesQuestionSearch(q, normalizedSearch)) return false;
      switch (activeView) {
        case "waiting":
          return q.status !== "SOLVED";
        case "solved":
          return q.status === "SOLVED";
        case "media":
          return hasMediaQuestion(q);
        case "discussion":
          return q.commentCount > 0;
        case "physics":
          return (q.subject || "").toLowerCase().includes("physics");
        case "maths":
          return ["maths", "math"].some((term) =>
            (q.subject || "").toLowerCase().includes(term),
          );
        default:
          return true;
      }
    });
    const createdAtDiff = (a: FeedQuestion, b: FeedQuestion) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    const scoreHot = (q: FeedQuestion) =>
      q.reactionCount * 2 + q.commentCount * 3 + q.answerCount * 4;
    return filtered
      .sort((a, b) => {
        if (activeSort === "new") return createdAtDiff(a, b);
        if (activeSort === "discussed")
          return (
            b.commentCount - a.commentCount ||
            b.reactionCount - a.reactionCount ||
            createdAtDiff(a, b)
          );
        return scoreHot(b) - scoreHot(a) || createdAtDiff(a, b);
      })
      .map((q) => getFeedQuestionId(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSort, questionOrderKey, normalizedSearch, activeView]);

  // Step 2: apply stable order to live question data so reaction counts
  // update in-place without reshuffling positions.
  const visibleQuestions = useMemo(() => {
    const lookup = new Map(feedQuestions.map((q) => [getFeedQuestionId(q), q]));
    return stableOrderedIds.map((id) => lookup.get(id)).filter(Boolean) as FeedQuestion[];
  }, [stableOrderedIds, feedQuestions]);

  const visibleCourses = useMemo(() => {
    const matched = courseList.filter((c) => matchesCourseSearch(c, normalizedSearch));
    return matched.slice(0, 6);
  }, [courseList, normalizedSearch]);
  const shouldHideCoursesForSearch = false;

  const handleRefresh = async () => {
    dispatch(setFeedRefreshing(true));
    dispatch(setCoursesRefreshing(true));
    try {
      await Promise.all([loadFeed(true), loadCourses(true)]);
    } finally {
      dispatch(setFeedRefreshing(false));
      dispatch(setCoursesRefreshing(false));
    }
  };

  const fetchComments = async (questionId: string) => {
    try {
      const res = await api.get(`/questions/${questionId}/comments?limit=6`);
      const comments = Array.isArray(res.data) ? res.data : [];
      setCommentsMap((prev) => ({
        ...prev,
        [questionId]: dedupeComments(comments as PeerCommentItem[]),
      }));
    } catch {
      setCommentsMap((prev) => ({ ...prev, [questionId]: prev[questionId] || [] }));
    }
  };

  const toggleAnswer = (questionId: string) => {
    setExpandedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) {
        next.delete(questionId);
      } else {
        next.add(questionId);
      }
      return next;
    });
  };

  const toggleComments = useCallback(
    (questionId: string) => {
      setExpandedComments((prev) => {
        const next = new Set(prev);
        if (next.has(questionId)) {
          next.delete(questionId);
        } else {
          next.add(questionId);
          if (!commentsMap[questionId]) void fetchComments(questionId);
        }
        return next;
      });
    },
    [commentsMap, fetchComments],
  );

  const handleReact = useCallback(
    async (questionId: string, type: ReactionType) => {
      if (!userId) return;
      const targetQuestion = feedQuestions.find(
        (q) => getFeedQuestionId(q) === questionId,
      );
      if (!targetQuestion) return;

      const nextReactions = [...targetQuestion.reactions];
      const idx = nextReactions.findIndex((r) => r.userId === userId);
      if (idx >= 0) {
        if (nextReactions[idx].type === type) nextReactions.splice(idx, 1);
        else nextReactions[idx] = { ...nextReactions[idx], type };
      } else {
        nextReactions.push({ userId, type });
      }

      const optimistic: FeedQuestion = {
        ...targetQuestion,
        reactions: nextReactions,
        reactionCount: nextReactions.length,
      };
      dispatch(updateQuestion({ id: questionId, data: optimistic }));

      try {
        const res = await api.post(`/questions/${questionId}/react`, { type });
        dispatch(
          updateQuestion({ id: questionId, data: normalizeFeedQuestion(res.data) }),
        );
      } catch {
        dispatch(updateQuestion({ id: questionId, data: targetQuestion }));
      }
    },
    [userId, feedQuestions, dispatch],
  );

  const handleAccept = useCallback(
    async (questionId: string) => {
      setAcceptingId(questionId);
      try {
        const res = await api.post(`/questions/${questionId}/accept`);
        const updated = normalizeFeedQuestion(res.data);
        dispatch(updateQuestion({ id: questionId, data: updated }));

        const timerDeadline = res.data?.timerDeadline;
        const channelId = updated.channelId;

        // The accept response already carries the full channel payload, so seed
        // the cache here and the workspace screen renders populated on first
        // paint instead of spinning through its own GET /channels/:id.
        const bootstrap = res.data?.channelBootstrap;
        if (channelId && bootstrap?.channel) {
          dispatch(
            setChannelData({
              channelId,
              detail: bootstrap.channel,
              messages: bootstrap.messages ?? [],
            }),
          );
        }

        if (timerDeadline && channelId) {
          scheduleAnswerDeadlineReminder({
            questionTitle: updated.title,
            channelId,
            timerDeadline,
          }).catch(() => {});
        }

        if (channelId) router.push(`/workspace/${channelId}` as any);
      } catch (err: any) {
        Toast.show({
          type: "error",
          text1:
            err?.response?.data?.error ??
            err?.response?.data?.message ??
            "Failed to accept question",
        });
      } finally {
        setAcceptingId(null);
      }
    },
    [api, dispatch, router, scheduleAnswerDeadlineReminder],
  );

  const handleDelete = useCallback((questionId: string, questionTitle: string) => {
    setDeleteModalTarget({ id: questionId, title: questionTitle });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteModalTarget) return;
    const { id } = deleteModalTarget;
    setDeletingId(id);
    try {
      await api.delete(`/questions/${id}`);
      dispatch(removeQuestion(id));
      dispatch(
        updateUser({
          questionsAsked: Math.max(0, (user?.questionsAsked ?? 1) - 1),
        }),
      );
      Toast.show({ type: "success", text1: "Question deleted." });
    } catch (err: any) {
      Toast.show({
        type: "error",
        text1: err?.response?.data?.error ?? "Failed to delete question",
      });
    } finally {
      setDeletingId(null);
      setDeleteModalTarget(null);
    }
  }, [api, deleteModalTarget, dispatch, removeQuestion, updateUser, user]);

  const handleSubmitComment = useCallback(
    async (questionId: string) => {
      const text = commentInput[questionId]?.trim();
      if (!text) return;
      setIsSubmittingComment(questionId);
      try {
        const res = await api.post(`/questions/${questionId}/comments`, {
          content: text,
        });
        if (res.data?.comment) {
          const incoming = res.data.comment as PeerCommentItem;
          setCommentsMap((prev) => ({
            ...prev,
            [questionId]: dedupeComments([incoming, ...(prev[questionId] || [])]),
          }));
          setCommentInput((prev) => ({ ...prev, [questionId]: "" }));
          const current = feedQuestions.find((q) => getFeedQuestionId(q) === questionId);
          dispatch(
            updateQuestion({
              id: questionId,
              data: { commentCount: (current?.commentCount ?? 0) + 1 },
            }),
          );
        }
        Toast.show({
          type: "success",
          text1: res.data?.milestoneMessage ?? "Comment posted!",
        });
      } catch (err: any) {
        Toast.show({
          type: "error",
          text1:
            err?.response?.data?.error ??
            err?.response?.data?.message ??
            "Failed to post comment",
        });
      } finally {
        setIsSubmittingComment(null);
      }
    },
    [commentInput, feedQuestions, dispatch],
  );

  // ─── Filter Modal ───────────────────────────────────────────────
  const renderFilterModal = () => (
    <FeedFilterModal
      visible={filterModalVisible}
      modalSlide={modalSlide}
      activeView={activeView}
      activeSort={activeSort}
      defaultSort={defaultSort}
      hasActiveFilters={hasActiveFilters}
      questionCount={visibleQuestions.length}
      onClose={closeFilterModal}
      onReset={() => {
        setSearchInput("");
        setActiveView("all");
        setActiveSort(defaultSort);
      }}
      onViewChange={setActiveView}
      onSortChange={setActiveSort}
    />
  );

  // ─── Header ─────────────────────────────────────────────────────
  // Passed to the FlatList as a React *element* (stable type `FeedHeader`),
  // NOT a function/component. A function whose identity changes per keystroke
  // makes the list treat it as a new component type and remount the whole
  // header — which unmounts the search TextInput, dropping focus and eating
  // fast keystrokes. As an element, React reconciles in place and the input
  // keeps focus while typing.
  const feedHeader = (
    <FeedHeader
      error={feedState.error}
      searchValue={searchInput}
      onSearchChange={setSearchInput}
      activeView={activeView}
      onViewChange={setActiveView}
      activeFilterCount={activeFilterCount}
      onFilterPress={openFilterModal}
      courses={visibleCourses}
      coursesLoading={coursesState.isLoading}
      showCourses={
        activeView === "all" &&
        normalizedSearch.length === 0 &&
        !shouldHideCoursesForSearch
      }
    />
  );

  // ─── Question Card ───────────────────────────────────────────────
  const renderQuestionItem = useCallback(
    ({ item }: { item: FeedQuestion }) => {
      const questionId = getFeedQuestionId(item);
      const isOwnQuestion = userId === item.askerId;
      const canAccept =
        isTeacher &&
        !isOwnQuestion &&
        (item.status === "OPEN" || item.status === "RESET");
      const canComment = Boolean(userId) && !isOwnQuestion;
      const comments = dedupeComments(commentsMap[questionId] || []);
      const userReaction = userId
        ? item.reactions.find((r) => r.userId === userId)
        : undefined;
      const reactionSummary = getReactionSummary(item);
      const isSolved = item.status === "SOLVED";
      const isAccepted = item.status === "ACCEPTED";
      const isOptimistic = feedState.optimisticIds.includes(questionId);

      return (
        <FeedQuestionCard
          item={item}
          questionId={questionId}
          isOwnQuestion={isOwnQuestion}
          canAccept={canAccept}
          canComment={canComment}
          isSolved={isSolved}
          isAccepted={isAccepted}
          isOptimistic={isOptimistic}
          isAnswerExpanded={!expandedAnswers.has(questionId)}
          isCommentsExpanded={expandedComments.has(questionId)}
          comments={comments}
          commentText={commentInput[questionId] || ""}
          reactionSummary={reactionSummary}
          userReactionType={userReaction?.type}
          acceptingId={acceptingId}
          deletingId={deletingId}
          submittingCommentId={isSubmittingComment}
          formatTimeAgo={formatTimeAgo}
          onToggleAnswer={() => toggleAnswer(questionId)}
          onToggleComments={() => toggleComments(questionId)}
          onImagePress={openImageViewer}
          onReact={(type) => handleReact(questionId, type)}
          onAccept={() => handleAccept(questionId)}
          onDelete={() => handleDelete(questionId, questionSummary(item))}
          onCommentTextChange={(text) =>
            setCommentInput((prev) => ({ ...prev, [questionId]: text }))
          }
          onSubmitComment={() => handleSubmitComment(questionId)}
        />
      );
    },
    [
      userId,
      isTeacher,
      expandedAnswers,
      expandedComments,
      commentsMap,
      commentInput,
      feedState.optimisticIds,
      acceptingId,
      deletingId,
      isSubmittingComment,
      handleAccept,
      handleDelete,
      handleReact,
      handleSubmitComment,
      openImageViewer,
      toggleComments,
    ],
  );

  // ─── Empty State ─────────────────────────────────────────────────
  const renderEmptyState = useCallback(() => {
    if (isInitialFeedLoading) {
      return (
        <View className="gap-3">
          {[1, 2, 3].map((i) => (
            <View
              key={i}
              className="rounded-2xl border border-border bg-card p-4"
              style={{ borderColor }}
            >
              <View className="flex-row items-center gap-3">
                <View className="bg-muted/30 h-10 w-10 rounded-full" />
                <View className="gap-1.5">
                  <View className="bg-muted/30 h-3 w-24 rounded-full" />
                  <View className="bg-muted/30 h-2.5 w-14 rounded-full" />
                </View>
              </View>
              <View className="bg-muted/30 mt-3 h-4 w-4/5 rounded-full" />
              <View className="bg-muted/30 mt-2 h-3 w-full rounded-full" />
              <View className="bg-muted/30 mt-2 h-3 w-3/4 rounded-full" />
            </View>
          ))}
        </View>
      );
    }

    const emptyTitle =
      feedQuestions.length === 0
        ? "No questions yet"
        : normalizedSearch.length > 0
          ? "No results found"
          : "Nothing here";

    const emptyBody =
      feedQuestions.length === 0
        ? "New questions will appear here as soon as they're posted."
        : normalizedSearch.length > 0
          ? "Try a different keyword."
          : "Adjust your filters to see more questions.";

    return (
      <View className="items-center rounded-2xl border border-dashed border-border bg-card p-6">
        <View
          className="mb-3 h-14 w-14 items-center justify-center rounded-2xl"
          style={{ backgroundColor: primarySoftColor }}
        >
          <Ionicons
            name={feedQuestions.length === 0 ? "chatbubbles-outline" : "search-outline"}
            size={28}
            color={primaryColor}
          />
        </View>
        <Text className="text-center text-base font-semibold text-foreground">
          {emptyTitle}
        </Text>
        <Text className="mt-1.5 max-w-[260px] text-center text-sm leading-5 text-muted-foreground">
          {emptyBody}
        </Text>
        <View className="mt-4 flex-row gap-2">
          {feedQuestions.length === 0 ? (
            <TouchableOpacity
              onPress={() => router.push("/ask" as any)}
              className="rounded-full px-4 py-2.5"
              style={{ backgroundColor: primaryColor }}
            >
              <Text className="text-sm font-semibold text-white">Post a question</Text>
            </TouchableOpacity>
          ) : null}
          {hasActiveFilters ? (
            <TouchableOpacity
              onPress={() => {
                setSearchInput("");
                setActiveView("all");
                setActiveSort(defaultSort);
              }}
              className="rounded-full border border-border bg-background px-4 py-2.5"
            >
              <Text className="text-sm font-semibold text-foreground">Reset filters</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }, [
    isInitialFeedLoading,
    feedQuestions.length,
    normalizedSearch,
    hasActiveFilters,
    defaultSort,
    borderColor,
    primaryColor,
    primarySoftColor,
  ]);

  return (
    <View style={{ flex: 1, backgroundColor: feedColors.page }}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={feedColors.page} />

      {/* Delete confirmation modal */}
      <Modal
        transparent
        visible={deleteModalTarget !== null}
        animationType="none"
        onRequestClose={() => setDeleteModalTarget(null)}
      >
        <TouchableWithoutFeedback
          onPress={() => !deletingId && setDeleteModalTarget(null)}
        >
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(0,0,0,0.45)",
            }}
          >
            <TouchableWithoutFeedback>
              <RNAnimated.View
                style={{
                  backgroundColor: cardColor,
                  borderColor,
                  borderWidth: 1,
                  borderRadius: 20,
                  width: 300,
                  padding: 24,
                }}
              >
                <View
                  style={{
                    height: 56,
                    width: 56,
                    borderRadius: 28,
                    backgroundColor: "rgba(239,68,68,0.1)",
                    alignItems: "center",
                    justifyContent: "center",
                    alignSelf: "center",
                    marginBottom: 16,
                  }}
                >
                  <Ionicons name="trash-outline" size={28} color="#EF4444" />
                </View>
                <Text
                  style={{
                    textAlign: "center",
                    fontSize: 17,
                    fontWeight: "700",
                    color: iconColor,
                    marginBottom: 6,
                  }}
                >
                  Delete Question?
                </Text>
                <Text
                  style={{
                    textAlign: "center",
                    fontSize: 14,
                    lineHeight: 20,
                    color: mutedIconColor,
                    marginBottom: 24,
                  }}
                >
                  This will permanently remove your question and cannot be undone.
                </Text>
                <TouchableOpacity
                  onPress={handleDeleteConfirm}
                  disabled={!!deletingId}
                  activeOpacity={0.8}
                  style={{
                    backgroundColor: "#EF4444",
                    borderRadius: 12,
                    paddingVertical: 12,
                    alignItems: "center",
                    marginBottom: 10,
                  }}
                >
                  {deletingId ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                      Yes, Delete
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setDeleteModalTarget(null)}
                  disabled={!!deletingId}
                  activeOpacity={0.8}
                  style={{
                    backgroundColor: borderColor,
                    borderRadius: 12,
                    paddingVertical: 12,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ fontWeight: "600", fontSize: 14, color: iconColor }}>
                    Cancel
                  </Text>
                </TouchableOpacity>
              </RNAnimated.View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {renderFilterModal()}

      <RNAnimated.FlatList
        ref={flatListRef}
        data={visibleQuestions}
        onScroll={onScroll}
        scrollEventThrottle={16}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        keyExtractor={getQuestionKey}
        renderItem={renderQuestionItem}
        ListHeaderComponent={feedHeader}
        ListEmptyComponent={renderEmptyState}
        ListFooterComponent={
          feedState.isLoadingMore ? (
            <View className="items-center py-6">
              <ActivityIndicator color={primaryColor} />
            </View>
          ) : null
        }
        onEndReached={() => {
          if (!feedState.isLoadingMore && feedState.hasMore) void loadMore();
        }}
        onEndReachedThreshold={0.4}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={5}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews
        contentContainerStyle={{
          paddingBottom: 20,
          // Clear the pinned top bar in its initial (lowered) position so the
          // first row of the scrolling header sits right beneath it.
          paddingTop: insets.top + TOP_BAR_HEIGHT + COLLAPSE_DISTANCE,
        }}
        ItemSeparatorComponent={() => (
          <View
            style={{
              height: 1,
              backgroundColor: feedColors.divider,
              marginHorizontal: 18,
            }}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={primaryColor}
            progressViewOffset={insets.top + TOP_BAR_HEIGHT}
          />
        }
        keyboardDismissMode="none"
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
      />

      {/* Pinned top bar — scrolls up a touch, then sticks below the status bar */}
      <RNAnimated.View
        pointerEvents="box-none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 20,
          backgroundColor: feedColors.page,
          paddingTop: insets.top,
          transform: [{ translateY: barTranslateY }],
        }}
      >
        <View style={{ paddingTop: 6, paddingBottom: 8 }}>
          <FeedTopBar unreadCount={unreadCount} />
        </View>
        <RNAnimated.View
          pointerEvents="none"
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: feedColors.divider,
            opacity: barBorderOpacity,
          }}
        />
      </RNAnimated.View>
    </View>
  );
}
