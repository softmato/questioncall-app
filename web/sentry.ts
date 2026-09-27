/**
 * `@sentry/react-native` for the PWA. Its native SDK has no browser build here,
 * so crash reporting is off on the web; `app/_layout.tsx` still calls both.
 */
export const init = (_options?: unknown) => {};

export const wrap = <T>(component: T) => component;
