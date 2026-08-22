/**
 * Asking is camera-first: the title is optional, so a photo-only question has
 * an empty `title`. Feed cards can simply show the photo instead, but list
 * rows and confirmation dialogs still need a name for it — run those through
 * this so a title-less question never renders as a blank line.
 */
export function questionSummary(
  question: { title?: string | null; body?: string | null },
  maxLength = 80,
  fallback = "Photo question",
): string {
  const title = question.title?.trim();
  if (title) return truncate(title, maxLength);

  const body = question.body?.trim().split("\n")[0]?.trim();
  if (body) return truncate(body, maxLength);

  return fallback;
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;
}
