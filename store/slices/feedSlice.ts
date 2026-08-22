import { createSlice, PayloadAction } from "@reduxjs/toolkit";

import type {
  FeedQuestion as FeedQuestionRecord,
  QuestionReaction,
  QuestionStatus,
} from "@/types/question";

export type FeedQuestion = FeedQuestionRecord;

type FeedRole = "STUDENT" | "TEACHER" | "ADMIN";

interface FeedState {
  questions: FeedQuestion[];
  myQuestions: FeedQuestion[];
  isLoading: boolean;
  isLoadingMore: boolean;
  isRefreshing: boolean;
  hasMore: boolean;
  page: number;
  error: string | null;
  lastFetchedAt: number | null;
  loadedForRole: FeedRole | null;
  loadedForUserId: string | null;
  // Question IDs that are still being persisted to the server.
  // Used to render a "Posting…" badge on optimistic question cards.
  optimisticIds: string[];
}

const FEED_CACHE_TTL_MS = 60 * 1000;

function toStringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function toNumberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeReaction(value: unknown): QuestionReaction | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as { userId?: unknown; type?: unknown };
  const userId = toStringValue(raw.userId);
  const type =
    raw.type === "like" || raw.type === "insightful" || raw.type === "same_doubt"
      ? raw.type
      : null;

  if (!userId || !type) {
    return null;
  }

  return { userId, type };
}

export function getFeedQuestionId(
  question: Pick<FeedQuestion, "id"> & {
    _id?: string | null;
  },
) {
  return question.id || question._id || "";
}

export function normalizeFeedQuestion(raw: unknown): FeedQuestion {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const createdAt = toStringValue(data.createdAt, new Date().toISOString());
  const status =
    data.status === "ACCEPTED" || data.status === "SOLVED" || data.status === "RESET"
      ? (data.status as QuestionStatus)
      : "OPEN";
  const reactions = Array.isArray(data.reactions)
    ? data.reactions
        .map(normalizeReaction)
        .filter((reaction): reaction is QuestionReaction => Boolean(reaction))
    : [];
  const answerRaw =
    data.answer && typeof data.answer === "object"
      ? (data.answer as Record<string, unknown>)
      : null;

  return {
    id: toStringValue(data.id ?? data._id, `question-${Date.now()}`),
    _id: toStringValue(data._id, ""),
    channelId:
      typeof data.channelId === "string" || data.channelId === null
        ? (data.channelId as string | null)
        : null,
    askerId: toStringValue(data.askerId, ""),
    askerName: toStringValue(data.askerName, "Anonymous"),
    askerUsername:
      typeof data.askerUsername === "string" ? data.askerUsername : undefined,
    askerImage: typeof data.askerImage === "string" ? data.askerImage : undefined,
    askerIsOnline: data.askerIsOnline === true,
    // Optional since the ask flow went camera-first — a photo-only
    // question has no title, and the card renders the photo instead.
    title: toStringValue(data.title, ""),
    body: toStringValue(data.body, ""),
    images: toStringArray(data.images),
    answerFormat: toStringValue(data.answerFormat, "ANY") as FeedQuestion["answerFormat"],
    answerVisibility: data.answerVisibility === "PRIVATE" ? "PRIVATE" : "PUBLIC",
    status,
    subject: typeof data.subject === "string" ? data.subject : undefined,
    stream: typeof data.stream === "string" ? data.stream : undefined,
    level: typeof data.level === "string" ? data.level : undefined,
    resetCount: toNumberValue(data.resetCount, 0),
    reactions,
    acceptedById:
      typeof data.acceptedById === "string" || data.acceptedById === null
        ? (data.acceptedById as string | null)
        : null,
    acceptedAt:
      typeof data.acceptedAt === "string" || data.acceptedAt === null
        ? (data.acceptedAt as string | null)
        : null,
    createdAt,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : createdAt,
    answerCount: toNumberValue(data.answerCount, answerRaw ? 1 : 0),
    reactionCount: toNumberValue(data.reactionCount, reactions.length),
    commentCount: toNumberValue(data.commentCount, 0),
    acceptedByName:
      typeof data.acceptedByName === "string" || data.acceptedByName === null
        ? (data.acceptedByName as string | null)
        : null,
    previewAuthor:
      typeof data.previewAuthor === "string" ? data.previewAuthor : undefined,
    previewText: typeof data.previewText === "string" ? data.previewText : undefined,
    answer: answerRaw
      ? {
          content: typeof answerRaw.content === "string" ? answerRaw.content : undefined,
          mediaUrls: toStringArray(answerRaw.mediaUrls),
          answerFormat:
            typeof answerRaw.answerFormat === "string"
              ? answerRaw.answerFormat
              : undefined,
          rating: typeof answerRaw.rating === "number" ? answerRaw.rating : null,
          acceptorName:
            typeof answerRaw.acceptorName === "string"
              ? answerRaw.acceptorName
              : undefined,
          submittedAt:
            typeof answerRaw.submittedAt === "string" ? answerRaw.submittedAt : undefined,
        }
      : undefined,
  };
}

