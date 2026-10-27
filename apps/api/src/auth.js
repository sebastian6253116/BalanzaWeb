/**
 * Passwords and sessions.
 *
 * Passwords use scrypt (node:crypto) with a per-user random salt — no native
 * dependency, and deliberately slow. Session tokens are random, stored only as a
 * SHA-256 digest, and expire.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SESSION_TTL_HOURS = 12;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sessionExpiry(from = new Date()) {
  return new Date(from.getTime() + SESSION_TTL_HOURS * 3600_000).toISOString();
}

export function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < 8) {
    const error = new Error('password must be at least 8 characters');
    error.status = 422;
    throw error;
  }
}
