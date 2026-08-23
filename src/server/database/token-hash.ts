import { createHash } from 'node:crypto';

/** Tokens are stored and looked up only as SHA-256 hashes, so a database dump never contains a usable credential. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
