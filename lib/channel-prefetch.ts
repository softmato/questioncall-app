/**
 * Channel prefetch cache.
 *
 * Opening a chat should never show a loading state. The chat screen renders
 * straight out of `state.channel.cache`, so the job here is to make sure an
 * entry is already there by the time the user taps a row: the channels list
 * warms the top of the list on load, and every row warms itself on press-in.
 *
 * All fetches are deduped and TTL-gated, so calling these on every render,
 * every scroll, or every press is cheap.
 */
import { api } from "@/lib/api";
import { store } from "@/store";
import {
  prefetchChannelData,
  type ChannelDetail,
  type ChatMessage,
} from "@/store/slices/channelSlice";

/** How long a warmed entry counts as fresh enough to skip re-fetching. */
const PREFETCH_TTL_MS = 60_000;

/** How many channels the list warms up front, newest first. */
export const PREFETCH_CHANNEL_COUNT = 12;

/** How many of those requests are allowed in flight at once. */
const PREFETCH_CONCURRENCY = 4;

/** In-flight requests, keyed by channel id, so duplicates share one call. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Normalizes a channel detail coming off the wire. Cache entries written
 * before `questionImages` existed rehydrate with it undefined, which the
 * question banner reads as "no images attached" — so always land an array.
 */
function normalizeDetail(channel: any): ChannelDetail {
  return {
    ...(channel as ChannelDetail),
    questionImages: Array.isArray(channel?.questionImages) ? channel.questionImages : [],
  };
}

function isFresh(channelId: string): boolean {
  const entry = store.getState().channel.cache[channelId];
  if (!entry) return false;
  if (!Array.isArray(entry.detail?.questionImages)) return false;
  return Date.now() - entry.fetchedAt < PREFETCH_TTL_MS;
}

/**
 * Warms one channel. Resolves once the cache is populated (or immediately if
 * it already is). Failures are swallowed — the chat screen refetches on open.
 */
export function prefetchChannel(channelId: string): Promise<void> {
  if (!channelId) return Promise.resolve();
  if (isFresh(channelId)) return Promise.resolve();

  const existing = inFlight.get(channelId);
  if (existing) return existing;

  const request = (async () => {
    try {
      // Same payload the chat screen fetches on open (the endpoint returns the
      // full message history), so a warmed entry is complete — "Load older
      // messages" keeps working straight off the cache.
      const res = await api.get(`/channels/${channelId}`);
      const { channel, messages } = res.data ?? {};
      if (channel && Array.isArray(messages)) {
        store.dispatch(
          prefetchChannelData({
            channelId,
            detail: normalizeDetail(channel),
            messages: messages as ChatMessage[],
          }),
        );
      }
    } catch {
      // Best-effort: the chat screen falls back to its own fetch.
    } finally {
      inFlight.delete(channelId);
    }
  })();

  inFlight.set(channelId, request);
  return request;
}

/**
 * Warms a batch of channels with bounded concurrency so a long list can't
 * fire dozens of parallel requests behind the user's back.
 */
export async function prefetchChannels(
  channelIds: string[],
  limit = PREFETCH_CHANNEL_COUNT,
): Promise<void> {
  const targets = channelIds.filter(Boolean).slice(0, limit);
  if (targets.length === 0) return;

  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const id = targets[cursor++];
      await prefetchChannel(id);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PREFETCH_CONCURRENCY, targets.length) }, worker),
  );
}
