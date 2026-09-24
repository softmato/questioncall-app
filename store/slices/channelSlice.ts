import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export interface ChatMessage {
  id: string;
  _id?: string;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
  isSystemMessage: boolean;
  isOwn: boolean;
  isSeen: boolean;
  isDelivered: boolean;
  isMarkedAsAnswer: boolean;
  isDeleted: boolean;
  sentAt: string;
  callInfo?: {
    callSessionId: string;
    mode: "AUDIO" | "VIDEO";
    status: "ENDED" | "REJECTED" | "MISSED";
    durationSeconds: number | null;
    callerName: string;
    callerId: string;
  } | null;
  localId?: string;
  isSending?: boolean;
  sendFailed?: boolean;
}

export interface ChannelDetail {
  id: string;
  questionId: string;
  askerId: string;
  acceptorId: string;
  openedAt: string;
  timerDeadline: string;
  timeExtensionCount: number;
  closedAt?: string | null;
  status: "ACTIVE" | "CLOSED" | "EXPIRED" | "ANSWERED";
  isClosedByAsker: boolean;
  ratingGiven?: number | null;
  createdAt: string;
  updatedAt: string;
  questionTitle: string;
  questionBody: string;
  questionImages: string[];
  answerFormat: string;
  answerVisibility: string;
  askerName: string;
  askerUsername?: string;
  askerImage?: string;
  acceptorName: string;
  acceptorUsername?: string;
  acceptorImage?: string;
  formatDurationMinutes: number;
  maxVideoDurationMinutes: number;
  isAnswerSubmitted: boolean;
}

interface ChannelCacheEntry {
  detail: ChannelDetail;
  messages: ChatMessage[];
  fetchedAt: number;
}

interface ChannelState {
  activeChannelId: string | null;
  cache: Record<string, ChannelCacheEntry>;
  isLoading: boolean;
  error: string | null;
}

const initialState: ChannelState = {
  activeChannelId: null,
  cache: {},
  isLoading: false,
  error: null,
};

function getMessageId(m: ChatMessage) {
  return m.id || m._id || m.localId || "";
}

function getActive(state: ChannelState) {
  if (!state.activeChannelId) return null;
  return state.cache[state.activeChannelId] ?? null;
}

