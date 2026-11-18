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
  /** A pending send's file, kept so a retry can upload it (mediaUrl is its local uri). */
  localMedia?: {
    name: string;
    mimeType: string;
    size?: number;
    width?: number;
    height?: number;
  };
  /** The optimistic localId, kept after the server copy lands so the list row never remounts. */
  clientKey?: string;
  /** Local file shown while the uploaded copy downloads — avoids the blank flash on resolve. */
  localPreviewUri?: string;
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

/**
 * A server refetch replaces the list, but must not erase what only this device
 * knows: sends still uploading or failed (a gallery pick backgrounds the app,
 * the socket reconnects, and the refetch used to wipe the in-flight photo until
 * the chat was reopened), and the local preview/row key of a send that landed.
 */
function mergeServerMessages(existing: ChatMessage[] | undefined, server: ChatMessage[]) {
  const prevById = new Map((existing ?? []).map((m) => [getMessageId(m), m]));
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const m of server) {
    const id = getMessageId(m);
    if (seen.has(id)) continue;
    seen.add(id);
    const prev = prevById.get(id);
    out.push(
      prev?.clientKey || prev?.localPreviewUri
        ? { ...m, clientKey: prev.clientKey, localPreviewUri: prev.localPreviewUri }
        : m,
    );
  }
  for (const m of existing ?? []) {
    if ((m.isSending || m.sendFailed) && !seen.has(getMessageId(m))) {
      seen.add(getMessageId(m));
      out.push(m);
    }
  }
  return out;
}

function resolveAt(
  entry: ChannelCacheEntry,
  idx: number,
  prev: ChatMessage,
  next: ChatMessage,
) {
  entry.messages[idx] = {
    ...next,
    clientKey: prev.clientKey ?? prev.localId,
    localMedia: next.localMedia ?? prev.localMedia,
    localPreviewUri:
      prev.localPreviewUri ??
      (prev.mediaUrl && !/^https?:\/\//.test(prev.mediaUrl) ? prev.mediaUrl : undefined),
  };
}

/**
 * The cache entry holding a pending send. Uploads outlive the screen: the user
 * can leave the chat mid-upload (activeChannelId → null), and resolving against
 * the active entry used to drop the result, leaving a bubble stuck "sending".
 */
function findPending(state: ChannelState, localId: string) {
  for (const entry of Object.values(state.cache)) {
    const idx = entry.messages.findIndex((m) => m.localId === localId);
    if (idx !== -1) return { entry, idx };
  }
  return null;
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
      state.cache[channelId] = {
        detail,
        messages: mergeServerMessages(state.cache[channelId]?.messages, messages),
        fetchedAt: Date.now(),
      };
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
      state.cache[channelId] = {
        detail,
        messages: mergeServerMessages(state.cache[channelId]?.messages, messages),
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
      const entry = state.cache[action.payload.channelId] ?? getActive(state);
      if (entry) entry.messages.push(action.payload);
    },
    resolvePendingMessage(
      state,
      action: PayloadAction<{ localId: string; message: ChatMessage }>,
    ) {
      const found = findPending(state, action.payload.localId);
      if (!found) return;
      const { entry, idx } = found;
      const prev = entry.messages[idx];
      const next = action.payload.message;
      // A refetch can land the server copy before this resolve does; drop that
      // copy so the pending row (and its stable key) becomes the one message.
      const serverId = next.localId ? "" : getMessageId(next);
      const dup = serverId
        ? entry.messages.findIndex((m, i) => i !== idx && getMessageId(m) === serverId)
        : -1;
      if (dup !== -1) entry.messages.splice(dup, 1);
      resolveAt(entry, dup !== -1 && dup < idx ? idx - 1 : idx, prev, next);
    },
    failPendingMessage(state, action: PayloadAction<string>) {
      const found = findPending(state, action.payload);
      if (!found) return;
      const { entry, idx } = found;
      entry.messages[idx] = {
        ...entry.messages[idx],
        isSending: false,
        sendFailed: true,
      };
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
