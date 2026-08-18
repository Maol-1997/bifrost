import { format, parseISO } from 'date-fns';

export function clockTime(isoTimestamp: string): string {
  return format(parseISO(isoTimestamp), 'p');
}
