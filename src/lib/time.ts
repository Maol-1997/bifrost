/**
 * Timestamps cross the wire as ISO UTC and are formatted here, in the browser,
 * so the status and clients screens can honestly claim to show local time.
 */

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const UNITS: readonly { limitMs: number; perUnitMs: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { limitMs: 60_000, perUnitMs: 1_000, unit: 'second' },
  { limitMs: 3_600_000, perUnitMs: 60_000, unit: 'minute' },
  { limitMs: 86_400_000, perUnitMs: 3_600_000, unit: 'hour' },
  { limitMs: 2_592_000_000, perUnitMs: 86_400_000, unit: 'day' },
  { limitMs: 31_536_000_000, perUnitMs: 2_592_000_000, unit: 'month' },
  { limitMs: Number.POSITIVE_INFINITY, perUnitMs: 31_536_000_000, unit: 'year' },
];

export function relativeTime(isoTimestamp: string): string {
  const elapsedMs = Date.now() - new Date(isoTimestamp).getTime();
  if (Number.isNaN(elapsedMs)) return 'unknown';
  const magnitude = Math.abs(elapsedMs);
  if (magnitude < 10_000) return 'just now';
  const scale = UNITS.find((candidate) => magnitude < candidate.limitMs) ?? UNITS[UNITS.length - 1]!;
  return relative.format(-Math.round(elapsedMs / scale.perUnitMs), scale.unit);
}

export function shortDate(isoTimestamp: string): string {
  return shortDateFormat.format(new Date(isoTimestamp));
}

export function clockTime(isoTimestamp: string): string {
  return clockFormat.format(new Date(isoTimestamp));
}
