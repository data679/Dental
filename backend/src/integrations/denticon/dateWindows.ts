// Denticon caps every date-range filter at 30 days, so any backfill or catch-up sync has
// to be split into consecutive windows. Kept dependency-free and pure so it's easy to test.

export const DENTICON_MAX_WINDOW_DAYS = 30;

export interface DateWindow {
  from: Date;
  to: Date;
}

/**
 * Splits [from, to] into consecutive windows of at most `maxDays` each. Windows abut
 * (next.from === prev.to) — Denticon's filters are inclusive on both ends, so a record
 * whose lastChangedOn lands exactly on a boundary may appear twice. Consumers must upsert
 * or dedupe by id rather than blindly insert.
 */
export function splitIntoWindows(
  from: Date,
  to: Date,
  maxDays: number = DENTICON_MAX_WINDOW_DAYS,
): DateWindow[] {
  if (!(maxDays > 0)) throw new Error("maxDays must be positive");
  if (to.getTime() <= from.getTime()) return [];

  const stepMs = maxDays * 24 * 60 * 60 * 1000;
  const windows: DateWindow[] = [];
  let cursor = from.getTime();
  const end = to.getTime();

  while (cursor < end) {
    const next = Math.min(cursor + stepMs, end);
    windows.push({ from: new Date(cursor), to: new Date(next) });
    cursor = next;
  }
  return windows;
}

/** Denticon accepts `yyyy-MM-ddTHH:mm:ss.SSS+/-HH:mm` or the `Z` form; we always send UTC. */
export function toDenticonDateTime(d: Date): string {
  return d.toISOString();
}
