import { formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';

/**
 * Timestamps cross the wire as ISO UTC and are formatted here, in the browser,
 * so the status and clients screens can honestly claim to show local time.
 */

const JUST_NOW_THRESHOLD_MS = 10_000;

export function relativeTime(isoTimestamp: string): string {
  const timestamp = parseISO(isoTimestamp);
  if (!isValid(timestamp)) return 'unknown';
  if (Math.abs(Date.now() - timestamp.getTime()) < JUST_NOW_THRESHOLD_MS) return 'just now';
  return formatDistanceToNowStrict(timestamp, { addSuffix: true, roundingMethod: 'round' });
}