export function normalizeFeedQuestions(rawQuestions: unknown) {
  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  return rawQuestions.map((question) => normalizeFeedQuestion(question));
}

const initialState: FeedState = {
  questions: [],
  myQuestions: [],
  isLoading: false,
  isLoadingMore: false,
  isRefreshing: false,
  hasMore: true,
  page: 1,
  error: null,
  lastFetchedAt: null,
  loadedForRole: null,
  loadedForUserId: null,
  optimisticIds: [],
};

const feedSlice = createSlice({
  name: "feed",
  initialState,
  reducers: {
    setQuestions(
      state,
      action: PayloadAction<{
        questions: FeedQuestion[];
        role: FeedRole | null;
        userId: string | null;
      }>,
    ) {
      state.questions = action.payload.questions;
      state.lastFetchedAt = Date.now();
      state.loadedForRole = action.payload.role;
      state.loadedForUserId = action.payload.userId;
      state.isLoading = false;
      state.isRefreshing = false;
    },
    appendQuestions(state, action: PayloadAction<FeedQuestion[]>) {
      state.questions = [...state.questions, ...action.payload];
      state.isLoading = false;
    },
    prependQuestion(state, action: PayloadAction<FeedQuestion>) {
      const nextQuestionId = getFeedQuestionId(action.payload);
      state.questions = [
        action.payload,
        ...state.questions.filter(
          (question) => getFeedQuestionId(question) !== nextQuestionId,
        ),
      ];
    },
    removeQuestion(state, action: PayloadAction<string>) {
      state.questions = state.questions.filter(
        (q) => getFeedQuestionId(q) !== action.payload,
      );
      state.myQuestions = state.myQuestions.filter(
        (q) => getFeedQuestionId(q) !== action.payload,
      );
    },
    updateQuestion(
      state,
      action: PayloadAction<{ id: string; data: Partial<FeedQuestion> }>,
    ) {
      const idx = state.questions.findIndex(
        (q) => getFeedQuestionId(q) === action.payload.id,
      );
      if (idx !== -1) {
        state.questions[idx] = {
          ...state.questions[idx],
          ...action.payload.data,
        };
      }

      state.myQuestions = state.myQuestions.map((question) =>
        getFeedQuestionId(question) === action.payload.id
          ? {
              ...question,
              ...action.payload.data,
            }
          : question,
      );
    },
    setMyQuestions(state, action: PayloadAction<FeedQuestion[]>) {
      state.myQuestions = action.payload;
    },
    addMyQuestion(state, action: PayloadAction<FeedQuestion>) {
      const nextQuestionId = getFeedQuestionId(action.payload);
      state.myQuestions = [
        action.payload,
        ...state.myQuestions.filter(
          (question) => getFeedQuestionId(question) !== nextQuestionId,
        ),
      ];
    },
    setFeedLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
    setFeedLoadingMore(state, action: PayloadAction<boolean>) {
      state.isLoadingMore = action.payload;
    },
    setFeedRefreshing(state, action: PayloadAction<boolean>) {
      state.isRefreshing = action.payload;
    },
    setHasMore(state, action: PayloadAction<boolean>) {
      state.hasMore = action.payload;
    },
    markOptimistic(state, action: PayloadAction<string>) {
      if (!state.optimisticIds.includes(action.payload)) {
        state.optimisticIds.push(action.payload);
      }
    },
    unmarkOptimistic(state, action: PayloadAction<string>) {
      state.optimisticIds = state.optimisticIds.filter((id) => id !== action.payload);
    },
    setPage(state, action: PayloadAction<number>) {
      state.page = action.payload;
    },
    setFeedError(state, action: PayloadAction<string>) {
      state.error = action.payload;
      state.isLoading = false;
    },
    clearFeedError(state) {
      state.error = null;
    },
    clearFeedCache(state) {
      state.questions = [];
      state.myQuestions = [];
      state.lastFetchedAt = null;
      state.loadedForRole = null;
      state.loadedForUserId = null;
      state.error = null;
      state.isLoading = false;
      state.isLoadingMore = false;
      state.isRefreshing = false;
      state.hasMore = true;
      state.optimisticIds = [];
    },
  },
});

export const {
  setQuestions,
  appendQuestions,
  prependQuestion,
  removeQuestion,
  updateQuestion,
  setMyQuestions,
  addMyQuestion,
  setFeedLoading,
  setFeedLoadingMore,
  setFeedRefreshing,
  setHasMore,
  setPage,
  setFeedError,
  clearFeedError,
  clearFeedCache,
  markOptimistic,
  unmarkOptimistic,
} = feedSlice.actions;

export const selectIsFeedStale = (lastFetchedAt: number | null) => {
  if (!lastFetchedAt) return true;
  return Date.now() - lastFetchedAt > FEED_CACHE_TTL_MS;
};

export default feedSlice.reducer;
