Play Console Permission Declarations Guide
After you upload your first AAB/APK, Google will flag certain permissions and ask you to fill out declaration forms. You won't be able to publish until these are completed. Here's exactly where to go and what to say for each:

1. MANAGE_OWN_CALLS + CALL_PHONE
   Where: Play Console > your app > Policy and programs > App content > Permissions

What Google asks: "Why does your app need calling permissions?"

What to select: "My app is a calling/VoIP app"

Justification to write:

QuestionCall is a paid consultation calling app. Users make and receive voice/video calls with experts. We use MANAGE_OWN_CALLS to integrate with the Android Telecom framework via CallKeep so incoming calls show on the lock screen. CALL_PHONE is required for the ConnectionService declaration.

2. USE_FULL_SCREEN_INTENT
   Where: Play Console > your app > Policy and programs > App content > Full-screen intent permission

(This shows up specifically on Android 14+ targeting)

What to select: "Calling" category

Justification to write:

QuestionCall uses full-screen intent to display incoming call notifications when the device is locked, identical to native phone calls. This is critical for our real-time paid consultation service — missed calls mean lost revenue for experts.

3. SYSTEM_ALERT_WINDOW
   Where: Play Console > your app > Policy and programs > App content > Permissions

What Google asks: "Why does your app draw over other apps?"

Justification to write:

QuestionCall displays incoming call overlays using react-native-full-screen-notification-incoming-call. When a paid call arrives, the overlay appears over other apps (like native phone behavior) so users don't miss time-sensitive consultations.

Note: Google is strict about this one. If they reject it, the fallback is that incoming calls show as a heads-up notification instead of a full-screen overlay. The app still works — just less prominent.

4. FOREGROUND_SERVICE_PHONE_CALL + FOREGROUND_SERVICE_MEDIA_PROJECTION
   Where: Play Console > your app > Policy and programs > App content > Foreground service permissions

Google will list each foreground service type and ask for justification.

For FOREGROUND_SERVICE_PHONE_CALL:

Used during active voice/video calls to keep the call alive when the app is backgrounded. The IncomingCallService and VoiceConnectionService require this to prevent Android from killing the call process.

For FOREGROUND_SERVICE_MEDIA_PROJECTION:

Used for screen sharing during video consultations. Experts may share their screen to explain concepts to clients. This requires a foreground service to maintain the projection session.

When do you fill these out?
You create the app listing in Play Console
You upload your first build (AAB)
You go to "App content" in the left sidebar
Google shows you a checklist of declarations you need to complete
Fill each one using the justifications above
Submit for review
You cannot publish until all declarations are approved. First review usually takes 1-3 days.

Foreground service declarations — status (2026-10-28, versionCode 13)
Play flagged 5 FGS types. Where each one comes from and what was declared:

| Type             | Source                                                                | Real use?                                                                                          | Declared as                             |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| PHONE_CALL       | plugins/withCallKeep.js (call FGS)                                    | Yes, ongoing calls                                                                                 | VoIP, telecom APIs                      |
| MICROPHONE       | plugins/withCallKeep.js (call FGS type bit)                           | Yes, call audio in background                                                                      | Background audio input                  |
| CAMERA           | plugins/withCallKeep.js (call FGS type bit)                           | Yes, video call in background                                                                      | Other                                   |
| MEDIA_PROJECTION | withCallKeep.js + @livekit/react-native-webrtc MediaProjectionService | Yes, screen share (call-screen.tsx)                                                                | Media and content projection, streaming |
| MEDIA_PLAYBACK   | expo-audio's own AndroidManifest (AudioControlsService)               | **No.** expo-audio only plays ringtone previews in app/settings/call-settings.tsx, foreground only | Other (library-added)                   |

DONE in app.json `android.blockedPermissions` (2026-10-28, ships in the build after versionCode 13):

- `FOREGROUND_SERVICE_MEDIA_PLAYBACK`: nothing calls expo-audio's `setActiveForLockScreen` or background playback.
  If that ever changes, unblock it. Starting the service without the permission crashes on Android 14+.
