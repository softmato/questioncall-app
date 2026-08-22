# Package rename → Softmato (`com.softmato.questioncall`)

Android only. iOS is not shipping, so no Apple-side work is listed here (the
`bundleIdentifier` in `app.json` was renamed alongside the package purely so the
two identifiers stay consistent).

|                  |                                |
| ---------------- | ------------------------------ |
| Old package      | `com.questioncall.app`         |
| New package      | `com.softmato.questioncall`    |
| Deep-link scheme | `questioncall` — **unchanged** |

The package id was chosen as `com.softmato.questioncall` (company namespace +
app name). If Softmato wants a different id, change `android.package` in
`app.json` and everything below follows from it — the code no longer hardcodes
it anywhere.

---

## 1. Code changes — DONE

| File                                                                     | Change                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.json`                                                               | `android.package`, `ios.bundleIdentifier`, and the second entry of `scheme`                                                                                                                                                                                         |
| `lib/app-identity.ts`                                                    | `FALLBACK_PACKAGE` (used only when `expoConfig` is unavailable)                                                                                                                                                                                                     |
| `plugins/withCallKeep.js`                                                | No longer hardcodes the package. The generated Kotlin sources carry a `__APP_PACKAGE__` token, and the plugin reads `android.package` from `app.json` to pick both the Java source directory and the Kotlin `package` line. A future rename needs **no** edit here. |
| `google-services.json`                                                   | `package_name` updated — **but see §2, this file must be re-downloaded**                                                                                                                                                                                            |
| `components/branding/brand-splash.tsx`                                   | New — "Powered by Softmato" splash (see §5)                                                                                                                                                                                                                         |
| `assets/images/powered-by-softmato.png` + `plugins/splash-branding-res/` | New — real Softmato lockup, native + JS splash (see §5)                                                                                                                                                                                                             |

`GOOGLE_OAUTH_REDIRECT_URI` in `lib/app-identity.ts` is derived from the package,
so it automatically became `com.softmato.questioncall:/oauthredirect`. Android
OAuth clients authorise by package + SHA-1 rather than by redirect URI, so no
redirect URI needs registering — but the client itself does (§3).

### Required before the next build

`android/` still contains the old generated `com/questioncall/app` sources. It is
gitignored and fully generated, so wipe and regenerate it:

```bash
npx expo prebuild --platform android --clean
```

Without `--clean`, the stale package directory stays behind and the build fails
on duplicate/mismatched Kotlin classes.

---

## 2. Firebase — moved to a new project under Softmato

The app was **not** re-registered inside the old `question-call` project. A fresh
Firebase project was created under Softmato's Google account:

|                                | old                                 | new                                         |
| ------------------------------ | ----------------------------------- | ------------------------------------------- |
| Project id                     | `question-call`                     | `softmato-questioncall`                     |
| Project number / FCM sender id | `116367880758`                      | `77884593631`                               |
| Storage bucket                 | `question-call.firebasestorage.app` | `softmato-questioncall.firebasestorage.app` |

`app/google-services.json` — **DONE**, replaced with the real download for
`com.softmato.questioncall` in the new project.

Because the whole project moved, every FCM registration token issued under the
old sender id is dead. That is harmless here (a new package is a fresh install
anyway) but it does mean the `pushSubscriptions` rows for old installs will fail
to send and get pruned by the invalid-token handling in `web/lib/fcm-push.ts`.

Still to do in the new project:

1. Add the signing SHA-1 **and SHA-256** for every keystore that ships — the
   debug keystore (`secure-files/generate-sha-keys.md`) and the EAS build
   keystore (`eas credentials -p android`). Needed for Google Sign-In, not FCM.
2. Server credentials — **currently blocked, see §2b**.

## 2b. Service-account key creation is blocked — BLOCKS ALL PUSH

Generating the Firebase Admin private key fails with _"Key creation is not
allowed on this service account"_. That is the Google Cloud organization policy
`constraints/iam.disableServiceAccountKeyCreation`, enforced on the org that owns
`softmato-questioncall` — it is not a Firebase or billing problem.

Every push in this product — ordinary notifications _and_ the data-only call
push — is sent through Expo:
`sendPushNotificationToUser` (`web/lib/push/web-push.ts`) → `sendExpoPush`
(`web/lib/push/expo-push.ts`) → `https://exp.host/--/api/v2/push/send`.
Expo then talks to FCM using the **FCM V1 service account key uploaded to EAS**.
So that one upload is the whole fix — the server never touches Firebase itself.

