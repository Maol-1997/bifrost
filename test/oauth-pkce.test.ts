import { describe, expect, it } from 'vitest';
import { isSupportedChallengeMethod, isWellFormedVerifier, verifyCodeChallenge } from '../src/server/oauth-server/pkce.js';

// The RFC 7636 Appendix B vector, so a hashing regression fails against the
// spec's own numbers rather than against whatever we happened to generate.
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const nearMissVerifier = `${verifier.slice(0, -1)}j`;

describe('challenge method', () => {
  it('accepts only S256', () => {
    expect(isSupportedChallengeMethod('S256')).toBe(true);
    // `plain` sends the secret in the redirect it is meant to protect, so
    // OAuth 2.1 dropped it. An absent method must not fall back to it either.
    expect(isSupportedChallengeMethod('plain')).toBe(false);
    expect(isSupportedChallengeMethod(undefined)).toBe(false);
    expect(isSupportedChallengeMethod('s256')).toBe(false);
  });
});

describe('verifier shape', () => {
  it('holds to the RFC 7636 length and alphabet', () => {
    expect(isWellFormedVerifier(verifier)).toBe(true);
    expect(isWellFormedVerifier('a'.repeat(43))).toBe(true);
    expect(isWellFormedVerifier('a'.repeat(128))).toBe(true);
    expect(isWellFormedVerifier('a'.repeat(42))).toBe(false);
    expect(isWellFormedVerifier('a'.repeat(129))).toBe(false);
    expect(isWellFormedVerifier(`${'a'.repeat(42)}+`)).toBe(false);
  });
});

describe('verifying a code challenge', () => {
  it('accepts the verifier the challenge was derived from', () => {
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
  });

  it('rejects any other verifier', () => {
    expect(verifyCodeChallenge(nearMissVerifier, challenge)).toBe(false);
  });

  it('rejects a malformed verifier before hashing it', () => {
    expect(verifyCodeChallenge('short', challenge)).toBe(false);
  });

  it('rejects a challenge that is the raw verifier, closing the plain downgrade', () => {
    expect(verifyCodeChallenge(verifier, verifier)).toBe(false);
  });

  it('rejects a truncated challenge rather than matching on a prefix', () => {
    expect(verifyCodeChallenge(verifier, challenge.slice(0, 20))).toBe(false);
  });
});