- `READ_MEDIA_IMAGES`: expo-screen-capture's manifest adds it (API 33 only, for screenshot _listeners_). The app only
  uses `usePreventScreenCapture` (FLAG_SECURE), which needs no permission. Image picking goes through
  expo-image-picker's system photo picker, which requests no permission on API 33+. Do NOT declare broad photo
  access in Play; it gets rejected for picker-only apps. If `addScreenshotListener` is ever added, it needs a new plan.
  Checked in native code before blocking: ScreenShotEventEmitter checks the permission before registering its observer
  (it only logs if missing), and AudioControlsService only starts via setActiveForLockScreen.

Deliberately NOT blocked (2026-10-28 audit of the AAB manifest). None of these needs a Play declaration form, and
removing them risks breaking calls that work today:

- DISABLE_KEYGUARD: IncomingCallActivity calls `disableKeyguard()` on a locked device (SecurityException without it).
- BROADCAST_CLOSE_SYSTEM_DIALOGS: IncomingCallService sends it below Android 12.
- CALL_PHONE, READ_PHONE_STATE (maxSdk 29), READ_PHONE_NUMBERS: from react-native-callkeep / the full-screen-call
  plugin. CallKeep is iOS-only and these are never requested at runtime. Harmless, but untested without them.
- SYSTEM_ALERT_WINDOW: Expo template default, never requested. No Play form.
- USE_FULL_SCREEN_INTENT: real use (incoming-call screen). Declare it as "Calling" in App content.
  After the next AAB is uploaded, remove the Media playback declaration in Play Console → App content → Foreground
  service permissions. The Photo and video permissions form should disappear by itself.

Demo video: one unlisted YouTube video covers all types. It shows a video call → Home (call continues,
notification visible) → back → screen share → another app (share continues) → Settings ringtone preview.

How the demo video was made (2026-10-28, 97 s, `marketing/playstore-fgs-demo.mp4`; all tooling in `marketing/fgs/`):

- Phones: Samsung = student (`RZCY81L8MCZ`, 1080×2340), Infinix = teacher (`061162513H005522`, 720×1640).
  adb came from `winget install Google.PlatformTools` (not on PATH in Git Bash; `env.sh` adds it).
- Record: `bash marketing/fgs/long.sh` screenrecords both phones back-to-back in 175 s segments while you do the
  flow by hand; `touch marketing/fgs/STOP` ends it. Pull with Windows paths (`adb pull /sdcard/fgs1.mp4 D:/...`);
  Git Bash `/d/...` paths fail under `MSYS_NO_PATHCONV=1`. Raw clips: `clips/S1,S2.mp4` + `clips/T1,T2.mp4`,
  joined to 30 fps `clips/S.mp4` / `clips/T.mp4` (ffmpeg concat, `scale=-2:960`).
- Build: `cd marketing/fgs && node build.mjs`. The `SEGS` list sets the title cards, clip ranges (seconds in S/T.mp4),
  voice lines and blur boxes. Clips are sped up to fit the voice (at most 2.5×). Subtitles use ffmpeg drawtext with
  Arial (`f.ttf`, `fb.ttf`). There is no music.
- Voice: ElevenLabs "Rachel" `21m00Tcm4TlvDq8ikWAM`, `eleven_v3`, `language_code: "en"`, via `marketing/fgs/tts.mjs`.
  It reads the key from `D:/hostel-management-software/marketing/video/.env`. Lines are cached in `audio/NN.mp3`;
  delete one to regenerate it.
- The teacher phone shows each screen about 1 s after the student phone, so blur windows must cover both
  (Facebook feed blurred at src 171–178).
- Gap: the voice-only call had no HOME shot. The video call covers PHONE_CALL + MICROPHONE + CAMERA together.
- Redo after MEDIA_PLAYBACK is removed: delete the last two `SEGS` entries (MEDIA_PLAYBACK card + the 178–212 clip)
  and run `node build.mjs`. No re-recording is needed.
