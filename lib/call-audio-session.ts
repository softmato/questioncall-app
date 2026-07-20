// WhatsApp-style call audio routing, built on @livekit/react-native's native
// AudioSession instead of expo-av.
//
// Android: the "communication" preset puts the device in MODE_IN_COMMUNICATION
// with audio on STREAM_VOICE_CALL — the remote voice plays at *call* volume
// (hardware volume keys adjust call volume, not media), echo cancellation/AGC
// engage, and routing is earpiece-first like a phone call. Speaker toggle goes
// through selectAudioOutput, not audio-mode flips.
//
// iOS: playAndRecord + voiceChat/videoChat via the Apple audio configuration;
// the speaker toggle stays on CallKit's route override (see callkeep-setup).
//
// IMPORTANT: keep expo-av's Audio.setAudioModeAsync OUT of the in-call path.
// Mixing the two audio managers is what caused the "remote voice missing/tiny"
// bug: expo-av would flip Android back to MODE_NORMAL and WebRTC audio landed
// on the media stream. Other features that play media (chat voice notes etc.)
// must skip audio-mode changes while a call is active — see hasAnyActiveCall().

import { Platform } from "react-native";
import {
  AudioSession,
  AndroidAudioTypePresets,
  getDefaultAppleAudioConfigurationForMode,
} from "@livekit/react-native";

export type CallMode = "AUDIO" | "VIDEO";

let sessionActive = false;

/**
 * Configure + start the native call audio session. Safe to call repeatedly —
 * reconfiguration is cheap and idempotent. Voice calls default to the
 * earpiece, video calls to the loudspeaker (WhatsApp behavior).
 */
export async function startCallAudio(mode: CallMode, speakerOn?: boolean) {
  const wantSpeaker = speakerOn ?? mode === "VIDEO";
  try {
    await AudioSession.configureAudio({
      android: {
        preferredOutputList: [wantSpeaker ? "speaker" : "earpiece"],
        audioTypeOptions: AndroidAudioTypePresets.communication,
      },
      ios: {
        defaultOutput: wantSpeaker ? "speaker" : "earpiece",
      },
    });
    if (Platform.OS === "ios") {
      await AudioSession.setAppleAudioConfiguration(
        getDefaultAppleAudioConfigurationForMode("localAndRemote", wantSpeaker),
      );
    }
    await AudioSession.startAudioSession();
    sessionActive = true;
    await setCallSpeaker(wantSpeaker);
  } catch (err) {
    console.warn(
      "[call-audio] startCallAudio failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Route in-call audio to the loudspeaker (true) or earpiece (false). */
export async function setCallSpeaker(on: boolean) {
  try {
    if (Platform.OS === "android") {
      await AudioSession.selectAudioOutput(on ? "speaker" : "earpiece");
    } else {
      await AudioSession.selectAudioOutput(on ? "force_speaker" : "default");
    }
  } catch (err) {
    console.warn(
      "[call-audio] setCallSpeaker failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Stop the call audio session and hand the device back to its default state:
 * media plays on the loudspeaker at media volume, volume keys control the
 * ringer again. Must run on every call teardown path.
 */
export async function stopCallAudio() {
  if (!sessionActive) return;
  sessionActive = false;
  try {
    await AudioSession.stopAudioSession();
  } catch (err) {
    console.warn(
      "[call-audio] stopAudioSession failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  // Also reset expo-av to neutral defaults in case any sound (e.g. the
  // outgoing ringback) touched its audio mode during the call.
  try {
    const { Audio } = await import("expo-av");
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: false,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      allowsRecordingIOS: false,
      playThroughEarpieceAndroid: false,
    });
  } catch {}
}
