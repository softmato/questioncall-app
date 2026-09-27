import { Appearance } from "react-native";

/**
 * react-native-web's `Appearance` only reads the browser's scheme, and has no
 * `setColorScheme` — which `app/_layout.tsx` calls at module scope, so without
 * this the PWA would crash before its first frame. Here the app's own
 * light / dark / system choice drives `useColorScheme`, puts `dark` on <html>
 * (NativeWind's `dark:` and the CSS variables follow it; tailwind's `darkMode`
 * is "class" in the PWA build), and paints the status bar to match.
 */
type Scheme = "light" | "dark";
type Listener = (preferences: { colorScheme: Scheme }) => void;

const system = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<Listener>();
let chosen: Scheme | null = "light";

const current = (): Scheme => chosen ?? (system.matches ? "dark" : "light");

function apply() {
  const scheme = current();

  document.documentElement.classList.toggle("dark", scheme === "dark");
  document.documentElement.style.colorScheme = scheme;
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => {
      meta.content = scheme === "dark" ? "#1c1917" : "#ffffff";
    });
  listeners.forEach((listener) => listener({ colorScheme: scheme }));
}

Object.assign(Appearance, {
  addChangeListener(listener: Listener) {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
  getColorScheme: current,
  setColorScheme(scheme?: Scheme | null) {
    chosen = scheme ?? null;
    apply();
  },
});

system.addEventListener("change", apply);
apply();
