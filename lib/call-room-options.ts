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

  // Matches VideoPresets.h720.resolution, inlined rather than imported because
  // pulling the value would mean a runtime import of livekit-client (see note
  // above). NOT the web's 1080p: this client only runs on phones, and libwebrtc
  // has no hardware VP8 encoder for MediaTek chips (the Helio in the Infinix
  // test phone and most budget Androids), so 1080p30 is software-encoded while
  // the peer's 1080p is decoded — enough to starve the JS thread, which is
  // "the call plays but mute/camera/end do nothing".
  videoCaptureDefaults: {
    resolution: {
      width: 1280,
      height: 720,
      frameRate: 30,
      aspectRatio: 1280 / 720,
    },
  },

  publishDefaults: {
    // 1:1 call with one subscriber that always wants the top layer. Extra
    // simulcast layers cost uplink + encoder CPU and buy us nothing.
    simulcast: false,
    videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 },
    // degradationPreference deliberately unset: livekit-client then uses
    // 'balanced' for a sub-1080p camera (on a phone the pressure is CPU, and
    // holding resolution under CPU overuse is what froze the call UI) and
    // 'maintain-resolution' for screen share, where legibility is the point.

    // Screen share is a different signal from a camera feed and needs its own
    // ceiling. Without this key it inherits videoEncoding above, which was
    // tuned for a camera at 30fps; a shared phone screen is taller, sharper,
    // and mostly static text, so it wants the bitrate headroom far more than it
    // wants the framerate.
    screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 15 },
  },
};
