/**
 * `lib/livekit-runtime` for the PWA, and what web/persistent-call-host.tsx
 * loads. Expo moves a module that two async chunks share into the bundle every
 * page loads first, so the call screen and call-prewarm's livekit-client have
 * to come in one chunk to keep LiveKit out of startup.
 */
export { Room, RoomEvent } from "./livekit-client";
export { PersistentCallHost } from "@/components/calls/persistent-call-host";
