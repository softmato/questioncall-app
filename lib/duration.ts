/** Durations cross the API as minutes for compatibility; arithmetic uses whole seconds. */
export function durationSeconds(minutes?: number | null): number {
  return Number.isFinite(minutes) ? Math.round((minutes ?? 0) * 60) : 0;
}

export function minutesFromSeconds(seconds: number): number {
  return Number.isFinite(seconds)
    ? Number((Math.max(0, Math.round(seconds)) / 60).toFixed(6))
    : 0;
}

export function sumDurationMinutes(...minutes: number[]): number {
  return minutesFromSeconds(
    minutes.reduce((sum, value) => sum + durationSeconds(value), 0),
  );
}

export function normalizeDuration(minutes?: number | null): number {
  return minutesFromSeconds(durationSeconds(minutes));
}

export function formatDuration(minutes?: number | null): string {
  const seconds = Math.max(0, durationSeconds(minutes));
  const wholeMinutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${wholeMinutes}m ${remaining}s` : `${wholeMinutes} min`;
}
