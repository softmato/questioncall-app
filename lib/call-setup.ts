import { useCallback, useEffect, useState } from "react";
import {
  AppState,
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { useFocusEffect } from "expo-router";

/**
 * Call setup — the one-time checklist that makes incoming calls ring on every
 * Android phone, the way WhatsApp's do.
 *
 * The code path for a killed app is complete (see plugins/withCallKeep.js), but
 * the OS and phone makers sit in front of it: Android 13+ needs notification
 * permission, Android 14+ a full-screen-intent grant, and Xiaomi, Infinix,
 * Tecno, Oppo, Vivo, Huawei and friends stop background apps outright unless
 * the user allows them. WhatsApp ships on those makers' allow-lists; every
 * other app has to ask. Some of these can be read back from the system; the
 * phone-maker ones cannot, so the user confirms those themselves.
 */

type NativeStatus = {
  manufacturer: string;
  brand: string;
  sdkInt: number;
  ignoringBatteryOptimizations: boolean;
  backgroundRestricted: boolean;
  canUseFullScreenIntent: boolean;
};

type SettingsKind =
  | "notifications"
  | "fullScreenIntent"
  | "battery"
  | "autostart"
  | "lockscreen";

const native = NativeModules.CallForegroundService as
  | {
      getCallSetupStatus?: () => Promise<NativeStatus>;
      openCallSetupSettings?: (kind: SettingsKind) => Promise<boolean>;
    }
  | undefined;

export type CallSetupItemId =
  | "notifications"
  | "microphone"
  | "fullScreen"
  | "battery"
  | "autostart"
  | "lockscreen"
  | "camera";

export type CallSetupItem = {
  id: CallSetupItemId;
  icon: string;
  title: string;
  description: string;
  ok: boolean;
  /** Not readable from the system — the user confirms it after changing it. */
  manual: boolean;
  /** Decides whether calls ring at all, as opposed to a nice-to-have. */
  required: boolean;
};

/**
 * Phone makers whose battery managers kill background apps unless allowed.
 * Matched against Build.MANUFACTURER and Build.BRAND (Redmi and POCO report
 * Xiaomi as the manufacturer; Infinix reports "infinix mobility limited").
 */
const AUTOSTART_MAKERS: { match: RegExp; name: string; steps: string }[] = [
  {
    match: /xiaomi|redmi|poco/,
    name: "Xiaomi",
    // MIUI's own battery saver is separate from Android's battery setting.
    steps:
      'Turn on Autostart for QuestionCall, and set its Battery saver to "No restrictions".',
  },
  {
    match: /infinix|tecno|itel|transsion/,
    name: "Infinix / Tecno",
    // As is XOS / HiOS power saving in Phone Master.
    steps:
      "In Auto-start management, turn QuestionCall on, and turn off power saving for it.",
  },
  {
    match: /oppo|realme|oneplus/,
    name: "Oppo / Realme",
    steps: "Turn on Auto launch (and Allow background activity) for QuestionCall.",
  },
  {
    match: /vivo|iqoo/,
    name: "Vivo",
    steps: "Allow QuestionCall to auto-start and run in the background.",
  },
  {
    match: /huawei|honor/,
    name: "Huawei / Honor",
    steps:
      "Under App launch, set QuestionCall to Manage manually and turn on Auto-launch, Secondary launch and Run in background.",
  },
  {
    match: /asus/,
    name: "Asus",
    steps: "Turn on Auto-start for QuestionCall.",
  },
];

const XIAOMI = /xiaomi|redmi|poco/;

const CONFIRMED_KEY = "questioncall.callSetup.confirmed";
const PROMPTED_KEY = "questioncall.callSetup.prompted";

async function readConfirmed(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(CONFIRMED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readNativeStatus(): Promise<NativeStatus | null> {
  if (!native?.getCallSetupStatus) return null;
  try {
    return await native.getCallSetupStatus();
  } catch {
    return null;
  }
}

/** The phone maker that needs the manual auto-start step, if this is one. */
function getAutostartMaker(status: Pick<NativeStatus, "manufacturer" | "brand"> | null) {
  if (!status) return null;
  const id = `${status.manufacturer} ${status.brand}`;
  return AUTOSTART_MAKERS.find((maker) => maker.match.test(id)) ?? null;
}

export async function getCallSetupItems(): Promise<CallSetupItem[]> {
  if (Platform.OS !== "android") return [];

  const [notifications, microphone, camera, status, confirmed] = await Promise.all([
    Notifications.getPermissionsAsync()
      .then((p) => p.granted)
      .catch(() => true),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO).catch(
      () => true,
    ),
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA).catch(() => true),
    readNativeStatus(),
    readConfirmed(),
  ]);

  const items: CallSetupItem[] = [
    {
      id: "notifications",
      icon: "notifications-outline",
      title: "Notifications",
      description:
        "Incoming calls arrive as notifications. Without this your phone stays silent.",
      ok: notifications,
      manual: false,
      required: true,
    },
    {
      id: "microphone",
      icon: "mic-outline",
      title: "Microphone",
      description: "So the other person can hear you when you answer.",
      ok: microphone,
      manual: false,
      required: true,
    },
  ];

  if (status && status.sdkInt >= 34) {
    items.push({
      id: "fullScreen",
      icon: "phone-portrait-outline",
      title: "Full-screen calls",
      description:
        "Lets a call turn the screen on and ring over the lock screen, like a phone call.",
      ok: status.canUseFullScreenIntent,
      manual: false,
      required: true,
    });
  }

  if (status) {
    items.push({
      id: "battery",
      icon: "battery-charging-outline",
      title: "Battery: unrestricted",
      description: `Stops your phone from putting QuestionCall to sleep, which blocks calls from reaching it. ${
        status.sdkInt >= 31
          ? 'Tap Battery, then choose "Unrestricted".'
          : 'Switch the list to "All apps", tap QuestionCall and choose "Don\'t optimize".'
      }`,
      ok: status.ignoringBatteryOptimizations && !status.backgroundRestricted,
      manual: false,
      required: true,
    });
  }

  const maker = getAutostartMaker(status);
  if (maker) {
    items.push({
      id: "autostart",
      icon: "rocket-outline",
      title: "Auto-start",
      description: `${maker.name} phones stop apps that are closed. ${maker.steps}`,
      ok: confirmed.includes("autostart"),
      manual: true,
      required: true,
    });
  }

  if (status && XIAOMI.test(`${status.manufacturer} ${status.brand}`)) {
    items.push({
      id: "lockscreen",
      icon: "lock-open-outline",
      title: "Lock screen & pop-ups",
      description:
        'Turn on "Show on lock screen" and "Display pop-up windows while running in the background". Without them the call screen cannot appear.',
      ok: confirmed.includes("lockscreen"),
      manual: true,
      required: true,
    });
  }

  items.push({
    id: "camera",
    icon: "videocam-outline",
    title: "Camera",
    description: "For video calls.",
    ok: camera,
    manual: false,
    required: false,
  });

  return items;
}

async function openSettings(kind: SettingsKind) {
  if (native?.openCallSetupSettings) {
    await native.openCallSetupSettings(kind).catch(() => Linking.openSettings());
  } else {
    await Linking.openSettings();
  }
}

async function requestRuntimePermission(
  permission: Parameters<typeof PermissionsAndroid.request>[0],
) {
  const result = await PermissionsAndroid.request(permission);
  // Android will not ask again — only the app's settings page can grant it now.
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) await Linking.openSettings();
}