const channelSlice = createSlice({
  name: "channel",
  initialState,
  reducers: {
    setChannelLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
    setChannelError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
      state.isLoading = false;
    },
    setChannelData(
      state,
      action: PayloadAction<{
        channelId: string;
        detail: ChannelDetail;
        messages: ChatMessage[];
      }>,
    ) {
      const { channelId, detail, messages } = action.payload;
      state.activeChannelId = channelId;
      state.cache[channelId] = { detail, messages, fetchedAt: Date.now() };
      state.isLoading = false;
      state.error = null;
    },
    /**
     * Warms the cache for a channel the user has *not* opened yet.
     *
     * Unlike `setChannelData` this never touches `activeChannelId` — a
     * background prefetch of ten channels must not make the last one to
     * resolve "active", or realtime messages would land in the wrong chat.
     * Locally-owned messages (still sending, or failed and queued for retry)
     * are preserved: the server response doesn't know about them yet.
     */
    prefetchChannelData(
      state,
      action: PayloadAction<{
        channelId: string;
        detail: ChannelDetail;
        messages: ChatMessage[];
      }>,
    ) {
      const { channelId, detail, messages } = action.payload;
      const existing = state.cache[channelId];
      const localOnly =
        existing?.messages.filter((m) => m.isSending || m.sendFailed) ?? [];
      const serverIds = new Set(messages.map(getMessageId));
      state.cache[channelId] = {
        detail,
        messages: [
          ...messages,
          ...localOnly.filter((m) => !serverIds.has(getMessageId(m))),
        ],
        fetchedAt: Date.now(),
      };
    },
    /**
     * Marks a channel active without replacing its cached payload — used when
     * the chat screen opens on a warm cache, so it can paint immediately and
     * refresh in the background instead of blocking on the network.
     */
    setActiveChannel(state, action: PayloadAction<string>) {
      state.activeChannelId = action.payload;
      state.isLoading = false;
      state.error = null;
    },
    appendMessage(state, action: PayloadAction<ChatMessage>) {
      const msg = action.payload;
      // Try active channel first, then fall back to the message's own channelId
      const activeEntry = getActive(state);
      const entry =
        activeEntry ?? (msg.channelId ? state.cache[msg.channelId] : undefined);
      if (!entry) {
        // Channel data hasn't been fetched yet — this message will be
        // picked up on the next fetch. Log it for debugging.
        console.warn(
          `[channelSlice] appendMessage: no cache entry for channelId=${msg.channelId} (activeChannelId=${state.activeChannelId}). Message will be fetched on next load.`,
        );
        return;
      }
      const msgId = getMessageId(msg);
      const exists = entry.messages.some((m) => getMessageId(m) === msgId);
      if (!exists) {
        entry.messages.push(msg);
      }
    },
    addPendingMessage(state, action: PayloadAction<ChatMessage>) {
      const entry = getActive(state);
      if (entry) entry.messages.push(action.payload);
    },
    resolvePendingMessage(
      state,
      action: PayloadAction<{ localId: string; message: ChatMessage }>,
    ) {
      const entry = getActive(state);
      if (!entry) return;
      const idx = entry.messages.findIndex((m) => m.localId === action.payload.localId);
      if (idx !== -1) {
        entry.messages[idx] = action.payload.message;
      }
    },
    failPendingMessage(state, action: PayloadAction<string>) {
      const entry = getActive(state);
      if (!entry) return;
      const idx = entry.messages.findIndex((m) => m.localId === action.payload);
      if (idx !== -1) {
        entry.messages[idx] = {
          ...entry.messages[idx],
          isSending: false,
          sendFailed: true,
        };
      }
    },
    removeMessage(state, action: PayloadAction<string>) {
      const entry = getActive(state);
      if (entry) {
        entry.messages = entry.messages.filter((m) => getMessageId(m) !== action.payload);
      }
    },
    toggleMessageMarked(
      state,
      action: PayloadAction<{ messageId: string; isMarkedAsAnswer: boolean }>,
    ) {
      const entry = getActive(state);
      if (!entry) return;
      const msg = entry.messages.find(
        (m) => getMessageId(m) === action.payload.messageId,
      );
      if (msg) msg.isMarkedAsAnswer = action.payload.isMarkedAsAnswer;
    },
    setMessageDeleted(state, action: PayloadAction<string>) {
      const entry = getActive(state);
      if (!entry) return;
      const msg = entry.messages.find((m) => getMessageId(m) === action.payload);
      if (msg) {
        msg.isDeleted = true;
        msg.content = "";
      }
    },
    markMessagesAsSeen(state) {
      const entry = getActive(state);
      if (!entry) return;
      for (const msg of entry.messages) {
        if (!msg.isOwn) msg.isSeen = true;
      }
    },
    setChannelStatus(
      state,
      action: PayloadAction<{
        status: ChannelDetail["status"];
        ratingGiven?: number | null;
      }>,
    ) {
      const entry = getActive(state);
      if (entry) {
        entry.detail.status = action.payload.status;
        if (action.payload.ratingGiven !== undefined) {
          entry.detail.ratingGiven = action.payload.ratingGiven;
        }
      }
    },
    setChannelTimer(
      state,
      action: PayloadAction<{
        timerDeadline: string;
        timeExtensionCount: number;
      }>,
    ) {
      const entry = getActive(state);
      if (entry) {
        entry.detail.timerDeadline = action.payload.timerDeadline;
        entry.detail.timeExtensionCount = action.payload.timeExtensionCount;
      }
    },
    setAnswerSubmitted(state, action: PayloadAction<boolean>) {
      const entry = getActive(state);
      if (entry) entry.detail.isAnswerSubmitted = action.payload;
    },
    clearChannel(state) {
      state.activeChannelId = null;
      state.error = null;
      state.isLoading = false;
    },
    evictChannelCache(state, action: PayloadAction<string>) {
      delete state.cache[action.payload];
    },
    clearAllChannelCache(state) {
      state.cache = {};
      state.activeChannelId = null;
      state.error = null;
      state.isLoading = false;
    },
  },
});

export const {
  setChannelLoading,
  setChannelError,
  setChannelData,
  prefetchChannelData,
  setActiveChannel,
  appendMessage,
  addPendingMessage,
  resolvePendingMessage,
  failPendingMessage,
  removeMessage,
  toggleMessageMarked,
  setMessageDeleted,
  markMessagesAsSeen,
  setChannelStatus,
  setChannelTimer,
  setAnswerSubmitted,
  clearChannel,
  evictChannelCache,
  clearAllChannelCache,
} = channelSlice.actions;
export default channelSlice.reducer;
