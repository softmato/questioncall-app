import { requireOptionalNativeModule } from "expo";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Platform, StyleSheet, View } from "react-native";

/**
 * The JS half of the launch screen.
 *
 * On Android the launch screen is native: `modules/questioncall-boot-splash`,
 * which MainActivity puts up on its first frame (wired by
 * `plugins/withSplashBranding.js`). The system splash shows only the centred
 * logo — the one thing every phone draws the same; its branding slot is missing
 * on Android 11 and below, skipped by some OEM skins, and forced into a 200x80dp
 * box everywhere else. The native view takes over with that logo in place, then
 * "Powered by Softmato" rises in and a shine crosses the logo while the loader
 * under it fills in step — to 85%, and the rest once `releaseBootSplash()` says
 * the app is up. Then it fades onto the first screen.
 *
 * Where the module is missing (the PWA, an Android build from before it), this
 * overlay plays the same animation in JS instead.
 *
 * Geometry is mirrored from four places; keep them in sync:
 *   - `LOGO_WIDTH` ← `imageWidth` in the app.json splash config
 *   - `LOGO_HEIGHT` ← the canvas ratio `scripts/gen_splash.py` prints
 *   - `STRIP_*`    ← the dp size the drawables in `plugins/splash-branding-res` were cut for
 *   - the timeline and the shine ← `BootSplash.kt`
 */

// Matches `expo-splash-screen`'s `imageWidth` in app.json.
const LOGO_WIDTH = 210;
// splash-logo.png is 1024×568 — the icon+wordmark lockup cropped to its ink with an
// even margin, as printed by `scripts/gen_splash.py`. Keeping the aspect ratio
// makes `contain` a no-op, and centring the lockup (rather than the icon alone)
// is what sits the icon just above the optical centre with the name under it.
const LOGO_HEIGHT = Math.round(LOGO_WIDTH * (568 / 1024));

// The branding strip is cut for 136×55dp and sits 60dp above the bottom of the
// screen (not the safe area — the splash is full-bleed).
const STRIP_WIDTH = 136;
const STRIP_HEIGHT = 55;
const STRIP_BOTTOM_MARGIN = 60;

const SPLASH_BACKGROUND = "#ffffff";

const STRIP_DELAY_MS = 300;
const STRIP_MS = 450;
const STRIP_RISE = 14;
const SHINE_DELAY_MS = 750;
const SHINE_MS = 750;
const FADE_OUT_MS = 320;

const SHINE_TRAVEL = 83;
const SHINE_BAND = 33;
const SHINE_ANGLE = "20deg";
const LOADER_WIDTH = 60;
const LOADER_HEIGHT = 3;
/** Bar centre below the screen centre: under the wordmark's ink, then a 22dp gap. */
const LOADER_OFFSET = 69;
const LOADER_HOLD = 0.85;
const LOADER_FINISH_MS = 220;
/** `--primary`, and a 10% tint of it on white. */
const LOADER_FILL = "#0A8A4B";
const LOADER_TRACK = "#E6F4EC";

/** The ground colour, clear → 60% (`99`) → clear: invisible over the ground, a shine over the ink. */
const SHINE_COLORS = [
  `${SPLASH_BACKGROUND}00`,
  `${SPLASH_BACKGROUND}99`,
  `${SPLASH_BACKGROUND}00`,
] as const;

/** `modules/questioncall-boot-splash` — Android only, and absent from builds that predate it. */
const nativeSplash =
  Platform.OS === "android"
    ? requireOptionalNativeModule<{ hide(): Promise<void> }>("QuestionCallBootSplash")
    : null;

let release = () => {};
const released = new Promise<void>((resolve) => {
  release = resolve;
});

/** Routing is decided: the launch screen leaves as soon as its animation has played. */
export function releaseBootSplash() {
  release();
  if (nativeSplash) {
    void nativeSplash.hide().catch(() => {});
  }
}