/** Do whatever gets this item granted: a permission prompt, or the right settings screen. */
export async function fixCallSetupItem(id: CallSetupItemId): Promise<void> {
  switch (id) {
    case "notifications": {
      const current = await Notifications.getPermissionsAsync();
      if (current.canAskAgain) {
        const asked = await Notifications.requestPermissionsAsync();
        if (asked.granted) return;
      }
      await openSettings("notifications");
      return;
    }
    case "microphone":
      await requestRuntimePermission(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      return;
    case "camera":
      await requestRuntimePermission(PermissionsAndroid.PERMISSIONS.CAMERA);
      return;
    case "fullScreen":
      await openSettings("fullScreenIntent");
      return;
    case "battery": {
      // Already off the optimisation list but "Restricted": only the app's own
      // battery page can lift that, and it lives under app info.
      const status = await readNativeStatus();
      if (status?.ignoringBatteryOptimizations) await Linking.openSettings();
      else await openSettings("battery");
      return;
    }
    case "autostart":
      await openSettings("autostart");
      return;
    case "lockscreen":
      await openSettings("lockscreen");
      return;
  }
}

/** Record a step the system cannot report on (see CallSetupItem.manual). */
export async function confirmCallSetupItem(id: CallSetupItemId): Promise<void> {
  const confirmed = await readConfirmed();
  if (confirmed.includes(id)) return;
  await AsyncStorage.setItem(CONFIRMED_KEY, JSON.stringify([...confirmed, id])).catch(
    () => {},
  );
}

/**
 * Open the setup screen once per install, the first time something required is
 * missing. Afterwards it lives in the menu, with a badge while anything is left.
 */
export async function maybeOpenCallSetup(open: () => void): Promise<void> {
  if (Platform.OS !== "android") return;
  const prompted = await AsyncStorage.getItem(PROMPTED_KEY).catch(() => "1");
  if (prompted) return;
  // Push registration's own notification prompt is still unanswered — don't
  // stack a screen behind it. The next visit picks this up.
  const permission = await Notifications.getPermissionsAsync().catch(() => null);
  if (permission?.status === "undetermined") return;
  const items = await getCallSetupItems();
  if (!items.some((item) => item.required && !item.ok)) return;
  await AsyncStorage.setItem(PROMPTED_KEY, "1").catch(() => {});
  open();
}

/**
 * Live checklist. Re-reads when the screen regains focus and when the app
 * comes back from a settings screen, so a fixed step ticks over by itself.
 */
export function useCallSetup() {
  const [items, setItems] = useState<CallSetupItem[] | null>(null);

  const refresh = useCallback(() => {
    void getCallSetupItems().then(setItems);
  }, []);

  useFocusEffect(refresh);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const issues = items?.filter((item) => item.required && !item.ok).length ?? 0;
  return { items, issues, refresh };
}
