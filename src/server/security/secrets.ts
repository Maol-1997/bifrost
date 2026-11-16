import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const SECRET_ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
export const ENCRYPTION_KEY_BYTES = 32;
/**
 * Version 1 records predate key ids and associated data. They are only ever
 * read, with the key registered under this id; every write produces version 2.
 */
export const LEGACY_KEY_ID = 'legacy';
/** The version every write produces; anything else is due for re-encryption. */
export const KEYED_SECRET_VERSION = 2;

type SealedSecret = {
  iv: string;
  ciphertext: string;
  authTag: string;
};

export type LegacyEncryptedSecret = SealedSecret & { version: 1 };
export type KeyedEncryptedSecret = SealedSecret & { version: typeof KEYED_SECRET_VERSION; keyId: string };
export type EncryptedSecret = LegacyEncryptedSecret | KeyedEncryptedSecret;

/** Every key that may still be needed to read a record, and the one new records are written with. */
export type EncryptionKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

/**
 * `context` is authenticated, not encrypted: a record only opens with the exact
 * context it was sealed with. Binding it to the row's identity is what makes a
 * ciphertext copied onto another row fail instead of handing over a credential.
 */
export function encryptSecret(plaintext: string, keyring: EncryptionKeyring, context: string): KeyedEncryptedSecret {
  const key = keyFor(keyring, keyring.activeKeyId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(SECRET_ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: KEYED_SECRET_VERSION,
    keyId: keyring.activeKeyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(encrypted: EncryptedSecret, keyring: EncryptionKeyring, context: string): string {
  switch (encrypted.version) {
    case 1:
      return open(encrypted, keyFor(keyring, LEGACY_KEY_ID));
    case KEYED_SECRET_VERSION:
      return open(encrypted, keyFor(keyring, encrypted.keyId), context);
    default:
      throw new Error('Unsupported encrypted credential version');
  }
}

/** Whether a record was written by anything other than the current active key. */
export function needsReencryption(encrypted: EncryptedSecret, keyring: EncryptionKeyring): boolean {
  return encrypted.version !== KEYED_SECRET_VERSION || encrypted.keyId !== keyring.activeKeyId;
}

function open(encrypted: EncryptedSecret, key: Buffer, context?: string): string {
  const decipher = createDecipheriv(SECRET_ENCRYPTION_ALGORITHM, key, Buffer.from(encrypted.iv, 'base64'), {
    authTagLength: AUTH_TAG_BYTES,
  });
  if (context !== undefined) decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

function keyFor(keyring: EncryptionKeyring, keyId: string): Buffer {
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`Unknown encryption key id: ${keyId}`);
  if (key.length !== ENCRYPTION_KEY_BYTES) throw new Error('Encryption key must be exactly 32 bytes');
  return key;
}
