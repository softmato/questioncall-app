import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, StyleSheet, View } from "react-native";

/**
 * The JS half of the launch screen.
 *
 * The native splash draws two things: the Questioncall logo in the centre
 * (`windowSplashScreenAnimatedIcon`, from the `expo-splash-screen` block in
 * app.json) and the "Powered by Softmato" strip at the bottom
 * (`windowSplashScreenBrandingImage`, added by `plugins/withSplashBranding.js`).
 * This overlay reproduces both at the same sizes and positions, so when
 * `SplashScreen.hideAsync()` runs in `_layout.tsx` the branded screen simply
 * stays on screen and then fades out as one piece — no pop-in, no reflow.
 *
 * It is also the *only* place the attribution appears on Android 11 and below,
 * where the system splash has no branding slot at all.
 *
 * Geometry is mirrored from four places; keep them in sync:
 *   - `LOGO_WIDTH` ← `imageWidth` in the app.json splash config
 *   - `LOGO_HEIGHT` ← the canvas ratio `scripts/gen_splash.py` prints
 *   - `STRIP_*`    ← the dp size the drawables in `plugins/splash-branding-res` were cut for
 *   - `STRIP_BOTTOM_MARGIN` ← Android's fixed 60dp branding-image inset
 */

// Matches `expo-splash-screen`'s `imageWidth` in app.json.
const LOGO_WIDTH = 280;
// splash-logo.png is 1024×568 — the icon+wordmark lockup cropped to its ink with an
// even margin, as printed by `scripts/gen_splash.py`. Keeping the aspect ratio
// makes `contain` a no-op, and centring the lockup (rather than the icon alone)
// is what sits the icon just above the optical centre with the name under it.
const LOGO_HEIGHT = Math.round(LOGO_WIDTH * (568 / 1024));

// The branding strip is cut for 136×55dp; Android pins it 60dp above the
// bottom of the splash window (not the safe area — the splash is full-bleed).
const STRIP_WIDTH = 136;
const STRIP_HEIGHT = 55;
const STRIP_BOTTOM_MARGIN = 60;

const SPLASH_BACKGROUND = "#ffffff";

/** How long the branded screen is held before it starts leaving. */
const HOLD_MS = 900;
const FADE_OUT_MS = 320;

export function BrandSplash() {
  const [finished, setFinished] = useState(false);
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const animation = Animated.sequence([
      Animated.delay(HOLD_MS),
      Animated.timing(opacity, {
        toValue: 0,
        duration: FADE_OUT_MS,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]);

    animation.start(({ finished: completed }) => {
      // Unmount on cancel too — a half-faded overlay must never be left sitting
      // over the app.
      if (completed !== false) setFinished(true);
    });

    return () => animation.stop();
  }, [opacity]);

  if (finished) return null;

  return (
    <Animated.View
      // Never intercepts touches: the app underneath is already interactive by
      // the time the overlay is fading.
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.overlay, { opacity }]}
    >
      <View style={styles.logoSlot}>
        <Image
          source={require("../../assets/images/splash-logo.png")}
          style={styles.logo}
          resizeMode="contain"
          fadeDuration={0}
        />
      </View>

      <View style={styles.brandingSlot}>
        <Image
          source={require("../../assets/images/powered-by-softmato.png")}
          style={styles.branding}
          resizeMode="contain"
          fadeDuration={0}
        />
      </View>
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
