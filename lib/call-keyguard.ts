import { useEffect, useState } from "react";
import { AppState, DeviceEventEmitter, NativeModules, Platform } from "react-native";

/**
 * Lock-screen handling for active calls.
 *
 * The library's incoming-call activity is allowed over the keyguard, which is
 * why a locked phone can ring and show Accept/Decline. But on accept it hands
 * off to MainActivity, which is NOT — so the call would connect (audio flowing,
 * room joined) while the user stared at the lock screen, only seeing the call
 * after unlocking.
 *
 * The flag is therefore armed for the duration of a call and cleared as soon as
 * it ends. It is never left on: a permanently show-when-locked MainActivity
 * would put the entire app — chats, wallet, admin — above the lock screen.
 */
type CallForegroundServiceModule = {
  setShowWhenLocked?: (enabled: boolean) => void;
  isDeviceLocked?: () => Promise<boolean>;
};

const callForegroundService = NativeModules.CallForegroundService as
  | CallForegroundServiceModule
  | undefined;

/** Emitted natively on ACTION_USER_PRESENT (the user finished unlocking). */
const USER_PRESENT_EVENT = "QuestionCallUserPresent";

export function setCallShowsOverLockScreen(enabled: boolean) {
  if (Platform.OS !== "android" || !callForegroundService?.setShowWhenLocked) return;
  try {
    callForegroundService.setShowWhenLocked(enabled);
  } catch {
    // Never let a window-flag failure interfere with the call itself.
  }
}

export async function isDeviceLocked(): Promise<boolean> {
  if (Platform.OS !== "android" || !callForegroundService?.isDeviceLocked) return false;
  try {
    return await callForegroundService.isDeviceLocked();
  } catch {
    return false;
  }
}

/**
 * Whether the keyguard is currently in front of the call.
 *
 * Callers use this to suppress every affordance that would let the user leave
 * the call UI — minimizing to the bubble over the lock screen would otherwise
 * expose the whole app without authentication.
 *
 * Pass `active: false` when there is no call, so we neither poll nor hold a
 * subscription.
 */
export function useIsDeviceLocked(active: boolean): boolean {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (!active || Platform.OS !== "android") {
      setLocked(false);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      void isDeviceLocked().then((value) => {
        if (!cancelled) setLocked(value);
      });
    };

    refresh();

    // Unlocking does not necessarily change AppState (the activity was already
    // foreground, in front of the keyguard), so the native broadcast is the
    // only reliable signal that the lock screen is gone.
    const unlockSub = DeviceEventEmitter.addListener(USER_PRESENT_EVENT, () => {
      if (!cancelled) setLocked(false);
    });
    // Re-check when coming back from the background — the phone may have been
    // locked while we were away.
    const appStateSub = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });

    return () => {
      cancelled = true;
      unlockSub.remove();
      appStateSub.remove();
    };
  }, [active]);

  return locked;
}
