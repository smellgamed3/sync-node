import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function normalizeKey(key?: Buffer | string): Buffer {
  if (!key) return Buffer.alloc(32, 0);
  if (Buffer.isBuffer(key)) {
    return key.length === 32 ? key : createHash('sha256').update(key).digest();
  }

  try {
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    // fall through
  }

  return createHash('sha256').update(key).digest();
}

export function generateKey(): string {
  return randomBytes(32).toString('base64');
}

export function encrypt(plaintext: Buffer, key?: Buffer | string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, normalizeKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

export function decrypt(data: Buffer, key?: Buffer | string): Buffer {
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, normalizeKey(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
