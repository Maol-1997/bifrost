import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../src/server/security/secrets.js';

/** Flips a bit in one base64-encoded byte, so the value stays decodable but is no longer authentic. */
function corruptBase64Byte(value: string, index: number): string {
  const bytes = Buffer.from(value, 'base64');
  bytes.writeUInt8(bytes.readUInt8(index) ^ 0x01, index);
  return bytes.toString('base64');
}

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

  it('rejects a short key on decrypt as well as on encrypt', () => {
    const encrypted = encryptSecret('value', randomBytes(32));

    expect(() => decryptSecret(encrypted, randomBytes(16))).toThrow('exactly 32 bytes');
  });

  it('refuses a correctly formed record encrypted under a different key', () => {
    const encrypted = encryptSecret('confidential', randomBytes(32));

    expect(() => decryptSecret(encrypted, randomBytes(32))).toThrow();
  });

  it('detects IV tampering', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('confidential', key);
    encrypted.iv = corruptBase64Byte(encrypted.iv, 0);

    expect(() => decryptSecret(encrypted, key)).toThrow();
  });

  it('detects auth tag tampering', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('confidential', key);
    encrypted.authTag = corruptBase64Byte(encrypted.authTag, 0);

    expect(() => decryptSecret(encrypted, key)).toThrow();
  });

  it('refuses a version it does not know how to read', () => {
    const key = randomBytes(32);
    const encrypted: EncryptedSecret = { ...encryptSecret('confidential', key), version: 2 };

    expect(() => decryptSecret(encrypted, key)).toThrow('Unsupported encrypted credential version');
  });

  it('round-trips an empty string', () => {
    const key = randomBytes(32);

    expect(decryptSecret(encryptSecret('', key), key)).toBe('');
  });

  it('round-trips multibyte UTF-8 without mangling it', () => {
    const key = randomBytes(32);
    const plaintext = 'héllo 🔐';

    expect(decryptSecret(encryptSecret(plaintext, key), key)).toBe(plaintext);
  });
});
