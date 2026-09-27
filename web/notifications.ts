/**
 * `expo-notifications` for the PWA — what lib/local-notifications.ts and
 * lib/call-ui-store.ts use. Push itself is web/push-notifications.ts. A
 * scheduled reminder is a timer that shows its notification through the app's
 * service worker, so it fires while the app is open or in the background tab.
 */
export enum AndroidImportance {
  MIN = 1,
  LOW = 2,
  DEFAULT = 3,
  HIGH = 4,
  MAX = 5,
}

export enum SchedulableTriggerInputTypes {
  DATE = "date",
  TIME_INTERVAL = "timeInterval",
}

type Content = { body?: string; data?: Record<string, unknown>; title?: string };
type Trigger = { date?: Date | number; seconds?: number } | null;

const timers = new Map<string, number>();

function permission() {
  const state = "Notification" in window ? Notification.permission : "denied";

  return {
    canAskAgain: state !== "denied",
    granted: state === "granted",
    status: state === "default" ? ("undetermined" as const) : state,
  };
}

export const getPermissionsAsync = async () => permission();

export async function requestPermissionsAsync() {
  if ("Notification" in window) await Notification.requestPermission();
  return permission();
}

export const setNotificationChannelAsync = async (..._args: unknown[]) => null;

export const getPresentedNotificationsAsync = async (): Promise<
  { request: { content: Content; identifier: string } }[]
> => [];

export const dismissNotificationAsync = async (_identifier: string) => {};

export async function scheduleNotificationAsync({
  content,
  trigger,
}: {
  content: Content;
  trigger?: Trigger;
}) {
  const id = crypto.randomUUID();
  const at =
    trigger?.date !== undefined
      ? new Date(trigger.date).getTime()
      : Date.now() + (trigger?.seconds ?? 0) * 1000;

  timers.set(
    id,
    window.setTimeout(
      async () => {
        timers.delete(id);
        if (Notification.permission !== "granted") return;
        const registration = await navigator.serviceWorker?.getRegistration("/app");
        await registration?.showNotification(content.title ?? "QuestionCall", {
          body: content.body,
          data: { url: typeof content.data?.url === "string" ? content.data.url : "/" },
          icon: "/icon.png",
        });
      },
      Math.max(0, at - Date.now()),
    ),
  );

  return id;
}

export async function cancelScheduledNotificationAsync(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}
