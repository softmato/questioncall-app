import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { api } from "@/lib/api";
import {
  setNotices,
  setNoticesError,
  setNoticesLoading,
} from "@/store/slices/noticesSlice";
import {
  setOnboardingData,
  setOnboardingError,
  setOnboardingLoading,
} from "@/store/slices/onboardingSlice";

/**
 * How long a foregrounded app trusts the notices it already has. Backgrounding
 * and returning is a constant gesture (notification tap, app switch), so
 * refetching on every `active` transition put a request on the wire for what is
 * almost always an unchanged list.
 */
const NOTICES_FOREGROUND_TTL_MS = 5 * 60 * 1000;

export function Sprint2Bootstrap() {
  const dispatch = useAppDispatch();
  const isAuthenticated = useAppSelector((s) => s.auth.isAuthenticated);
  const user = useAppSelector((s) => s.user.data);
  const onboardingLoadedForUserId = useAppSelector((s) => s.onboarding.loadedForUserId);
  const noticesLoadedForUserId = useAppSelector((s) => s.notices.loadedForUserId);
  const noticesLastFetchedAt = useAppSelector((s) => s.notices.lastFetchedAt);

  // Mirrored into a ref so the AppState subscription can read the freshest
  // value without tearing down and re-adding its listener on every fetch.
  const noticesLastFetchedAtRef = useRef(noticesLastFetchedAt);
  noticesLastFetchedAtRef.current = noticesLastFetchedAt;

  const fetchOnboarding = useCallback(async () => {
    if (!user?._id) return;

    dispatch(setOnboardingLoading(true));
    try {
      const res = await api.get("/onboarding-video");
      dispatch(
        setOnboardingData({
          shouldShow: Boolean(res.data?.shouldShow),
          role: res.data?.role ?? user.role,
          video: res.data?.video ?? null,
          userId: user._id,
        }),
      );
    } catch (err: any) {
      dispatch(
        setOnboardingError(
          err?.response?.data?.error ?? "Unable to load onboarding video.",
        ),
      );
    }
  }, [dispatch, user?._id, user?.role]);

  const fetchNotices = useCallback(
    async (activateModal = true) => {
      if (!user?._id) return;

      dispatch(setNoticesLoading(true));
      try {
        const res = await api.get("/notices");
        dispatch(
          setNotices({
            notices: Array.isArray(res.data) ? res.data : [],
            userId: user._id,
            activateModal,
          }),
        );
      } catch (err: any) {
        dispatch(
          setNoticesError(err?.response?.data?.error ?? "Unable to load notices."),
        );
      }
    },
    [dispatch, user?._id],
  );

  useEffect(() => {
    if (!isAuthenticated || !user?._id) return;

    // The `onboarding` slice is not persisted, so `loadedForUserId` is null on
    // every cold boot — that alone would refetch on every launch for the rest
    // of the user's life. `seenOnboardingRoles` lives on the persisted user and
    // is exactly what the server checks (`shouldShow = video && !seen`), so if
    // this role is already seen the answer is a guaranteed `false` and the
    // request is pure waste. When the field is missing we still fetch, so an
    // incomplete user record errs toward showing onboarding rather than
    // silently swallowing it.
    const hasSeenOnboarding = Boolean(
      user.role && user.seenOnboardingRoles?.includes(user.role),
    );
    if (!hasSeenOnboarding && onboardingLoadedForUserId !== user._id) {
      void fetchOnboarding();
    }
    if (noticesLoadedForUserId !== user._id) {
      void fetchNotices(true);
    }
  }, [
    fetchNotices,
    fetchOnboarding,
    isAuthenticated,
    noticesLoadedForUserId,
    onboardingLoadedForUserId,
    user?._id,
    user?.role,
    user?.seenOnboardingRoles,
  ]);

  useEffect(() => {
    if (!isAuthenticated || !user?._id) return;

    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;

      const lastFetchedAt = noticesLastFetchedAtRef.current;
      if (lastFetchedAt && Date.now() - lastFetchedAt < NOTICES_FOREGROUND_TTL_MS) {
        return;
      }
      void fetchNotices(true);
    });

    return () => subscription.remove();
  }, [fetchNotices, isAuthenticated, user?._id]);

  return null;
}
