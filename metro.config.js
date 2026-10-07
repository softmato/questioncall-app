const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// ─────────────────────────────────────────────────────────────────────────────
// Stub @react-native-community/netinfo.
//
// pusher-js/react-native depends on @react-native-community/netinfo, which
// throws at JS module-load time if the RNCNetInfo native module isn't
// compiled into the dev client APK (`NativeModule.RNCNetInfo is null`). Until
// the dev client is rebuilt with `npx expo run:android`, we redirect every
// import of `@react-native-community/netinfo` to the JS-only stub at
// `lib/netinfo-stub.js` so Pusher loads cleanly and reports "permanently
// online". To restore real network awareness, rebuild the dev client and
// remove this resolver block.
// ─────────────────────────────────────────────────────────────────────────────
const netInfoStubPath = path.resolve(__dirname, "lib/netinfo-stub.js");
const baseResolveRequest = config.resolver.resolveRequest;

// ─────────────────────────────────────────────────────────────────────────────
// The installable web app (PWA): this app exported for the browser and served
// by questioncall.com at `/app`. Where the phone leans on something a browser
// does not have, the web bundle — and only the web bundle — gets a stand-in
// from `web/`. Nothing else in the app knows the web build exists.
// `expo-router/entry-classic` is how `web/entry.ts` runs ahead of the router
// (package.json `main` never reaches this resolver).
// ─────────────────────────────────────────────────────────────────────────────
const webRoot = path.resolve(__dirname, "web");
const WEB_STAND_INS = {
  "@/lib/google-signin": "google-signin.ts",
  "@/lib/push-notifications": "push-notifications.ts",
  "@/components/calls/persistent-call-host": "persistent-call-host.tsx",
  "@/lib/livekit-runtime": "call-chunk.ts",
  "@livekit/react-native": "livekit.tsx",
  "@sentry/react-native": "sentry.ts",
  "expo-file-system/legacy": "file-system.ts",
  "expo-local-authentication": "local-authentication.ts",
  "expo-notifications": "notifications.ts",
  "expo-router/entry-classic": "entry.ts",
  "expo-screen-capture": "screen-capture.ts",
  "expo-secure-store": "secure-store.ts",
  "livekit-client": "livekit-client.ts",
  "react-native-callkeep": "callkeep.ts",
  "react-native-webview": "webview.tsx",
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === "web" &&
    WEB_STAND_INS[moduleName] &&
    !context.originModulePath.startsWith(webRoot)
  ) {
    return {
      filePath: path.join(webRoot, WEB_STAND_INS[moduleName]),
      type: "sourceFile",
    };
  }
  if (moduleName === "@react-native-community/netinfo") {
    return { filePath: netInfoStubPath, type: "sourceFile" };
  }
  if (typeof baseResolveRequest === "function") {
    return baseResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./global.css" });
