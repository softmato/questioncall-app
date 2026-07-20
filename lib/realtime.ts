// Use the RN-specific build, not the default browser build. The default entry
// references DOM globals that crash in Hermes with "constructor is not callable".
// See: https://github.com/pusher/pusher-js/blob/master/README.md#react-native
//
// CommonJS interop note: pusher-js v8's webpack bundle ends with
// `module.exports.Pusher = r` — i.e. the class lives on `.Pusher`, NOT on the
// default export. So `import Pusher from "pusher-js/react-native"` resolves
// to `undefined` and `new undefined()` throws "constructor is not callable".
// Pull `.Pusher` off the require'd namespace explicitly.
//
// pusher-js also imports @react-native-community/netinfo, which would crash
// at load time if the RNCNetInfo native module isn't built into the dev
// client APK. metro.config.js aliases that package to lib/netinfo-stub.js so
// the import resolves to a JS-only "always-connected" implementation.
const PusherModule: any = require("pusher-js/react-native");
const Pusher: any = PusherModule?.Pusher ?? PusherModule?.default ?? PusherModule;

let pusherClient: any = null;

export const USER_CHANNEL_PREFIX = "user-";
export const QUESTION_FEED_CHANNEL = "questions-feed";
export const QUESTION_CREATED_EVENT = "question:created";
export const QUESTION_UPDATED_EVENT = "question:updated";
export const CHANNEL_UPDATED_EVENT = "channel:updated";
export const NEW_CHANNEL_EVENT = "channel:new";
export const NOTIFICATION_EVENT = "notification:new";
export const SUBSCRIPTION_UPDATED_EVENT = "subscription:updated";
export const CHANNEL_MESSAGE_EVENT = "channel:message";
export const CHANNEL_STATUS_EVENT = "channel:status";
export const CHANNEL_CLOSED_EVENT = "channel:closed";
export const CHANNEL_TIMER_UPDATED_EVENT = "channel:timer_updated";
export const CHANNEL_MESSAGES_SEEN_EVENT = "channel:messages_seen";
export const MESSAGE_MARKED_EVENT = "message:marked";
export const MESSAGE_DELETED_EVENT = "message:deleted";
export const ANSWER_SUBMITTED_EVENT = "answer:submitted";
export const CALL_INCOMING_EVENT = "call:incoming";
export const CALL_ACCEPTED_EVENT = "call:accepted";
export const CALL_REJECTED_EVENT = "call:rejected";
export const CALL_CANCELLED_EVENT = "call:cancelled";
export const CALL_ENDED_EVENT = "call:ended";
export const CALL_MISSED_EVENT = "call:missed";
// Fired to the CALLEE's user channel when they accept/reject on one device, so
// their other logged-in devices (web + app) dismiss the incoming-call UI
// immediately instead of ringing until timeout.
export const CALL_HANDLED_EVENT = "call:handled";

export function getUserPusherName(userId: string) {
  return `${USER_CHANNEL_PREFIX}${userId}`;
}

export function getChannelPusherName(channelId: string) {
  return `channel-${channelId}`;
}

export function getPusherConfig() {
  const key = process.env.EXPO_PUBLIC_PUSHER_KEY;
  const cluster = process.env.EXPO_PUBLIC_PUSHER_CLUSTER;

  if (!key || !cluster) {
    return null;
  }

  return { key, cluster };
}

export function getPusherClient() {
  const config = getPusherConfig();
  if (!config) return null;

  if (!pusherClient) {
    pusherClient = new Pusher(config.key, {
      cluster: config.cluster,
    });
  }

  return pusherClient;
}

export function resetPusherClient() {
  pusherClient?.disconnect();
  pusherClient = null;
}
