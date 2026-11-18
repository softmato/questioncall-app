// Self-check for the pending-send handling in channelSlice.
// Run: npx sucrase-node scripts/check-channel-slice.ts
import assert from "node:assert/strict";
import reducer, {
  addPendingMessage,
  clearChannel,
  resolvePendingMessage,
  setChannelData,
  type ChatMessage,
  type ChannelDetail,
} from "../store/slices/channelSlice";

const detail = { id: "c1", questionImages: [] } as unknown as ChannelDetail;
const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "",
  channelId: "c1",
  senderId: "u1",
  senderName: "You",
  content: "",
  isSystemMessage: false,
  isOwn: true,
  isSeen: false,
  isDelivered: false,
  isMarkedAsAnswer: false,
  isDeleted: false,
  sentAt: new Date().toISOString(),
  ...over,
});

let s = reducer(
  undefined,
  setChannelData({ channelId: "c1", detail, messages: [msg({ id: "m1" })] }),
);
s = reducer(
  s,
  addPendingMessage(
    msg({ id: "l1", localId: "l1", mediaUrl: "file:///a.jpg", isSending: true }),
  ),
);

// A refetch mid-upload must not wipe the in-flight photo.
s = reducer(
  s,
  setChannelData({ channelId: "c1", detail, messages: [msg({ id: "m1" })] }),
);
assert.equal(s.cache.c1.messages.length, 2, "pending send survives refetch");

// Leaving the chat mid-upload must not drop the resolve.
s = reducer(s, clearChannel());
s = reducer(
  s,
  resolvePendingMessage({
    localId: "l1",
    message: msg({ id: "m2", mediaUrl: "https://x/a.jpg" }),
  }),
);
const sent = s.cache.c1.messages[1];
assert.equal(sent.id, "m2", "resolved while chat closed");
assert.equal(sent.clientKey, "l1", "row key stays stable");
assert.equal(sent.localPreviewUri, "file:///a.jpg", "local preview kept for the swap");

// Server copy landing first (refetch) then the resolve: one message, not two.
s = reducer(s, addPendingMessage(msg({ id: "l2", localId: "l2", isSending: true })));
s = reducer(
  s,
  setChannelData({
    channelId: "c1",
    detail,
    messages: [msg({ id: "m1" }), msg({ id: "m2" }), msg({ id: "m3" })],
  }),
);
s = reducer(s, resolvePendingMessage({ localId: "l2", message: msg({ id: "m3" }) }));
assert.deepEqual(
  s.cache.c1.messages.map((m) => m.id),
  ["m1", "m2", "m3"],
  "no duplicate after resolve",
);
assert.equal(s.cache.c1.messages[1].clientKey, "l1", "refetch keeps clientKey");

console.log("channelSlice checks passed");
