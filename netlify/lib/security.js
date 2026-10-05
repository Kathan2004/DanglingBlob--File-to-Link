// Shared security helpers for the Netlify functions.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { getStore } from '@netlify/blobs';

const scrypt = promisify(scryptCb);
const SCRYPT_KEYLEN = 32;

/** Constant-time string comparison (hashes first so length differences do not leak). */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** Salted scrypt hash for link passwords: scrypt$<salt b64>$<hash b64>. */
export async function hashLinkPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Verify a link password. Accepts legacy unsalted SHA-256 hex hashes from older links. */
export async function verifyLinkPassword(password, stored) {
  const value = String(stored || '');
  if (value.startsWith('scrypt$')) {
    const [, saltB64, hashB64] = value.split('$');
    const expected = Buffer.from(hashB64 || '', 'base64');
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const actual = await scrypt(String(password), Buffer.from(saltB64 || '', 'base64'), SCRYPT_KEYLEN);
    return timingSafeEqual(actual, expected);
  }
  if (/^[0-9a-f]{64}$/.test(value)) {
    const legacy = createHash('sha256').update(String(password)).digest('hex');
    return safeEqual(legacy, value);
  }
  return false;
}

export function clientIp(request) {
  return (
    request.headers.get('x-nf-client-connection-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Fixed-window failure counter backed by Netlify Blobs.
 * isLocked() before checking credentials, recordFailure() on a miss, clear() on success.
 */
export function throttle(scope, { maxFailures, windowMs }) {
  const store = getStore('auth-throttle');
  const keyFor = (id) => `${scope}:${id}`.slice(0, 200);
  return {
    async isLocked(id) {
      const entry = await store.get(keyFor(id), { type: 'json' });
      return Boolean(entry && Date.now() - entry.windowStart < windowMs && entry.failures >= maxFailures);
    },
    async recordFailure(id) {
      const key = keyFor(id);
      const entry = await store.get(key, { type: 'json' });
      const fresh = !entry || Date.now() - entry.windowStart >= windowMs;
      await store.setJSON(key, {
        windowStart: fresh ? Date.now() : entry.windowStart,
        failures: fresh ? 1 : entry.failures + 1
      });
    },
    async clear(id) {
      await store.delete(keyFor(id));
    }
  };
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function attachmentDisposition(filename) {
  const name = String(filename || 'download.bin');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download.bin';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
