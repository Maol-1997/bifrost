import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/security/secrets.js';

describe('AES-256-GCM secret handling', () => {
  it('round-trips a credential without storing plaintext', () => {
    const key = randomBytes(32);
    const plaintext = randomBytes(32).toString('base64url');
    const encrypted = encryptSecret(plaintext, key);

    expect(JSON.stringify(encrypted)).not.toContain(plaintext);
    expect(decryptSecret(encrypted, key)).toBe(plaintext);
  });

  it('detects ciphertext tampering', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('confidential', key);
    encrypted.ciphertext = `${encrypted.ciphertext.slice(0, -2)}AA`;

    expect(() => decryptSecret(encrypted, key)).toThrow();
  });

  it('rejects keys that are not 256 bits', () => {
    expect(() => encryptSecret('value', randomBytes(16))).toThrow('exactly 32 bytes');
  });
});
