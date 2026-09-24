import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Tracks whether the software keyboard is currently on screen.
 *
 * Used to decide whether a bottom-anchored bar still needs to clear the system
 * navigation bar: when the keyboard is up it covers that area, so adding the
 * safe-area inset on top of it just leaves a dead band.
 *
 * iOS gets the `Will` events so the layout moves with the keyboard animation;
 * Android only reliably emits the `Did` events.
 */
export function useKeyboardVisible(): boolean {
  // Seeded from the live state: the screen can mount with the keyboard
  // already up (returning from another screen, a Fast Refresh), and the
  // listeners below only fire on the next change.
  const [visible, setVisible] = useState(() => Keyboard.isVisible());

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, () => setVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setVisible(false));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return visible;
}

export default useKeyboardVisible;
