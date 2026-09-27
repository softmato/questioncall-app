import { useEffect, useRef } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import type { VideoTrack } from "livekit-client";

/**
 * `@livekit/react-native` for the PWA. livekit-client runs natively in a
 * browser, so the app's Room code is unchanged; only what wraps the phone's
 * WebRTC and audio routing is replaced. `VideoView` is a <video> the track is
 * attached to, and the audio session is the browser's own — earpiece and
 * speaker routing do not exist on the web.
 */
export const registerGlobals = () => {};

export const AndroidAudioTypePresets = { communication: {}, media: {} };

export const getDefaultAppleAudioConfigurationForMode = (..._args: unknown[]) => ({});

export const AudioSession = {
  configureAudio: async (_config?: unknown) => {},
  selectAudioOutput: async (_output?: string) => {},
  setAppleAudioConfiguration: async (_config?: unknown) => {},
  startAudioSession: async () => {},
  stopAudioSession: async () => {},
};

type Props = {
  mirror?: boolean;
  objectFit?: "contain" | "cover";
  style?: StyleProp<ViewStyle>;
  videoTrack?: VideoTrack | null;
  zOrder?: number;
};

export function VideoView({
  mirror,
  objectFit = "cover",
  style,
  videoTrack,
  zOrder,
}: Props) {
  const video = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = video.current;
    if (!element || !videoTrack) return;

    videoTrack.attach(element);
    return () => {
      videoTrack.detach(element);
    };
  }, [videoTrack]);

  return (
    <View style={[{ overflow: "hidden", zIndex: zOrder }, style]}>
      <video
        autoPlay
        muted
        playsInline
        ref={video}
        style={{
          height: "100%",
          objectFit,
          transform: mirror ? "scaleX(-1)" : undefined,
          width: "100%",
        }}
      />
    </View>
  );
}
