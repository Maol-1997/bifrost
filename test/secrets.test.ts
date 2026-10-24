import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  LEGACY_KEY_ID,
  needsReencryption,
  type EncryptedSecret,
  type EncryptionKeyring,
  type LegacyEncryptedSecret,
} from '../src/server/security/secrets.js';

const CONTEXT = '11111111-1111-4111-8111-111111111111:github';

function keyring(activeKeyId: string, keys: Record<string, Buffer>): EncryptionKeyring {
  return { activeKeyId, keys: new Map(Object.entries(keys)) };
}

function singleKeyring(key = randomBytes(32)): EncryptionKeyring {
  return keyring('primary', { primary: key });
}

/** Flips a bit in one base64-encoded byte, so the value stays decodable but is no longer authentic. */
function corruptBase64Byte(value: string, index: number): string {
  const bytes = Buffer.from(value, 'base64');
  bytes.writeUInt8(bytes.readUInt8(index) ^ 0x01, index);
  return bytes.toString('base64');
}

/** What the previous release wrote: AES-256-GCM, no key id, no associated data. */
function legacyEncrypt(plaintext: string, key: Buffer): LegacyEncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

describe('AES-256-GCM secret handling', () => {
  it('round-trips a credential as a version 2 record naming the active key, without storing plaintext', () => {
    const keys = singleKeyring();
    const plaintext = randomBytes(32).toString('base64url');
    const encrypted = encryptSecret(plaintext, keys, CONTEXT);

    expect({ version: encrypted.version, keyId: encrypted.keyId, leaks: JSON.stringify(encrypted).includes(plaintext) })
      .toEqual({ version: 2, keyId: 'primary', leaks: false });
    expect(decryptSecret(encrypted, keys, CONTEXT)).toBe(plaintext);
  });

  it('refuses a record opened with a different context, as when a blob is copied onto another row', () => {
    const keys = singleKeyring();
    const encrypted = encryptSecret('confidential', keys, CONTEXT);

    expect(() => decryptSecret(encrypted, keys, '22222222-2222-4222-8222-222222222222:github')).toThrow();
    expect(() => decryptSecret(encrypted, keys, '11111111-1111-4111-8111-111111111111:linear')).toThrow();
  });

  it('reads a version 1 record with the legacy key, ignoring the context it never had', () => {
    const legacyKey = randomBytes(32);
    const keys = keyring('next', { [LEGACY_KEY_ID]: legacyKey, next: randomBytes(32) });

    expect(decryptSecret(legacyEncrypt('from the old release', legacyKey), keys, CONTEXT)).toBe('from the old release');
  });

  it('refuses a version 1 record when no legacy key is configured', () => {
    expect(() => decryptSecret(legacyEncrypt('orphaned', randomBytes(32)), singleKeyring(), CONTEXT))
      .toThrow(`Unknown encryption key id: ${LEGACY_KEY_ID}`);
  });

  it('reads a record sealed by a key that is no longer active', () => {
    const retiring = randomBytes(32);
    const encrypted = encryptSecret('sealed earlier', keyring('old', { old: retiring }), CONTEXT);

    expect(decryptSecret(encrypted, keyring('new', { old: retiring, new: randomBytes(32) }), CONTEXT)).toBe('sealed earlier');
  });

  it('refuses a record whose key id is not in the keyring', () => {
    const encrypted = encryptSecret('confidential', keyring('removed', { removed: randomBytes(32) }), CONTEXT);

    expect(() => decryptSecret(encrypted, singleKeyring(), CONTEXT)).toThrow('Unknown encryption key id: removed');
  });

  it('refuses a record whose key id was rewritten to point at another configured key', () => {
    const keys = keyring('first', { first: randomBytes(32), second: randomBytes(32) });
    const encrypted = { ...encryptSecret('confidential', keys, CONTEXT), keyId: 'second' };

    expect(() => decryptSecret(encrypted, keys, CONTEXT)).toThrow();
  });

  it('flags every record not written by the active key for re-encryption', () => {
    const legacyKey = randomBytes(32);
    const older = keyring('old', { old: randomBytes(32) });
    const current = keyring('new', { new: randomBytes(32) });

    expect([
      needsReencryption(legacyEncrypt('v1', legacyKey), current),
      needsReencryption(encryptSecret('v2 old', older, CONTEXT), current),
      needsReencryption(encryptSecret('v2 new', current, CONTEXT), current),
    ]).toEqual([true, true, false]);
  });

  it('detects ciphertext tampering', () => {
    const keys = singleKeyring();
    const encrypted = encryptSecret('confidential', keys, CONTEXT);
    encrypted.ciphertext = `${encrypted.ciphertext.slice(0, -2)}AA`;

    expect(() => decryptSecret(encrypted, keys, CONTEXT)).toThrow();
  });

  it('rejects an active key that is not 256 bits', () => {
    expect(() => encryptSecret('value', singleKeyring(randomBytes(16)), CONTEXT)).toThrow('exactly 32 bytes');
  });

  it('rejects a short key on decrypt as well as on encrypt', () => {
    const encrypted = encryptSecret('value', singleKeyring(), CONTEXT);

    expect(() => decryptSecret(encrypted, singleKeyring(randomBytes(16)), CONTEXT)).toThrow('exactly 32 bytes');
  });

  it('refuses a correctly formed record encrypted under a different key with the same id', () => {
    const encrypted = encryptSecret('confidential', singleKeyring(), CONTEXT);

    expect(() => decryptSecret(encrypted, singleKeyring(), CONTEXT)).toThrow();
  });

  it('detects IV tampering', () => {
    const keys = singleKeyring();
    const encrypted = encryptSecret('confidential', keys, CONTEXT);
    encrypted.iv = corruptBase64Byte(encrypted.iv, 0);

    expect(() => decryptSecret(encrypted, keys, CONTEXT)).toThrow();
  });

  it('detects auth tag tampering', () => {
    const keys = singleKeyring();
    const encrypted = encryptSecret('confidential', keys, CONTEXT);
    encrypted.authTag = corruptBase64Byte(encrypted.authTag, 0);

    expect(() => decryptSecret(encrypted, keys, CONTEXT)).toThrow();
  });

  it('refuses a version it does not know how to read', () => {
    const keys = singleKeyring();
    const encrypted = { ...encryptSecret('confidential', keys, CONTEXT), version: 3 } as unknown as EncryptedSecret;

    expect(() => decryptSecret(encrypted, keys, CONTEXT)).toThrow('Unsupported encrypted credential version');
  });

  it('round-trips an empty string', () => {
    const keys = singleKeyring();

    expect(decryptSecret(encryptSecret('', keys, CONTEXT), keys, CONTEXT)).toBe('');
  });

  it('round-trips multibyte UTF-8 without mangling it', () => {
    const keys = singleKeyring();
    const plaintext = 'héllo 🔐';

    expect(decryptSecret(encryptSecret(plaintext, keys, CONTEXT), keys, CONTEXT)).toBe(plaintext);
  });
});