> `web/lib/fcm-push.ts` and `web/lib/firebase-admin.ts` (and the
> `FIREBASE_SERVICE_ACCOUNT_KEY` env var they read) are **dead code** — nothing
> imports `fcm-push.ts`. Do not add that variable to Vercel; it does nothing.
> Either delete both files or wire them up, but don't treat them as live config.

To get the key, one of these:

**Option A — exempt the project from the policy (recommended).** Needs
`roles/orgpolicy.policyAdmin` at the organization.
Google Cloud Console → **IAM & Admin → Organization Policies** → pick the
**organization** in the resource picker → find _Disable service account key
creation_ → **Manage policy** → **Customize** → add a rule with **Enforcement:
Off** scoped to `softmato-questioncall` (or select the project in the picker and
override the parent policy there). Save, wait a minute, retry _Generate new
private key_.

**Option B — create the Firebase project outside the organization.** A project
owned by a personal Google account has no org policies, so key creation just
works. Costs Softmato org-level ownership of the project.

**Option C — no key at all: Workload Identity Federation.** Vercel can mint OIDC
tokens that GCP trusts, so `firebase-admin` authenticates without a static key.
Correct long-term, but it is real work: create a workload identity pool +
provider for Vercel's issuer, grant `roles/iam.workloadIdentityUser` on
`firebase-adminsdk-fbsvc@softmato-questioncall.iam.gserviceaccount.com`, ship the
external-account config, and switch `initializeFirebase()` from
`admin.credential.cert()` to `admin.credential.applicationDefault()`. It also
does **not** help the Expo push path, which needs a literal JSON key file.

**DONE 2026-08-22** — the legacy `iam.disableServiceAccountKeyCreation` policy was
overridden to _Off_ for the project, the key was generated, and it is uploaded:
`eas credentials -p android` → Google Service Account → _Push Notifications
(FCM V1)_, bound to `com.softmato.questioncall`
(`firebase-adminsdk-fbsvc@softmato-questioncall.iam.gserviceaccount.com`).

Nothing goes to Vercel. Keep the downloaded JSON out of both repos.

Note that pushes only start flowing once a build carrying the **new**
`google-services.json` is installed — the sender id changed, so existing installs
still register against the old project.

## 3. Google Sign-In (Google Cloud Console) — REQUIRED, blocks login

Android OAuth client IDs are bound to **package name + signing SHA-1**. The
existing ones are bound to `com.questioncall.app` and will return
`DEVELOPER_ERROR` / `invalid_client` under the new package.

In the Cloud Console project backing the new Firebase project —
**`softmato-questioncall` → APIs & Services → Credentials**:

1. Create **OAuth client ID → Android** for `com.softmato.questioncall` with the
   **debug** SHA-1 → `app/.env` as `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`.
2. Create a second Android client for `com.softmato.questioncall` with the
   **release/EAS** SHA-1 → `app/.env` as `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID_PROD`.
3. **Also put both into `web/.env` (and Vercel)** as `GOOGLE_ANDROID_CLIENT_ID` /
   `GOOGLE_ANDROID_CLIENT_ID_PROD`. `web/app/api/mobile/login/route.ts` verifies
   the id_token against `getGoogleAudiences()`, which is built from those vars —
   if the client id the app signed in with is not in that list, login fails
   server-side even though Google itself succeeded.

Adding the SHAs in Firebase (§2) auto-creates these OAuth clients in the same
Cloud project — check Credentials first, they may already exist and just need
copying into the two `.env` files.

