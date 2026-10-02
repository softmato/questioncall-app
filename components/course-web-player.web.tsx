import { useEffect, useRef, useState } from "react";
import type HlsController from "hls.js";
import type { CourseWebPlayerProps } from "./course-web-player";

export default function CourseWebPlayer({ source, onProgress }: CourseWebPlayerProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let disposed = false;
    let hls: HlsController | undefined;
    setFailed(false);
    const reportError = (detail?: unknown) => {
      // Keep this diagnostic in production (Babel removes direct console calls).
      Reflect.apply(console.error, console, [
        "[Course video playback]",
        {
          code: video.error?.code,
          message: video.error?.message,
          currentSrc: video.currentSrc,
          source,
          detail,
        },
      ]);
      setFailed(true);
    };
    const onError = () => reportError();
    video.addEventListener("error", onError);

    const load = async () => {
      try {
        if (/\.m3u8(?:[?#]|$)/i.test(source)) {
          const { default: HlsPlayer } = await import("hls.js");
          if (disposed) return;
          if (HlsPlayer.isSupported()) {
            hls = new HlsPlayer();
            hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
              if (data.fatal) reportError({ type: data.type, details: data.details });
            });
            hls.loadSource(source);
            hls.attachMedia(video);
            return;
          }
        }
        // Native HLS on Safari, or a direct MP4 URL.
        video.src = source;
        video.load();
      } catch (error) {
        if (!disposed) reportError(String(error));
      }
    };
    void load();
    return () => {
      disposed = true;
      video.removeEventListener("error", onError);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [source, attempt]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <video
        ref={ref}
        controls
        playsInline
        preload="metadata"
        style={{ width: "100%", height: "100%" }}
        onTimeUpdate={(event) => onProgress(event.currentTarget.currentTime)}
        onEnded={(event) => onProgress(event.currentTarget.currentTime)}
      />
      {failed && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "black",
            color: "white",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
          }}
        >
          <p>This video couldn&apos;t play.</p>
          <button onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>
      )}
    </div>
  );
}
