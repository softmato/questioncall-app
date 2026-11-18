import { router } from "expo-router";
import { hasAnyActiveCall } from "@/lib/active-call";
import { store } from "@/store";

const autoOpened = new Set<string>();

/**
 * Takes the asker straight into the chat their question just opened. Called
 * from both the `channel:new` socket event and the QUESTION_ACCEPTED push,
 * whichever lands first: the socket alone missed it whenever it was mid-
 * reconnect (e.g. right after the app came back from the background).
 */
export function openAcceptedChannel(channelId: string) {
  if (!channelId || autoOpened.has(channelId)) return;
  autoOpened.add(channelId);
  if (hasAnyActiveCall()) return;
  if (store.getState().channels.activeChannelId === channelId) return;
  router.push(`/workspace/${channelId}` as any);
}

// Notification hrefs are written by the web server and shared with the website,
// so they are web paths. This maps each to the app route that shows the same
// thing; anything unrecognised falls back to the feed rather than not-found.
export function resolveNotificationRoute(href: string): string {
  // Routes that already match mobile paths — pass through
  if (href.startsWith("/workspace/")) return href;
  if (href.startsWith("/call/")) return href;
  if (href.startsWith("/course/")) return href;
  if (href.startsWith("/quiz/")) return href;
  if (href.startsWith("/studio/")) return href;
  if (href.startsWith("/wallet/")) return href;
  if (href.startsWith("/profile/")) return href;
  if (href.startsWith("/settings/")) return href;
  if (href.startsWith("/daily-target/")) return href;
  if (href.startsWith("/payment/")) return href;
  if (href.startsWith("/user/")) return href;
  if (href.startsWith("/admin/courses/coupons")) return "/admin/coupons";
  if (href === "/admin" || href.startsWith("/admin/")) return href;

  // Courses and chapters are addressed by slug on the web; the app's detail
  // screens take an id, so land on the catalogue instead.
  if (href.startsWith("/courses") || href.startsWith("/chapters"))
    return "/(tabs)/courses";

  // Exact web routes → best mobile equivalent
  if (href === "/wallet") return "/wallet/index";
  if (href === "/subscription") return "/payment/plans";
  if (href === "/settings") return "/settings/notifications";
  if (href === "/profile") return "/profile/index";
  if (href === "/notifications") return "/notifications";
  if (href === "/leaderboard") return "/leaderboard";
  if (href === "/referral") return "/referral";
  if (href === "/notices") return "/notices";
  if (href === "/notes") return "/notes";
  if (href === "/channels") return "/(tabs)/channels";
  if (href === "/daily-target") return "/daily-target/index";

  return "/(tabs)/feed";
}
