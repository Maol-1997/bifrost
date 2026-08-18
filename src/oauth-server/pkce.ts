import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * PKCE verification (RFC 7636).
 *
 * This is the check that makes an intercepted authorization code useless: only
 * the client that generated the verifier can redeem the code, so a code stolen
 * from a redirect cannot be exchanged for a token.
 */

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Only `S256` is accepted. OAuth 2.1 removed `plain`, which offers no protection at all. */
export function isSupportedChallengeMethod(method: string | undefined): boolean {
  return method === 'S256';
}

export function isWellFormedVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

/**
 * Compared in constant time. Nothing here is secret (the challenge is public
 * and a hash digest does not reveal its preimage byte by byte), so this is not
 * closing a known oracle; it is the habit of never comparing credential-shaped
 * values with `===`, kept uniform so no reader has to judge the exception.
 */
export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  if (!isWellFormedVerifier(verifier)) return false;
  const expected = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const actual = Buffer.from(challenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
