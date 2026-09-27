/**
 * `app.json` stays the config. This file only adds what the installable web app
 * (PWA) needs — this app exported for the browser and served by questioncall.com
 * at `/app` — and only when `scripts/export-pwa.mjs` sets `EXPO_PWA`, so every
 * native build resolves exactly the config it did before.
 */
module.exports = ({ config }) =>
  process.env.EXPO_PWA === "1"
    ? {
        ...config,
        experiments: { ...config.experiments, baseUrl: "/app" },
        web: { ...config.web, bundler: "metro", output: "single" },
      }
    : config;
