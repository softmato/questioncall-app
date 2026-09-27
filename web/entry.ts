/**
 * Entry of the installable web app (PWA): this app exported for the browser and
 * served by questioncall.com at `/app`.
 *
 * `metro.config.js` puts this in front of expo-router's entry in the web bundle
 * only. Everything in `web/` stands in for something the phone has natively and
 * the browser does not; nothing else in the app knows the web build exists.
 *
 * `./appearance` goes first: `app/_layout.tsx` sets the colour scheme at module
 * scope, before the first frame.
 */
import "./appearance";
import "./alert";
import "./form-data";

import "expo-router/entry-classic";
