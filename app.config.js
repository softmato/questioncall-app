/**
 * `app.json` stays the config. This file only adds what the installable web app
 * (PWA) needs — this app exported for the browser and served by questioncall.com
 * at `/app` — and only when the web repo's `scripts/build-pwa.mjs` sets
 * `EXPO_PWA`, so every native build resolves exactly the config it did before.
 *
 * `asyncRoutes` splits the web bundle per screen: the PWA loads the shell and
 * the screen it opens on, and each other screen when it is first visited,
 * instead of one bundle of every screen up front.
 */
module.exports = ({ config }) =>
  process.env.EXPO_PWA === "1"
    ? {
        ...config,
        experiments: { ...config.experiments, baseUrl: "/app" },
        web: { ...config.web, bundler: "metro", output: "single" },
        extra: {
          ...config.extra,
          router: { ...config.extra?.router, asyncRoutes: { web: "production" } },
        },
      }
    : config;
