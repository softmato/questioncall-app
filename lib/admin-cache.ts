import { api } from "@/lib/api";

/**
 * Admin prefetch cache.
 *
 * The admin console is reached by auto-routing an `ADMIN` user to `/(admin)`
 * right after login/boot. The moment that route group mounts we fire every
 * lightweight list/config GET in parallel (`prefetchAdmin`) and stash the
 * results here, keyed by section. Each admin screen then seeds its initial
 * state from `readCache(...)` so it paints instantly instead of showing a
 * spinner, and still revalidates in the background on mount.
 *
 * This is a deliberately tiny module-level store (not Redux): admin data is
 * sensitive, large and short-lived, so it must never be persisted to disk.
 * `clearAdminCache()` is called on logout alongside the Redux `resetStore()`.
 */

export type AdminCacheKey =
  | "transactions"
  | "withdrawals"
  | "users"
  | "notifications"
  | "notices"
  | "questions"
  | "notes"
  | "courses"
  | "chapters"
  | "coupons"
  | "subscription-coupons"
  | "services"
  | "config"
  | "receipts"
  | "account-deletions"
  | "ai-keys"
  | "quiz-management"
  | "live-sessions"
  | "developer"
  | "security";

type CacheEntry = { data: unknown; ts: number };

const cache = new Map<AdminCacheKey, CacheEntry>();

/** Last successfully cached value for a section, or `undefined` if never fetched. */
export function readCache<T>(key: AdminCacheKey): T | undefined {
  return cache.get(key)?.data as T | undefined;
}

/** Write-through used by screens after a (re)fetch so revisits stay warm. */
export function writeCache<T>(key: AdminCacheKey, data: T): void {
  cache.set(key, { data, ts: Date.now() });
}

/** Milliseconds since a section was last cached, or `Infinity` if never. */
export function cacheAge(key: AdminCacheKey): number {
  const entry = cache.get(key);
  return entry ? Date.now() - entry.ts : Infinity;
}

/** Wipe everything — call on logout so no admin data leaks across accounts. */
export function clearAdminCache(): void {
  cache.clear();
}

/**
 * A prefetchable GET. `select` maps the raw response body to the shape each
 * screen seeds from (mirrors what that screen does in its own `load()`).
 */
type PrefetchSource = {
  key: AdminCacheKey;
  url: string;
  select?: (raw: any) => unknown;
};

const asArray = (value: unknown) => (Array.isArray(value) ? value : []);

/**
 * Every section whose default view is a plain GET. Search/filter-scoped
 * sections (questions, notes) are prefetched with their *unfiltered* default,
 * which is exactly what the screen renders before the user types.
 *
 * `config` is a single document that backs Payment Config, Social,
 * Subscription, Format, Onboarding, Settings and Legal — one fetch, seven
 * screens.
 */
const PREFETCH_SOURCES: PrefetchSource[] = [
  {
    key: "transactions",
    url: "/mobile/admin/transactions?limit=80",
    select: (r) => asArray(r?.transactions),
  },
  {
    key: "withdrawals",
    url: "/mobile/admin/withdrawals?limit=80",
    select: (r) => asArray(r?.requests),
  },
  { key: "users", url: "/mobile/admin/users", select: asArray },
  {
    key: "notifications",
    url: "/mobile/admin/notifications?history=false",
    select: (r) => asArray(r?.notifications),
  },
  { key: "notices", url: "/mobile/admin/notices", select: asArray },
  { key: "questions", url: "/mobile/admin/questions?", select: asArray },
  { key: "notes", url: "/mobile/admin/notes?", select: asArray },
  { key: "courses", url: "/mobile/admin/courses", select: asArray },
  { key: "chapters", url: "/mobile/admin/chapters", select: asArray },
  {
    key: "coupons",
    url: "/mobile/admin/coupons",
    select: (r) => asArray(r?.coupons),
  },
  {
    key: "subscription-coupons",
    url: "/mobile/admin/subscription-coupons",
    select: (r) => asArray(r?.coupons),
  },
  { key: "services", url: "/mobile/admin/services", select: (r) => asArray(r?.services) },
  { key: "config", url: "/mobile/admin/config" },
  {
    key: "account-deletions",
    url: "/mobile/admin/account-deletions",
    select: (r) => asArray(r?.requests),
  },
  { key: "ai-keys", url: "/mobile/admin/ai-keys" },
  { key: "quiz-management", url: "/mobile/admin/quiz-management" },
  {
    key: "live-sessions",
    url: "/mobile/admin/live-sessions",
    select: (r) => asArray(r?.sessions),
  },
  { key: "developer", url: "/mobile/admin/developer" },
  { key: "security", url: "/mobile/admin/security" },
];

let inFlight: Promise<void> | null = null;

/**
 * How long a prefetched section stays warm enough to skip on a re-entry.
 * `inFlight` only dedupes *concurrent* runs, so without this leaving the admin
 * group and coming back remounts the layout and refires all ~19 GETs. Screens
 * still revalidate themselves on mount, so a stale-but-warm cache only affects
 * the first paint, never the data the admin ends up acting on.
 */
const PREFETCH_TTL_MS = 2 * 60 * 1000;

/**
 * Fire every not-recently-cached section GET in parallel and cache each result.
 * Failures are swallowed per-section — the matching screen will retry and
 * surface its own error on open, so one dead endpoint never blocks the rest of
 * the prefetch. Concurrent calls share one in-flight run.
 */
export function prefetchAdmin(): Promise<void> {
  if (inFlight) return inFlight;

  const stale = PREFETCH_SOURCES.filter(({ key }) => cacheAge(key) > PREFETCH_TTL_MS);
  if (stale.length === 0) return Promise.resolve();

  inFlight = Promise.allSettled(
    stale.map(async ({ key, url, select }) => {
      const res = await api.get(url);
      writeCache(key, select ? select(res.data) : res.data);
    }),
  ).then(() => {
    inFlight = null;
  });
  return inFlight;
}
