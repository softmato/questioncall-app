// Single source of truth for LiveKit Room options on the mobile client.
// Mirrored by web/lib/call-room-options.ts — keep the two in sync.
//
// Why these are set explicitly: livekit-client's stock defaults are tuned for
// multi-party rooms and are actively wrong for our 1:1 calls. Left unset they
// resolve to 720p capture, VP8, simulcast ON (180p + 360p + 720p ≈ 2.31 Mbps
// split across three layers), and degradationPreference 'balanced'. Our rooms
// are created with maxParticipants: 2 and both clients run adaptiveStream and
// dynacast OFF, so the two lower layers are encoded and uplinked but never
// watched — and when bandwidth estimation lands under ~2.3 Mbps libwebrtc
// culls the TOP layer first, leaving the peer looking at the 360p copy. That
// was the "video quality is way worse than WhatsApp" report.
//
// NOTE: this module must not import anything from "livekit-client" at runtime
// — only `import type`, which is erased at compile time. See the header of
// call-prewarm.ts: livekit-client touches DOMException at module-load time and
// must not be evaluated before registerGlobals() has run.

import type { RoomOptions } from "livekit-client";

export const CALL_ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: false,
  dynacast: false,

  // Matches VideoPresets.h1080.resolution. Inlined rather than imported
  // because pulling the value would mean a runtime import of livekit-client
  // (see note above). Treated as `ideal` by getUserMedia, so devices that
  // can't do 1080p degrade to their closest supported capture format.
  videoCaptureDefaults: {
    resolution: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      aspectRatio: 1920 / 1080,
    },
  },

  publishDefaults: {
    // 1:1 call with one subscriber that always wants the top layer. Extra
    // simulcast layers cost uplink + encoder CPU and buy us nothing.
    simulcast: false,
    videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 },
    // Default for sub-1080p capture is 'balanced', which resolves CPU or
    // bandwidth pressure by downscaling and is slow to climb back. We would
    // rather hold resolution and lose some smoothness — students hold written
    // work up to the camera, so legibility beats framerate.
    degradationPreference: "maintain-resolution",

    // Screen share is a different signal from a camera feed and needs its own
    // ceiling. Without this key it inherits videoEncoding above, which was
    // tuned for a 1080p camera at 30fps; a shared phone screen is taller,
    // sharper, and mostly static text, so it wants the bitrate headroom far
    // more than it wants the framerate. maintain-resolution for the same reason
    // it is set above, and more so: a downscaled screen share is unreadable,
    // which is the entire point of sharing one.
    screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 15 },
  },
};
