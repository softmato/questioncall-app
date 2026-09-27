import { useEffect, useRef } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";

type Props = {
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
  source: { baseUrl?: string; html: string } | { uri: string };
  style?: StyleProp<ViewStyle>;
};

/**
 * `react-native-webview` for the PWA, which it has no web build for. The one
 * WebView in the app (the onboarding video player) renders a page it wrote
 * around a YouTube / Vimeo / Loom embed, so an `srcdoc` iframe carries it, with
 * a `window.ReactNativeWebView` defined ahead of the page's scripts that posts
 * back to `onMessage`.
 */
export function WebView({ onMessage, source, style }: Props) {
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    function listen(event: MessageEvent) {
      if (
        event.source === frame.current?.contentWindow &&
        event.data?.rnWebView !== undefined
      ) {
        onMessage?.({ nativeEvent: { data: String(event.data.rnWebView) } });
      }
    }

    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [onMessage]);

  const bridge = `<script>window.ReactNativeWebView={postMessage:function(d){parent.postMessage({rnWebView:String(d)},"*")}};</script>`;
  const srcDoc =
    "html" in source
      ? /<head[^>]*>/i.test(source.html)
        ? source.html.replace(/<head[^>]*>/i, (head) => head + bridge)
        : bridge + source.html
      : undefined;

  return (
    <View style={[{ flex: 1, overflow: "hidden" }, style]}>
      <iframe
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        ref={frame}
        src={"uri" in source ? source.uri : undefined}
        srcDoc={srcDoc}
        style={{ border: 0, height: "100%", width: "100%" }}
      />
    </View>
  );
}

export default WebView;
