import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/core/crypto.js';

describe('crypto', () => {
  it('round-trips plaintext', () => {
    const input = Buffer.from('hello filesync');
    const encrypted = encrypt(input, Buffer.alloc(32, 7));
    expect(encrypted.equals(input)).toBe(false);
    const decrypted = decrypt(encrypted, Buffer.alloc(32, 7));
    expect(decrypted.toString()).toBe('hello filesync');
  });
});