Audience verification is not project-scoped, so the app's Android clients living
in `softmato-questioncall` while `GOOGLE_CLIENT_ID` (the web/NextAuth client)
stays in the client's original project is fine. Nothing needs to move.

## 4. Everything else

| Thing                                                             | Package-bound?                     | Action                                                                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play Store listing                                                | **Yes — permanently**              | A package is immutable once published. The app is not published yet, so rename now. The Play Console entry must be created under `com.softmato.questioncall`. |
| EAS build credentials                                             | Keyed by Expo project, not package | No change needed. If Softmato wants their own keystore, generate it _before_ first publish — the SHA-1s in §2/§3 change with it.                              |
| Expo project (`owner: question-call`, `projectId`, `updates.url`) | No                                 | Only change if the Expo account itself moves to Softmato — that regenerates `projectId` and invalidates existing Expo push tokens and OTA channels.           |
| Sentry (`org: question-call`, `project: react-native`)            | No                                 | Cosmetic; rename in Sentry if desired.                                                                                                                        |
| Backend (`web/`) — NextAuth, Mongo, Pusher, LiveKit, eSewa        | No                                 | Nothing keyed on the mobile package.                                                                                                                          |
| Deep links `questioncall://…`                                     | No                                 | Scheme deliberately unchanged, so server-side links keep working.                                                                                             |
| Notification channel ids (`questioncall_ongoing_call`)            | No                                 | Left as-is; renaming would orphan users' existing channel settings.                                                                                           |

## 5. Splash screen — "Powered by Softmato"

`expo-splash-screen` only exposes one centred image, and baking the attribution
into that image does not work: on Android 12+ the system masks the splash icon
into a circle, so anything below the logo is cropped away.

Android 12 has a slot built for exactly this — `windowSplashScreenBrandingImage`,
drawn by the system at the bottom of the splash. androidx's `core-splashscreen`
compat library does not forward the attribute, so `plugins/withSplashBranding.js`
sets it in a `values-v31/styles.xml` override of `Theme.App.SplashScreen` and
copies the strip drawable into every density bucket. It is registered in the
app.json `plugins` array.

| Piece                                             | Where it comes from                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Centre logo                                       | `assets/images/splash-logo.png` → `expo-splash-screen`, `imageWidth: 280`                              |
| Bottom strip, **Android 12+**                     | `plugins/splash-branding-res/drawable-*/splashscreen_branding.png` → `@drawable/splashscreen_branding` |
| Bottom strip, **Android ≤ 11** and after JS boots | `assets/images/powered-by-softmato.png` via `components/branding/brand-splash.tsx`                     |

Android ≤ 11 has no branding slot at all, so there the strip comes only from the
JS overlay. The overlay reproduces the native layout exactly — same logo at
280dp, same 136×55dp strip pinned 60dp above the bottom edge, same white — so
`SplashScreen.hideAsync()` is invisible: the branded screen just stays put and
then fades out as one piece (~1.2s). It is `pointerEvents="none"` throughout, so
it never delays interaction.

### Regenerating the strip

The strip is `Powered by` (Lucida Calligraphy, baked in — no font shipped) next
to the Softmato lockup from `D:\company docs\powered_logo.png`, trimmed to its
content box with the near-white background flattened to pure white so it seams
into the splash. Sizes are cut for 136×55dp: mdpi 136×55 up to xxxhdpi 544×220,
plus a 1082×440 copy in `assets/images/` for the JS overlay.

If the lockup changes, regenerate all six PNGs at those sizes and keep
`STRIP_WIDTH`/`STRIP_HEIGHT` in `brand-splash.tsx` matching the dp box.

### If app.json's splash config changes

`values-v31/styles.xml` _replaces_ the base splash theme rather than merging
into it, so the four items expo-splash-screen writes are mirrored inside
`plugins/withSplashBranding.js`. Adding a new splash option in app.json (a dark
variant, an icon background colour) means mirroring it there too.
