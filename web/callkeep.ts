/**
 * `react-native-callkeep` for the PWA. The phone rings through CallKit or the
 * Android full-screen call notification; a browser has neither, so an incoming
 * call is drawn as the ringing screen (`#call` in public/index.html), and Accept
 * / Decline fire the same `answerCall` / `endCall` events the native library
 * does — lib/callkeep-setup.ts answers and declines exactly as on the phone.
 */
type Handler = (event: { callUUID: string }) => void;

const handlers: Record<string, Handler[]> = {};
const ringtone = new Audio("/sounds/incoming_ringtone.mp3");
let ringing: string | null = null;

ringtone.loop = true;

const screen = () => document.getElementById("call");

function stop(callUUID?: string) {
  // The push may have rung this call in the tray too (public/sw.js tags it
  // `call-<id>`); answered, declined or ended here, it must not linger there.
  const id = callUUID ?? ringing;
  if (id) {
    void navigator.serviceWorker
      ?.getRegistration("/app")
      .then((registration) => registration?.getNotifications({ tag: `call-${id}` }))
      .then((notifications) => notifications?.forEach((n) => n.close()))
      .catch(() => {});
  }

  if (callUUID && callUUID !== ringing) return;
  ringing = null;
  ringtone.pause();
  ringtone.currentTime = 0;
  navigator.vibrate?.(0);
  screen()?.setAttribute("hidden", "");
}

document.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest?.(
    "#call [data-answer], #call [data-decline]",
  );
  if (!button || !ringing) return;

  const callUUID = ringing;
  stop();
  handlers[button.hasAttribute("data-answer") ? "answerCall" : "endCall"]?.forEach(
    (handler) => handler({ callUUID }),
  );
});

const RNCallKeep = {
  addEventListener(event: string, handler: Handler) {
    (handlers[event] ??= []).push(handler);
  },
  displayIncomingCall(
    callUUID: string,
    _handle: string,
    name: string,
    _type: string,
    video: boolean,
  ) {
    const element = screen();
    if (!element) return;

    ringing = callUUID;
    element.querySelector("[data-name]")!.textContent = name;
    element.querySelector("[data-initial]")!.textContent = name
      .trim()
      .charAt(0)
      .toUpperCase();
    element.querySelector("[data-kind]")!.textContent = video
      ? "Incoming video call"
      : "Incoming voice call";
    element.removeAttribute("hidden");
    // Autoplay may be refused until the page has had a tap; the screen still shows.
    void ringtone.play().catch(() => {});
    navigator.vibrate?.([600, 400, 600, 400, 600, 400, 600]);
  },
  endAllCalls: () => stop(),
  endCall: (callUUID: string) => stop(callUUID),
  removeEventListener(event: string) {
    delete handlers[event];
  },
  setAvailable(_available: boolean) {},
  setCurrentCallActive(_callUUID: string) {},
  setup: async (_options: unknown) => true,
};

export default RNCallKeep;
