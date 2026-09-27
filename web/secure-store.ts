/**
 * `expo-secure-store` for the PWA. A browser has no keychain, so the tokens and
 * the theme choice live in `localStorage`, as web clients keep them. `getItem`
 * is synchronous because `app/_layout.tsx` reads the theme before first paint.
 */
export const getItem = (key: string) => localStorage.getItem(key);

export const setItem = (key: string, value: string) => localStorage.setItem(key, value);

export const getItemAsync = async (key: string) => getItem(key);

export const setItemAsync = async (key: string, value: string) => setItem(key, value);

export const deleteItemAsync = async (key: string) => localStorage.removeItem(key);
