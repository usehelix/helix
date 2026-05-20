import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for Jira API tokens stored at rest.
 *
 * Key source: HELIX_ENCRYPTION_KEY env var (32 bytes hex = 64 chars).
 * Format: base64(iv[12] || tag[16] || ciphertext)
 */

function getKey(): Buffer {
  const hex = process.env.HELIX_ENCRYPTION_KEY || '';
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('HELIX_ENCRYPTION_KEY must be 32 bytes hex (64 hex chars)');
  }
  return key;
}

export function encrypt(plain: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(encoded: string): string {
  const key = getKey();
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 28) {
    throw new Error('encrypted blob too short — expected iv(12) + tag(16) + ciphertext');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Generate a 32-byte random hex string suitable for HELIX_ENCRYPTION_KEY.
 * Exposed for the `vial jira connect` first-run UX.
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate a webhook secret (32-byte URL-safe random).
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}
