import { format, parseISO } from 'date-fns';

export function shortDate(isoTimestamp: string): string {
  return format(parseISO(isoTimestamp), 'MMM d');
}
