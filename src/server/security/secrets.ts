import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const SECRET_ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENCRYPTED_SECRET_VERSION = 1;

export type EncryptedSecret = {
  version: number;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(SECRET_ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: ENCRYPTED_SECRET_VERSION,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(encrypted: EncryptedSecret, key: Buffer): string {
  assertKey(key);
  if (encrypted.version !== ENCRYPTED_SECRET_VERSION) throw new Error('Unsupported encrypted credential version');
  const decipher = createDecipheriv(SECRET_ENCRYPTION_ALGORITHM, key, Buffer.from(encrypted.iv, 'base64'), { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes');
}
