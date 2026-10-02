import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, StatusBar, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useEvent } from "expo";
import { router, useLocalSearchParams } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";

import { api } from "@/lib/api";
import CourseWebPlayer from "@/components/course-web-player";

const PROGRESS_PING_INTERVAL_MS = 10_000;

export default function CourseVideoScreen() {
  const {
    courseId,
    videoId,
    title,
    videoUrl,
    isPreview: initialIsPreview,
  } = useLocalSearchParams<{
    courseId: string;
    videoId: string;
    title?: string;
    videoUrl?: string;
    isPreview?: string;
  }>();

  const [videoSrc, setVideoSrc] = useState<string | null>(videoUrl ?? null);
  const [isPreview, setIsPreview] = useState(initialIsPreview === "1");
  const [error, setError] = useState<string | null>(null);
  const lastPingAt = useRef(0);
  const watchedSecondsRef = useRef(0);

  useEffect(() => {
    if (videoSrc) return;
    if (!courseId || !videoId) {
      setError("Missing course or video ID");
      return;
    }
    (async () => {
      try {
        const res = await api.get(`/courses/${courseId}/videos/${videoId}`);
        const d = res.data;
        // Prefer web-constructed playbackUrl which already includes Mux logic
        const src =
          d.playbackUrl ??
          (d.muxPlaybackId ? `https://stream.mux.com/${d.muxPlaybackId}.m3u8` : null) ??
          d.videoUrl ??
          d.url ??
          null;
        if (!src) {
          setError("Video URL not available");
          return;
        }
        setVideoSrc(src);
        setIsPreview(Boolean(d.isPreview));
      } catch (err) {
        console.error("[Video load error]", err);
        setError("Unable to load video. You may not have access.");
      }
    })();
  }, [courseId, videoId, videoSrc]);

  const player = useVideoPlayer(
    Platform.OS === "web" ? null : (videoSrc ?? null),
    (p) => {
      p.loop = false;
    },
  );

  // Without this a failed load is just ExoPlayer's grey "broken" icon, with
  // no hint of why (network, DNS, codec, 403…).
  const { error: playbackError } = useEvent(player, "statusChange", {
    status: player.status,
  });

  const sendProgressPing = useCallback(async () => {
    if (!courseId || !videoId || isPreview) return;
    const now = Date.now();
    if (now - lastPingAt.current < PROGRESS_PING_INTERVAL_MS) return;
    lastPingAt.current = now;

    try {
      await api.post(`/courses/${courseId}/progress`, {
        videoId,
        watchedSeconds: watchedSecondsRef.current,
      });
    } catch {}
  }, [courseId, videoId, isPreview]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (player.playing) {
        watchedSecondsRef.current = Math.floor(player.currentTime);
        void sendProgressPing();
      }
    }, PROGRESS_PING_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [player, sendProgressPing]);

  useEffect(() => {
    return () => {
      if (watchedSecondsRef.current > 0 && !isPreview) {
        api
          .post(`/courses/${courseId}/progress`, {
            videoId,
            watchedSeconds: watchedSecondsRef.current,
          })
          .catch(() => {});
      }
    };
  }, [courseId, videoId, isPreview]);

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-black px-8">
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text className="mt-3 text-center text-base text-white">{error}</Text>
        <TouchableOpacity
          onPress={() => router.back()}
          className="mt-4 rounded-full bg-white/20 px-6 py-2.5"
        >
          <Text className="font-semibold text-white">Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* Header */}
      <View className="flex-row items-center px-4 pb-2 pt-14">
        <TouchableOpacity onPress={() => router.back()} className="mr-3">
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text className="flex-1 text-base font-semibold text-white" numberOfLines={1}>
          {title ?? "Video"}
        </Text>
      </View>

      {/* Video player */}
      <View className="flex-1 items-center justify-center">
        {videoSrc && Platform.OS === "web" ? (
          <CourseWebPlayer
            source={videoSrc}
            onProgress={(seconds) => {
              watchedSecondsRef.current = Math.floor(seconds);
              void sendProgressPing();
            }}
          />
        ) : videoSrc ? (
          <VideoView
            player={player}
            style={{ width: "100%", height: "100%" }}
            fullscreenOptions={{ enable: true, orientation: "landscape" }}
            allowsPictureInPicture
            nativeControls
          />
        ) : (
          <Text className="text-base text-white/60">Loading video...</Text>
        )}
        {Platform.OS !== "web" && videoSrc && playbackError ? (
          <View className="absolute inset-0 items-center justify-center bg-black px-8">
            <Ionicons name="alert-circle-outline" size={40} color="#ef4444" />
            <Text className="mt-3 text-center text-base font-semibold text-white">
              This video couldn&apos;t play.
            </Text>
            <Text className="mt-1 text-center text-xs text-white/60">
              {playbackError.message}
            </Text>
            <TouchableOpacity
              onPress={() => void player.replaceAsync(videoSrc)}
              className="mt-4 rounded-full bg-white/20 px-6 py-2.5"
            >
              <Text className="font-semibold text-white">Try again</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {isPreview ? (
        <View className="border-t border-white/10 bg-black px-4 pb-6 pt-4">
          <Text className="text-sm font-semibold text-white">Free preview</Text>
          <Text className="mt-1 text-xs leading-5 text-white/65">
            Enroll or buy the course to unlock the full curriculum and save progress.
          </Text>
          <TouchableOpacity
            onPress={() =>
              router.push({
                pathname: "/course/[id]" as any,
                params: { id: courseId },
              })
            }
            className="mt-3 items-center rounded-full bg-white px-4 py-2.5"
          >
            <Text className="text-sm font-semibold text-black">View course</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}
