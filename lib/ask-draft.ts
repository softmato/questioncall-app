export type AskDraftImage = {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
};

/**
 * In-flight draft for the ask screen.
 *
 * Capturing a photo and then wandering off to the feed (or into the gallery
 * picker) must not throw the shots away — coming back to the Ask tab should
 * find them exactly where they were. But these are local `file://` captures of
 * someone's homework, so they are deliberately NOT persisted to disk: this is
 * a module-level store, which means the draft lives exactly as long as the JS
 * runtime and is gone the moment the app is closed.
 *
 * Cleared on a successful post, when the last photo is removed, and on logout
 * via `purgeLocalSession()` — the same way `admin-cache` is.
 */
let draft: AskDraftImage[] = [];

export function getAskDraftImages(): AskDraftImage[] {
  return draft;
}

export function setAskDraftImages(next: AskDraftImage[]) {
  draft = next;
}

export function clearAskDraft() {
  draft = [];
}