export function BrandSplash() {
  const [finished, setFinished] = useState(nativeSplash !== null);
  const strip = useRef(new Animated.Value(0)).current;
  const shine = useRef(new Animated.Value(0)).current;
  const finish = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (nativeSplash) return;

    let cancelled = false;
    const intro = Animated.parallel([
      Animated.timing(strip, {
        toValue: 1,
        delay: STRIP_DELAY_MS,
        duration: STRIP_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(shine, {
        toValue: 1,
        delay: SHINE_DELAY_MS,
        duration: SHINE_MS,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }),
    ]);
    const played = new Promise<void>((resolve) => intro.start(() => resolve()));

    void Promise.all([played, released]).then(() => {
      if (cancelled) return;
      Animated.sequence([
        Animated.timing(finish, {
          toValue: 1,
          duration: LOADER_FINISH_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: FADE_OUT_MS,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start(() => setFinished(true));
    });

    return () => {
      cancelled = true;
      intro.stop();
    };
  }, [finish, opacity, shine, strip]);

  if (finished) return null;

  return (
    <Animated.View
      // Never intercepts touches: the app underneath is already interactive by
      // the time the overlay is fading.
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.overlay, { opacity }]}
    >
      <View style={styles.logoSlot}>
        <View style={styles.logo}>
          <Image
            source={require("../../assets/images/splash-logo.png")}
            style={styles.logo}
            resizeMode="contain"
            fadeDuration={0}
          />
          <Animated.View
            style={[
              styles.shine,
              {
                opacity: shine.interpolate({
                  inputRange: [0, 0.001, 0.999, 1],
                  outputRange: [0, 1, 1, 0],
                }),
                transform: [
                  {
                    translateX: shine.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-SHINE_TRAVEL, SHINE_TRAVEL],
                    }),
                  },
                  { rotate: SHINE_ANGLE },
                ],
              },
            ]}
          >
            <LinearGradient
              colors={SHINE_COLORS}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>
      </View>

      {/* The fill is a full-width pill slid in from the left, so its round end leads and the track clips the rest. */}
      <View style={styles.loaderSlot}>
        <Animated.View style={[styles.track, { opacity: strip }]}>
          <Animated.View
            style={[
              styles.fill,
              {
                transform: [
                  {
                    translateX: Animated.add(
                      Animated.multiply(shine, LOADER_HOLD),
                      Animated.multiply(finish, 1 - LOADER_HOLD),
                    ).interpolate({
                      inputRange: [0, 1],
                      outputRange: [-LOADER_WIDTH, 0],
                    }),
                  },
                ],
              },
            ]}
          />
        </Animated.View>
      </View>

      <Animated.View
        style={[
          styles.brandingSlot,
          {
            opacity: strip,
            transform: [
              {
                translateY: strip.interpolate({
                  inputRange: [0, 1],
                  outputRange: [STRIP_RISE, 0],
                }),
              },
            ],
          },
        ]}
      >
        <Image
          source={require("../../assets/images/powered-by-softmato.png")}
          style={styles.branding}
          resizeMode="contain"
          fadeDuration={0}
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    backgroundColor: SPLASH_BACKGROUND,
    // Above the Stack and every root-level host (call overlay, toasts).
    zIndex: 9999,
    elevation: 9999,
  },
  // Centres the logo on the whole screen, exactly like the native splash. The
  // branding strip is absolutely positioned so it cannot pull the logo up.
  logoSlot: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    width: LOGO_WIDTH,
    height: LOGO_HEIGHT,
    overflow: "hidden",
  },
  shine: {
    position: "absolute",
    left: (LOGO_WIDTH - SHINE_BAND) / 2,
    top: -LOGO_HEIGHT / 2,
    width: SHINE_BAND,
    height: LOGO_HEIGHT * 2,
  },
  loaderSlot: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  track: {
    width: LOADER_WIDTH,
    height: LOADER_HEIGHT,
    borderRadius: LOADER_HEIGHT / 2,
    backgroundColor: LOADER_TRACK,
    overflow: "hidden",
    transform: [{ translateY: LOADER_OFFSET }],
  },
  fill: {
    width: LOADER_WIDTH,
    height: LOADER_HEIGHT,
    borderRadius: LOADER_HEIGHT / 2,
    backgroundColor: LOADER_FILL,
  },
  brandingSlot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: STRIP_BOTTOM_MARGIN,
    alignItems: "center",
  },
  branding: {
    width: STRIP_WIDTH,
    height: STRIP_HEIGHT,
  },
});
